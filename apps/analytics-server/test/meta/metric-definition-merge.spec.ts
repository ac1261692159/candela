/**
 * 指标编辑：API 只传部分定义时不得丢字段（phase: clklog-analytics-metric-detail-v1）。
 *
 * 背景：`normalizeDefinition` 按白名单**重建**定义对象，调用方漏传的字段会直接消失。
 * 2026-09-15 生产验收实测到：`PUT /sa/api/meta/metrics/:id` 只传 `{analysis, event, prop}` 时，
 * 已存的 `filters` 与 `alias` 被静默清掉——界面上根本看不到的字段被改，属于数据破坏级行为。
 * 修复：规范化之前先合并已存定义（undefined=未提供→保留；null=显式清空→覆盖）。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { mergeMetricDefinition } from '../../src/modules/meta/metric-definition-merge';

const EVENT_STORED = {
  metric: {
    id: 'm_0',
    kind: 'event',
    analysis: 'total_times',
    event: 'Purchase',
    alias: '订单量',
    stage_reduce: 'sum',
    filters: { logic: 'and', items: [{ scope: 'event', prop: 'pay_type', op: '=', value: 'alipay' }] },
  },
};

const RETENTION_STORED = {
  start_event: { event: 'SignUp', filters: { logic: 'and', items: [{ scope: 'event', prop: 'channel', op: '=', value: 'app' }] } },
  retain_event: { event: 'Purchase' },
  cohort: 'first_day',
  granularity: 'week',
  n: 2,
  measure: 'count',
};

describe('事件指标定义合并', () => {
  it('只传部分字段时，filters / alias / stage_reduce 保留', () => {
    const merged = mergeMetricDefinition('event', EVENT_STORED, {
      metric: { kind: 'event', analysis: 'sum', event: 'Purchase', prop: 'amount' },
    });
    const metric = merged.metric as Record<string, unknown>;
    expect(metric.analysis).toBe('sum');
    expect(metric.prop).toBe('amount');
    expect(metric.alias).toBe('订单量');
    expect(metric.stage_reduce).toBe('sum');
    expect(metric.filters).toEqual(EVENT_STORED.metric.filters);
  });

  it('显式传 null 可以清空筛选（保留「能删掉」的能力）', () => {
    const merged = mergeMetricDefinition('event', EVENT_STORED, {
      metric: { analysis: 'sum', event: 'Purchase', prop: 'amount', filters: null },
    });
    expect((merged.metric as Record<string, unknown>).filters).toBeNull();
  });

  it('兼容把 metric 字段平铺在顶层的旧写法', () => {
    const merged = mergeMetricDefinition('event', EVENT_STORED, { analysis: 'avg', event: 'Purchase', prop: 'amount' });
    const metric = merged.metric as Record<string, unknown>;
    expect(metric.analysis).toBe('avg');
    expect(metric.alias).toBe('订单量');
  });

  it('已存定义为空（理论上不会发生）时不报错，直接用入参', () => {
    const incoming = { metric: { analysis: 'sum', event: 'Purchase', prop: 'amount' } };
    expect(mergeMetricDefinition('event', {}, incoming)).toBe(incoming);
  });
});

describe('留存指标定义合并', () => {
  it('只改周期时，两侧事件与其 filters、队列/粒度都保留', () => {
    const merged = mergeMetricDefinition('retention', RETENTION_STORED, { n: 7 });
    expect(merged.n).toBe(7);
    expect(merged.cohort).toBe('first_day');
    expect(merged.granularity).toBe('week');
    expect(merged.measure).toBe('count');
    expect((merged.start_event as Record<string, unknown>).filters).toEqual(
      RETENTION_STORED.start_event.filters,
    );
    expect((merged.start_event as Record<string, unknown>).event).toBe('SignUp');
  });

  it('替换回访事件时保留初始事件的筛选条件', () => {
    const merged = mergeMetricDefinition('retention', RETENTION_STORED, {
      retain_event: { event: 'OtherEvent' },
    });
    expect((merged.retain_event as Record<string, unknown>).event).toBe('OtherEvent');
    expect((merged.start_event as Record<string, unknown>).filters).toEqual(
      RETENTION_STORED.start_event.filters,
    );
  });

  it('同时接受 startEvent/retainEvent 驼峰写法', () => {
    const merged = mergeMetricDefinition('retention', RETENTION_STORED, {
      startEvent: { event: 'NewStart' },
      retainEvent: { event: 'NewRetain' },
    });
    expect((merged.start_event as Record<string, unknown>).event).toBe('NewStart');
    expect((merged.retain_event as Record<string, unknown>).event).toBe('NewRetain');
  });
});

describe('留存队列范围合并（phase: clklog-analytics-metric-v3）', () => {
  const stored = {
    version: 2,
    start_event: { event: 'A' },
    retain_event: { event: 'B' },
    cohort: 'all',
    granularity: 'day',
    n: 1,
    measure: 'rate',
    time_range: { relative: { kind: 'recent_n', n: 90 } },
  };

  it('改动队列范围会写进合并结果（否则编辑静默无效）', () => {
    const merged = mergeMetricDefinition('retention', stored, {
      time_range: { relative: { kind: 'recent_n', n: 60 } },
    }) as Record<string, unknown>;
    expect(merged.time_range).toEqual({ relative: { kind: 'recent_n', n: 60 } });
  });

  it('显式清空（null）会删掉队列范围，回到按周期推导', () => {
    const merged = mergeMetricDefinition('retention', stored, { time_range: null }) as Record<string, unknown>;
    expect('time_range' in merged).toBe(false);
  });

  it('未提交 time_range 时保留已存值', () => {
    const merged = mergeMetricDefinition('retention', stored, { n: 7 }) as Record<string, unknown>;
    expect(merged.time_range).toEqual({ relative: { kind: 'recent_n', n: 90 } });
    expect(merged.n).toBe(7);
  });
});
