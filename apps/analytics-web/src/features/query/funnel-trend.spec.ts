import { describe, expect, it } from 'vitest';
import {
  FUNNEL_TIME_COLUMN,
  funnelTimeGranularity,
  funnelTrendResult,
  withFunnelTimeGranularity,
} from './funnel-trend';
import type { FunnelQuery, FunnelResult } from '../../types/dsl.types';

const baseDsl = {
  project: 'clklogapp',
  window_seconds: 86400,
  steps: [{ event: 'a' }, { event: 'b' }],
  time_range: { start: '2026-09-01', end: '2026-09-07' },
} as unknown as FunnelQuery;

describe('funnel-trend', () => {
  it('无时间分组时为 none', () => {
    expect(funnelTimeGranularity(null)).toBe('none');
    expect(funnelTimeGranularity(baseDsl)).toBe('none');
  });

  it('识别时间分组粒度', () => {
    expect(
      funnelTimeGranularity({ ...baseDsl, groups: [{ scope: 'time', granularity: 'day' }] } as FunnelQuery),
    ).toBe('day');
    expect(
      funnelTimeGranularity({ ...baseDsl, groups: [{ scope: 'time', granularity: 'hour' }] } as FunnelQuery),
    ).toBe('hour');
  });

  it('设置时间粒度：时间分组替换维度分组（后端仅支持单分组）', () => {
    expect(withFunnelTimeGranularity(baseDsl, 'day').groups).toEqual([{ scope: 'time', granularity: 'day' }]);
    const withProp = { ...baseDsl, groups: [{ scope: 'user', prop: 'os' }] } as FunnelQuery;
    expect(withFunnelTimeGranularity(withProp, 'hour').groups).toEqual([{ scope: 'time', granularity: 'hour' }]);
  });

  it('清除时间粒度时保留其它分组', () => {
    const dsl = {
      ...baseDsl,
      groups: [
        { scope: 'time', granularity: 'day' },
        { scope: 'user', prop: 'os' },
      ],
    } as FunnelQuery;
    expect(withFunnelTimeGranularity(dsl, 'none').groups).toEqual([{ scope: 'user', prop: 'os' }]);
  });

  it('多桶结果转为趋势图结果（重命名时间列并补类型）', () => {
    const result = {
      columns: [
        { key: 'group_col', title: '时间(day)' },
        { key: 'step_1', title: '步骤1人数' },
        { key: 'step_2', title: '步骤2人数' },
      ],
      rows: [
        { group_col: '2026-09-01', step_1: 100, step_2: 50 },
        { group_col: '2026-09-02', step_1: 110, step_2: 55 },
      ],
      elapsed_ms: 10,
    } as unknown as FunnelResult;

    const trend = funnelTrendResult(result);
    expect(trend).not.toBeNull();
    expect(trend!.columns[0]).toEqual({ name: FUNNEL_TIME_COLUMN, type: 'Date' });
    expect(trend!.columns.map((c) => c.name)).toEqual(['time_bucket', 'step_1', 'step_2']);
    expect(trend!.rows).toHaveLength(2);
    expect(trend!.rows[0]).toEqual({ time_bucket: '2026-09-01', step_1: 100, step_2: 50 });
  });

  it('缺少分组列或步骤列时返回 null（避免画出假趋势）', () => {
    expect(funnelTrendResult(null)).toBeNull();
    expect(
      funnelTrendResult({ columns: [{ key: 'step_1' }], rows: [{ step_1: 1 }] } as unknown as FunnelResult),
    ).toBeNull();
    expect(
      funnelTrendResult({ columns: [{ key: 'group_col' }], rows: [{ group_col: 'x' }] } as unknown as FunnelResult),
    ).toBeNull();
    expect(funnelTrendResult({ columns: [{ key: 'group_col' }, { key: 'step_1' }], rows: [] } as unknown as FunnelResult)).toBeNull();
  });
});
