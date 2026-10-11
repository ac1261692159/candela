import { describe, expect, it } from 'vitest';
import { buildEventChartModel } from './event-binding';
import type { ChartConfigV1, ChartIssueCode } from '../visualization/chart.types';
import type { QueryColumn } from '../../types/dsl.types';
import { defaultOptions } from '../visualization/chart-compatibility';

const columns: QueryColumn[] = [
  { key: 'g_0', role: 'time', title: '日期' },
  { key: 'g_1', role: 'dimension', title: '渠道' },
  { key: 'm_0', role: 'metric', title: '消耗总量' },
  { key: 'm_1', role: 'metric', title: '消耗用户数' },
];

const channelColumns: QueryColumn[] = [
  { key: 'g_0', role: 'dimension', title: 'channel_name' },
  { key: 'm_0', role: 'metric', title: '消耗总量' },
  { key: 'm_1', role: 'metric', title: '消耗用户数' },
];

const config = (over: Partial<ChartConfigV1> = {}): ChartConfigV1 => ({
  schema_version: 1,
  recommendation_version: 1,
  mode: 'manual',
  preferred_view: 'chart',
  chart_type: 'line',
  roles: { g_0: 'time', g_1: 'dimension', m_0: 'metric', m_1: 'metric' },
  bindings: { x: 'g_0', metrics: ['m_0', 'm_1'], ignored: [] },
  options: defaultOptions({ units: { m_0: 'number', m_1: 'number' } }),
  ...over,
});

const codes = (issues: { code: ChartIssueCode }[]) => issues.map((issue) => issue.code);

