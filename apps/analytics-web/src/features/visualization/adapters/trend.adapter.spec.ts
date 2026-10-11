import { describe, expect, it } from 'vitest';
import { CHART_CONFIG_SCHEMA_VERSION, CHART_RECOMMENDATION_VERSION } from '../chart.constants';
import type { ChartConfigV1, QueryColumn, TrendOptions } from '../chart.types';
import { resolveVisualization } from '../chart-pipeline';

/**
 * 趋势图 adapter 单测（phase: clklog-analytics-trend-chart-v1）。
 *
 * fixture 采用「磁盘每日用量」——运维面板磁盘预估的真实消费场景。
 * 趋势图按设计是**手动选择**的图表（不参与自动推荐），故测试显式给出
 * roles / bindings，不依赖列角色推断。
 */

const COLUMNS: QueryColumn[] = [
  { name: 'day', type: 'Date' },
  { name: 'used_gb', type: 'Float64' },
];

/** 每天 +30GB，完美线性 */
const FIVE_DAYS = [
  { day: '2026-09-01', used_gb: 1000 },
  { day: '2026-09-02', used_gb: 1030 },
  { day: '2026-09-03', used_gb: 1060 },
  { day: '2026-09-04', used_gb: 1090 },
  { day: '2026-09-05', used_gb: 1120 },
];

const TWO_DAYS = [
  { day: '2026-09-01', used_gb: 1000 },
  { day: '2026-09-02', used_gb: 1030 },
];

const DEFAULT_TREND: TrendOptions = {
  forecast_points: 7,
  threshold: null,
  show_trend_line: false,
  show_threshold: true,
};

type SeriesLike = {
  name: string;
  type: string;
  data: unknown[];
  lineStyle?: { type?: string };
  markLine?: { data?: Array<{ yAxis?: number; xAxis?: number }> };
  /** 双轴：该系列挂在哪条 Y 轴上（单轴时不存在） */
  yAxisIndex?: number;
};

function trendConfig(trend?: Partial<TrendOptions>): ChartConfigV1 {
  return {
    schema_version: CHART_CONFIG_SCHEMA_VERSION,
    recommendation_version: CHART_RECOMMENDATION_VERSION,
    mode: 'manual',
    preferred_view: 'chart',
    chart_type: 'trend',
    roles: { day: 'time', used_gb: 'metric' },
    bindings: { x: 'day', metrics: ['used_gb'], ignored: [] },
    options: {
      orientation: 'vertical',
      donut: false,
      include_other: false,
      units: {},
      aggregation: {},
      ...(trend ? { trend: { ...DEFAULT_TREND, ...trend } } : {}),
    },
  };
}

function resolveTrend(rows: Record<string, unknown>[], trend?: Partial<TrendOptions>) {
  return resolveVisualization({ columns: COLUMNS, rows, savedConfig: trendConfig(trend) });
}

function seriesOf(resolved: ReturnType<typeof resolveVisualization>): SeriesLike[] {
  return (resolved.adapter!.option.series as SeriesLike[]) ?? [];
}

