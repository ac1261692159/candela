import { describe, expect, it } from 'vitest';
import { buildRetentionQuery } from './dsl-builder';
import { pickExampleEvents, lastNDaysRange } from '../features/query/example-query';

describe('buildRetentionQuery', () => {
  it('maps form fields onto the backend RetentionQuery shape', () => {
    const dsl = buildRetentionQuery(
      {
        startEvent: 'AppLaunch',
        returnEvent: 'Pay',
        startFilters: { logic: 'and', items: [] },
        returnFilters: { logic: 'and', items: [] },
        cohort: 'first_day',
        granularity: 'week',
        nList: [7, 1],
        timeRange: { start: '2026-08-01', end: '2026-08-31' },
      },
      'clklogapp',
    );
    expect(dsl.start_event.event).toBe('AppLaunch');
    expect(dsl.retain_event.event).toBe('Pay');
    expect(dsl.cohort).toBe('first_day');
    expect(dsl.n_list).toEqual([1, 7]);
    expect(dsl.project_name).toBe('clklogapp');
  });

  it('passes global cohort filter and group onto RetentionQuery', () => {
    const dsl = buildRetentionQuery(
      {
        startEvent: 'AppLaunch',
        returnEvent: 'Pay',
        startFilters: { logic: 'and', items: [] },
        returnFilters: { logic: 'and', items: [] },
        filters: { logic: 'and', items: [{ scope: 'cohort', prop: 'cohort_abc123xx', op: 'in' }] },
        groupCohortId: 'cohort_abc123xx',
        cohort: 'all',
        granularity: 'day',
        nList: [1],
        timeRange: { start: '2026-08-01', end: '2026-08-31' },
      },
      'clklogapp',
    );
    expect(dsl.filters?.items[0]).toMatchObject({ scope: 'cohort', prop: 'cohort_abc123xx', op: 'in' });
    expect(dsl.groups).toEqual([{ scope: 'cohort', prop: 'cohort_abc123xx' }]);
  });

  it('prefers tag group over cohort when both are set', () => {
    const dsl = buildRetentionQuery(
      {
        startEvent: 'AppLaunch',
        returnEvent: 'Pay',
        startFilters: { logic: 'and', items: [] },
        returnFilters: { logic: 'and', items: [] },
        filters: { logic: 'and', items: [{ scope: 'tag', prop: 'tag_abc123xx', op: '=', value: '高活' }] },
        groupCohortId: 'cohort_abc123xx',
        groupTagId: 'tag_abc123xx',
        cohort: 'all',
        granularity: 'day',
        nList: [1],
        timeRange: { start: '2026-08-01', end: '2026-08-31' },
      },
      'clklogapp',
    );
    expect(dsl.filters?.items[0]).toMatchObject({ scope: 'tag', prop: 'tag_abc123xx', op: '=' });
    expect(dsl.groups).toEqual([{ scope: 'tag', prop: 'tag_abc123xx' }]);
  });

  it('rejects missing events', () => {
    expect(() =>
      buildRetentionQuery({
        startEvent: '',
        returnEvent: 'Pay',
        startFilters: { logic: 'and', items: [] },
        returnFilters: { logic: 'and', items: [] },
        cohort: 'all',
        granularity: 'day',
        nList: [1],
        timeRange: { start: '2026-08-01', end: '2026-08-31' },
      }),
    ).toThrow('请选择初始事件');
  });
});

describe('example query helpers', () => {
  it('prefers common launch events and falls back to the first visible key', () => {
    expect(pickExampleEvents([{ event_key: 'Pay' }, { event_key: 'AppLaunch' }])).toEqual({
      first: 'AppLaunch',
      second: 'Pay',
    });
    expect(pickExampleEvents([{ event_key: 'hidden', status: 'hidden' }, { event_key: 'Shown' }]).first).toBe(
      'Shown',
    );
    const range = lastNDaysRange(7);
    expect(range.start <= range.end).toBe(true);
  });
});
