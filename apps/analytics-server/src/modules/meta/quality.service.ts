import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ClickHouseService, RECONCILE_MAX_EXECUTION_TIME } from '../shared/clickhouse.service';
import { PrismaService } from '../shared/prisma.service';
import { appConfig } from '../../config/configuration';
import { badRequest } from '../../i18n/domain-error';
import { computeRetentionFloor, parseTtlDays, shiftYmd } from '../ops/retention-policy';
import { todayInTz } from '../time/calendar';
import { TimezoneService } from '../time/timezone.service';

export interface ReconcileQuery {
  project: string;
  from?: string;
  to?: string;
  /** 偏差阈值（比例，如 0.1=10%）——legacy 参数，等价于 threshold_pct=10 */
  threshold?: number;
  /** 偏差阈值（**百分比**，单一语义；不传则取配置） */
  threshold_pct?: number;
  /** auto=定时 / manual=页面手点 / cli=运维脚本 */
  trigger?: 'auto' | 'manual' | 'cli';
}

/** 每日对拍行（status=skipped 为已清理、out_of_retention 为超保留期，两者都不参与告警） */
export interface ReconcileDailyRow {
  date: string;
  sa_cnt: number;
  sa_uniq: number;
  raw_cnt: number;
  deviation_pct: number;
  status: 'ok' | 'ALERT' | 'skipped' | 'out_of_retention';
  skipped_reason?: string;
  skipped_source?: string;
}

export interface ReconcileConfigView {
  enabled: boolean;
  run_at: string;
  threshold_pct: number;
  ignore_events: string[];
  skip_empty_event: boolean;
  stale_warn_hours: number;
  stale_error_hours: number;
  updated_by: string;
  updated_at: string | null;
}

/** 缺省配置：与线上现状一致（阈值 10%），口径对齐后再降（PRD R3-3） */
const DEFAULT_RECONCILE_CONFIG: ReconcileConfigView = {
  enabled: true,
  run_at: '03:30',
  threshold_pct: 10,
  ignore_events: [],
  skip_empty_event: true,
  stale_warn_hours: 24,
  stale_error_hours: 72,
  updated_by: 'system',
  updated_at: null,
};

/** 配置缓存时长：定时/手动对拍会连续多次读配置，避免每次都查库 */
const CONFIG_CACHE_MS = 30_000;

/**
 * 对拍查询统一使用 RECONCILE_MAX_EXECUTION_TIME（600s，见 clickhouse.service）。
 * - max_memory_usage 4GB：超限抛错拒绝该查询（CH 端保护），而非 OOM 拖垮
 *   整个实例——单机 CH 容器 12GiB memcg 两次被对拍扫描打挂后的兜底。
 * - max_threads 2：CH 默认按核数并行聚合，每个线程各持一份局部聚合哈希，
 *   内存按核数放大（实测单日 8100 万行 4GB 触顶）；限线程把内存降一个量级。
 */
const RECONCILE_QUERY_OPTIONS = {
  readonly: true,
  maxExecutionTime: RECONCILE_MAX_EXECUTION_TIME,
  maxMemoryUsage: 4_000_000_000,
  maxThreads: 2,
} as const;

/** sa 侧 query() 的对拍选项（走 write 连接，同样限时限内存限线程） */
const RECONCILE_SA_OPTIONS = {
  maxExecutionTime: RECONCILE_MAX_EXECUTION_TIME,
  maxMemoryUsage: 4_000_000_000,
  maxThreads: 2,
} as const;

/**
 * 变化类型 → 前端 i18n 键名（snake_case → camelCase）。
 *
 * 用通用转换而不是枚举表：`meta_discovery_log.change_type` 有 7 种取值
 * （event_created / property_created / property_type_changed /
 * user_property_created / user_property_type_changed / user_property_hidden /
 * user_property_active），枚举表漏一个就会让页面显示成原始 key
 * （2026-10-09 生产实测踩到：`quality.changeType.user_property_type_changed`）。
 * 前端仍按 change_type 白名单翻译，未知类型显示原始标识而不是 key。
 */
