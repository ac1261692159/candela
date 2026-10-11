import { Injectable, Logger } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import { ClickHouseService } from '../shared/clickhouse.service';
import { PrismaService } from '../shared/prisma.service';
import { todayInTz } from '../time/calendar';
import { TimezoneService } from '../time/timezone.service';
import {
  COMMUNITY_DB,
  computeRetentionFloor,
  DEFAULT_PROJECT,
  parseTtlDays,
  SA_EVENTS_TABLE,
  shiftYmd,
  type RetentionFloor,
} from './retention-policy';

/** 默认预期保留：sa 侧事件表与线上现状一致（18 个月）；社区版库表建议 180 天（R2-5 逐个确认） */
export const DEFAULT_SA_KEEP_DAYS = 540;
export const DEFAULT_RAW_KEEP_DAYS = 180;

/** 清理前置对拍的最大快照年龄（PRD R2-3：默认 7 天） */
export const PREFLIGHT_MAX_AGE_HOURS = 24 * 7;

export type RetentionStatus = 'ok' | 'unset' | 'deviates' | 'disabled';

export interface RetentionRow {
  table: string;
  /** 预期保留天数（登记策略优先，缺省用默认建议值） */
  expected_days: number;
  /** 是否已登记策略（未登记 = 用默认建议值展示，落库需人工确认） */
  registered: boolean;
  mode: string;
  enabled: boolean;
  remark: string | null;
  updated_by: string | null;
  updated_at: string | null;
  /** 实际 TTL 天数（null = 表上未设置 TTL） */
  actual_ttl_days: number | null;
  status: RetentionStatus;
  rows: number;
  compressed_bytes: number;
  partitions: number;
}

export interface TrustedRange {
  /** 可信起点（含）；null = 两侧都未设置保留期，不设地板 */
  from: string | null;
  to: string;
  retention_days: number | null;
  sa_days: number | null;
  raw_days: number | null;
  bound_by: string | null;
}

export interface RetentionOverview {
  rows: RetentionRow[];
  trusted_range: TrustedRange;
  summary: {
    total: number;
    unset: number;
    deviates: number;
    /** 社区版中未设置 TTL 的表数（AC-6：必须能标出「未设置（风险）」） */
    raw_unset: number;
    suspicious_partitions: Array<{ table: string; partition: string; kind: 'future' | 'ancient'; rows: number }>;
  };
}

export interface PreflightResult {
  ok: boolean;
  reason: 'ok' | 'no_snapshot' | 'not_covered' | 'snapshot_failed' | 'snapshot_stale';
  /** 被清理窗口是否落在对拍可信区间内（是 → 必须由通过快照覆盖；否 → 只需最近通过快照） */
  coverage_required: boolean;
  snapshot_id: string | null;
  ran_at: string | null;
  range: { from: string; to: string } | null;
  has_alert: boolean | null;
  age_hours: number | null;
  max_age_hours: number;
  /** 前置要求的覆盖点（被清理数据里最新的一天） */
  required_to: string;
}

interface PolicyRow {
  target_db: string;
  target_table: string;
  keep_days: number;
  mode: string;
  enabled: boolean;
  remark: string | null;
  updated_by: string;
  updated_at: Date;
}

