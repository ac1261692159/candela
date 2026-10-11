import { describe, expect, it } from 'vitest';
import type { MetricItem } from '../../types/dsl.types';
import type { SavedMetric } from '../../types/meta.types';
import type { RetentionFormState } from '../../utils/dsl-builder';
import { appendEventMetric, applyRetentionDefinition, metricFromSavedEvent } from './apply-saved-metric';

function saved(partial: Partial<SavedMetric> & Pick<SavedMetric, 'kind' | 'definition_json'>): SavedMetric {
  return {
    metric_id: 'metric_abc123xxxx',
    project_name: 'clklogapp',
    owner: 'u1',
    name: 'dau',
    display_name: '日活',
    format: 'number',
    created_at: '',
    updated_at: '',
    ...partial,
  };
}

describe('apply-saved-metric', () => {
  it('copies an event metric with a new id and the catalog display name', () => {
    const item = metricFromSavedEvent(
      saved({
        kind: 'event',
        definition_json: {
          metric: { kind: 'event', analysis: 'trig_user_num', event: 'AppStart', alias: '触发用户数' },
        },
      }),
      'm_new',
    );
    expect(item).toMatchObject({
      id: 'm_new',
      kind: 'event',
      event: 'AppStart',
      analysis: 'trig_user_num',
      alias: '日活',
    });
    expect(metricFromSavedEvent(saved({ kind: 'retention', definition_json: { n: 1 } }), 'x')).toBeNull();
  });

  it('replaces a blank placeholder metric instead of appending a second empty row', () => {
    const blank: MetricItem = { id: 'm_0', kind: 'event', analysis: 'total_times' };
    const incoming: MetricItem = { id: 'm_new', kind: 'event', analysis: 'total_times', event: 'Pay' };
    expect(appendEventMetric([blank], incoming)).toEqual([{ ...incoming, id: 'm_0' }]);
    expect(appendEventMetric([{ ...blank, event: 'A' }], incoming)).toHaveLength(2);
  });

  it('fills retention events without freezing the current time range', () => {
    const form: RetentionFormState = {
      startEvent: 'Old',
      returnEvent: 'Old',
      startFilters: { logic: 'and', items: [] },
      returnFilters: { logic: 'and', items: [] },
      cohort: 'all',
      granularity: 'day',
      nList: [1, 30],
      timeRange: { start: '2026-08-01', end: '2026-08-31' },
    };
    const next = applyRetentionDefinition(
      form,
      saved({
        kind: 'retention',
        definition_json: {
          start_event: { event: 'AppStart' },
          retain_event: { event: 'Pay' },
          cohort: 'first_day',
          granularity: 'week',
          n: 7,
          measure: 'rate',
        },
      }),
    );
    expect(next).toMatchObject({
      startEvent: 'AppStart',
      returnEvent: 'Pay',
      cohort: 'first_day',
      granularity: 'week',
      nList: [1, 7, 30],
      timeRange: form.timeRange,
    });
  });
});