describe('trend.adapter', () => {
  it('手动选择趋势图时可正常解析出 adapter', () => {
    const resolved = resolveTrend(FIVE_DAYS);
    expect(resolved.config?.chart_type).toBe('trend');
    expect(resolved.adapter).toBeDefined();
  });

  it('X 轴为等距时间轴（区别于折线图的类目轴）', () => {
    const resolved = resolveTrend(FIVE_DAYS);
    const xAxis = resolved.adapter!.option.xAxis as {
      type: string;
      axisLabel?: { formatter?: (value: number) => string };
    };
    expect(xAxis.type).toBe('time');
    const first = Date.parse('2026-09-01T00:00:00');
    expect(xAxis.axisLabel?.formatter?.(first)).toBe('9月1日');
  });

  it('渲染预测段：虚线，且从最后一个实测点接续', () => {
    const resolved = resolveTrend(FIVE_DAYS, { forecast_points: 3 });
    const forecastSeries = seriesOf(resolved).find((s) => s.name.includes('预测'));
    expect(forecastSeries).toBeDefined();
    // 含接续用的最后一个实测点，故为 forecast_points + 1
    expect(forecastSeries!.data).toHaveLength(4);
    expect(forecastSeries!.lineStyle?.type).toBe('dashed');
    expect((forecastSeries!.data[0] as [number, number])[1]).toBe(1120);
  });

  it('实测曲线为实线，与预测虚线区分（AC7）', () => {
    const resolved = resolveTrend(FIVE_DAYS, { forecast_points: 3 });
    const actual = seriesOf(resolved).find((s) => !s.name.includes('预测'));
    expect(actual).toBeDefined();
    expect(actual!.lineStyle?.type).toBe('solid');
  });

  it('配置阈值后给出阈值线与预计达到日期（AC8）', () => {
    const resolved = resolveTrend(FIVE_DAYS, {
      forecast_points: 60,
      threshold: 2000,
      show_threshold: true,
    });
    expect(seriesOf(resolved)[0].markLine).toBeDefined();
    expect(resolved.adapter!.summary).toContain('预计');
    expect(resolved.adapter!.summary).toMatch(/剩余 \d+ 天/);
  });

  it('阈值已越过（低于当前值）时提示已越过，不给出预计日期', () => {
    const resolved = resolveTrend(FIVE_DAYS, {
      forecast_points: 3,
      threshold: 500,
      show_threshold: true,
    });
    expect(resolved.adapter!.summary).toContain('已越过阈值');
    expect(resolved.adapter!.summary).not.toMatch(/剩余 \d+ 天/);
  });

  it('无增长且阈值高于当前值时说明不会触及', () => {
    const flat = [
      { day: '2026-09-01', used_gb: 1000 },
      { day: '2026-09-02', used_gb: 1000 },
      { day: '2026-09-03', used_gb: 1000 },
    ];
    const resolved = resolveTrend(flat, {
      forecast_points: 3,
      threshold: 2000,
      show_threshold: true,
    });
    expect(resolved.adapter!.summary).toContain('不会触及阈值');
    expect(resolved.adapter!.summary).not.toMatch(/剩余 \d+ 天/);
  });

  it('数据点不足 3 个时不外推（AC9）', () => {
    const resolved = resolveTrend(TWO_DAYS, { forecast_points: 5, threshold: 2000 });
    expect(seriesOf(resolved).some((s) => s.name.includes('预测'))).toBe(false);
    expect(resolved.adapter!.summary).toContain('数据点不足，无法预测');
  });

  it('启用拟合线时多出一条拟合曲线', () => {
    const withLine = resolveTrend(FIVE_DAYS, { forecast_points: 3, show_trend_line: true });
    const without = resolveTrend(FIVE_DAYS, { forecast_points: 3, show_trend_line: false });
    expect(seriesOf(withLine).some((s) => s.name.includes('拟合'))).toBe(true);
    expect(seriesOf(without).some((s) => s.name.includes('拟合'))).toBe(false);
  });

  it('关闭阈值线时不绘制 markLine', () => {
    const resolved = resolveTrend(FIVE_DAYS, {
      forecast_points: 3,
      threshold: 2000,
      show_threshold: false,
    });
    expect(seriesOf(resolved)[0].markLine).toBeUndefined();
  });

  it('audit 反映输入行数与输出点数', () => {
    const resolved = resolveTrend(FIVE_DAYS, { forecast_points: 3 });
    expect(resolved.adapter!.audit.inputRows).toBe(FIVE_DAYS.length);
    expect(resolved.adapter!.audit.outputPoints).toBe(5 + 3);
  });

  it('未配置 trend 时使用默认外推点数 7', () => {
    const resolved = resolveTrend(FIVE_DAYS);
    const forecastSeries = seriesOf(resolved).find((s) => s.name.includes('预测'));
    expect(forecastSeries!.data).toHaveLength(8);
  });

  it('trend 类型能通过配置白名单校验（AC10 保存与复现的前提）', () => {
    const resolved = resolveTrend(FIVE_DAYS, { forecast_points: 3 });
    // readSavedConfig 若拒绝 trend，config 会回退且 chart_type 不再是 trend
    expect(resolved.config?.chart_type).toBe('trend');
    // readSavedConfig 若在白名单校验处拒绝 trend，会附加 STALE_CONFIG 并回退
    expect(resolved.issues.some((issue) => issue.code === 'STALE_CONFIG')).toBe(false);
  });

  it('对全部指标各自外推（2026-09-09 用户决策），而不只主系列', () => {
    const columns: QueryColumn[] = [
      { name: 'day', type: 'Date' },
      { name: 'dau', type: 'UInt64' },
      { name: 'dnu', type: 'UInt64' },
    ];
    const rows = [
      { day: '2026-09-01', dau: 1000, dnu: 100 },
      { day: '2026-09-02', dau: 1030, dnu: 110 },
      { day: '2026-09-03', dau: 1060, dnu: 120 },
      { day: '2026-09-04', dau: 1090, dnu: 130 },
      { day: '2026-09-05', dau: 1120, dnu: 140 },
    ];
    const config: ChartConfigV1 = {
      schema_version: CHART_CONFIG_SCHEMA_VERSION,
      recommendation_version: CHART_RECOMMENDATION_VERSION,
      mode: 'manual',
      preferred_view: 'chart',
      chart_type: 'trend',
      roles: { day: 'time', dau: 'metric', dnu: 'metric' },
      bindings: { x: 'day', metrics: ['dau', 'dnu'], ignored: [] },
      options: {
        orientation: 'vertical',
        donut: false,
        include_other: false,
        units: {},
        aggregation: {},
        trend: { ...DEFAULT_TREND },
      },
    };
    const resolved = resolveVisualization({ columns, rows, savedConfig: config });
    const series = (resolved.adapter!.option.series as SeriesLike[]) ?? [];
    expect(series.some((item) => item.name === 'dau（预测）')).toBe(true);
    expect(series.some((item) => item.name === 'dnu（预测）')).toBe(true);
    expect(resolved.adapter!.summary).toContain('2 个系列');
  });
});