/**
 * 保留策略登记 + 清理前置对拍 + 清理区间登记（phase: clklog-data-quality-ops-v1，R2）。
 *
 * 三件事必须同源，否则会出现「清理了却在对拍里报丢数」：
 * 1. 预期保留（登记表） × 实际保留（TTL/分区） → 总览与可信区间；
 * 2. 清理前必须有**覆盖该范围且通过**的对拍快照（默认 7 天内）；
 * 3. 清理成功后把「已清理区间」登记进 `ops_cleanup_ledger`，对拍据此跳过而不是告警。
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clickHouse: ClickHouseService,
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
  ) {}

  /** 已登记策略（key = db.table） */
  private async policies(): Promise<Map<string, PolicyRow>> {
    const rows = (await this.prisma.opsRetentionPolicy.findMany()) as unknown as PolicyRow[];
    return new Map(rows.map((r) => [`${r.target_db}.${r.target_table}`, r]));
  }

  /** 默认预期保留（未登记时用于展示，不落库） */
  private defaultKeepDays(table: string): number {
    return table === SA_EVENTS_TABLE ? DEFAULT_SA_KEEP_DAYS : DEFAULT_RAW_KEEP_DAYS;
  }

  /**
   * 保留策略总览（PRD R2-1）：
   * 预期（登记/默认建议） × 实际（表上 TTL） × 状态 × 对拍可信区间（物理保留期取小）。
   */
  async overview(inventory: { tables: Array<{ table: string; ttl_days: number | null; rows: number; compressed_bytes: number; partitions: number }> }): Promise<RetentionOverview> {
    const policies = await this.policies();
    const candidates = inventory.tables.filter(
      (t) => t.table === SA_EVENTS_TABLE || t.table.startsWith(`${COMMUNITY_DB}.`),
    );
    const rows: RetentionRow[] = candidates.map((t) => {
      const policy = policies.get(t.table);
      const expected = policy?.keep_days ?? this.defaultKeepDays(t.table);
      const actual = t.ttl_days;
      const tolerance = Math.max(1, Math.round(expected * 0.1));
      const status: RetentionStatus =
        actual === null
          ? 'unset'
          : policy && !policy.enabled
            ? 'disabled'
            : Math.abs(actual - expected) > tolerance
              ? 'deviates'
              : 'ok';
      return {
        table: t.table,
        expected_days: expected,
        registered: Boolean(policy),
        mode: policy?.mode ?? 'ttl',
        enabled: policy?.enabled ?? true,
        remark: policy?.remark ?? null,
        updated_by: policy?.updated_by ?? null,
        updated_at: policy?.updated_at ? policy.updated_at.toISOString() : null,
        actual_ttl_days: actual,
        status,
        rows: t.rows,
        compressed_bytes: t.compressed_bytes,
        partitions: t.partitions,
      };
    });

    const floor: RetentionFloor = computeRetentionFloor(
      rows.map((r) => ({ table: r.table, ttl_days: r.actual_ttl_days })),
    );
    const today = todayInTz(this.timezones.platformTz);
    const trustedTo = shiftYmd(today, -1); // 只承诺「完整日」
    const trustedFrom = floor.days === null ? null : shiftYmd(trustedTo, -(floor.days - 1));

    return {
      rows,
      trusted_range: {
        from: trustedFrom,
        to: trustedTo,
        retention_days: floor.days,
        sa_days: floor.sa_days,
        raw_days: floor.raw_days,
        bound_by: floor.bound_by,
      },
      summary: {
        total: rows.length,
        unset: rows.filter((r) => r.status === 'unset').length,
        deviates: rows.filter((r) => r.status === 'deviates').length,
        raw_unset: rows.filter((r) => r.table.startsWith(`${COMMUNITY_DB}.`) && r.status === 'unset').length,
        suspicious_partitions: await this.suspiciousPartitions(trustedFrom),
      },
    };
  }

  /** 可疑日期分区（R2-6）：未来分区 / 早于可信区间下限的历史脏数据；默认只提示不删 */
  private async suspiciousPartitions(
    trustedFrom: string | null,
  ): Promise<Array<{ table: string; partition: string; kind: 'future' | 'ancient'; rows: number }>> {
    const currentMonth = todayInTz(this.timezones.platformTz).slice(0, 7).replace('-', '');
    const floorMonth = trustedFrom ? trustedFrom.slice(0, 7).replace('-', '') : null;
    try {
      // 只读、有界：仅 system.parts 元数据（不扫数据）
      const parts = await this.clickHouse.queryReconcile<{ tname: string; partition: string; rows: string }>(
        `SELECT database || '.' || table AS tname, partition, sum(rows) AS rows
         FROM system.parts
         WHERE active AND database IN ('${COMMUNITY_DB}', 'clklog_sa')
         GROUP BY tname, partition
         ORDER BY partition`,
        undefined,
        { readonly: true, maxExecutionTime: 30, maxMemoryUsage: 500_000_000, maxThreads: 1 },
      );
      const out: Array<{ table: string; partition: string; kind: 'future' | 'ancient'; rows: number }> = [];
      for (const p of parts) {
        if (!/^\d{6}$/.test(p.partition)) continue;
        const rows = parseInt(p.rows, 10);
        if (p.partition > currentMonth) out.push({ table: p.tname, partition: p.partition, kind: 'future', rows });
        else if (floorMonth && p.partition < floorMonth) {
          out.push({ table: p.tname, partition: p.partition, kind: 'ancient', rows });
        }
      }
      return out.slice(0, 50);
    } catch (error) {
      this.logger.warn(`可疑分区盘点失败: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** system.parts 月分区清单（只读、有界） */

  /** 登记/更新预期保留（审计由调用方写 action=retention_policy_update） */
  async upsertPolicy(
    input: { db: string; table: string; keep_days: number; mode?: string; enabled?: boolean; remark?: string | null },
    operator: string,
    allowedTables: string[],
  ): Promise<RetentionRow> {
    const full = `${input.db}.${input.table}`;
    if (!allowedTables.includes(full)) {
      throw badRequest({
        code: 'ops.retention.tableNotInventoried',
        messageKey: 'ops:error.retention.tableNotInventoried',
        params: { allowed: allowedTables.join(', ') },
        message: `表不在保留策略范围（允许：${allowedTables.join(', ')}）`,
      });
    }
    const keepDays = Math.floor(input.keep_days);
    if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > 3650) {
      throw badRequest({
        code: 'ops.retention.keepDaysInvalid',
        messageKey: 'ops:error.retention.keepDaysInvalid',
        message: '保留天数须为 1-3650 的整数',
      });
    }
    const mode = input.mode === 'partition' ? 'partition' : 'ttl';
    const saved = (await this.prisma.opsRetentionPolicy.upsert({
      where: { target_db_target_table: { target_db: input.db, target_table: input.table } },
      create: {
        target_db: input.db,
        target_table: input.table,
        keep_days: keepDays,
        mode,
        enabled: input.enabled ?? true,
        remark: input.remark ?? null,
        updated_by: operator,
      },
      update: {
        keep_days: keepDays,
        mode,
        enabled: input.enabled ?? true,
        remark: input.remark ?? null,
        updated_by: operator,
      },
    })) as unknown as PolicyRow;
    return {
      table: full,
      expected_days: saved.keep_days,
      registered: true,
      mode: saved.mode,
      enabled: saved.enabled,
      remark: saved.remark,
      updated_by: saved.updated_by,
      updated_at: saved.updated_at.toISOString(),
      actual_ttl_days: null,
      status: saved.enabled ? 'ok' : 'disabled',
      rows: 0,
      compressed_bytes: 0,
      partitions: 0,
    };
  }

  /** 对拍可信区间下限（物理保留期取小；缓存 5 分钟） */
  private floorCache: { at: number; days: number | null } | null = null;

  async trustedFrom(): Promise<string | null> {
    if (this.floorCache && Date.now() - this.floorCache.at < 300_000) {
      const days = this.floorCache.days;
      return days === null ? null : shiftYmd(todayInTz(this.timezones.platformTz), -(days - 1));
    }
    let days: number | null = null;
    try {
      const rows = await this.clickHouse.queryReconcile<{ tname: string; engine_full: string }>(
        `SELECT database || '.' || name AS tname, engine_full
         FROM system.tables WHERE database IN ('${COMMUNITY_DB}', 'clklog_sa')`,
        undefined,
        { readonly: true, maxExecutionTime: 30, maxMemoryUsage: 300_000_000, maxThreads: 1 },
      );
      days = computeRetentionFloor(rows.map((r) => ({ table: r.tname, ttl_days: parseTtlDays(r.engine_full) }))).days;
    } catch (error) {
      this.logger.warn(`可信区间下限查询失败（本次不要求覆盖）: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.floorCache = { at: Date.now(), days };
    return days === null ? null : shiftYmd(todayInTz(this.timezones.platformTz), -(days - 1));
  }

  /**
   * 清理前置对拍（PRD R2-3）。
   *
   * `required_to` = 本次动作影响的最新一天（DROP 取月分区末日；TTL 取保留截止日）。
   * 覆盖要求分两种（否则旧分区永远清不掉——对拍单次上限 3 天，不可能覆盖几个月前的区间）：
   * - 被清理窗口**落在对拍可信区间内**（还在可对比范围）→ 必须存在**覆盖 required_to**、通过、
   *   且不过期的快照：删的这段时间能对得上，才允许删。
   * - 被清理窗口**已超出物理保留期**（本来就不可比，数据会被 TTL 带走的那些）→ 只要求存在
   *   通过且不过期的**近期**快照：证明链路当前健康、不是边写边删。
   */
  async preflight(
    requiredTo: string,
    project: string = DEFAULT_PROJECT,
    options: { requireCoverage?: boolean } = {},
  ): Promise<PreflightResult> {
    const floorFrom = await this.trustedFrom();
    // DROP PARTITION：立刻删掉一个具体窗口 → 窗口在可比范围内就必须被通过快照覆盖。
    // SET TTL（requireCoverage=false）：只改保留策略，删除是后续 merge 逐步发生的，
    //   而且被删的窗口按定义就是「比新保留期更老」的数据 —— 那个边界日永远不可能被
    //   近期快照覆盖（对拍单次上限 3 天）。此时要求「近期通过快照」即可，
    //   它证明链路当前健康、不是边写边删。
    const coverageRequired =
      options.requireCoverage === false ? false : floorFrom === null || requiredTo >= floorFrom;
    const base = { snapshot_id: null, ran_at: null, range: null, has_alert: null, age_hours: null, max_age_hours: PREFLIGHT_MAX_AGE_HOURS, required_to: requiredTo, coverage_required: coverageRequired };
    const latest = await this.prisma.reconcileSnapshot.findFirst({
      where: { project_name: project },
      orderBy: { ran_at: 'desc' },
    });
    if (!latest) return { ok: false, reason: 'no_snapshot', ...base };
    const range = { from: latest.range_from, to: latest.range_to };
    const hasAlert = Boolean((latest.summary as { has_alert?: boolean } | null)?.has_alert);
    const ageHours = Math.round(((Date.now() - latest.ran_at.getTime()) / 3_600_000) * 10) / 10;
    const common = {
      snapshot_id: String(latest.id),
      coverage_required: coverageRequired,
      ran_at: latest.ran_at.toISOString(),
      range,
      has_alert: hasAlert,
      age_hours: ageHours,
      max_age_hours: PREFLIGHT_MAX_AGE_HOURS,
      required_to: requiredTo,
    };
    if (coverageRequired && !(range.from <= requiredTo && requiredTo <= range.to)) {
      return { ok: false, reason: 'not_covered', ...common };
    }
    if (hasAlert) return { ok: false, reason: 'snapshot_failed', ...common };
    if (ageHours > PREFLIGHT_MAX_AGE_HOURS) return { ok: false, reason: 'snapshot_stale', ...common };
    return { ok: true, reason: 'ok', ...common };
  }

  /** 已清理区间登记（PRD R2-4）：对拍据此把这段时间标「已清理」而不是告警 */
  async recordLedger(input: {
    target_db: string;
    target_table: string;
    // rows = 定点删除（ALTER DELETE）影响的日期区间（phase: clklog-data-management-v1.2）
    scope_type: 'partition' | 'ttl' | 'dir_log' | 'rows';
    range_from: string;
    range_to: string;
    action: string;
    detail?: Record<string, unknown>;
    snapshot_id?: string | null;
    operator: string;
  }): Promise<string> {
    const row = await this.prisma.opsCleanupLedger.create({
      data: {
        target_db: input.target_db,
        target_table: input.target_table,
        scope_type: input.scope_type,
        range_from: input.range_from,
        range_to: input.range_to,
        action: input.action,
        detail: (input.detail ?? {}) as object,
        snapshot_id: input.snapshot_id && /^\d+$/.test(input.snapshot_id) ? BigInt(input.snapshot_id) : null,
        operator: input.operator,
      },
    });
    return String(row.id);
  }
}
