import { describe, expect, it } from 'vitest';
import {
  buildExploreOption,
  modelFromEventResult,
  modelFromRetentionDaily,
  modelFromRetentionNth,
  resolveXLabel,
  type ExploreChartModel,
} from './explore-chart-option';
import type { QueryColumn } from '../../types/dsl.types';

/** 双轴 / 标签策略 / 每系列单位（phase: clklog-analytics-event-chart-binding-v1） */
type AxisOption = { axisLabel?: { formatter?: (value: number) => string } };

const axisFormatter = (option: Record<string, unknown>, index?: number): ((value: number) => string) => {
  const yAxis = option.yAxis as AxisOption | AxisOption[];
  const axis = Array.isArray(yAxis) ? yAxis[index ?? 0] : yAxis;
  return axis.axisLabel!.formatter!;
};

const xAxisLabel = (option: Record<string, unknown>) =>
  (option.xAxis as { axisLabel?: { rotate?: number; width?: number; overflow?: string; formatter?: (v: string) => string } })
    .axisLabel ?? {};

const eventColumns: QueryColumn[] = [
  { key: 'g_0', title: '日期' },
  { key: 'm_0', title: 'DAU' },
  { key: 'm_1', title: 'DNU' },
];

const eventRows = [
  { g_0: '2026-09-07', m_0: 100, m_1: 10 },
  { g_0: '2026-09-08', m_0: 120, m_1: 12 },
];

const scrambledRows = [
  { g_0: '2026-09-06 00:00:00', m_0: 9000, m_1: 900 },
  { g_0: '2026-09-04 00:00:00', m_0: 8500, m_1: 800 },
  { g_0: '2026-09-07 00:00:00', m_0: 8351, m_1: 1316 },
];

describe('explore-chart-option', () => {
  it('maps event results to date × metrics', () => {
    const model = modelFromEventResult(eventColumns, eventRows);
    expect(model.categories).toEqual(['2026-09-07', '2026-09-08']);
    expect(model.series[0]).toEqual({ name: 'DAU', values: [100, 120] });
  });

  it('uses value_map labels on the category axis', () => {
    const columns: QueryColumn[] = [
      { key: 'g_0', title: '商品', value_map: { SGD1: 'Feather Arc' } },
      { key: 'm_0', title: '次数' },
    ];
    const model = modelFromEventResult(columns, [{ g_0: 'SGD1', m_0: 3 }]);
    expect(model.categories).toEqual(['Feather Arc']);
  });

  it('sorts metric-desc dates back onto the calendar axis', () => {
    const model = modelFromEventResult(eventColumns, scrambledRows);
    expect(model.categories).toEqual(['2026-09-04', '2026-09-06', '2026-09-07']);
    expect(model.series[0].values).toEqual([8500, 9000, 8351]);
    const option = buildExploreOption('line', model, ['last', 'avg']);
    expect((option.xAxis as { data: string[] }).data).toEqual(['2026-09-04', '2026-09-06', '2026-09-07']);
    const formatter = (option.xAxis as { axisLabel?: { formatter?: (value: string) => string } }).axisLabel?.formatter;
    expect(formatter?.('2026-09-04')).toBe('9月4日');
    expect((option.legend as { bottom?: number }).bottom).toBe(0);
    expect((option.series as Array<{ markLine?: unknown; markPoint?: unknown }>)[0].markLine).toBeUndefined();
  });

  it('stacks bars and accumulates lines', () => {
    const model = modelFromEventResult(eventColumns, eventRows);
    const stacked = buildExploreOption('stack', model, ['avg']);
    expect((stacked.series as Array<{ stack?: string }>)[0].stack).toBe('total');
    const cumulative = buildExploreOption('cumulative', model, ['last']);
    expect((cumulative.series as Array<{ data: number[] }>)[0].data).toEqual([100, 220]);
  });

  it('nth retention is cohort dates; daily retention is D-n categories', () => {
    const columns: QueryColumn[] = [
      { key: 'cohort_date', title: '日期' },
      { key: 'n_1_rate', title: '次留' },
      { key: 'n_2_rate', title: 'D2' },
    ];
    const rows = [
      { cohort_date: '2026-09-07', n_1_rate: 0.2, n_2_rate: 0.1 },
      { cohort_date: '2026-09-08', n_1_rate: 0.25, n_2_rate: null },
    ];
    const nth = modelFromRetentionNth(columns, rows);
    expect(nth.categories).toEqual(['2026-09-07', '2026-09-08']);
    expect(nth.series[0].name).toBe('次留');
    const daily = modelFromRetentionDaily(columns, rows);
    expect(daily.categories).toEqual(['次留', 'D2']);
    expect(daily.series.map((item) => item.name)).toEqual(['2026-09-07', '2026-09-08']);
    expect(daily.series[0].values).toEqual([0.2, 0.1]);
    const nthOption = buildExploreOption('nth_trend', nth, ['avg', 'max']);
    expect((nthOption.series as Array<{ connectNulls?: boolean; markLine?: unknown }>)[0].connectNulls).toBe(false);
    expect((nthOption.series as Array<{ markLine?: unknown }>)[0].markLine).toBeUndefined();
    expect((nthOption.legend as { bottom?: number }).bottom).toBe(0);
  });
});