function changeKeyOf(changeType: string): string {
  return changeType.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

interface SaDaily {
  d: string;
  sa_cnt: string;
  sa_uniq: string;
}

interface RawDaily {
  d: string;
  raw_cnt: string;
}

interface CrcResult {
  total: string;
  uniq: string;
}

/**
 * 数据一致性对拍服务。
 *
 * 对比 clklog_sa.sa_events（旁路分析库）与 clklog.log_analysis（社区版）的数据一致性，
 * 用于发现 ingestor 静默丢数据/停转/重复。只读，不写任何库表。
 *
 * 对拍 SQL 契约见 docs/architecture/clklog-analytics-design-data-governance.md §4。
 * - sa_events 侧强制 project_name 过滤（红线）。
 * - log_analysis 侧走 queryReconcile 只读跨库查询（社区版无 project_name 列）。
 */
@Injectable()
export class QualityService {
  private readonly logger = new Logger(QualityService.name);
  /** legacy：比例语义的默认阈值（10%），新代码统一用 threshold_pct */
  private static readonly DEFAULT_THRESHOLD = 0.1;
  private configCache: { at: number; value: ReconcileConfigView } | null = null;

  constructor(
    private readonly clickHouse: ClickHouseService,
    private readonly prisma: PrismaService,
    // 缺省构造兜底纯单测；生产由 DI 注入
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
  ) {}

  /** 对拍配置（缺行返回默认值，不写库） */
  async configView(): Promise<ReconcileConfigView> {
    const row = await this.prisma.opsReconcileConfig.findFirst({ orderBy: { id: 'asc' } });
    if (!row) return DEFAULT_RECONCILE_CONFIG;
    return {
      enabled: row.enabled,
      run_at: row.run_at,
      threshold_pct: row.threshold_pct,
      ignore_events: Array.isArray(row.ignore_events) ? (row.ignore_events as string[]) : [],
      skip_empty_event: row.skip_empty_event,
      stale_warn_hours: row.stale_warn_hours,
      stale_error_hours: row.stale_error_hours,
      updated_by: row.updated_by,
      updated_at: row.updated_at.toISOString(),
    };
  }

  /** 保存对拍配置（校验 + 审计）；只覆盖显式传入的字段 */
  async saveConfig(patch: Partial<ReconcileConfigView>, operator: string): Promise<ReconcileConfigView> {
    const current = await this.configView();
    const next: ReconcileConfigView = { ...current, ...patch, updated_by: operator };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.run_at)) {
      throw badRequest({
        code: 'ops.reconcile.runAtInvalid',
        messageKey: 'ops:error.reconcile.runAtInvalid',
        message: '执行时刻格式应为 HH:mm（平台时区）',
      });
    }
    if (!Number.isFinite(next.threshold_pct) || next.threshold_pct < 0 || next.threshold_pct > 100) {
      throw badRequest({
        code: 'ops.reconcile.thresholdInvalid',
        messageKey: 'ops:error.reconcile.thresholdInvalid',
        message: '偏差阈值须为 0~100 的百分比',
      });
    }
    if (next.stale_error_hours <= next.stale_warn_hours) {
      throw badRequest({
        code: 'ops.reconcile.staleOrderInvalid',
        messageKey: 'ops:error.reconcile.staleOrderInvalid',
        message: '过期（红）阈值必须大于（黄）阈值',
      });
    }
    if (![next.stale_warn_hours, next.stale_error_hours].every((h) => Number.isInteger(h) && h >= 1 && h <= 24 * 30)) {
      throw badRequest({
        code: 'ops.reconcile.staleHoursInvalid',
        messageKey: 'ops:error.reconcile.staleHoursInvalid',
        message: '过期阈值须为 1~720 的整数小时',
      });
    }
    const ignore = next.ignore_events.map((v) => String(v).trim()).filter(Boolean).slice(0, 200);
    await this.prisma.opsReconcileConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        enabled: next.enabled,
        run_at: next.run_at,
        threshold_pct: next.threshold_pct,
        ignore_events: ignore,
        skip_empty_event: next.skip_empty_event,
        stale_warn_hours: next.stale_warn_hours,
        stale_error_hours: next.stale_error_hours,
        updated_by: operator,
      },
      update: {
        enabled: next.enabled,
        run_at: next.run_at,
        threshold_pct: next.threshold_pct,
        ignore_events: ignore,
        skip_empty_event: next.skip_empty_event,
        stale_warn_hours: next.stale_warn_hours,
        stale_error_hours: next.stale_error_hours,
        updated_by: operator,
      },
    });
    this.configCache = null;
    await this.audit('reconcile_config_update', { changes: { threshold_pct: next.threshold_pct, run_at: next.run_at, enabled: next.enabled, ignore_events: ignore.length, skip_empty_event: next.skip_empty_event } }, operator);
    return { ...next, ignore_events: ignore };
  }

  /** 带缓存的有效配置（对拍自身用） */
  private async effectiveConfig(): Promise<ReconcileConfigView> {
    if (this.configCache && Date.now() - this.configCache.at < CONFIG_CACHE_MS) return this.configCache.value;
    const value = await this.configView();
    this.configCache = { at: Date.now(), value };
    return value;
  }

  /** 运维变更审计（对拍域沿用 alert_ 前缀外的独立动作名，进现有变更记录时间线） */
  private async audit(action: string, detail: Record<string, unknown>, operator: string): Promise<void> {
    try {
      await this.prisma.opsActionLog.create({
        data: { action, target_table: 'ops_reconcile_snapshot', detail: detail as object, status: 'done', operator },
      });
    } catch (error) {
      this.logger.warn(`对拍审计写入失败 [${action}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 报告落盘（写不进只记日志，不影响对拍结果） */
  private async writeReport(name: string, text: string): Promise<string | null> {
    const dir = appConfig.reconcile?.reportDir ?? '/data/logs/production/clklog_manager/reconcile';
    try {
      await mkdir(dir, { recursive: true });
      const path = join(dir, name);
      await writeFile(path, text, 'utf8');
      return path;
    } catch (error) {
      this.logger.warn(`对拍报告落盘失败（${dir}）: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 物理保留期（对拍可信区间地板，R2-2/AC-7）。
   *
   * 只认实际生效的 TTL（见 retention-policy.ts 的 computeRetentionFloor 注释）；
   * 缓存 5 分钟：TTL 变更不频繁，而每次对拍都查一遍 system.tables 没必要。
   */
  private floorCache: { at: number; days: number | null } | null = null;

  private async retentionFloorDays(): Promise<number | null> {
    if (this.floorCache && Date.now() - this.floorCache.at < 300_000) return this.floorCache.days;
    let days: number | null = null;
    try {
      const rows = await this.clickHouse.queryReconcile<{ tname: string; engine_full: string }>(
        `SELECT database || '.' || name AS tname, engine_full
         FROM system.tables WHERE database IN ('clklog', 'clklog_sa')`,
        undefined,
        { readonly: true, maxExecutionTime: 30, maxMemoryUsage: 300_000_000, maxThreads: 1 },
      );
      days = computeRetentionFloor(
        rows.map((r) => ({ table: r.tname, ttl_days: parseTtlDays(r.engine_full) })),
      ).days;
    } catch (error) {
      this.logger.warn(`保留期地板查询失败（本次不设地板）: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.floorCache = { at: Date.now(), days };
    return days;
  }

  /**
   * 被跳过的日期（已清理区间）——这些日期不参与告警判定：
   * 清理（DROP PARTITION / TTL）会主动删掉一侧的数据，把它当成「丢数」是假告警。
   */
  private async skippedDates(from: string, to: string): Promise<{ from: string; to: string; reason: string; source: string }[]> {
    const rows = await this.prisma.opsCleanupLedger.findMany({
      where: {
        // 两侧任一被清理，这段时间的「对照」都不成立：sa 少了会误判为丢数，raw 少了会误判为多写
        target_table: { in: ['sa_events', 'clklog_sa.sa_events', 'log_analysis', 'clklog.log_analysis'] },
        range_from: { lte: to },
        range_to: { gte: from },
      },
      orderBy: { executed_at: 'desc' },
      take: 50,
    });
    return rows.map((row) => ({
      from: row.range_from,
      to: row.range_to,
      // 稳定标识，不下发译好的文案（前端按 key 翻译）
      reason: 'cleaned',
      source: `${row.action}@${row.executed_at.toISOString().slice(0, 19)}`,
    }));
  }

  /**
   * 数据一致性对拍报告。
   *
   * ⚠️ 默认与范围上限（2026-09-07 两次 OOM 事故后拍板）：
   * 单机 CH 容器 12GiB memcg，内存常年贴顶运行，5 亿行/天的表上跑
   * 7 天全量扫描是 OOM 诱因（18:58、19:08 两次把 CH 容器打死）。
   * 默认对拍「昨天」单日；显式指定范围时最大 3 天。
   * 大范围对账归数据管理模块的低峰期专项任务（预留）。
   */
  async reconcile(query: ReconcileQuery) {
    const { project } = query;
    const config = await this.effectiveConfig();
    const from = this.normalizeDate(query.from, -1); // 默认昨天（单日）
    const to = this.normalizeDate(query.to, 0); // 默认今天
    // 阈值只有一个语义：**百分比**。legacy 的 threshold 是比例（0.1=10%），只为兼容旧调用保留。
    const thresholdPct = query.threshold_pct ?? (query.threshold !== undefined ? query.threshold * 100 : config.threshold_pct);
    const trigger = query.trigger ?? 'manual';

    const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
    if (spanDays > 3) {
      throw new Error('对拍范围最大 3 天：全量扫描对单机 ClickHouse 内存压力大（历史 OOM 事故），大范围对账请使用低峰期专项任务');
    }

    // 0. 已清理区间（清理过的一侧数据本就没了，不能当成「丢数」）
    const skipped = await this.skippedDates(from, to);

    // 0.1 可信区间地板（R2-2/AC-7）：两侧保留期之外的日期**不比对**，
    // 标注为「超保留期」而不是计成差异——那是数据已被 TTL/清理删掉，不是丢数。
    const floorDays = await this.retentionFloorDays();
    const retentionFloor = floorDays === null ? null : shiftYmd(todayInTz(this.timezones.platformTz), -(floorDays - 1));
    const outOfRetention =
      retentionFloor && from < retentionFloor
        ? { from, to: shiftYmd(retentionFloor, -1) }
        : null;
    const queryFrom = outOfRetention ? retentionFloor! : from;
    // 整个范围都超保留期：没有任何「可比日」，直接跳过三组重查询（不白扫 CH）
    const comparable = queryFrom <= to;

    // 1. 总量对拍（按日）
    const dailyRaw = comparable
      ? await this.reconcileCount(queryFrom, to, thresholdPct, project, config, skipped)
      : { items: [] as ReconcileDailyRow[], has_alert: false };

    // 2. CRC 唯一性
    const crc = comparable
      ? await this.reconcileCrc(queryFrom, to, project, skipped, retentionFloor)
      : { range: { from: to, to }, total: 0, uniq: 0, dup_rows: 0, pass: true, approx: true, skipped: true };

    // 3. 事件级差异（含忽略清单与「仅一侧存在」）
    const events = comparable
      ? await this.reconcileEvent(queryFrom, to, project, config)
      : { sa_events: [], log_analysis: [], diffs: [], diff_total: 0, only_in_one: [], ignored_events: config.ignore_events };

    // 超保留期的日期补成显式行：页面看得到「这几天为什么不比」，而不是静默少几天
    const outRows: ReconcileDailyRow[] = outOfRetention
      ? this.dateSeries(outOfRetention.from, outOfRetention.to).map((date) => ({
          date,
          sa_cnt: 0,
          sa_uniq: 0,
          raw_cnt: 0,
          deviation_pct: 0,
          status: 'out_of_retention',
        }))
      : [];
    const daily = { items: [...outRows, ...dailyRaw.items], has_alert: dailyRaw.has_alert };

    // 4. 近期元数据发现变化（新增事件/属性/类型变更）
    const discoveryLogs = await this.getDiscoveryLog(project, 50);

    const summary = {
      has_alert: daily.has_alert || (!crc.pass && !crc.skipped),
      total_days: daily.items.length,
      alert_days: daily.items.filter((i) => i.status === 'ALERT').length,
      skipped_days: daily.items.filter((i) => i.status === 'skipped').length,
      out_of_retention_days: outRows.length,
      dup_crc_rows: crc.dup_rows,
      crc_pass: crc.pass,
      recent_changes: discoveryLogs.length,
      threshold_pct: thresholdPct,
      ignored_events: config.ignore_events.length,
      skip_empty_event: config.skip_empty_event,
    };

    const reportPath = await this.writeReport(
      `reconcile-${trigger}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`,
      this.renderReport({ project, from, to, trigger, thresholdPct, config, summary, daily, crc, events, skipped, outOfRetention, discoveryLogs }),
    );

    // 快照落库（页面读快照，不重复跑重查询；失败不影响对拍结果返回）
    try {
      await this.prisma.reconcileSnapshot.create({
        data: {
          project_name: project,
          range_from: from,
          range_to: to,
          summary: summary as object,
          daily: daily as object,
          crc: crc as object,
          // 快照只存页面要读的差异（Top 20 + 仅一侧）——两侧全量事件清单太大，
          // 逐日写库会把 ops_reconcile_snapshot 撑成 MB 级 JSON
          events: {
            diffs: events.diffs,
            diff_total: events.diff_total,
            only_in_one: events.only_in_one,
            ignored_events: events.ignored_events,
          } as object,
          skipped: skipped as object,
          threshold_pct: thresholdPct,
          report_path: reportPath,
          trigger,
          discovery_count: discoveryLogs.length,
        },
      });
    } catch (e) {
      this.logger.warn(`对拍快照落库失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 变更记录（红线 6：动作可追溯；与告警变更同一时间线）
    await this.audit(
      'reconcile_run',
      {
        project,
        trigger,
        range: { from, to },
        threshold_pct: thresholdPct,
        has_alert: summary.has_alert,
        alert_days: summary.alert_days,
        skipped_days: summary.skipped_days,
        dup_crc_rows: summary.dup_crc_rows,
        report_path: reportPath,
      },
      trigger === 'auto' ? 'system' : 'operator',
    );

    return {
      range: { from, to },
      threshold_pct: thresholdPct,
      trigger,
      summary,
      daily,
      crc,
      events,
      skipped,
      out_of_retention: outOfRetention,
      retention_days: floorDays,
      discovery_logs: discoveryLogs,
      report_path: reportPath,
    };
  }

  /** [from, to] 的日期序列（含两端） */
  private dateSeries(from: string, to: string): string[] {
    const out: string[] = [];
    for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }

  /** 报告文本（落盘用；页面展示走接口数据） */
  private renderReport(input: {
    project: string;
    from: string;
    to: string;
    trigger: string;
    thresholdPct: number;
    config: ReconcileConfigView;
    summary: Record<string, unknown>;
    daily: { items: { date: string; sa_cnt: number; sa_uniq: number; raw_cnt: number; deviation_pct: number; status: string }[] };
    crc: { range: { from: string; to: string }; total: number; uniq: number; dup_rows: number; pass: boolean; skipped?: boolean };
    events: { diffs: { event: string; sa_cnt: number; raw_cnt: number; diff: number; deviation_pct: number }[]; only_in_one: { event: string; side: string; cnt: number }[] };
    skipped: { from: string; to: string; reason: string; source: string }[];
    outOfRetention: { from: string; to: string } | null;
    discoveryLogs: unknown[];
  }): string {
    const lines: string[] = [];
    // 报告是**机器可读诊断产物**（归档 / grep / 二次解析）：字段名固定英文，不随语言变化；
    // 给人看的结论走通知（按收件人语言）与页面（按查看者语言）。
    lines.push('# clklog reconcile report');
    lines.push(
      `project=${input.project} range=${input.from}..${input.to} trigger=${input.trigger} threshold_pct=${input.thresholdPct}`,
    );
    lines.push(
      `ignore_events=${input.config.ignore_events.length} skip_empty_event=${input.config.skip_empty_event} generated_at=${new Date().toISOString()}`,
    );
    lines.push('');
    lines.push('## daily');
    lines.push('date\tsa_cnt\tsa_uniq\traw_cnt\tdeviation_pct\tstatus');
    for (const item of input.daily.items) {
      lines.push(`${item.date}\t${item.sa_cnt}\t${item.sa_uniq}\t${item.raw_cnt}\t${item.deviation_pct}\t${item.status}`);
    }
    lines.push('');
    lines.push('## event_diffs (sa - raw, top)');
    lines.push('event\tsa_cnt\traw_cnt\tdiff\tdeviation_pct');
    for (const item of input.events.diffs) {
      lines.push(`${item.event}\t${item.sa_cnt}\t${item.raw_cnt}\t${item.diff}\t${item.deviation_pct}`);
    }
    if (input.events.only_in_one.length > 0) {
      lines.push('');
      lines.push('## only_in_one_side');
      for (const item of input.events.only_in_one) lines.push(`${item.event}\t${item.side}\t${item.cnt}`);
    }
    if (input.outOfRetention) {
      lines.push('');
      lines.push(
        `## out_of_retention (not compared) ${input.outOfRetention.from}..${input.outOfRetention.to}`,
      );
    }
    if (input.skipped.length > 0) {
      lines.push('');
      lines.push('## skipped_ranges (cleaned, excluded from alerting)');
      for (const item of input.skipped) lines.push(`${item.from}..${item.to}\t${item.reason}\t${item.source}`);
    }
    lines.push('');
    lines.push(
      `## crc pass=${input.crc.pass}${input.crc.skipped ? ' skipped=true' : ''} range=${input.crc.range.from}..${input.crc.range.to}`,
    );
    lines.push(`crc total=${input.crc.total} uniq=${input.crc.uniq} dup_rows=${input.crc.dup_rows} (approx, tolerance 0.5%)`);
    lines.push('');
    lines.push(
      `## summary has_alert=${Boolean(input.summary.has_alert)} alert_days=${input.summary.alert_days} skipped_days=${input.summary.skipped_days} discovery_changes=${input.discoveryLogs.length}`,
    );
    return `${lines.join('\n')}\n`;
  }

  /**
   * 查询元数据自动发现变化记录（新增事件/属性/类型变更）。
   */
  async getDiscoveryLog(project: string, limit = 50) {
    const rows = await this.prisma.metaDiscoveryLog.findMany({
      where: { project_name: project },
      orderBy: { created_at: 'desc' },
      take: Math.min(200, Math.max(1, limit)),
    });
    return rows.map((r) => ({
      id: r.id,
      event: r.event_key,
      prop: r.prop_key,
      change_type: r.change_type,
      // 只下发稳定 key，文案由前端在渲染边界按查看者语言翻译（i18n 设计 §4 类别 5）
      change_key: changeKeyOf(r.change_type),
      from_value: r.from_value,
      to_value: r.to_value,
      created_at: r.created_at,
    }));
  }

  /**
   * 最近一次对拍快照（质量页与数据运维页「健康」同源，秒开）。
   *
   * 带 `stale_level`：过期结论不能被当现状——>warn 小时变黄、>error 小时变红，
   * 页面据此提示「需重新对拍」而不是继续显示「一致性正常」（PRD R1-2 / AC-2）。
   */
  async latestSnapshot(project: string) {
    const row = await this.prisma.reconcileSnapshot.findFirst({
      where: { project_name: project },
      orderBy: { ran_at: 'desc' },
    });
    if (!row) return null;
    const config = await this.effectiveConfig();
    const ageHours = (Date.now() - row.ran_at.getTime()) / 3_600_000;
    const staleLevel = ageHours > config.stale_error_hours
      ? 'error'
      : ageHours > config.stale_warn_hours
        ? 'warn'
        : 'fresh';
    // 形状与既有快照响应兼容（字段平铺），额外带过期等级供两个页面共用
    return {
      ran_at: row.ran_at.toISOString(),
      range: { from: row.range_from, to: row.range_to },
      summary: row.summary,
      daily: row.daily,
      crc: row.crc,
      events: row.events,
      skipped: row.skipped,
      threshold_pct: row.threshold_pct,
      report_path: row.report_path,
      trigger: row.trigger,
      discovery_count: row.discovery_count,
      stale_level: staleLevel as 'fresh' | 'warn' | 'error',
      age_hours: Math.round(ageHours * 10) / 10,
      stale_warn_hours: config.stale_warn_hours,
      stale_error_hours: config.stale_error_hours,
    };
  }

  /**
   * 数据质量概览（预留扩展，先返回对拍 summary）。
   */
  async report(project: string) {
    const from = this.normalizeDate(undefined, -7);
    const to = this.normalizeDate(undefined, 0);
    const config = await this.effectiveConfig();
    const daily = await this.reconcileCount(from, to, config.threshold_pct, project, config, []);
    return {
      range: { from, to },
      total_events: daily.items.reduce((s, i) => s + (i.sa_cnt || 0), 0),
      invalid_events: daily.items
        .filter((i) => i.status === 'ALERT')
        .reduce((s, i) => s + (i.sa_cnt || 0), 0),
      ...daily,
    };
  }

  // ---------- 内部实现 ----------

  /**
   * 总量对拍（R-1）：按日统计 sa_events vs log_analysis 非空 event 行数。
   */
  private async reconcileCount(
    from: string,
    to: string,
    thresholdPct: number,
    project: string,
    config: ReconcileConfigView,
    skipped: { from: string; to: string; reason: string; source: string }[],
  ) {
    // sa_events 侧：强制 project_name 过滤（红线）
    // ⚠️ uniqCombined(20) 而非 count(DISTINCT)：后者=uniqExact 两阶段聚合，
    // 19:26 事故中在 8100 万行上触发 1GB chunk 分配、4GB 上限拒绝（OSError 前兆）。
    // sa_uniq 为近似值（±0.15%），仅用于展示趋势，精确去重在 reconcileCrc。
    const eventFilter = this.eventFilterSql(config);
    const saSql = `
      SELECT toDate(stat_date) AS d, count() AS sa_cnt, uniqCombined(20)(crc) AS sa_uniq
      FROM clklog_sa.sa_events
      WHERE project_name = {project: String}
        AND stat_date BETWEEN {from: Date} AND {to: Date}
        ${eventFilter}
      GROUP BY d ORDER BY d
    `;
    // log_analysis 侧：社区版全量对照（无 project_name 列），只读跨库。
    // 日期用**表自带的 stat_date**（分区键）而不是 toDate(log_time)：后者是表达式、无法分区剪枝，
    // 单日对拍也要扫全部 90 个日分区（实测两者计数一致，见 quality-ops 调研 §2.1.1）。
    const rawSql = `
      SELECT stat_date AS d, count() AS raw_cnt
      FROM clklog.log_analysis
      WHERE stat_date BETWEEN {from: Date} AND {to: Date}
        ${eventFilter}
      GROUP BY d ORDER BY d
    `;

    const [saRows, rawRows] = await Promise.all([
      this.clickHouse.query<SaDaily>(saSql, { project, from, to }, RECONCILE_SA_OPTIONS),
      this.clickHouse.queryReconcile<RawDaily>(rawSql, { from, to }, RECONCILE_QUERY_OPTIONS),
    ]);

    const rawMap = new Map(rawRows.map((r) => [r.d, parseInt(r.raw_cnt, 10)]));
    const items: ReconcileDailyRow[] = saRows.map((row) => {
      const saCnt = parseInt(row.sa_cnt, 10);
      const saUniq = parseInt(row.sa_uniq, 10);
      const rawCnt = rawMap.get(row.d) ?? 0;
      const dev = this.deviation(saCnt, rawCnt);
      const absDev = Math.abs(dev);
      const skippedHit = skipped.find((range) => range.from <= row.d && row.d <= range.to);
      const status = skippedHit ? 'skipped' : absDev > thresholdPct ? 'ALERT' : 'ok';
      return {
        date: row.d,
        sa_cnt: saCnt,
        sa_uniq: saUniq,
        raw_cnt: rawCnt,
        deviation_pct: Math.round(dev * 100) / 100,
        status,
        // 原因只下发稳定标识（'cleaned'）与来源，文案由前端按查看者语言渲染
        ...(skippedHit ? { skipped_reason: skippedHit.reason, skipped_source: skippedHit.source } : {}),
      };
    });

    // 已跳过（已清理）的日期不参与告警判定
    const hasAlert = items.some((i) => i.status === 'ALERT');
    return { items, has_alert: hasAlert };
  }

  /**
   * CRC 唯一性（R-3）：sa_events 内重复检测。
   *
   * ⚠️ 两个降载决策（2026-09-07 事故后拍板）：
   * 1. 范围固定「to 的前一个完整日」单日——对拍要抓的 ingestor 重复写入
   *    是近期故障，单日足够灵敏（该表排序键以 event 开头，stat_date 过滤
   *    只有月分区剪枝，单日也要扫约 4 亿行）。
   * 2. uniqCombined 近似去重替代 count(DISTINCT)——精确去重（uniqExact）
   *    是 OOM 诱因：18:58 CH 容器（12GiB memcg）在 uniqExact 与后台 Merge
   *    叠加下被 oom-killer 杀掉重启。uniqCombined 内存 MB 级，误差 ~1%，
   *    故障级大规模重复（dup 比例显著）依然能暴露。精确对账归数据管理
   *    模块的低峰期专项任务。
   */
  private async reconcileCrc(
    from: string,
    to: string,
    project: string,
    skipped: { from: string; to: string }[] = [],
    retentionFloor: string | null = null,
  ) {
    void from;
    const d = new Date(Date.parse(to) - 86_400_000).toISOString().slice(0, 10);
    // 该日若已被清理（分区删掉）或超出保留期（数据已被 TTL 删），CRC 检查没有意义也不该告警
    if ((retentionFloor !== null && d < retentionFloor) || skipped.some((range) => range.from <= d && d <= range.to)) {
      return { range: { from: d, to: d }, total: 0, uniq: 0, dup_rows: 0, pass: true, approx: true, skipped: true };
    }
    const sql = `
      SELECT count() AS total, uniqCombined(20)(crc) AS uniq
      FROM clklog_sa.sa_events
      WHERE project_name = {project: String}
        AND stat_date = {d: Date}
    `;
    const rows = await this.clickHouse.query<CrcResult>(sql, { project, d }, RECONCILE_SA_OPTIONS);
    const total = rows.length ? parseInt(rows[0].total, 10) : 0;
    const uniq = rows.length ? parseInt(rows[0].uniq, 10) : 0;
    // HLL 固有误差（实测 2 精度 20 约 ±0.15%）：dup_rows 可能为负，钳 0；
    // 告警带 0.5% 容忍，滤掉近似噪声——ingestor 故障级重复（>5%）远超容忍带
    const dupRows = Math.max(0, total - uniq);
    const tolerance = Math.floor(total * 0.005);
    return {
      range: { from: d, to: d },
      total,
      uniq,
      dup_rows: dupRows,
      pass: dupRows <= tolerance,
      approx: true,
    };
  }

  /**
   * 事件级对拍（R-2）：列出两侧各事件计数。
   */
  private async reconcileEvent(from: string, to: string, project: string, config: ReconcileConfigView) {
    const eventFilter = this.eventFilterSql(config);
    const saSql = `
      SELECT event, count() AS cnt
      FROM clklog_sa.sa_events
      WHERE project_name = {project: String}
        AND stat_date BETWEEN {from: Date} AND {to: Date}
        ${eventFilter}
      GROUP BY event ORDER BY event
    `;
    const rawSql = `
      SELECT event, count() AS cnt
      FROM clklog.log_analysis
      WHERE stat_date BETWEEN {from: Date} AND {to: Date}
        ${eventFilter}
      GROUP BY event ORDER BY event
    `;

    const [saRows, rawRows] = await Promise.all([
      this.clickHouse.query<{ event: string; cnt: string }>(saSql, { project, from, to }, RECONCILE_SA_OPTIONS),
      this.clickHouse.queryReconcile<{ event: string; cnt: string }>(
        rawSql,
        { from, to },
        RECONCILE_QUERY_OPTIONS,
      ),
    ]);

    const saMap = new Map(saRows.map((r) => [r.event, parseInt(r.cnt, 10)]));
    const rawMap = new Map(rawRows.map((r) => [r.event, parseInt(r.cnt, 10)]));
    const allEvents = new Set([...saMap.keys(), ...rawMap.keys()]);
    const diffs: { event: string; sa_cnt: number; raw_cnt: number; diff: number; deviation_pct: number }[] = [];
    const onlyInOne: { event: string; side: string; cnt: number }[] = [];
    for (const event of allEvents) {
      const saCnt = saMap.get(event) ?? 0;
      const rawCnt = rawMap.get(event) ?? 0;
      if (saCnt === 0 || rawCnt === 0) {
        onlyInOne.push({ event, side: saCnt === 0 ? 'log_analysis' : 'sa_events', cnt: saCnt === 0 ? rawCnt : saCnt });
        continue;
      }
      if (saCnt === rawCnt) continue;
      diffs.push({
        event,
        sa_cnt: saCnt,
        raw_cnt: rawCnt,
        diff: saCnt - rawCnt,
        deviation_pct: Math.round(this.deviation(saCnt, rawCnt) * 100) / 100,
      });
    }
    diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    onlyInOne.sort((a, b) => b.cnt - a.cnt);

    return {
      sa_events: saRows.map((r) => ({ event: r.event, cnt: parseInt(r.cnt, 10) })),
      log_analysis: rawRows.map((r) => ({ event: r.event, cnt: parseInt(r.cnt, 10) })),
      // 事件级差异进快照，页面直读（PRD AC-11）：Top 20 与「仅一侧存在」
      diffs: diffs.slice(0, 20),
      diff_total: diffs.length,
      only_in_one: onlyInOne.slice(0, 20),
      ignored_events: config.ignore_events,
    };
  }

  /**
   * 两侧**同一套**事件过滤：空 event 与忽略清单都要对称应用。
   * 现状（R1 前）raw 侧过滤空 event、sa 侧不过滤，低量日会放大成假告警（调研 §2.5）。
   */
  private eventFilterSql(config: ReconcileConfigView): string {
    const parts: string[] = [];
    if (config.skip_empty_event) parts.push("event != ''");
    if (config.ignore_events.length > 0) {
      const list = config.ignore_events.map((name) => `'${String(name).replace(/'/g, "''")}'`).join(', ');
      parts.push(`event NOT IN (${list})`);
    }
    return parts.map((part) => `AND ${part}`).join('\n        ');
  }

  private deviation(sa: number, raw: number): number {
    if (raw === 0) return sa === 0 ? 0 : 999;
    return ((sa - raw) / raw) * 100;
  }

  private normalizeDate(value: string | undefined, dayOffset: number): string {
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    // 默认对拍日按平台日历（ZQ 清零：原 setDate/toISOString 混合实为 UTC 日）
    return todayInTz(this.timezones.platformTz, new Date(Date.now() + dayOffset * 86_400_000));
  }
}
