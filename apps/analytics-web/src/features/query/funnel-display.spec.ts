import { describe, expect, it } from 'vitest';
import {
  buildFunnelChartOption,
  buildFunnelTableModel,
  colorForConversionPct,
  colorForStep,
  DEFAULT_FUNNEL_COLOR,
  defaultFunnelLayout,
  FUNNEL_LABEL_MIN_GAP_PX,
  funnelLayoutFromDsl,
  rebaseFunnelSeries,
  nextFunnelBaseIndex,
  funnelRateFromDsl,
  funnelSeriesFromResult,
  funnelTableColCharsFromDsl,
  funnelTableColWidthPx,
  funnelViewFromDsl,
  MIN_FUNNEL_TABLE_COL_CHARS,
  parseFunnelRateMode,
  parseFunnelTableColChars,
  resolveFunnelLayout,
  stepRateVsFirst,
  stepRateVsPrevious,
} from './funnel-display';
import type { FunnelResult } from '../../types/dsl.types';

const columns = [
  { key: 'step_1', title: '启动 人数' },
  { key: 'step_2', title: '登录 人数' },
  { key: 'step_2_conversion', title: '登录 转化率' },
  { key: 'step_2_churn', title: '登录 流失' },
];

const sample: FunnelResult = {
  columns,
  rows: [{ step_1: 100, step_2: 80, step_2_conversion: 0.8, step_2_churn: 20 }],
  elapsed_ms: 1,
  steps: [
    { key: 'step_1', title: '启动' },
    { key: 'step_2', title: '登录' },
  ],
};

