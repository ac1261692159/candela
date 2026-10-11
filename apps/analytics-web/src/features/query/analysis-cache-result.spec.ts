import { describe, expect, it } from 'vitest';
import { funnelResultFromCache, queryResultFromCache } from './analysis-cache-result';

describe('analysis-cache-result', () => {
  it('hydrates event/retention payloads and rejects SQL or truncated blobs', () => {
    const ok = queryResultFromCache({
      columns: [{ key: 'm_0', title: '总次数', unit: 'number' }],
      rows: [{ m_0: 12 }],
      elapsed_ms: 9,
      sql: 'SELECT 1',
    });
    expect(ok?.from_cache).toBe(true);
    expect(ok?.columns[0]).toEqual({ key: 'm_0', title: '总次数', unit: 'number' });
    expect(queryResultFromCache({ columns: [{ name: 'day', type: 'Date' }], rows: [] })).toBeNull();
    expect(queryResultFromCache({ reason: 'cache_too_large', columns: [], rows: [] })).toBeNull();
  });

  it('keeps funnel steps with the query payload', () => {
    const ok = funnelResultFromCache({
      columns: [{ key: 'step_1', title: '浏览' }],
      rows: [{ step_1: 10 }],
      steps: [{ key: 'step_1', title: '浏览' }, { key: 2 }],
      elapsed_ms: 4,
    });
    expect(ok?.steps).toEqual([{ key: 'step_1', title: '浏览' }]);
    expect(ok?.from_cache).toBe(true);
  });
});
