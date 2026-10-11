import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClient, DataFormat } from '@clickhouse/client';
import { appConfig } from '../../config/configuration';

type ClickHouseClient = ReturnType<typeof createClient>;

// insert 瞬时网络错误重试：最多 3 次，基础退避 200ms（200/400ms）
const INSERT_MAX_ATTEMPTS = 3;
const INSERT_RETRY_BASE_MS = 200;

/**
 * 对拍查询上限：sa_events / log_analysis 全量按日 count 是重查询
 * （7 天各约 5 亿行），CH 23.2 在执行前按读取速度做时间估算，
 * 估算值在 200-400s 间波动并直接拒绝（23.2 无 max_estimated_execution_time
 * 设置可单独放宽，23.3+ 才引入），因此执行上限须 > 估算波动上限。
 * 取 600s；列存 count 实际执行 ~40s，远低于上限。
 */
export const RECONCILE_MAX_EXECUTION_TIME = 600;

/**
 * 慢 SQL 查询：固定列与返回上限（运维面板专用，不接受调用方指定）。
 * 列固定可杜绝注入，也避免把 query_log 中其它敏感字段暴露出去。
 */
const SLOW_QUERY_COLUMNS = [
  'event_time',
  'query_duration_ms',
  'read_rows',
  'read_bytes',
  'memory_usage',
  'user',
  'type',
  'query',
  'exception',
] as const;

const SLOW_QUERY_MAX_ROWS = 1000;

export interface SlowQueryRow {
  event_time: string;
  query_duration_ms: number;
  read_rows: number;
  read_bytes: number;
  memory_usage: number;
  user: string;
  type: string;
  query: string;
  exception: string;
}

export interface DataStatsRow {
  chVersion: string;
  eventRows: number;
  eventBytes: number;
  lastWriteAt: string | null;
}

/**
 * 传给 ClickHouse DateTime 参数的值：**epoch 秒**，SQL 侧用 `toDateTime({x:UInt32})` 还原。
 *
 * ⚠️ 不要改回 'YYYY-MM-DD HH:MM:SS' 字符串：字符串字面量按 **ClickHouse 服务端时区**
 * （生产为 Asia/Shanghai）解释，而 `toISOString()` 产出的是 UTC，时间窗会整体偏移时区差
 * ——曾因此偏 8 小时：「近 5 分钟」实际查了近 8 小时，`slow_query_spike` 规则连续误报 8 天
 * （`CODE_HANDOVER.md` AL-01）。epoch 比较与双方时区无关，服务器换时区也不会再错。
 */
export function toClickHouseEpochSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

interface QueryOptions {
  readonly?: boolean;
  maxExecutionTime?: number;
  maxResultRows?: number;
  /** 查询级内存上限（字节）：超限 CH 抛错拒绝该查询，而非 OOM 拖垮整个实例 */
  maxMemoryUsage?: number;
  /** 查询线程数：并行聚合按线程数放大内存（局部哈希各一份），限线程即限内存 */
  maxThreads?: number;
}

