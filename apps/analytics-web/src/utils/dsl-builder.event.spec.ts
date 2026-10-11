import { describe, expect, it } from 'vitest';
import { buildEventQuery, hydrateEventForm } from './dsl-builder';

const range = { start: '2026-08-01', end: '2026-08-31' };

describe('hydrateEventForm', () => {
  it('copies a legacy top-level event onto metrics that omitted it', () => {
    const next = hydrateEventForm({
      event: 'AppLaunch',
      metrics: [{ id: 'm_0', type: 'count', alias: '触发次数' }],
      filters: { logic: 'and', items: [] },
      groups: [],
      timeRange: range,
    });
    expect(next.metrics[0].event).toBe('AppLaunch');
    expect(next.event).toBe('AppLaunch');
  });
});

describe('buildEventQuery', () => {
  it('uses each metric event and keeps query.event as the first metric', () => {
    const dsl = buildEventQuery(
      {
        metrics: [
          { id: 'm_0', type: 'count', alias: '启动次数', event: 'AppLaunch' },
          { id: 'm_1', type: 'uniq_user', alias: '付费用户', event: 'Pay' },
        ],
        filters: { logic: 'and', items: [] },
        groups: [{ scope: 'time', granularity: 'day' }],
        timeRange: range,
      },
      'clklogapp',
    );
    expect(dsl.event).toBe('AppLaunch');
    expect(dsl.metrics.map((item) => item.event)).toEqual(['AppLaunch', 'Pay']);
    expect(dsl.project_name).toBe('clklogapp');
  });

  it('rejects a metric without an event', () => {
    expect(() =>
      buildEventQuery({
        metrics: [{ id: 'm_0', type: 'count', alias: '总次数' }],
        filters: { logic: 'and', items: [] },
        groups: [],
        timeRange: range,
      }),
    ).toThrow('请为每个指标选择事件');
  });

  it('accepts any-event and maps legacy uniq_user', () => {
    const dsl = buildEventQuery(
      {
        metrics: [{ id: 'm_0', type: 'uniq_user', alias: '人数', event: '*' }],
        filters: { logic: 'and', items: [] },
        groups: [],
        timeRange: range,
      },
      'clklogapp',
    );
    expect(dsl.event).toBe('*');
    expect(dsl.metrics[0].analysis).toBe('trig_user_num');
  });

  it('omits approx unless checked', () => {
    const exact = buildEventQuery(
      {
        metrics: [{ id: 'm_0', type: 'uniq_user', alias: '人数', event: '*' }],
        filters: { logic: 'and', items: [] },
        groups: [],
        timeRange: range,
      },
      'clklogapp',
    );
    expect(exact.approx).toBeUndefined();
    const approx = buildEventQuery(
      {
        metrics: [{ id: 'm_0', type: 'uniq_user', alias: '人数', event: '*' }],
        filters: { logic: 'and', items: [] },
        groups: [],
        timeRange: range,
        approx: true,
      },
      'clklogapp',
    );
    expect(approx.approx).toBe(true);
  });

  it('maps dimension grouping to event scope for the API', () => {
    const dsl = buildEventQuery(
      {
        metrics: [{ id: 'm_0', type: 'count', alias: '总次数', event: 'Pay' }],
        filters: { logic: 'and', items: [] },
        groups: [{ scope: 'dimension', prop: 'goods_id@goods_name', topn: 20 }],
        timeRange: range,
      },
      'clklogapp',
    );
    expect(dsl.groups).toEqual([{ scope: 'event', prop: 'goods_id@goods_name', topn: 20 }]);
  });
});

describe('dimension grouping in the editor', () => {
  it('hydrates event@field groups back to dimension scope', () => {
    const next = hydrateEventForm({
      metrics: [{ id: 'm_0', type: 'count', alias: '总次数', event: 'Pay' }],
      filters: { logic: 'and', items: [] },
      groups: [{ scope: 'event', prop: 'goods_id@goods_name', topn: 20 }],
      timeRange: range,
    });
    expect(next.groups[0].scope).toBe('dimension');
  });
});