describe('event-binding', () => {
  it('不拆分系列时每个指标一条线，单位与轴从 options 落到系列上', () => {
    const rows = [
      { g_0: '2026-09-07', g_1: 'a', m_0: 100, m_1: 10 },
      { g_0: '2026-09-08', g_1: 'b', m_0: 120, m_1: 12 },
    ];
    const { model } = buildEventChartModel(
      columns,
      rows,
      config({ options: defaultOptions({ units: { m_0: 'number', m_1: 'percent_0_100' }, metric_axis: { m_1: 'right' } }) }),
    );
    expect(model.categories).toEqual(['2026-09-07', '2026-09-08']);
    expect(model.series).toEqual([
      { name: '消耗总量', values: [100, 120], unit: 'number', axis: 'left' },
      { name: '消耗用户数', values: [10, 12], unit: 'percent_0_100', axis: 'right' },
    ]);
    expect(model.timeAxis).toBe(true);
  });

  it('剔除阶段汇总行', () => {
    const rows = [
      { __stage: true, g_0: '阶段汇总', m_0: 220, m_1: 22 },
      { g_0: '2026-09-07', m_0: 100, m_1: 10 },
      { g_0: '2026-09-08', m_0: 120, m_1: 12 },
    ];
    const { model } = buildEventChartModel(columns, rows, config());
    expect(model.categories).toEqual(['2026-09-07', '2026-09-08']);
    expect(model.series[0].values).toEqual([100, 120]);
  });

  it('时间轴按时间升序；维度轴保持服务端返回顺序', () => {
    const timeRows = [
      { g_0: '2026-09-09', m_0: 3, m_1: 1 },
      { g_0: '2026-09-07', m_0: 1, m_1: 1 },
    ];
    expect(buildEventChartModel(columns, timeRows, config()).model.categories).toEqual([
      '2026-09-07',
      '2026-09-09',
    ]);
    const dimRows = [
      { g_0: '/app/b', m_0: 20, m_1: 2 },
      { g_0: '/app/a', m_0: 10, m_1: 1 },
    ];
    const dimConfig = config({ roles: { g_0: 'dimension', m_0: 'metric', m_1: 'metric' }, bindings: { x: 'g_0', metrics: ['m_0', 'm_1'], ignored: [] } });
    const { model } = buildEventChartModel(channelColumns, dimRows, dimConfig);
    expect(model.categories).toEqual(['/app/b', '/app/a']);
    expect(model.timeAxis).toBe(false);
  });

  it('维度取值走维表显示名', () => {
    const mapped: QueryColumn[] = [
      { key: 'g_0', role: 'dimension', title: '渠道', value_map: { SGD1: 'Feather Arc' } },
      { key: 'm_0', role: 'metric', title: '次数' },
    ];
    const { model } = buildEventChartModel(
      mapped,
      [{ g_0: 'SGD1', m_0: 3 }],
      config({
        roles: { g_0: 'dimension', m_0: 'metric' },
        bindings: { x: 'g_0', metrics: ['m_0'], ignored: [] },
      }),
    );
    expect(model.categories).toEqual(['Feather Arc']);
  });

  it('拆分系列按维度取值透视：多指标时线名带指标名', () => {
    const rows = [
      { g_0: '2026-09-07', g_1: 'iOS', m_0: 10, m_1: 1 },
      { g_0: '2026-09-07', g_1: 'Android', m_0: 20, m_1: 2 },
      { g_0: '2026-09-08', g_1: 'iOS', m_0: 30, m_1: 3 },
    ];
    const { model, issues } = buildEventChartModel(
      columns,
      rows,
      config({ bindings: { x: 'g_0', series: 'g_1', metrics: ['m_0', 'm_1'], ignored: [] } }),
    );
    expect(model.categories).toEqual(['2026-09-07', '2026-09-08']);
    expect(model.series.map((item) => item.name)).toEqual([
      'iOS · 消耗总量',
      'iOS · 消耗用户数',
      'Android · 消耗总量',
      'Android · 消耗用户数',
    ]);
    expect(model.series[0].values).toEqual([10, 30]);
    expect(model.series[1].values).toEqual([1, 3]);
    expect(model.series[2].values).toEqual([20, null]);
    expect(codes(issues)).not.toContain('SERIES_CELL_COLLAPSED');
  });

  it('单指标拆分系列时线名就是拆分取值', () => {
    const rows = [
      { g_0: '2026-09-07', g_1: 'iOS', m_0: 10 },
      { g_0: '2026-09-07', g_1: 'Android', m_0: 20 },
    ];
    const { model } = buildEventChartModel(
      columns,
      rows,
      config({ bindings: { x: 'g_0', series: 'g_1', metrics: ['m_0'], ignored: [] } }),
    );
    expect(model.series.map((item) => item.name)).toEqual(['iOS', 'Android']);
  });

  it('同一 (X, 拆分取值) 命中多行时求和合并并给出提示', () => {
    const rows = [
      { g_0: '2026-09-07', g_1: 'iOS', m_0: 10 },
      { g_0: '2026-09-07', g_1: 'iOS', m_0: 5 },
      { g_0: '2026-09-08', g_1: 'iOS', m_0: 7 },
    ];
    const { model, issues } = buildEventChartModel(
      columns,
      rows,
      config({ bindings: { x: 'g_0', series: 'g_1', metrics: ['m_0'], ignored: [] } }),
    );
    expect(model.series[0].values).toEqual([15, 7]);
    expect(codes(issues)).toContain('SERIES_CELL_COLLAPSED');
  });

  it('线数超限按总量取前 N 条并提示', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      g_0: '2026-09-07',
      g_1: `渠道${i}`,
      m_0: (i + 1) * 10,
    }));
    const { model, issues } = buildEventChartModel(
      columns,
      rows,
      config({ bindings: { x: 'g_0', series: 'g_1', metrics: ['m_0'], ignored: [] } }),
    );
    expect(model.series).toHaveLength(5);
    // 保留总量最大的五个，按首次出现顺序排列
    expect(model.series.map((item) => item.name)).toEqual(['渠道3', '渠道4', '渠道5', '渠道6', '渠道7']);
    expect(codes(issues)).toContain('SERIES_LIMIT_EXCEEDED');
  });

  it('还有未绑定的维度列且未拆分系列时提示可设拆分系列', () => {
    const rows = [{ g_0: '2026-09-07', g_1: 'iOS', m_0: 10, m_1: 1 }];
    expect(codes(buildEventChartModel(columns, rows, config()).issues)).toContain('SERIES_DIMENSION_UNUSED');
    // 已经绑了拆分系列就不再提示
    expect(
      codes(
        buildEventChartModel(
          columns,
          rows,
          config({ bindings: { x: 'g_0', series: 'g_1', metrics: ['m_0'], ignored: [] } }),
        ).issues,
      ),
    ).not.toContain('SERIES_DIMENSION_UNUSED');
    // 被忽略的维度列不算未绑定
    expect(
      codes(
        buildEventChartModel(
          columns,
          rows,
          config({ bindings: { x: 'g_0', metrics: ['m_0'], ignored: ['g_1'] } }),
        ).issues,
      ),
    ).not.toContain('SERIES_DIMENSION_UNUSED');
  });

  it('x_label 透传到模型，缺省为 null（自动）', () => {
    const rows = [{ g_0: '2026-09-07', m_0: 1, m_1: 1 }];
    expect(buildEventChartModel(columns, rows, config()).model.xLabel).toBeNull();
    expect(
      buildEventChartModel(
        columns,
        rows,
        config({ options: defaultOptions({ x_label: { rotate: 45, max_width: 88 } }) }),
      ).model.xLabel,
    ).toEqual({ rotate: 45, max_width: 88 });
  });

  it('非法的指标绑定被忽略，不产生空线', () => {
    const rows = [{ g_0: '2026-09-07', m_0: 1 }];
    const { model } = buildEventChartModel(
      columns,
      rows,
      config({ bindings: { x: 'g_0', metrics: ['m_0', 'gone'], ignored: [] } }),
    );
    expect(model.series.map((item) => item.name)).toEqual(['消耗总量']);
  });
});
