import { describe, expect, it } from 'vitest';
import { CHART_CONFIG_SCHEMA_VERSION, CHART_RECOMMENDATION_VERSION } from '../chart.constants';
import type { ChartConfigV1, ChartOptions, QueryColumn } from '../chart.types';
import { resolveVisualization } from '../chart-pipeline';

/**
 * 折线图 adapter 单测（phase: clklog-analytics-sql-dual-axis-v1）。
 *
 * fixture 取「收入金额 + 付费人数」——量级差两个数量级，正是双轴要解决的场景：
 * 单轴上付费人数会被压成贴底直线。
 */

const COLUMNS: QueryColumn[] = [
  { name: 'day', type: 'Date' },
  { name: 'revenue', type: 'Float64' },
  { name: 'payers', type: 'Float64' },
];

const ROWS = [
  { day: '2026-09-01', revenue: 12000, payers: 120 },
  { day: '2026-09-02', revenue: 9500, payers: 90 },
  { day: '2026-09-03', revenue: 14000, payers: 150 },
];

type AxisLike = { axisLabel?: { formatter?: (value: number) => string } };
type SeriesLike = { name: string; yAxisIndex?: number };

function lineConfig(options?: Partial<ChartOptions>): ChartConfigV1 {
  return {
    schema_version: CHART_CONFIG_SCHEMA_VERSION,
    recommendation_version: CHART_RECOMMENDATION_VERSION,
    mode: 'manual',
    preferred_view: 'chart',
    chart_type: 'line',
    roles: { day: 'time', revenue: 'metric', payers: 'metric' },
    bindings: { x: 'day', metrics: ['revenue', 'payers'], ignored: [] },
    options: {
      orientation: 'vertical',
      donut: false,
      include_other: false,
      units: {},
      aggregation: {},
      ...options,
    },
  };
}

const resolveLine = (config: ChartConfigV1) =>
  resolveVisualization({ columns: COLUMNS, rows: ROWS, savedConfig: config });

const axesOf = (config: ChartConfigV1): AxisLike | AxisLike[] =>
  resolveLine(config).adapter!.option.yAxis as AxisLike | AxisLike[];

const seriesOf = (config: ChartConfigV1): SeriesLike[] =>
  (resolveLine(config).adapter!.option.series as SeriesLike[]) ?? [];

const gridOf = (config: ChartConfigV1) =>
  resolveLine(config).adapter!.option.grid as { right: number };

describe('line.adapter 双 Y 轴', () => {
  it('未配置轴归属时仍是单条轴对象，且边距与改造前一致（既有图不变的回归基线）', () => {
    const config = lineConfig();
    const yAxis = axesOf(config);
    expect(Array.isArray(yAxis)).toBe(false);
    expect(gridOf(config).right).toBe(16);
    expect(seriesOf(config).map((item) => item.yAxisIndex)).toEqual([undefined, undefined]);
  });

  it('把指标设到右轴后输出两条轴，并给每条系列标出 yAxisIndex', () => {
    const config = lineConfig({ metric_axis: { payers: 'right' } });
    const yAxis = axesOf(config);
    expect(Array.isArray(yAxis)).toBe(true);
    expect((yAxis as AxisLike[]).length).toBe(2);
    expect(seriesOf(config).map((item) => item.name)).toEqual(['revenue', 'payers']);
    expect(seriesOf(config).map((item) => item.yAxisIndex)).toEqual([0, 1]);
  });

  it('双轴时放宽右边距，否则右轴刻度会被裁掉', () => {
    expect(gridOf(lineConfig({ metric_axis: { payers: 'right' } })).right).toBe(48);
    // 显式全左轴仍是单轴、边距不变
    expect(gridOf(lineConfig({ metric_axis: { payers: 'left' } })).right).toBe(16);
  });

  it('左右轴各按所属指标的单位格式化刻度', () => {
    const yAxis = axesOf(
      lineConfig({ metric_axis: { payers: 'right' }, units: { payers: 'percent_0_100' } }),
    ) as AxisLike[];
    expect(yAxis[1].axisLabel?.formatter?.(0.5)).toContain('%');
    expect(yAxis[0].axisLabel?.formatter?.(0.5)).not.toContain('%');
  });

  it('同一根轴混单位时该轴刻度不做单位装饰（不再把 A 的量纲套到 B 上）', () => {
    // 全在左轴、两个指标单位不同：旧行为会拿第一个指标（percent）格式化整根轴，
    // 把计数的刻度也标成百分号。
    const yAxis = axesOf(lineConfig({ units: { revenue: 'percent_0_100' } })) as AxisLike;
    expect(Array.isArray(yAxis)).toBe(false);
    const format = yAxis.axisLabel!.formatter!;
    expect(format(12000)).not.toContain('%');
    expect(format(12000)).toContain('万');
  });

  it('该轴单位唯一时刻度格式不变（既有图不回归）', () => {
    const allPercent = axesOf(lineConfig({
      units: { revenue: 'percent_0_100', payers: 'percent_0_100' },
    })) as AxisLike;
    expect(allPercent.axisLabel!.formatter!(12.3)).toBe('12.3%');
  });

  it('左右轴单位不同但各自轴上唯一时不报混单位', () => {
    const resolved = resolveLine(lineConfig({
      metric_axis: { payers: 'right' },
      units: { payers: 'percent_0_100' },
    }));
    expect(resolved.issues.some((issue) => issue.code === 'MIXED_UNITS')).toBe(false);
    const yAxis = resolved.adapter!.option.yAxis as AxisLike[];
    expect(yAxis[1].axisLabel!.formatter!(12.3)).toBe('12.3%');
    expect(yAxis[0].axisLabel!.formatter!(12000)).not.toContain('%');
  });

  it('未参与绘制的指标设了右轴也不会逼出第二条轴（绑定 series 时只画第一个指标）', () => {
    const config = lineConfig({ metric_axis: { payers: 'right' } });
    config.bindings.series = 'day';
    config.bindings.metrics = ['revenue', 'payers'];
    // series 绑定下所有线共用第一个指标 revenue（左轴）→ 不应产生右轴
    expect(Array.isArray(axesOf(config))).toBe(false);
    expect(gridOf(config).right).toBe(16);
  });

  it('全部指标都在右轴时不产生空左轴刻度（左轴退回自动量程）', () => {
    const yAxis = axesOf(
      lineConfig({ metric_axis: { revenue: 'right', payers: 'right' } }),
    ) as AxisLike[];
    expect(yAxis.length).toBe(2);
    // 左轴没有系列，不应被钉在 0..0
    expect((yAxis[0] as { min?: number }).min).toBeUndefined();
    expect((yAxis[0] as { max?: number }).max).toBeUndefined();
  });
});
