/**
 * 保留策略纯函数（phase: clklog-data-quality-ops-v1，R2）。
 *
 * 无 DI、无 IO：ops 域（数据管理/保留策略）与 meta 域（对拍可信区间）共用同一套口径，
 * 避免「一处认为可对比、另一处认为不可对比」。跨域只允许依赖本文件这类纯函数，
 * 不允许 meta → ops 的服务依赖（会成环）。
 */

/** 解析 TTL 保留天数（`engine_full`），无 TTL 返回 null */
/**
 * 从 engine_full 解析 TTL 保留天数。
 *
 * 兼容 ClickHouse 的几种写法（生产 sa_events 实际是 `toIntervalMonth(18)`，
 * 旧实现只认 `INTERVAL 'N' DAY`，导致概览把已有 TTL 显示为「无」——验收 B2）：
 *   - `TTL col + TO INTERVAL '180' DAY` / `+ INTERVAL 180 DAY`
 *   - `TTL col + toIntervalDay(180)`
 *   - `TTL col + toIntervalMonth(18)` → 按 30 天/月折算（近似值，仅用于展示）
 */
export function parseTtlDays(engineFull: string): number | null {
  const day = /\+\s*(?:TO\s+)?INTERVAL\s+'?(\d+)'?\s+DAY/i.exec(engineFull);
  if (day) return parseInt(day[1], 10);
  const toDay = /\+\s*toIntervalDay\((\d+)\)/i.exec(engineFull);
  if (toDay) return parseInt(toDay[1], 10);
  const toMonth = /\+\s*toIntervalMonth\((\d+)\)/i.exec(engineFull);
  if (toMonth) return parseInt(toMonth[1], 10) * 30;
  return null;
}

/** 对拍归属项目（与告警域一致：单项目部署） */
export const DEFAULT_PROJECT = 'clklogapp';

/** sa 侧（旁路分析库）事件表 */
export const SA_EVENTS_TABLE = 'clklog_sa.sa_events';
/** 社区版库名（raw 侧） */
export const COMMUNITY_DB = 'clklog';

export interface RetentionTableInput {
  table: string;
  /** 实际 TTL 天数（system.tables.engine_full 解析结果；null = 未设置） */
  ttl_days: number | null;
}

export interface RetentionFloor {
  /** 两侧保留期的较小者（天）；两侧都未设置 = null（不限，回到数据实际范围） */
  days: number | null;
  sa_days: number | null;
  raw_days: number | null;
  /** 限制可比范围的表（用于解释「为什么只比到某天」） */
  bound_by: string | null;
}

/**
 * 对拍可信区间的地板：**物理保留期**取小。
 *
 * - sa 侧 = `clklog_sa.sa_events` 的 TTL；
 * - raw 侧 = `clklog.*` 各表 TTL 的最小值（含 18 张聚合表：任一表被 TTL/清理都会让
 *   那段时间的对照失真，取最小才安全）；
 * - 未设置 TTL 视为「不限」（数据一直在，可对比范围不受其限制）。
 *
 * 只认**实际生效**的 TTL，不把「已登记的预期策略」当地板：预期是目标，不是现状；
 * 用预期当地板会把还能对比的日期误标成「超保留期不比对」。
 */
export function computeRetentionFloor(tables: RetentionTableInput[]): RetentionFloor {
  const sa = tables.find((t) => t.table === SA_EVENTS_TABLE);
  const rawTables = tables.filter((t) => t.table.startsWith(`${COMMUNITY_DB}.`));
  const saDays = sa?.ttl_days ?? null;
  let rawDays: number | null = null;
  let rawBound: string | null = null;
  for (const t of rawTables) {
    if (t.ttl_days === null) continue;
    if (rawDays === null || t.ttl_days < rawDays) {
      rawDays = t.ttl_days;
      rawBound = t.table;
    }
  }
  const candidates: Array<{ days: number; table: string }> = [];
  if (saDays !== null) candidates.push({ days: saDays, table: SA_EVENTS_TABLE });
  if (rawDays !== null) candidates.push({ days: rawDays, table: rawBound ?? COMMUNITY_DB });
  if (candidates.length === 0) return { days: null, sa_days: null, raw_days: null, bound_by: null };
  const min = candidates.reduce((a, b) => (b.days < a.days ? b : a));
  return { days: min.days, sa_days: saDays, raw_days: rawDays, bound_by: min.table };
}

/** 月分区名（YYYYMM）→ 该月首日与末日（YYYY-MM-DD） */
export function monthRange(partition: string): { from: string; to: string } {
  const year = parseInt(partition.slice(0, 4), 10);
  const month = parseInt(partition.slice(4, 6), 10);
  const last = new Date(Date.UTC(year, month, 0));
  return {
    from: `${partition.slice(0, 4)}-${partition.slice(4, 6)}-01`,
    to: last.toISOString().slice(0, 10),
  };
}

/** 平台日历：`YYYY-MM-DD` 加/减天数（纯字符串运算，避免时区二次换算） */
export function shiftYmd(ymd: string, days: number): string {
  const ms = Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 可疑分区判定：未来分区 / 明显早于保留期的历史脏数据（2019、2023 这类测试日期） */
export function isSuspiciousPartition(
  partition: string,
  currentMonth: string,
  retentionFloorMonth: string | null,
): 'future' | 'ancient' | null {
  if (!/^\d{6}$/.test(partition)) return null;
  if (partition > currentMonth) return 'future';
  if (retentionFloorMonth && partition < retentionFloorMonth) return 'ancient';
  return null;
}
