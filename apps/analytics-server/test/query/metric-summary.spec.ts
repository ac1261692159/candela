/**
 * 口径摘要结构（phase: clklog-analytics-i18n-v1 收口）的**同一性**用例：
 * 结构 + 前端 `metrics:summary.*` 必须拼出与后端 `definitionSummary` 逐字一致的中文，
 * 因此这里把后端中文串写成断言（前端 `metric-definition.spec.ts` 用同一批字面量做交叉验证）。
 */
import { definitionSummary } from '../../src/modules/alerting/alert-metric-eval';
import { metricSummaryStructure } from '../../src/modules/query/metric-summary';

describe('metricSummaryStructure', () => {
  it('事件指标：窗口 / 取值 / 属性段与中文串逐字对应', () => {
    const definition = {
      metric: {
        event: 'pv',
        analysis: 'sum',
        prop: 'amount',
        time_range: { start: '', end: '', relative: { kind: 'recent_n', n: 7 } },
        value_pick: 'sum',
      },
    };
    expect(definitionSummary('event', definition)).toBe('事件 pv · 计算 sum · amount · 近 7 天（含今天） · 累计');
    expect(metricSummaryStructure('event', definition)).toEqual({
      kind: 'event',
      event: 'pv',
      analysis: 'sum',
      prop: 'amount',
      window: { days: 7, relative: { kind: 'recent_n', n: 7 }, source: 'metric' },
      value_pick: 'sum',
    });
  });

  it('未设查询时间与取值：结构与中文串都少这两段', () => {
    const definition = { metric: { event: 'pv', analysis: 'total_times' } };
    expect(definitionSummary('event', definition)).toBe('事件 pv · 计算 total_times');
    expect(metricSummaryStructure('event', definition)).toEqual({
      kind: 'event',
      event: 'pv',
      analysis: 'total_times',
    });
  });

  it('未指定事件：中文占位由前端 `metrics:summary.noEvent` 渲染，结构里 event 缺省', () => {
    const definition = { metric: { analysis: 'total_times' } };
    expect(definitionSummary('event', definition)).toBe('事件 (未指定事件) · 计算 total_times');
    expect(metricSummaryStructure('event', definition)).toEqual({
      kind: 'event',
      analysis: 'total_times',
    });
  });

  it('非法查询时间（无 relative）走默认 7 天短形态：不下发 relative', () => {
    const definition = {
      metric: {
        event: 'pv',
        analysis: 'sum',
        // 指标只允许相对范围：固定日期会被 metricTimeRange 判非法 → 默认 7 天
        time_range: { start: '2026-01-01', end: '2026-01-07' },
      },
    };
    expect(definitionSummary('event', definition)).toBe('事件 pv · 计算 sum · 近 7 天');
    expect(metricSummaryStructure('event', definition)).toEqual({
      kind: 'event',
      event: 'pv',
      analysis: 'sum',
      window: { days: 7, relative: null, source: 'default' },
    });
  });

  it('留存指标：初始 → 回访 · 周期 · 口径', () => {
    const definition = {
      start_event: { event: 'pv' },
      retain_event: { event: 'pv2' },
      n: 7,
      measure: 'rate',
    };
    expect(definitionSummary('retention', definition)).toBe('留存 pv → pv2 · 7 天 · 留存率');
    expect(metricSummaryStructure('retention', definition)).toEqual({
      kind: 'retention',
      start_event: 'pv',
      retain_event: 'pv2',
      n: 7,
      measure: 'rate',
    });

    const count = { ...definition, measure: 'count' };
    expect(definitionSummary('retention', count)).toBe('留存 pv → pv2 · 7 天 · 人数');
    expect(metricSummaryStructure('retention', count)).toMatchObject({
      measure: 'count',
      start_event: 'pv',
      retain_event: 'pv2',
    });
  });

  it('未知 kind：结构只有 kind，中文兜底串保持原值', () => {
    expect(definitionSummary('sql', {})).toBe('sql');
    expect(metricSummaryStructure('sql', {})).toEqual({ kind: 'sql' });
  });
});