describe('funnel-display', () => {
  it('defaults missing view config to conversion', () => {
    expect(parseFunnelRateMode(undefined)).toBe('conversion');
    expect(funnelRateFromDsl({ steps: [] })).toBe('conversion');
    expect(funnelRateFromDsl({ _view: { funnel_rate: 'churn' } })).toBe('churn');
  });

  it('builds a two-row table without 人数 in headers', () => {
    const table = buildFunnelTableModel(sample, 'conversion');
    expect(table.columns.map((c) => c.title)).toEqual(['', '启动', '登录']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]._metric).toBe('数值');
    expect(table.rows[0].step_1).toBe(100);
    expect(table.rows[0].step_2).toBe(80);
    expect(table.rows[1]._metric).toBe('转化率');
    expect(table.rows[1].step_1).toBe('100.0%');
    expect(table.rows[1].step_2).toBe('80.0%');
    const churn = buildFunnelTableModel(sample, 'churn');
    expect(churn.rows[1]._metric).toBe('流失率');
    expect(churn.rows[1].step_1).toBe('0.0%');
    expect(churn.rows[1].step_2).toBe('20.0%');
  });

  it('uses horizontal below 10 steps and vertical at 10+', () => {
    expect(defaultFunnelLayout(9)).toBe('horizontal');
    expect(defaultFunnelLayout(10)).toBe('vertical');
    expect(resolveFunnelLayout(undefined, 24)).toBe('vertical');
    expect(resolveFunnelLayout('horizontal', 24)).toBe('horizontal');
    expect(funnelLayoutFromDsl({ _view: { funnel_layout: 'vertical' } })).toBe('vertical');
    expect(funnelViewFromDsl({}).layout).toBeUndefined();
    expect(parseFunnelTableColChars(3)).toBe(MIN_FUNNEL_TABLE_COL_CHARS);
    expect(parseFunnelTableColChars(undefined)).toBe(6);
    expect(funnelTableColCharsFromDsl({ _view: { funnel_table_col_chars: 10 } })).toBe(10);
    expect(funnelTableColWidthPx('人', 6)).toBeGreaterThanOrEqual(6 * 14);
  });

  it('labels chart vs first step and colors vs previous step', () => {
    expect(stepRateVsFirst(80, 100, 'conversion')).toBe('80.0%');
    expect(stepRateVsFirst(80, 100, 'churn')).toBe('20.0%');
    expect(stepRateVsFirst(100, 100, 'conversion')).toBe('100.0%');
    expect(stepRateVsPrevious(80, 100, 'conversion')).toBe('80.0%');
    expect(colorForConversionPct(95, DEFAULT_FUNNEL_COLOR)).toBe('#1677ff');
    expect(colorForConversionPct(85, DEFAULT_FUNNEL_COLOR)).toBe('#faad14');
    expect(colorForConversionPct(70, DEFAULT_FUNNEL_COLOR)).toBe('#ff4d4f');
    expect(colorForConversionPct(49, DEFAULT_FUNNEL_COLOR)).toBe('#531dab');
    const bars = [{ value: 100 }, { value: 85 }, { value: 60 }];
    expect(colorForStep(0, bars, DEFAULT_FUNNEL_COLOR)).toBe('#1677ff');
    expect(colorForStep(1, bars, DEFAULT_FUNNEL_COLOR)).toBe('#faad14');
    expect(colorForStep(2, bars, DEFAULT_FUNNEL_COLOR)).toBe('#ff4d4f');
    expect(colorForStep(1, [{ value: 100 }, { value: 40 }], DEFAULT_FUNNEL_COLOR)).toBe('#531dab');
  });

  it('builds a trapezoid funnel with index-name left and rate right', () => {
    expect(funnelSeriesFromResult(sample)).toEqual([
      { name: '启动', value: 100, stepNo: 1 },
      { name: '登录', value: 80, stepNo: 2 },
    ]);
    const option = buildFunnelChartOption(funnelSeriesFromResult(sample), 'conversion', 'horizontal');
    expect(option.series).toHaveLength(1);
    expect(option.series[0]).toMatchObject({ type: 'funnel', sort: 'none', funnelAlign: 'center' });
    const formatLabel = option.series[0].label.formatter as (params: { dataIndex: number }) => string;
    expect(formatLabel({ dataIndex: 0 })).toContain('1 启动');
    expect(formatLabel({ dataIndex: 0 })).toContain('100.0%');
    expect(formatLabel({ dataIndex: 0 }).indexOf('1 启动')).toBeLessThan(
      formatLabel({ dataIndex: 0 }).indexOf('100.0%'),
    );
    expect(formatLabel({ dataIndex: 1 })).toContain('2 登录');
    expect(formatLabel({ dataIndex: 1 })).toContain('80.0%');
    const colored = option.series[0].data as Array<{ itemStyle: { color: string } }>;
    expect(colored[0].itemStyle.color).toBe('#1677ff');
    expect(colored[1].itemStyle.color).toBe('#faad14');
    const tip = option.tooltip.formatter({ dataIndex: 1 });
    expect(tip).toContain('登录');
    expect(tip).toContain('数值 80');
    expect(tip).toContain('转化率 80.0%');
    const three = buildFunnelChartOption(
      [
        { name: 'a', value: 100 },
        { name: 'b', value: 90 },
        { name: 'c', value: 72 },
      ],
      'conversion',
      'horizontal',
    );
    const formatThree = three.series[0].label.formatter as (params: { dataIndex: number }) => string;
    expect(formatThree({ dataIndex: 2 })).toContain('72.0%');
    expect(three.tooltip.formatter({ dataIndex: 2 })).toContain('转化率 80.0%');
    const uneven = buildFunnelChartOption(
      [
        { name: '短', value: 100 },
        { name: '很长很长的步骤名称', value: 50 },
      ],
      'conversion',
      'horizontal',
    );
    const rich = uneven.series[0].label.rich as Record<string, { width: number }>;
    expect(rich.g1.width).toBe(FUNNEL_LABEL_MIN_GAP_PX);
    expect(rich.g0.width).toBeGreaterThan(FUNNEL_LABEL_MIN_GAP_PX);
  });

  it('builds a vertical bar chart with vs-first labels on top', () => {
    const option = buildFunnelChartOption(funnelSeriesFromResult(sample), 'churn', 'vertical');
    expect(option.series[0].type).toBe('bar');
    expect(option.xAxis?.data).toEqual(['1 启动', '2 登录']);
    expect(option.series[0].label.formatter?.({ dataIndex: 0 })).toBe('0.0%');
    expect(option.series[0].label.formatter?.({ dataIndex: 1 })).toBe('20.0%');
    const tip = option.tooltip.formatter({ dataIndex: 1 });
    expect(tip).toContain('流失率 20.0%');
  });

  it('rebases later steps from a clicked step without hiding original numbers', () => {
    const full = [
      { name: '启动', value: 10000, stepNo: 1 },
      { name: '形象卡', value: 120, stepNo: 6 },
      { name: '性别', value: 90, stepNo: 7 },
    ];
    expect(nextFunnelBaseIndex(0, 0)).toBe(0);
    expect(nextFunnelBaseIndex(0, 1)).toBe(1);
    const sliced = rebaseFunnelSeries(full, 1);
    expect(sliced.map((s) => s.stepNo)).toEqual([6, 7]);
    const option = buildFunnelChartOption(sliced, 'conversion', 'horizontal');
    const formatLabel = option.series[0].label.formatter as (params: { dataIndex: number }) => string;
    expect(formatLabel({ dataIndex: 0 })).toContain('6 形象卡');
    expect(formatLabel({ dataIndex: 0 })).toContain('100.0%');
    expect(formatLabel({ dataIndex: 1 })).toContain('75.0%');
    expect(option.series[0].max).toBe(120);
    expect(option.series[0].data).toHaveLength(2);
  });
});
