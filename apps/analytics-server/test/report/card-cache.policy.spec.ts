import {
  cacheIsStale,
  failBackoffMs,
  isQueryCardType,
  nextRetryAt,
  serializeCacheResult,
  shouldWorkerRefresh,
  CACHE_MAX_BYTES,
  WORKER_FAIL_BACKOFF_BASE_MS,
  WORKER_FAIL_BACKOFF_MAX_MS,
} from '../../src/modules/report/card-cache.policy';

describe('card-cache.policy', () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z');

  it('过期当 age > ttl', () => {
    expect(cacheIsStale(new Date(now - 301_000), 300, now)).toBe(true);
    expect(cacheIsStale(new Date(now - 299_000), 300, now)).toBe(false);
  });

  it('指标卡（metric）参与后台刷新（v3：漏了它指标卡放到看板也永不刷新）', () => {
    expect(isQueryCardType('metric')).toBe(true);
    expect(shouldWorkerRefresh({ type: 'metric', dashboardTtls: [60], refreshedAt: null })).toBe(true);
  });

  it('worker 跳过 text / 未引用', () => {
    const fresh = new Date(now - 1000);
    expect(shouldWorkerRefresh({ type: 'text', dashboardTtls: [30], refreshedAt: null, now })).toBe(false);
    expect(shouldWorkerRefresh({ type: 'retention', dashboardTtls: [30], refreshedAt: null, now })).toBe(true);
    expect(shouldWorkerRefresh({ type: 'sql', dashboardTtls: [], refreshedAt: null, now })).toBe(false);
    expect(shouldWorkerRefresh({ type: 'sql', dashboardTtls: [300], refreshedAt: fresh, now })).toBe(false);
  });

  it('多看板取最短 TTL', () => {
    const age = new Date(now - 45_000);
    expect(shouldWorkerRefresh({ type: 'event', dashboardTtls: [300, 30], refreshedAt: age, now })).toBe(true);
    expect(shouldWorkerRefresh({ type: 'event', dashboardTtls: [300, 60], refreshedAt: age, now })).toBe(false);
  });

  it('无缓存则刷新', () => {
    expect(shouldWorkerRefresh({ type: 'funnel', dashboardTtls: [300], refreshedAt: null, now })).toBe(true);
  });

  it('超 512KB 截断', () => {
    const fat = { rows: [ { blob: 'x'.repeat(CACHE_MAX_BYTES) } ] };
    const ser = serializeCacheResult(fat);
    expect(ser.truncated).toBe(true);
    expect(JSON.parse(ser.json).reason).toBe('cache_too_large');
    expect(serializeCacheResult({ rows: [{ n: 1 }] }).truncated).toBe(false);
  });

  describe('刷新失败退避（AC6）', () => {
    it('未失败不等待', () => {
      expect(failBackoffMs(0)).toBe(0);
      expect(failBackoffMs(-1)).toBe(0);
      expect(failBackoffMs(Number.NaN)).toBe(0);
    });

    it('首次失败等待 base，之后指数增长', () => {
      expect(failBackoffMs(1)).toBe(WORKER_FAIL_BACKOFF_BASE_MS);
      expect(failBackoffMs(2)).toBe(WORKER_FAIL_BACKOFF_BASE_MS * 2);
      expect(failBackoffMs(3)).toBe(WORKER_FAIL_BACKOFF_BASE_MS * 4);
    });

    it('退避封顶，不随失败次数无限增长', () => {
      expect(failBackoffMs(10)).toBe(WORKER_FAIL_BACKOFF_MAX_MS);
      expect(failBackoffMs(1000)).toBe(WORKER_FAIL_BACKOFF_MAX_MS);
    });

    it('nextRetryAt = 失败时刻 + 退避时长', () => {
      const failedAt = Date.parse('2026-09-07T12:00:00.000Z');
      expect(nextRetryAt(failedAt, 1)).toBe(failedAt + WORKER_FAIL_BACKOFF_BASE_MS);
      expect(nextRetryAt(failedAt, 99)).toBe(failedAt + WORKER_FAIL_BACKOFF_MAX_MS);
    });

    it('退避明显长于扫描间隔，避免高频重试', () => {
      expect(WORKER_FAIL_BACKOFF_BASE_MS).toBeGreaterThan(30_000);
    });
  });
});
