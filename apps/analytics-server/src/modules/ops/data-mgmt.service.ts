import { Injectable, Logger } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import { PrismaService } from '../shared/prisma.service';
import { parseChDateTimeInTz, todayInTz, ymdInTz } from '../time/calendar';
import { TimezoneService } from '../time/timezone.service';
import { QualityService } from '../meta/quality.service';
import { ClickHouseService, RECONCILE_MAX_EXECUTION_TIME } from '../shared/clickhouse.service';
import { COMMUNITY_DB, monthRange, parseTtlDays, SA_EVENTS_TABLE } from './retention-policy';
import { RetentionService, type PreflightResult, type RetentionOverview } from './retention.service';

// 兼容既有引用（实现已移到纯函数文件 retention-policy.ts，ops/meta 两域共用同一口径）
export { parseTtlDays } from './retention-policy';

/**
 * 数据管理服务（phase: clklog-analytics-data-management-v1，设计文档 §3）。
 *
 * 只读优先：V1.0 只有概览/趋势/健康/预演，无任何写动作。
 * 所有对 sa_events / log_analysis 的扫描必须带护栏
 * （时间下界 + 4GB 内存 + 2 线程 + 600s 上限，HANDOVER §11.2 对拍事故）。
 */

/** 存储概览的目标库（盘点范围；CH 系统表不在业务盘点内） */
const INVENTORED_DATABASES = ['clklog_sa', 'clklog'];

export interface TableInventory {
  table: string;
  rows: number;
  compressed_bytes: number;
  total_bytes: number;
  partitions: number;
  last_write_at: string | null;
  ttl_days: number | null; // 从 engine 表达式解析 TTL（无则 null）
  engine: string;
}

export interface CleanupPreviewPartition {
  partition: string;
  rows: number;
  compressed_bytes: number;
}

export interface CleanupPreview {
  table: string;
  older_than_days: number;
  cutoff: string;
  partitions: CleanupPreviewPartition[];
  total_rows: number;
  total_compressed_bytes: number;
  action: string;
  /** 无候选时的原因说明（如按日分区的表不支持月分区清理） */
  note?: string;
  /** 前置对拍结论（R2-3：未通过则执行会被拒；预演阶段先展示原因） */
  preflight?: PreflightResult | null;
}

const RECONCILE_GUARDS = {
  readonly: true,
  maxExecutionTime: RECONCILE_MAX_EXECUTION_TIME,
  maxMemoryUsage: 4_000_000_000,
  maxThreads: 2,
} as const;

/** TTL 时间列映射（防拼错列名；盘点范围内需要 TTL 的表逐个登记） */
/**
 * 可设置 TTL 的表与其时间列（动作白名单：只允许这些表被 MODIFY TTL）。
 *
 * - `clklog_sa.sa_events`：旁路事件表，TTL 18 个月（现状）。
 * - `clklog.*` 共 19 张（log_analysis + 18 张聚合表）：**社区版表，改 TTL 属红线 1 的例外**，
 *   必须先获用户授权、逐个确认，并走本服务（审计 + 清理登记）执行，禁止手工 ALTER 后不回写。
 * - 时间列统一用 `stat_date`：它在所有 19 张表上都存在（实测 `Date` 类型），且与分区键同列——
 *   TTL 到期可直接丢弃整个分区，不必重写 part（`log_time` 是表达式口径，会触发 part 重写）。
 */
