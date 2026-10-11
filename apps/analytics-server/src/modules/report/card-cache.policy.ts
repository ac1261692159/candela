/** 卡片缓存与后台温热规则（纯函数，worker / refresh 共用）。 */

export const CACHE_MAX_BYTES = 512 * 1024;
export const WORKER_INTERVAL_MS = 30_000;
export const WORKER_CONCURRENCY = 2;
export const DEFAULT_CACHE_TTL_SEC = 300;

/**
 * 刷新失败退避（2026-09 缺陷修复）。
 *
 * 之前失败不写缓存，`refreshed_at` 不前进，卡片在每个 30s 周期都被判为需刷新，
 * 于是必然超时的查询被无限高频重试（线上累计 22537 次 Timeout）。
 * 退避让持续失败的卡片让出有限的并发槽。
 */
export const WORKER_FAIL_BACKOFF_BASE_MS = 5 * 60_000;
export const WORKER_FAIL_BACKOFF_MAX_MS = 30 * 60_000;

/** 第 n 次（n>=1）连续失败后的等待时长：base * 2^(n-1)，封顶 max。 */
export function failBackoffMs(failCount: number): number {
  if (!Number.isFinite(failCount) || failCount <= 0) return 0;
  const exp = Math.min(failCount - 1, 20); // 防指数溢出
  return Math.min(WORKER_FAIL_BACKOFF_BASE_MS * 2 ** exp, WORKER_FAIL_BACKOFF_MAX_MS);
}

/** 连续失败 failCount 次后，自 failedAt 起下次可重试的时间戳（ms）。 */
export function nextRetryAt(failedAt: number, failCount: number): number {
  return failedAt + failBackoffMs(failCount);
}

const QUERY_TYPES = new Set(['sql', 'event', 'funnel', 'retention', 'metric']);

export function isQueryCardType(type: string): boolean {
  return QUERY_TYPES.has(type);
}

export function minDashboardTtl(ttls: number[]): number {
  if (ttls.length === 0) return DEFAULT_CACHE_TTL_SEC;
  return Math.min(...ttls);
}

export function cacheIsStale(refreshedAt: Date | string, ttlSec: number, now = Date.now()): boolean {
  return now - new Date(refreshedAt).getTime() > ttlSec * 1000;
}

export function shouldWorkerRefresh(input: {
  type: string;
  dashboardTtls: number[];
  refreshedAt: Date | string | null;
  now?: number;
}): boolean {
  if (!isQueryCardType(input.type)) return false;
  if (input.dashboardTtls.length === 0) return false;
  if (!input.refreshedAt) return true;
  return cacheIsStale(input.refreshedAt, minDashboardTtl(input.dashboardTtls), input.now);
}

export function serializeCacheResult(result: unknown): {
  json: string;
  rowCount: number;
  truncated: boolean;
} {
  const json = JSON.stringify(result ?? null);
  const bytes = Buffer.byteLength(json, 'utf8');
  const rowCount = rowsOf(result);
  if (bytes <= CACHE_MAX_BYTES) {
    return { json, rowCount, truncated: false };
  }
  return {
    json: JSON.stringify({ truncated: true, reason: 'cache_too_large', columns: [], rows: [] }),
    rowCount: 0,
    truncated: true,
  };
}

/**
 * 列表用缓存摘要（2026-09）。
 *
 * 卡片列表一次可能返回大量卡片，不能搬运 `result_json`（LongText），
 * 因此只透出「有无缓存 / 是否过期 / 上次刷新时间 / 最近一次错误」。
 * 过期判定与后台温热一致：取引用看板中最小的 TTL（无引用时用默认值）。
 */
export function summarizeCache(
  cache: { error: string | null; refreshed_at: Date } | null | undefined,
  dashboardTtls: number[],
) {
  if (!cache) return { has_cache: false, stale: true, refreshed_at: null, error: null };
  return {
    has_cache: true,
    stale: cacheIsStale(cache.refreshed_at, minDashboardTtl(dashboardTtls)),
    refreshed_at: cache.refreshed_at.toISOString(),
    error: cache.error,
  };
}

export function parseStoredCache(
  cache: {
    result_json: string | null;
    error: string | null;
    row_count: number;
    refreshed_at: Date;
  } | null | undefined,
  ttlSec = DEFAULT_CACHE_TTL_SEC,
) {
  if (!cache) return null;
  let result: unknown = null;
  if (cache.result_json) {
    try {
      result = JSON.parse(cache.result_json);
    } catch {
      result = null;
    }
  }
  return {
    result,
    error: cache.error,
    row_count: cache.row_count,
    refreshed_at: cache.refreshed_at.toISOString(),
    stale: cacheIsStale(cache.refreshed_at, ttlSec),
  };
}

function rowsOf(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows.length : 0;
}