@Injectable()
export class ClickHouseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClickHouseService.name);
  private writeClient: ClickHouseClient;
  private readonlyClient: ClickHouseClient;
  /** 定点删除专用（`sa_cleanup`：仅 clklog_sa.* 的 SELECT / ALTER DELETE / ALTER UPDATE） */
  private cleanupClient: ClickHouseClient | null = null;

  onModuleInit() {
    this.writeClient = this.createClient(appConfig.clickhouse.write);
    this.readonlyClient = this.createClient(appConfig.clickhouse.readonly);
    const cleanup = appConfig.cleanup;
    if (cleanup?.enabled && cleanup.password) {
      this.cleanupClient = this.createClient({
        ...appConfig.clickhouse.write,
        username: cleanup.username,
        password: cleanup.password,
      });
    }
  }

  onModuleDestroy() {
    this.writeClient?.close();
    this.readonlyClient?.close();
    this.cleanupClient?.close();
  }

  /** 清洗账号是否可用（未注入口令时为 false：调用方必须拒绝执行，不得回退高权账号） */
  cleanupEnabled(): boolean {
    return this.cleanupClient !== null;
  }

  /**
   * 用**清洗账号**执行破坏性 DDL（ALTER DELETE / DROP PARTITION / 备份 INSERT SELECT）。
   *
   * 与 `command()` 的区别：走 `sa_cleanup`（最小权限），且**不做** ensureProjectFilter
   * —— 该守卫只针对 SELECT（红线 4），而这里的 SQL 由 `cleanup-plan.ts` 的构造器生成，
   * 已强制含 project_name 与时间上界（白名单表/列，无任意 SQL 入口）。
   */
  async cleanupCommand(
    sql: string,
    params?: Record<string, unknown>,
    options: { maxExecutionTime?: number; settings?: Record<string, unknown> } = {},
  ): Promise<void> {
    if (!this.cleanupClient) {
      throw new Error('清洗账号未配置（CLICKHOUSE_CLEANUP_PASSWORD 未注入）');
    }
    await this.cleanupClient.command({
      query: sql,
      query_params: params,
      clickhouse_settings: {
        max_execution_time: options.maxExecutionTime ?? appConfig.query.maxExecutionTime,
        ...(options.settings ?? {}),
      } as any,
    });
  }

  private createClient(config: typeof appConfig.clickhouse.write): ClickHouseClient {
    return createClient({
      host: `${config.protocol}://${config.host}:${config.port}`,
      username: config.username,
      password: config.password,
      database: config.database,
      // 客户端超时只做兜底（对拍长查询 ~40s）；真正的查询时限由
      // 每条查询的 max_execution_time 设置控制（用户查询 30s、对拍 300s）
      request_timeout: RECONCILE_MAX_EXECUTION_TIME * 1000,
    });
  }

  /**
   * 执行查询，返回对象数组
   */
  async query<T = unknown>(sql: string, params?: Record<string, unknown>, options: QueryOptions = {}): Promise<T[]> {
    const client = options.readonly ? this.readonlyClient : this.writeClient;
    const start = Date.now();

    this.ensureProjectFilter(sql);

    try {
      const resultSet = await client.query({
        query: sql,
        query_params: params,
        format: 'JSONEachRow' as DataFormat,
        clickhouse_settings: {
          max_execution_time: options.maxExecutionTime ?? appConfig.query.maxExecutionTime,
          max_result_rows: options.maxResultRows ?? appConfig.query.maxResultRows,
          ...(options.maxMemoryUsage ? { max_memory_usage: options.maxMemoryUsage } : {}),
          ...(options.maxThreads ? { max_threads: options.maxThreads } : {}),
        } as any,
      });

      const data = (await resultSet.json()) as T[];
      const elapsed = Date.now() - start;

      if (elapsed > appConfig.log.slowQueryThresholdMs) {
        this.logger.warn(`慢查询 ${elapsed}ms: ${sql}`);
      }

      return data;
    } catch (error) {
      this.logger.error(`ClickHouse 查询失败: ${sql}`, error);
      throw error;
    }
  }

  /**
   * 系统级只读对拍查询（数据一致性对拍专用）。
   *
   * 与 `query` 的区别：
   * - 必须传 readonly=true，否则拒绝（对拍只读，杜绝误用写连接）。
   * - 不强制 `project_name` 过滤：对拍需要与社区版 `clklog.log_analysis`
   *   （无 project_name 列）做跨库对照。仅限受控的系统 SQL，非用户输入。
   *
   * 账号说明（2026-09-07）：原设计走 sa_readonly 只读账号，但该账号的
   * clklog 库授权依赖服务器 users.d 文件，该文件被 Puppet 类机制周期性
   * 回滚（漂移复发，HANDOVER §11.2 同款问题第二次出现），授权反复丢失。
   * 故改走 write 账号 + **查询级 readonly=2 设置**：该设置对该查询强制
   * 只读（禁一切写操作与写设置），只读语义不依赖账号授权。
   * SQL 全部为服务端常量，无用户输入注入面。
   *
   * 红线说明：AGENTS.md「ClickHouse 分析查询必须有界」针对的是 DSL 驱动的用户查询
   * （强制 project_name）；对拍是只读运维操作，且查询级 readonly=2 兜底。
   */
  async queryReconcile<T = unknown>(
    sql: string,
    params?: Record<string, unknown>,
    options: QueryOptions = {},
  ): Promise<T[]> {
    if (options.readonly !== true) {
      throw new Error('queryReconcile 必须显式传 readonly: true');
    }
    const client = this.writeClient;
    const start = Date.now();
    try {
      const resultSet = await client.query({
        query: sql,
        query_params: params,
        format: 'JSONEachRow' as DataFormat,
        clickhouse_settings: {
          // 查询级只读锁定：禁一切写操作，不依赖账号授权（见方法注释）
          readonly: 2,
          max_execution_time: options.maxExecutionTime ?? appConfig.query.maxExecutionTime,
          max_result_rows: options.maxResultRows ?? appConfig.query.maxResultRows,
          ...(options.maxMemoryUsage ? { max_memory_usage: options.maxMemoryUsage } : {}),
          ...(options.maxThreads ? { max_threads: options.maxThreads } : {}),
        } as any,
      });
      const data = (await resultSet.json()) as T[];
      const elapsed = Date.now() - start;
      if (elapsed > appConfig.log.slowQueryThresholdMs) {
        this.logger.warn(`对拍慢查询 ${elapsed}ms: ${sql}`);
      }
      return data;
    } catch (error) {
      this.logger.error(`对拍查询失败: ${sql}`, error);
      throw error;
    }
  }

  /**
   * 自定义 SQL 只读执行（自定义 SQL 分析专用）。
   *
   * - 用 readonly client 执行（本期 readonly 仍为 default 账号，专用只读账号留 TODO）。
   * - 返回列名 + 类型 + 行 + 统计（read_rows/read_bytes），供结果区展示。
   * - 应用完整资源限额（评审要求，超出仅 max_execution_time 的保护）。
   */
  async querySql(
    sql: string,
    params?: Record<string, unknown>,
    settings?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{
    columns: { name: string; type: string }[];
    rows: Record<string, unknown>[];
    read_rows: number;
    read_bytes: number;
    query_id: string;
    /** 实测耗时（毫秒）；结果区「耗时」用它，别再回落成占位 0 */
    elapsed_ms: number;
  }> {
    const client = this.readonlyClient;
    const start = Date.now();
    const mergedSettings = {
      max_execution_time: appConfig.query.maxExecutionTime,
      max_result_rows: 100_000,
      max_result_bytes: 100_000_000,
      // 扫描上限：6 亿行。project + time 走 additional_table_filters，SQL 侧的 event
      // 条件可打到 ORDER BY (event, stat_date)。高频事件 7 天读 properties 约 45GB
      //（2026-09-03 实测 base_ui_open_trigger），5GB 会误杀合法查询。
      // 仍有界：6亿行 + 50GB 字节 + 2GB 内存 + 30s 超时（红线4）。
      max_rows_to_read: 600_000_000,
      max_bytes_to_read: 50_000_000_000,
      max_memory_usage: 2_000_000_000,
      max_threads: 4,
      // 23.2 无 max_estimated_execution_time。默认 10s 后按剩余行数预估，悲观时
      // 会把本能在 30s 内跑完的查询杀掉。调到大于 max_execution_time，只保留墙钟 30s。
      timeout_before_checking_execution_speed: 100,
      ...settings,
    };

    try {
      // 用 format: 'JSON' + resultSet.json()。
      // 依据 @clickhouse/client 源码（formatter.js decode）：'JSON' 属于
      // singleDocumentJSONFormats，decode 直接 JSON.parse 返回
      // { meta: [{name,type}], data: [[...]], rows, statistics: {rows_read, bytes_read} }。
      // 这是唯一有源码依据、稳定的取列名+类型+数据+统计的方式。
      const resultSet = await client.query({
        query: sql,
        query_params: params,
        format: 'JSON' as DataFormat,
        clickhouse_settings: mergedSettings as any,
        abort_signal: options?.signal,
      });

      const parsed = (await resultSet.json()) as {
        meta?: { name: string; type: string }[];
        data?: Array<Record<string, unknown>>;
        statistics?: { rows_read?: number; bytes_read?: number };
      };

      const columns = parsed.meta ?? [];
      // 注意：ClickHouse FORMAT JSON 的 data 是【对象数组】[{col: value}, ...]，
      // 已带列名，直接作为 rows 使用，无需再做 meta→data 映射。
      const rows = parsed.data ?? [];

      const elapsed = Date.now() - start;
      if (elapsed > appConfig.log.slowQueryThresholdMs) {
        this.logger.warn(`自定义 SQL 慢查询 ${elapsed}ms`);
      }
      return {
        columns,
        rows,
        read_rows: parsed.statistics?.rows_read ?? 0,
        read_bytes: parsed.statistics?.bytes_read ?? 0,
        query_id: resultSet.query_id,
        elapsed_ms: elapsed,
      };
    } catch (error) {
      // 客户端断开（长查询保活信号）不是故障：查询已被取消，不必刷错误日志
      if (options?.signal?.aborted || (error as { name?: string })?.name === 'AbortError') {
        this.logger.warn('自定义 SQL 已取消（客户端断开）');
        throw error;
      }
      this.logger.error(`自定义 SQL 执行失败`, error);
      throw error;
    }
  }

  /**
   * 只读系统表查询：慢 SQL（运维面板专用，phase: clklog-analytics-ops-console-v1）。
   *
   * 为什么不复用 `query()`：`query()` 会强制 `ensureProjectFilter`（红线 4 的执行点），
   * 而 `system.query_log` 没有 project_name 列，复用必然被拒。放宽该校验又会削弱红线，
   * 因此单独开一条**受限**通道：
   * - 表名固定 `system.query_log`，列固定为慢 SQL 需要的列，不接受调用方传入表名 /
   *   列名 / SQL 片段，杜绝注入；
   * - 过滤条件全部参数化，值不拼进 SQL；
   * - 强制时间范围 + LIMIT（红线 4：查询必须有界）；
   * - 走 readonly 账号（`sa_readonly`，已验证有 query_log 读权限）。
   */
  async querySlowQueries(input: {
    since: Date;
    until?: Date;
    minDurationMs: number;
    status: 'all' | 'success' | 'failed';
    limit: number;
  }): Promise<SlowQueryRow[]> {
    const limit = Math.min(Math.max(Math.trunc(input.limit) || 100, 1), SLOW_QUERY_MAX_ROWS);
    const params: Record<string, unknown> = {
      since: toClickHouseEpochSeconds(input.since),
      minDuration: Math.max(0, Math.trunc(input.minDurationMs)),
    };
    // 只取已完成的查询，避免统计到仍在跑的 QueryStart
    // 时间窗用 epoch → toDateTime()，与 ClickHouse 时区无关（见 toClickHouseEpochSeconds）
    const conditions = [
      'event_time >= toDateTime({since:UInt32})',
      'query_duration_ms >= {minDuration:UInt64}',
      "type IN ('QueryFinish', 'ExceptionWhileProcessing')",
    ];
    if (input.until) {
      conditions.push('event_time <= toDateTime({until:UInt32})');
      params.until = toClickHouseEpochSeconds(input.until);
    }
    if (input.status === 'success') conditions.push("type = 'QueryFinish'");
    if (input.status === 'failed') conditions.push("type = 'ExceptionWhileProcessing'");

    const sql = [
      `SELECT ${SLOW_QUERY_COLUMNS.join(', ')}`,
      'FROM system.query_log',
      `WHERE ${conditions.join(' AND ')}`,
      'ORDER BY query_duration_ms DESC',
      `LIMIT ${limit}`,
    ].join(' ');

    const resultSet = await this.readonlyClient.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow' as DataFormat,
      clickhouse_settings: {
        max_execution_time: appConfig.query.maxExecutionTime,
        max_result_rows: SLOW_QUERY_MAX_ROWS,
      } as any,
    });
    return (await resultSet.json()) as SlowQueryRow[];
  }

  /**
   * 只读系统表查询：数据量与链路状态（运维面板切片 2）。
   *
   * ⚠️ 链路判据用 `system.parts.modification_time`（CH 侧最后写入时间），
   * **不可用** `max(stat_date)`——生产实测该值为未来日期（2027-01-02），
   * 与写入时间无关（HANDOVER §10.9 / V5）。
   *
   * 同 `querySlowQueries`：表与列固定、参数化、有界、readonly。
   */
  async queryDataStats(): Promise<DataStatsRow> {
    const sql = [
      'SELECT',
      '  version() AS ch_version,',
      "  (SELECT sum(rows) FROM system.parts WHERE database = 'clklog_sa' AND table = 'sa_events' AND active) AS event_rows,",
      "  (SELECT sum(bytes) FROM system.parts WHERE database = 'clklog_sa' AND table = 'sa_events' AND active) AS event_bytes,",
      "  (SELECT toString(max(modification_time)) FROM system.parts WHERE database = 'clklog_sa' AND table = 'sa_events' AND active) AS last_write_at",
    ].join(' ');

    const resultSet = await this.readonlyClient.query({
      query: sql,
      format: 'JSONEachRow' as DataFormat,
      clickhouse_settings: {
        max_execution_time: appConfig.query.maxExecutionTime,
      } as any,
    });
    const rows = (await resultSet.json()) as Array<Record<string, unknown>>;
    const row = rows[0] ?? {};
    return {
      chVersion: String(row.ch_version ?? ''),
      eventRows: Number(row.event_rows ?? 0),
      eventBytes: Number(row.event_bytes ?? 0),
      lastWriteAt: row.last_write_at ? String(row.last_write_at) : null,
    };
  }

  /**
   * 执行 DDL / INSERT 等写操作
   */
  async exec(sql: string): Promise<void> {
    this.ensureProjectFilter(sql);
    await this.writeClient.command({ query: sql });
  }

  /**
   * `system.mutations` 上有几条未完成任务（定点删除的 IO 保护用）。
   *
   * 为什么不走 `query()`：`query()` 强制 `ensureProjectFilter`（红线 4），而系统表没有
   * `project_name` 列 —— 复用必然抛错，异常在本方法调用方被保守当成「有 mutation」，
   * 结果是**每次删除都被 409 拦住**（2026-10-09 端到端实测踩到）。与 `querySlowQueries`
   * 同样的处理：单独开受限通道——表名固定 `system.mutations`、SQL 固定、db/table 参数化、
   * 只看计数/LIMIT 1，走写账号（`sa_readonly` 未被授权系统表）。
   */
  async countPendingMutations(db: string, table: string): Promise<number> {
    const rs = await this.writeClient.query({
      query: 'SELECT count() AS n FROM system.mutations WHERE database = {db: String} AND table = {tbl: String} AND NOT is_done',
      query_params: { db, tbl: table },
      format: 'JSONEachRow' as DataFormat,
      clickhouse_settings: { max_execution_time: 30, max_result_rows: 1 } as any,
    });
    const rows = (await rs.json()) as Array<{ n: string }>;
    return rows.length ? parseInt(rows[0].n, 10) : 0;
  }

  /** 最近一次 mutation id（前端轮询进度用）；与 countPendingMutations 同一受限通道 */
  async latestMutationId(db: string, table: string): Promise<string | null> {
    const rs = await this.writeClient.query({
      query: 'SELECT toString(max(mutation_id)) AS id FROM system.mutations WHERE database = {db: String} AND table = {tbl: String}',
      query_params: { db, tbl: table },
      format: 'JSONEachRow' as DataFormat,
      clickhouse_settings: { max_execution_time: 30, max_result_rows: 1 } as any,
    });
    const rows = (await rs.json()) as Array<{ id: string }>;
    return rows.length && rows[0].id ? rows[0].id : null;
  }

  /**
   * 带参数的写命令（INSERT SELECT / ALTER DELETE）。SELECT 仍强制 project_name。
   */
  async command(
    sql: string,
    params?: Record<string, unknown>,
    options: { maxExecutionTime?: number; settings?: Record<string, unknown> } = {},
  ): Promise<void> {
    this.ensureProjectFilter(sql);
    await this.writeClient.command({
      query: sql,
      query_params: params,
      clickhouse_settings: {
        max_execution_time: options.maxExecutionTime ?? appConfig.query.maxExecutionTime,
        ...(options.settings ?? {}),
      } as any,
    });
  }

  /**
   * 批量插入
   *
   * 瞬时网络错误（EPIPE/ECONNRESET 等，源于 keep-alive 空闲连接被对端关闭后复用）
   * 自动指数退避重试，避免错误传播到 Kafka runner 导致 ingestor 进程崩溃循环。
   * 仅重试连接类错误；ClickHouse 返回的业务/语法错误不重试。
   */
  async insert<T extends object>(table: string, rows: T[]): Promise<void> {
    if (rows.length === 0) return;

    await this.insertWithRetry(table, rows, 1);
  }

  private async insertWithRetry<T extends object>(
    table: string,
    rows: T[],
    attempt: number,
  ): Promise<void> {
    try {
      await this.writeClient.insert({
        table,
        values: rows,
        format: 'JSONEachRow' as DataFormat,
      });
    } catch (error) {
      if (attempt < INSERT_MAX_ATTEMPTS && this.isTransientNetworkError(error)) {
        const delay = INSERT_RETRY_BASE_MS * 2 ** (attempt - 1);
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `写入 ${table} 遇到瞬时网络错误（第 ${attempt}/${INSERT_MAX_ATTEMPTS} 次重试，${delay}ms 后）: ${msg}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.insertWithRetry(table, rows, attempt + 1);
      }
      throw error;
    }
  }

  /** 判断是否为连接类瞬时错误（socket 被对端关闭 / 连接失败 / 超时） */
  private isTransientNetworkError(error: unknown): boolean {
    const msg = String((error as { message?: string })?.message ?? error ?? '');
    return /EPIPE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|Connection closed|Connection terminated/i.test(
      msg,
    );
  }

  /**
   * 防御式校验：所有查询必须包含 project_name 过滤
   * 注意：仅对 SELECT 做宽松检查，DDL/INSERT 不过滤 project
   */
  private ensureProjectFilter(sql: string): void {
    const trimmed = sql.trim().toLowerCase();
    if (!trimmed.startsWith('select')) return;

    if (!sql.includes('project_name')) {
      throw new Error('ClickHouse 查询缺少 project_name 过滤（红线）');
    }
  }
}
