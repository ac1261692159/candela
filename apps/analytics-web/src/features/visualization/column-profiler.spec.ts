import { describe, expect, it } from 'vitest';
import { aggregateAliasesFromSql, classifyBaseType, parseStrictNumber, parseStrictTime, profileColumns, unwrapClickHouseType } from './column-profiler';
import { fxCountryCount, fxDayEventCount, fxErrorCode, fxOsUniq, fxUnsafeAndNull } from './chart.fixtures';

describe('column-profiler', () => {
  it('unwraps ClickHouse wrapper types', () => {
    expect(unwrapClickHouseType('Nullable(LowCardinality(DateTime))')).toBe('DateTime');
    expect(unwrapClickHouseType('SimpleAggregateFunction(sum, UInt64)')).toBe('UInt64');
    expect(classifyBaseType('Nullable(Date)')).toBe('time');
    expect(classifyBaseType('UInt8')).toBe('number');
  });

  it('parses dates strictly and rejects loose strings', () => {
    expect(parseStrictTime('2026-09-01')).not.toBeNull();
    expect(parseStrictTime('2026-09-01 12:00:00')).not.toBeNull();
    expect(parseStrictTime('09/01/2026')).toBeNull();
    expect(parseStrictTime('yesterday')).toBeNull();
  });

  it('rejects loose numeric conversion and unsafe integers', () => {
    expect(parseStrictNumber('12abc')).toBeNull();
    expect(parseStrictNumber('9007199254740993')).toBe('unsafe');
    expect(parseStrictNumber('12.50')).toBe(12.5);
    expect(parseStrictNumber(null)).toBeNull();
  });

  it('treats numeric IDs as dimensions, not metrics', () => {
    const profiles = profileColumns(fxErrorCode.columns, fxErrorCode.rows);
    expect(profiles.find((item) => item.key === 'error_code')?.role).toBe('dimension');
    expect(profiles.find((item) => item.key === '次数')?.role).toBe('metric');
  });

  it('uses builder and alias evidence for time and metrics', () => {
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows, {
      builderDsl: { groups: [{ kind: 'time', granularity: 'day' }], metrics: [{ fn: 'count' }] },
    });
    expect(profiles[0]).toMatchObject({ role: 'time', confidence: 'certain' });
    expect(profiles[1]).toMatchObject({ role: 'metric', confidence: 'certain' });
  });

  it('marks Chinese/English metrics and keeps NULL counts', () => {
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
    expect(profiles[1].nullCount).toBe(1);
    expect(profiles[1].metric?.aggregation).toBe('additive');
    const os = profileColumns(fxOsUniq.columns, fxOsUniq.rows);
    expect(os[1].metric?.aggregation).toBe('non_additive');
  });

  it('treats the default SQL alias 事件量 as an additive metric', () => {
    const profiles = profileColumns([{ name: '事件量', type: 'UInt64' }], [{ 事件量: 100 }]);
    expect(profiles[0]).toMatchObject({ role: 'metric', confidence: 'probable' });
    expect(profiles[0].metric?.aggregation).toBe('additive');
  });

  it('keeps recharge UV as a count unit, not currency', () => {
    const profiles = profileColumns(
      [
        { name: '点击充值UV', type: 'UInt64' },
        { name: '充值金额', type: 'Float64' },
      ],
      [{ 点击充值UV: 19, 充值金额: 12.5 }],
    );
    expect(profiles[0].metric?.unit).toBe('number');
    expect(profiles[1].metric?.unit).toBe('currency');
  });

  it('does not treat sample-all-digits as the only metric evidence', () => {
    const profiles = profileColumns(fxCountryCount.columns, fxCountryCount.rows);
    expect(profiles[0].role).toBe('dimension');
  });

  it('flags unsafe integers as invalid for plotting', () => {
    const profiles = profileColumns(fxUnsafeAndNull.columns, fxUnsafeAndNull.rows);
    const big = profiles.find((item) => item.key === 'big_id');
    expect(big?.reasons).toContain('unsafe_integer');
  });

  it('extracts aggregate aliases from SQL, ignoring subqueries and plain aliases', () => {
    const sql = `-- 注释
SELECT
    toDate(log_time) AS d,
    uniqExact(distinct_id) AS \`DAU\`,
    uniqExactIf(distinct_id, JSONExtractString(properties, '$is_first_day') = 'true') AS \`DNU\`,
    count() AS 总次数,
    event AS 事件
FROM clklog_sa.sa_events
WHERE event = (SELECT event FROM t LIMIT 1)
GROUP BY d`;
    const aliases = aggregateAliasesFromSql(sql);
    expect(aliases.has('DAU')).toBe(true);
    expect(aliases.has('DNU')).toBe(true);
    expect(aliases.has('总次数')).toBe(true);
    expect(aliases.has('d')).toBe(false);
    expect(aliases.has('事件')).toBe(false);
  });

  it('classifies non-name numeric columns as metrics when the SQL proves aggregation', () => {
    const columns = [
      { name: 'd', type: 'Date' },
      { name: 'DAU', type: 'UInt64' },
    ];
    const rows = [
      { d: '2026-09-02', DAU: 6889 },
      { d: '2026-09-03', DAU: 7513 },
    ];
    const sql = "SELECT toDate(log_time) AS d, uniqExact(distinct_id) AS `DAU` FROM clklog_sa.sa_events GROUP BY d ORDER BY d";
    const withSql = profileColumns(columns, rows, { sql });
    expect(withSql.find((item) => item.key === 'DAU')).toMatchObject({ role: 'metric', confidence: 'certain' });
    expect(withSql.find((item) => item.key === 'DAU')?.reasons).toContain('sql_aggregate_alias');
    const withoutSql = profileColumns(columns, rows);
    expect(withoutSql.find((item) => item.key === 'DAU')).toMatchObject({ role: 'pending', confidence: 'pending' });
  });
});