describe('explore-chart-option 双轴 / 标签策略', () => {
  const model = (over: Partial<ExploreChartModel> = {}): ExploreChartModel => ({
    categories: ['a', 'b'],
    series: [
      { name: '总量', values: [18641, 54], unit: 'number' },
      { name: '用户数', values: [98, 8], unit: 'number' },
    ],
    ...over,
  });

  it('没有右轴系列时仍输出单条轴对象（旧图逐像素不变的前提）', () => {
    const option = buildExploreOption('line', model(), ['last']);
    expect(Array.isArray(option.yAxis)).toBe(false);
    expect((option.grid as { right: number }).right).toBe(16);
    expect((option.series as Array<{ yAxisIndex?: number }>)[0].yAxisIndex).toBeUndefined();
  });

  it('有右轴系列时输出两条刻度轴并标注 yAxisIndex，右边距加大', () => {
    const option = buildExploreOption(
      'line',
      model({
        series: [
          { name: '总量', values: [18641, 54], unit: 'number' },
          { name: '用户数', values: [98, 8], unit: 'number', axis: 'right' },
          { name: '人均', values: [190.2, 6.75], unit: 'percent_0_100', axis: 'right' },
        ],
      }),
      ['last'],
    );
    expect(Array.isArray(option.yAxis)).toBe(true);
    expect((option.yAxis as unknown[]).length).toBe(2);
    expect((option.grid as { right: number }).right).toBe(48);
    expect((option.series as Array<{ yAxisIndex?: number }>).map((item) => item.yAxisIndex)).toEqual([0, 1, 1]);
  });

  it('左右轴各按所属系列的单位格式化刻度', () => {
    const option = buildExploreOption(
      'line',
      model({
        series: [
          { name: '总量', values: [18641, 54], unit: 'number' },
          { name: '转化率', values: [0.5, 0.25], unit: 'percent_0_100', axis: 'right' },
        ],
      }),
      ['last'],
    );
    expect(axisFormatter(option, 1)(0.5)).toContain('%');
    expect(axisFormatter(option, 0)(0.5)).not.toContain('%');
  });

  it('每指标单位不同时 tooltip 换成按系列查单位的 formatter', () => {
    const same = buildExploreOption('line', model(), ['last']);
    expect((same.tooltip as { valueFormatter?: unknown }).valueFormatter).toBeTypeOf('function');

    const mixed = buildExploreOption(
      'line',
      model({
        series: [
          { name: '总量', values: [1, 2], unit: 'number' },
          { name: '时长', values: [30, 60], unit: 'duration_sec' },
        ],
      }),
      ['last'],
    );
    const tooltip = mixed.tooltip as { formatter?: unknown; valueFormatter?: unknown };
    expect(tooltip.valueFormatter).toBeUndefined();
    expect(tooltip.formatter).toBeTypeOf('function');
  });

  it('resolveXLabel 按分类数与标签长度分档，显式值优先', () => {
    expect(resolveXLabel(['a', 'b'])).toEqual({ rotate: 0, maxWidth: null });
    expect(resolveXLabel(Array.from({ length: 8 }, (_, i) => `分类-${i}`))).toEqual({ rotate: 0, maxWidth: 96 });
    expect(resolveXLabel(Array.from({ length: 12 }, (_, i) => `分类-${i}`))).toEqual({ rotate: 30, maxWidth: 96 });
    expect(resolveXLabel(Array.from({ length: 30 }, (_, i) => `分类-${i}`))).toEqual({ rotate: 45, maxWidth: 88 });
    expect(resolveXLabel(['a'], { rotate: 60, max_width: null })).toEqual({ rotate: 60, maxWidth: null });
    expect(resolveXLabel(['a'], { rotate: null, max_width: 200 })).toEqual({ rotate: 0, maxWidth: 200 });
  });

  it('长维度标签落到 axisLabel 的 rotate / truncate，且不被容器裁切', () => {
    const categories = Array.from({ length: 12 }, (_, i) => `/app/shop/goods${i}`);
    const option = buildExploreOption('line', model({ categories, timeAxis: false }), ['last']);
    const label = xAxisLabel(option);
    expect(label.rotate).toBe(30);
    expect(label.width).toBe(96);
    expect(label.overflow).toBe('truncate');
    expect((option.grid as { containLabel: boolean }).containLabel).toBe(true);
    // 维度轴不做日期格式化，悬停表头才是全文
    expect(label.formatter?.('/app/shop/goods0')).toBe('/app/shop/goods0');
  });

  it('时间轴仍走日期文案（缺省 timeAxis 即为时间）', () => {
    const option = buildExploreOption('line', model({ categories: ['2026-09-07'] }), ['last']);
    expect(xAxisLabel(option).formatter?.('2026-09-07')).toBe('9月7日');
    const dimension = buildExploreOption('line', model({ categories: ['2026-09-07'], timeAxis: false }), ['last']);
    expect(xAxisLabel(dimension).formatter?.('2026-09-07')).toBe('2026-09-07');
  });
});