const TTL_TIME_COLUMN: Record<string, string> = {
  'clklog.log_analysis': 'stat_date',
  'clklog_sa.sa_events': 'stat_date',
  // 18 张聚合表（2026-10-09 实测 system.columns：全部含 stat_date DATE 列）
  'clklog.area_detail_bydate': 'stat_date',
  'clklog.channel_detail_bydate': 'stat_date',
  'clklog.crashed_detail_bydate': 'stat_date',
  'clklog.device_detail_bydate': 'stat_date',
  'clklog.flow_trend_bydate': 'stat_date',
  'clklog.flow_trend_byhour': 'stat_date',
  'clklog.searchword_detail_bydate': 'stat_date',
  'clklog.sourcesite_detail_bydate': 'stat_date',
  'clklog.user_pv_bydate': 'stat_date',
  'clklog.user_visit_bydate': 'stat_date',
  'clklog.user_visittime_bydate': 'stat_date',
  'clklog.visitor_detail_bydate': 'stat_date',
  'clklog.visitor_detail_byinfo': 'stat_date',
  'clklog.visitor_detail_bysession': 'stat_date',
  'clklog.visitor_life_bydate': 'stat_date',
  'clklog.visitor_summary_byvisitor': 'stat_date',
  'clklog.visituri_detail_bydate': 'stat_date',
  'clklog.visituri_summary_bydate': 'stat_date',
};

/**
 * 分区候选校验（纯函数，供执行前二次校验）：
 * ① 格式 ^\d{6}$（toYYYYMM 命名）；② 非当前月（正在写入）。
 * 返回被拒分区与原因，执行时只放行通过者。
 */
export function filterDropCandidates(
  partitions: string[],
  currentMonth: string,
): { accepted: string[]; rejected: Array<{ partition: string; reason: string }> } {
  const accepted: string[] = [];
  const rejected: Array<{ partition: string; reason: string }> = [];
  for (const p of partitions) {
    if (!/^\d{6}$/.test(p)) {
      rejected.push({ partition: p, reason: '分区名非 YYYYMM 格式' });
    } else if (p === currentMonth) {
      rejected.push({ partition: p, reason: '当前月分区正在写入，禁止删除' });
    } else if (p > currentMonth) {
      rejected.push({ partition: p, reason: '未来分区' });
    } else {
      accepted.push(p);
    }
  }
  return { accepted, rejected };
}

@Injectable()
export class DataMgmtService {
  private readonly logger = new Logger(DataMgmtService.name);

  constructor(
    private readonly clickHouse: ClickHouseService,
    private readonly prisma: PrismaService,
    // 缺省构造兜底纯单测；生产由 DI 注入
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
    // 对拍结论（健康卡片 / 清理前置）——运维页与质量页同源
    private readonly quality: QualityService = undefined as unknown as QualityService,
    // 保留策略 / 前置对拍 / 清理登记（R2）
    private readonly retention: RetentionService = undefined as unknown as RetentionService,
  ) {}

  /** 存储概览：各表行数/字节/分区/最近写入 + TTL 盘点 */
  async overview(): Promise<{ tables: TableInventory[]; generated_at: string }> {
    const dbs = INVENTORED_DATABASES.map((d) => `'${d}'`).join(',');
    // 一次查询聚合 parts + 关联 tables 的 TTL（engine_full 含 TTL 表达式）
    const rows = await this.clickHouse.queryReconcile<{
      tname: string;
      rows: string;
      compressed: string;
      total: string;
      partitions: string;
      last_write: string | null;
      engine_full: string;
    }>(
      // ⚠️ 别名避开 table 关键字（CH 23.2 HTTP 裸 SQL 下 `AS table` 会解析出空结果）
      `SELECT t.database || '.' || t.name AS tname,
              coalesce(p.rows, 0) AS rows,
              coalesce(p.compressed, 0) AS compressed,
              coalesce(p.total, 0) AS total,
              coalesce(p.partitions, 0) AS partitions,
              p.last_write,
              t.engine_full
       FROM system.tables t
       LEFT JOIN (
         SELECT database, table, sum(rows) AS rows, sum(data_compressed_bytes) AS compressed,
                sum(bytes) AS total, uniq(partition) AS partitions, max(modification_time) AS last_write
         FROM system.parts WHERE active GROUP BY database, table
       ) p ON p.database = t.database AND p.table = t.name
       WHERE t.database IN (${dbs}) AND t.engine IN ('MergeTree','ReplacingMergeTree','SummingMergeTree','AggregatingMergeTree','CollapsingMergeTree','VersionedCollapsingMergeTree')
       ORDER BY compressed DESC`,
      undefined,
      { readonly: true, maxExecutionTime: 60, maxMemoryUsage: 1_000_000_000, maxThreads: 2 },
    );

    const tables: TableInventory[] = rows.map((r) => ({
      table: r.tname,
      rows: parseInt(r.rows, 10),
      compressed_bytes: parseInt(r.compressed, 10),
      total_bytes: parseInt(r.total, 10),
      partitions: parseInt(r.partitions, 10),
      last_write_at: r.last_write ? this.parseChIso(r.last_write) : null,
      ttl_days: parseTtlDays(r.engine_full),
      engine: r.engine_full.split(' ')[0] ?? 'MergeTree',
    }));
    return { tables, generated_at: new Date().toISOString() };
  }