/**
 * 双 Y 轴（phase: clklog-analytics-sql-dual-axis-v1）。
 * 趋势图比折线多「预测段」与「拟合段」，它们必须跟主系列同轴，否则会跳回左轴。
 */
describe('trend.adapter 双 Y 轴', () => {
  const TWO_METRIC_COLUMNS: QueryColumn[] = [
    { name: 'day', type: 'Date' },
    { name: 'revenue', type: 'Float64' },
    { name: 'payers', type: 'Float64' },
  ];
  const ROWS = [
    { day: '2026-09-01', revenue: 12000, payers: 120 },
    { day: '2026-09-02', revenue: 12500, payers: 130 },
    { day: '2026-09-03', revenue: 13000, payers: 140 },
    { day: '2026-09-04', revenue: 13500, payers: 150 },
    { day: '2026-09-05', revenue: 14000, payers: 160 },
  ];

  function config(patch: Partial<ChartConfigV1['options']> = {}): ChartConfigV1 {
    return {
      schema_version: CHART_CONFIG_SCHEMA_VERSION,
      recommendation_version: CHART_RECOMMENDATION_VERSION,
      mode: 'manual',
      preferred_view: 'chart',
      chart_type: 'trend',
      roles: { day: 'time', revenue: 'metric', payers: 'metric' },
      bindings: { x: 'day', metrics: ['revenue', 'payers'], ignored: [] },
      options: {
        orientation: 'vertical',
        donut: false,
        include_other: false,
        units: {},
        aggregation: {},
        trend: { ...DEFAULT_TREND, forecast_points: 3 },
        ...patch,
      },
    };
  }

  const resolve = (patch: Partial<ChartConfigV1['options']> = {}) =>
    resolveVisualization({ columns: TWO_METRIC_COLUMNS, rows: ROWS, savedConfig: config(patch) });

  it('未配置轴归属时仍是单条轴对象，边距与改造前一致', () => {
    const option = resolve().adapter!.option;
    expect(Array.isArray(option.yAxis)).toBe(false);
    expect((option.grid as { right: number }).right).toBe(16);
    expect(seriesOf(resolve()).every((item) => item.yAxisIndex === undefined)).toBe(true);
  });

  it('设到右轴的指标产出两条轴，实测曲线带 yAxisIndex', () => {
    const option = resolve({ metric_axis: { payers: 'right' } }).adapter!.option;
    expect(Array.isArray(option.yAxis)).toBe(true);
    expect((option.yAxis as unknown[]).length).toBe(2);
    expect((option.grid as { right: number }).right).toBe(48);
    const actual = (option.series as SeriesLike[])
      .filter((item) => !item.name.includes('预测') && !item.name.includes('拟合'))
      .map((item) => [item.name, item.yAxisIndex]);
    expect(actual).toEqual([['revenue', 0], ['payers', 1]]);
  });

  it('预测段与拟合段跟主系列同轴，不跳回左轴', () => {
    const series = seriesOf(resolve({ metric_axis: { payers: 'right' }, trend: { ...DEFAULT_TREND, forecast_points: 3, show_trend_line: true } }));
    const forecast = series.find((item) => item.name.includes('预测'));
    const fit = series.find((item) => item.name.includes('拟合'));
    expect(forecast?.yAxisIndex).toBe(0);
    expect(fit?.yAxisIndex).toBe(0);
  });

  it('左右轴各按所属指标的单位格式化刻度', () => {
    const yAxis = resolve({ metric_axis: { payers: 'right' }, units: { payers: 'percent_0_100' } })
      .adapter!.option.yAxis as Array<{ axisLabel?: { formatter?: (v: number) => string } }>;
    expect(yAxis[1].axisLabel?.formatter?.(0.5)).toContain('%');
    expect(yAxis[0].axisLabel?.formatter?.(0.5)).not.toContain('%');
  });
});
