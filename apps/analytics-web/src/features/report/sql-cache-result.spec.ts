import { describe, expect, it } from 'vitest';
import { CHART_CONFIG_SCHEMA_VERSION, CHART_RECOMMENDATION_VERSION } from '../visualization/chart.constants';
import type { ChartConfigV1 } from '../visualization/chart.types';
import { placeholderSqlResult, sqlResultFromCache } from './sql-cache-result';

const config: ChartConfigV1 = {
  schema_version: CHART_CONFIG_SCHEMA_VERSION,
  recommendation_version: CHART_RECOMMENDATION_VERSION,
  mode: 'manual',
  preferred_view: 'chart',
  chart_type: 'line',
  roles: { d: 'time', 收入金额: 'metric' },
  bindings: { x: 'd', metrics: ['收入金额'], ignored: [] },
  options: {
    orientation: 'vertical',
    donut: false,
    include_other: false,
    units: { 收入金额: 'currency_cny' },
    aggregation: {},
  },
};

describe('sql-cache-result', () => {
  it('hydrates a SQL execute payload and ignores truncated cache blobs', () => {
    const ok = sqlResultFromCache({
      query_id: 'q1',
      columns: [{ name: 'd', type: 'Date' }, { name: '收入金额', type: 'Float64' }],
      rows: [{ d: '2026-09-01', 收入金额: 12 }],
      row_count: 1,
      truncated: false,
      elapsed_ms: 9,
      read_rows: 10,
      read_bytes: 20,
    });
    expect(ok?.from_cache).toBe(true);
    expect(ok?.rows).toHaveLength(1);
    expect(sqlResultFromCache({ reason: 'cache_too_large', columns: [], rows: [] })).toBeNull();
    expect(sqlResultFromCache({ columns: [{ key: 'm_0', title: 'DAU' }], rows: [] })).toBeNull();
  });

  it('builds placeholder columns from saved chart roles', () => {
    const placeholder = placeholderSqlResult(config);
    expect(placeholder.query_id).toBe('card-placeholder');
    expect(placeholder.columns.map((column) => column.name)).toEqual(['d', '收入金额']);
    expect(placeholder.rows).toEqual([]);
  });
});