  /** 表级存储趋势（hostMetricSample 的 table:* 采样，小时粒度） */
  async trend(hours: number) {
    const h = Math.min(24 * 90, Math.max(1, hours));
    const since = new Date(Date.now() - h * 3_600_000);
    const samples = await this.prisma.hostMetricSample.findMany({
      where: { metric_key: { startsWith: 'table:' }, sampled_at: { gte: since } },
      orderBy: { sampled_at: 'asc' },
    });
    // 按表分组：{ 'clklog_sa.sa_events': { rows: [...], bytes: [...] } }
    const byTable = new Map<string, { rows: Array<[string, number]>; bytes: Array<[string, number]> }>();
    for (const s of samples) {
      const m = /^table:(.+):(rows|bytes)$/.exec(s.metric_key);
      if (!m) continue;
      const entry = byTable.get(m[1]) ?? { rows: [], bytes: [] };
      entry[m[2] === 'rows' ? 'rows' : 'bytes'].push([s.sampled_at.toISOString(), s.value]);
      byTable.set(m[1], entry);
    }
    return { hours: h, series: Object.fromEntries(byTable), sampled_points: samples.length };
  }

  /** 清理预演：列出将被 DROP PARTITION 影响的分区（只读，不执行） */
  async previewCleanup(table: string, olderThanDays: number): Promise<CleanupPreview> {
    const allowed = (await this.overview()).tables.map((t) => t.table);
    if (!allowed.includes(table)) {
      throw badRequest({
        code: 'ops.dataMgmt.tableNotInventoried',
        messageKey: 'ops:error.dataMgmt.tableNotInventoried',
        params: { allowed: allowed.join(', ') },
        message: `表不在盘点范围（允许：${allowed.join(', ')}）`,
      });
    }
    const [db, tbl] = table.split('.');
    if (!db || !tbl) {
      throw badRequest({
        code: 'ops.dataMgmt.tableNameInvalid',
        messageKey: 'ops:error.dataMgmt.tableNameInvalid',
        message: '表名格式须为 db.table',
      });
    }
    const days = Math.min(3650, Math.max(1, olderThanDays));
    // 数据管理口径统一为平台日历（ZQ-3：原 UTC 月/日在临界窗口会判错保护月）
    const cutoffDate = ymdInTz(this.timezones.platformTz, Date.now() - days * 86_400_000);
    const cutoffMonth = cutoffDate.slice(0, 7).replace('-', ''); // 分区命名 toYYYYMM(stat_date)

    const rows = await this.clickHouse.queryReconcile<{
      partition: string;
      rows: string;
      compressed: string;
    }>(
      `SELECT partition, sum(rows) AS rows, sum(data_compressed_bytes) AS compressed
       FROM system.parts
       WHERE active AND database = {db: String} AND table = {tbl: String}
       GROUP BY partition ORDER BY partition`,
      { db, tbl },
      RECONCILE_GUARDS,
    );

    // 保留月分区命名（toYYYYMM）；早于 cutoff 月的分区即候选。
    // 当月分区永不入选（正在写入），即使其名小于 cutoff。
    const currentMonth = todayInTz(this.timezones.platformTz).slice(0, 7).replace('-', '');
    const monthly = rows.filter((r) => /^\d{6}$/.test(r.partition));
    const partitions = rows
      .filter((r) => r.partition < cutoffMonth && r.partition !== currentMonth && /^\d{6}$/.test(r.partition))
      .map((r) => ({
        partition: r.partition,
        rows: parseInt(r.rows, 10),
        compressed_bytes: parseInt(r.compressed, 10),
      }));

    // 按日分区的表（如 clklog.log_analysis：PARTITION BY stat_date）在月分区清理里恒为空 ——
    // 必须说明原因，否则用户会把「工具不支持」误读成「没东西可清」（验收 B4）
    const note =
      monthly.length === 0 && rows.length > 0
        ? `该表按日分区（${rows.length} 个分区，如 ${rows[0].partition}），分区清理仅支持按月分区（YYYYMM）；请用「TTL 设置」管理保留期`
        : undefined;

    // 前置对拍（R2-3）：把「能不能清」提前到预演阶段展示，避免点了执行才被拒
    const requiredTo = partitions.length > 0 ? monthRange(partitions[partitions.length - 1].partition).to : cutoffDate;
    const preflight = await this.preflightOrNull(requiredTo);

    return {
      table,
      older_than_days: days,
      cutoff: cutoffDate,
      partitions,
      total_rows: partitions.reduce((s, p) => s + p.rows, 0),
      total_compressed_bytes: partitions.reduce((s, p) => s + p.compressed_bytes, 0),
      action: 'DROP PARTITION',
      note,
      preflight,
    };
  }

