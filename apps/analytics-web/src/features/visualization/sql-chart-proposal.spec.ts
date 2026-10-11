import { describe, expect, it } from 'vitest';
import { resolveVisualization } from './chart-pipeline';
import { materializeSqlChartProposal, SqlChartProposalError } from './sql-chart-proposal';

const revenueColumns = ['d', '付费人数', '支付成功次数', '收入金额', '客单价', '首充金额', '复充金额'];

describe('sql chart proposal materialize', () => {
  it('marks unnamed columns ignored so a five-metric line can render', () => {
    const config = materializeSqlChartProposal(
      {
        chart_type: 'line',
        bindings: {
          x: 'd',
          metrics: ['收入金额', '付费人数', '客单价', '首充金额', '复充金额'],
        },
      },
      revenueColumns,
    );
    expect(config.mode).toBe('manual');
    expect(config.roles['支付成功次数']).toBe('ignored');
    expect(config.bindings.metrics).toHaveLength(5);

    const resolved = resolveVisualization({
      columns: [
        { name: 'd', type: 'Date' },
        { name: '付费人数', type: 'UInt64' },
        { name: '支付成功次数', type: 'UInt64' },
        { name: '收入金额', type: 'Float64' },
        { name: '客单价', type: 'Float64' },
        { name: '首充金额', type: 'Float64' },
        { name: '复充金额', type: 'Float64' },
      ],
      rows: [{
        d: '2026-09-01',
        付费人数: 2,
        支付成功次数: 3,
        收入金额: 10.5,
        客单价: 3.5,
        首充金额: 4,
        复充金额: 6.5,
      }],
      savedConfig: config,
    });
    expect(resolved.view).toBe('chart');
    expect(resolved.config?.chart_type).toBe('line');
    expect(resolved.issues.some((issue) => issue.code === 'MIXED_UNITS' && issue.severity === 'warning')).toBe(true);
  });

  it('rejects six line metrics', () => {
    expect(() =>
      materializeSqlChartProposal(
        {
          chart_type: 'line',
          bindings: {
            x: 'd',
            metrics: ['付费人数', '支付成功次数', '收入金额', '客单价', '首充金额', '复充金额'],
          },
        },
        revenueColumns,
      ),
    ).toThrow(SqlChartProposalError);
  });

  it('继承旧配置的 options 时剔除旧列引用（回归：线上 13 次被拒 / 「应用配置点了没反应」）', () => {
    // 旧卡片的 options.sort 指向已不存在的 raw_cnt；不清掉会让整条新配置被判无效
    const staleOptions = {
      orientation: 'vertical',
      donut: false,
      sort: { column: 'raw_cnt', direction: 'desc' },
      include_other: false,
      units: { raw_cnt: 'number' },
      aggregation: { raw_cnt: 'additive' },
    } as unknown as Parameters<typeof materializeSqlChartProposal>[2];
    const next = materializeSqlChartProposal(
      { chart_type: 'bar', bindings: { category: '付费人数', metrics: ['收入金额', '客单价'] } },
      revenueColumns,
      staleOptions,
    );
    expect(next.chart_type).toBe('bar');
    expect(next.options.sort).toBeUndefined();
    expect(next.options.units).toEqual({});
    expect(next.options.aggregation).toEqual({});
  });

  it('仍然无法成立时，报错里带出真实原因（不再只报「不兼容」）', () => {
    // top_n 越界只会在底层校验器里被拒 —— 这种「说不清哪里错」的情况必须把原因带出来
    expect(() =>
      materializeSqlChartProposal(
        {
          chart_type: 'bar',
          bindings: { category: '付费人数', metrics: ['收入金额'] },
          options: { top_n: 9999 },
        },
        revenueColumns,
      ),
    ).toThrow(/原因：/);
  });

  /**
   * phase: clklog-ai-sql-chart-axis-v1 —— 提案带 options.metric_axis 后要真出右轴。
   * 服务端白名单此前漏了这个键，模型一提交就 400；这里从物化一路验到 ECharts option。
   */
  it('options.metric_axis 写进配置并渲染出左右双轴', () => {
    const config = materializeSqlChartProposal(
      {
        chart_type: 'line',
        bindings: { x: 'd', metrics: ['收入金额', '付费人数'] },
        options: { metric_axis: { 付费人数: 'right' }, units: { 收入金额: 'number' } },
      },
      revenueColumns,
    );
    expect(config.options.metric_axis).toEqual({ 付费人数: 'right' });

    const resolved = resolveVisualization({
      columns: [
        { name: 'd', type: 'Date' },
        { name: '付费人数', type: 'UInt64' },
        { name: '支付成功次数', type: 'UInt64' },
        { name: '收入金额', type: 'Float64' },
        { name: '客单价', type: 'Float64' },
        { name: '首充金额', type: 'Float64' },
        { name: '复充金额', type: 'Float64' },
      ],
      rows: [
        { d: '2026-09-01', 付费人数: 98, 支付成功次数: 210, 收入金额: 18641, 客单价: 190.2, 首充金额: 5200, 复充金额: 4300 },
        { d: '2026-09-02', 付费人数: 91, 支付成功次数: 198, 收入金额: 17002, 客单价: 186.8, 首充金额: 4800, 复充金额: 4100 },
      ],
      savedConfig: config,
    });
    expect(resolved.view).toBe('chart');
    const option = resolved.adapter?.option as { yAxis: unknown; series: { name: string; yAxisIndex?: number }[] };
    // 两个指标落在不同 Y 轴：yAxis 变成数组，且付费人数带 yAxisIndex=1
    expect(Array.isArray(option.yAxis)).toBe(true);
    expect(option.series.find((item) => item.name === '付费人数')?.yAxisIndex).toBe(1);
    expect(option.series.find((item) => item.name === '收入金额')?.yAxisIndex).toBe(0);
  });

  it('options 按整键替换：提案只写一个指标时，其余指标回到左轴（契约，不是缺陷）', () => {
    // 深合并会让「把某个指标挪回左轴」无法表达，所以整份替换是有意选择；
    // 模型必须先读 analysis.chart_config 再整份提交（见 Workspace 规范）。
    const current = materializeSqlChartProposal(
      {
        chart_type: 'line',
        bindings: { x: 'd', metrics: ['收入金额', '付费人数'] },
        options: { metric_axis: { 收入金额: 'right', 付费人数: 'right' } },
      },
      revenueColumns,
    );
    const next = materializeSqlChartProposal(
      {
        chart_type: 'line',
        bindings: { x: 'd', metrics: ['收入金额', '付费人数'] },
        options: { metric_axis: { 付费人数: 'right' } },
      },
      revenueColumns,
      current.options,
    );
    expect(next.options.metric_axis).toEqual({ 付费人数: 'right' });
  });
});