  /** 前置对拍：不可用时返回 null（预演是只读查询，不该因快照缺失而整体失败） */
  private async preflightOrNull(requiredTo: string): Promise<PreflightResult | null> {
    try {
      return await this.retention.preflight(requiredTo);
    } catch (e) {
      this.logger.warn(`前置对拍查询失败: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** 前置对拍：不通过即拒绝（错误码带原因，前端按 key 渲染） */
  private async assertPreflight(requiredTo: string, requireCoverage = true): Promise<PreflightResult> {
    const result = await this.retention.preflight(requiredTo, undefined, { requireCoverage });
    if (result.ok) return result;
    throw badRequest({
      code: `ops.dataMgmt.preflight.${result.reason}`,
      messageKey: `ops:error.dataMgmt.preflight`,
      params: {
        reason: result.reason,
        required_to: requiredTo,
        snapshot_range: result.range ? `${result.range.from} ~ ${result.range.to}` : '-',
        age_hours: result.age_hours ?? '-',
        max_age_hours: result.max_age_hours,
      },
      message: `清理前需先通过对拍（覆盖 ${requiredTo}）；当前快照状态：${result.reason}`,
    });
  }

  /** 对拍快照：最新一条 */
  /**
   * 数据运维页「健康」= 对拍结论（与质量页**同源同新鲜度**，含 stale_level）。
   * 直接委托 QualityService：两处各写一遍必然出现「一边显示过期、一边显示正常」。
   */
  async latestSnapshot(project: string) {
    return this.quality.latestSnapshot(project);
  }

  // ---------- V1.1 清理执行（动作类：预演已做 + 二次确认 + 审计）----------

  /**
   * 执行 DROP PARTITION。
   * 防线：① 表白名单；② confirmed_table 必须与表名一致（前端输入表名）；
   * ③ 分区候选二次校验（格式/非当月/非未来）；④ 分区清单须与预演一致（重放保护）；
   * ⑤ 逐分区执行，失败即停；⑥ 全程审计。
   */
  async executeDropPartitions(input: {
    table: string;
    partitions: string[];
    confirmed_table: string;
    dry_run_snapshot: unknown;
    operator: string;
  }): Promise<{ done: string[]; failed: Array<{ partition: string; error: string }>; rejected: Array<{ partition: string; reason: string }> }> {
    const { table, confirmed_table: confirmed, operator } = input;
    if (confirmed !== table) {
      throw badRequest({
        code: 'ops.dataMgmt.tableConfirmMismatch',
        messageKey: 'ops:error.dataMgmt.tableConfirmMismatch',
        params: { confirmed, table },
        message: `确认表名不匹配：输入 "${confirmed}" ≠ 目标 "${table}"`,
      });
    }
    const allowed = (await this.overview()).tables.map((t) => t.table);
    if (!allowed.includes(table)) {
      throw badRequest({
        code: 'ops.dataMgmt.tableNotInventoried',
        messageKey: 'ops:error.dataMgmt.tableNotInventoried',
        params: { allowed: allowed.join(', ') },
        message: `表不在盘点范围（允许：${allowed.join(', ')}）`,
      });
    }
    const [db, tbl] = table.split('.');
    if (!db || !tbl) {
      throw badRequest({
        code: 'ops.dataMgmt.tableNameInvalid',
        messageKey: 'ops:error.dataMgmt.tableNameInvalid',
        message: '表名格式须为 db.table',
      });
    }

    const currentMonth = todayInTz(this.timezones.platformTz).slice(0, 7).replace('-', '');
    const { accepted, rejected } = filterDropCandidates(input.partitions, currentMonth);
    if (!accepted.length) {
      const rejectedText = rejected.map((r) => `${r.partition}:${r.reason}`).join('; ') || '清单为空';
      throw badRequest({
        code: 'ops.dataMgmt.noExecutablePartition',
        messageKey: 'ops:error.dataMgmt.noExecutablePartition',
        params: { rejected: rejectedText },
        message: `无可执行分区（全部被拒：${rejectedText}）`,
      });
    }

    // 前置对拍（R2-3）：被清理数据里最新的一天必须落在**通过且未过期**的快照区间内，
    // 否则拒绝执行 —— 没验证过就删，等于放弃「丢数据」的唯一旁证。
    const newestPartition = accepted.reduce((a, b) => (b > a ? b : a));
    const preflight = await this.assertPreflight(monthRange(newestPartition).to);

    // 审计先落一行 running 再执行 DDL（验收 B7）：DDL 可能耗时很久，
    // 若事后才补记，客户端断开/进程重启会让「变更已发生但无留痕」——红线 6 不允许。
    const audit = await this.prisma.opsActionLog.create({
      data: {
        action: 'drop_partition',
        target_table: table,
        detail: { partitions: accepted, done: [], failed: [], preflight: preflight.reason } as object,
        dry_run_snapshot: input.dry_run_snapshot as object,
        status: 'running',
        operator,
      },
    });

    const done: string[] = [];
    const failed: Array<{ partition: string; error: string }> = [];
    for (const p of accepted) {
      try {
        // 分区名已严格校验为纯数字（^\d{6}$），拼接无注入面
        await this.clickHouse.command(`ALTER TABLE ${db}.${tbl} DROP PARTITION '${p}'`);
        done.push(p);
      } catch (e) {
        failed.push({ partition: p, error: e instanceof Error ? e.message : String(e) });
        break; // 失败即停，剩余分区留在原处（下次预演重盘）
      }
    }

    // 已清理区间登记（R2-4）：按「月分区 → 该月首末日」逐条登记，对拍据此跳过而非告警
    if (done.length > 0) {
      for (const partition of done) {
        const range = monthRange(partition);
        await this.retention
          .recordLedger({
            target_db: db,
            target_table: tbl,
            scope_type: 'partition',
            range_from: range.from,
            range_to: range.to,
            action: 'drop_partition',
            detail: { partition },
            snapshot_id: preflight?.snapshot_id ?? null,
            operator,
          })
          .catch((e) =>
            this.logger.warn(`清理登记失败(${partition}): ${e instanceof Error ? e.message : String(e)}`),
          );
      }
    }

    const status = failed.length ? (done.length ? 'partial' : 'failed') : 'done';
    try {
      await this.prisma.opsActionLog.update({
        where: { id: audit.id },
        data: { detail: { partitions: accepted, done, failed } as object, status, error: failed[0]?.error ?? null },
      });
    } catch (e) {
      this.logger.warn(`审计更新失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { done, failed, rejected };
  }

  /** 设置 TTL（MODIFY TTL）：白名单表 + 时间列映射 + 确认 + 审计 */
  async executeSetTtl(input: {
    table: string;
    days: number;
    confirmed_table: string;
    operator: string;
  }): Promise<{ table: string; ttl_days: number; time_column: string }> {
    const { table, confirmed_table: confirmed, operator } = input;
    if (confirmed !== table) {
      throw badRequest({
        code: 'ops.dataMgmt.tableConfirmMismatch',
        messageKey: 'ops:error.dataMgmt.tableConfirmMismatch',
        params: { confirmed, table },
        message: `确认表名不匹配：输入 "${confirmed}" ≠ 目标 "${table}"`,
      });
    }
    const timeColumn = TTL_TIME_COLUMN[table];
    if (!timeColumn) {
      const allowedColumns = Object.keys(TTL_TIME_COLUMN).join(', ');
      throw badRequest({
        code: 'ops.dataMgmt.ttlTimeColumnMissing',
        messageKey: 'ops:error.dataMgmt.ttlTimeColumnMissing',
        params: { allowed: allowedColumns },
        message: `表未登记 TTL 时间列（允许：${allowedColumns}）`,
      });
    }
    const days = Math.floor(input.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw badRequest({
        code: 'ops.dataMgmt.ttlDaysInvalid',
        messageKey: 'ops:error.dataMgmt.ttlDaysInvalid',
        message: 'TTL 天数须为 1-3650 的整数',
      });
    }
    const [db, tbl] = table.split('.');
    if (!db || !tbl) {
      throw badRequest({
        code: 'ops.dataMgmt.tableNameInvalid',
        messageKey: 'ops:error.dataMgmt.tableNameInvalid',
        message: '表名格式须为 db.table',
      });
    }

    // 前置对拍（R2-3）：TTL 会在后续 merge 中删掉「保留截止日」之前的数据 ——
    // 截止日必须已被通过的对拍覆盖，否则等于删掉未被验证过的数据。
    const cutoff = ymdInTz(this.timezones.platformTz, Date.now() - days * 86_400_000);
    // TTL 不要求覆盖截止日（见 RetentionService.preflight 的注释：那种边界永远覆盖不到）
    const preflight = await this.assertPreflight(cutoff, false);

    // 审计先落 running（验收 B7）：MODIFY TTL 可能长时间不返回；事后补记会丢留痕
    const audit = await this.prisma.opsActionLog.create({
      data: {
        action: 'set_ttl',
        target_table: table,
        detail: { ttl_days: days, time_column: timeColumn, status: 'running', preflight: preflight.reason } as object,
        status: 'running',
        operator,
      },
    });

    // 整数已校验，拼接无注入面。
    // ⚠️ materialize_ttl_after_modify=0（验收 B5）：默认值 1 会让 CH 对**既有数据**执行
    // MATERIALIZE TTL —— 亿级表上实测调用 >120s 不返回、且重写全部 part。置 0 后只改元数据，
    // 过期数据在后续 merge 中逐步清理（保留期语义不变，只是不立即重写历史 part）。
    try {
      await this.clickHouse.command(
        `ALTER TABLE ${db}.${tbl} MODIFY TTL ${timeColumn} + INTERVAL ${days} DAY`,
        undefined,
        { settings: { materialize_ttl_after_modify: 0 } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.prisma.opsActionLog
        .update({ where: { id: audit.id }, data: { status: 'failed', error: msg.slice(0, 500) } })
        .catch(() => undefined);
      throw badRequest({
        code: 'ops.dataMgmt.ttlSetFailed',
        messageKey: 'ops:error.dataMgmt.ttlSetFailed',
        params: { message: msg.slice(0, 300) },
        message: `TTL 设置失败：${msg.slice(0, 300)}`,
      });
    }
    await this.prisma.opsActionLog
      .update({ where: { id: audit.id }, data: { status: 'done' } })
      .catch(() => undefined);

    // 已清理区间登记（R2-4）：TTL 覆盖「开天辟地 ~ 截止日」；对拍据此跳过这段时间
    await this.retention
      .recordLedger({
        target_db: db,
        target_table: tbl,
        scope_type: 'ttl',
        range_from: '1970-01-01',
        range_to: cutoff,
        action: 'set_ttl',
        detail: { ttl_days: days, time_column: timeColumn },
        snapshot_id: preflight.snapshot_id,
        operator,
      })
      .catch((e) => this.logger.warn(`TTL 清理登记失败: ${e instanceof Error ? e.message : String(e)}`));

    return { table, ttl_days: days, time_column: timeColumn };
  }

  /** 保留策略总览（R2-1）：预期（登记） × 实际（TTL） × 状态 × 对拍可信区间 */
  async retentionOverview(): Promise<RetentionOverview> {
    const inventory = await this.overview();
    return this.retention.overview(inventory);
  }

  /** 登记预期保留（R2-1）：审计 retention_policy_update */
  async upsertRetentionPolicy(
    input: { db: string; table: string; keep_days: number; mode?: string; enabled?: boolean; remark?: string | null },
    operator: string,
  ) {
    const inventory = await this.overview();
    const allowed = inventory.tables
      .filter((t) => t.table === SA_EVENTS_TABLE || t.table.startsWith(`${COMMUNITY_DB}.`))
      .map((t) => t.table);
    const saved = await this.retention.upsertPolicy(input, operator, allowed);
    await this.prisma.opsActionLog
      .create({
        data: {
          action: 'retention_policy_update',
          target_table: `${input.db}.${input.table}`,
          detail: {
            keep_days: input.keep_days,
            mode: saved.mode,
            enabled: saved.enabled,
            remark: input.remark ?? null,
          } as object,
          status: 'done',
          operator,
        },
      })
      .catch((e) => this.logger.warn(`保留策略审计写入失败: ${e instanceof Error ? e.message : String(e)}`));
    return saved;
  }

  /** 审计记录（最近优先） */
  async listActions(table: string | undefined, limit: number) {
    const l = Math.min(100, Math.max(1, limit));
    const rows = await this.prisma.opsActionLog.findMany({
      where: {
        ...(table ? { target_table: table } : {}),
        // 共用本表但不属于数据运维清理动作的审计在此排除：
        // 告警配置（alerting-v3，alert_ 前缀）、账号域（account-lifecycle-v1，auth_ 前缀）
        AND: [{ action: { not: { startsWith: 'alert_' } } }, { action: { not: { startsWith: 'auth_' } } }],
      },
      orderBy: { created_at: 'desc' },
      take: l,
    });
    return rows.map((row) => ({
      id: String(row.id),
      action: row.action,
      target_table: row.target_table,
      detail: row.detail,
      dry_run_snapshot: row.dry_run_snapshot,
      status: row.status,
      error: row.error,
      operator: row.operator,
      created_at: row.created_at.toISOString(),
    }));
  }

  /** mutation 进度（ALTER TTL/DELETE 后台任务） */
  async mutationStatus(table: string) {
    const [db, tbl] = table.split('.');
    if (!db || !tbl) {
      throw badRequest({
        code: 'ops.dataMgmt.tableNameInvalid',
        messageKey: 'ops:error.dataMgmt.tableNameInvalid',
        message: '表名格式须为 db.table',
      });
    }
    const rows = await this.clickHouse.queryReconcile<{
      command: string;
      is_done: string;
      latest_fail_reason: string | null;
      create_time: string;
    }>(
      `SELECT command, is_done, latest_fail_reason, create_time
       FROM system.mutations
       WHERE database = {db: String} AND table = {tbl: String} AND NOT is_done
       ORDER BY create_time DESC LIMIT 10`,
      { db, tbl },
      { readonly: true, maxExecutionTime: 30 },
    );
    return {
      running: rows.map((r) => ({
        command: r.command,
        created_at: this.parseChIso(r.create_time),
        latest_fail_reason: r.latest_fail_reason,
      })),
    };
  }

  /** CH 服务端墙钟 → UTC ISO（显式平台时区解析；ZQ-4 修正，原 `+Z` 拼接） */
  private parseChIso(text: string): string | null {
    const ms = parseChDateTimeInTz(text, this.timezones.platformTz);
    return ms === null ? null : new Date(ms).toISOString();
  }
}

