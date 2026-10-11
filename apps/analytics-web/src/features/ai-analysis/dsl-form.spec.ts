import { describe, expect, it } from 'vitest';
import { eventForm, funnelForm, retentionForm } from './dsl-form';
import { buildEventQuery, buildFunnelQuery, buildRetentionQuery } from '../../utils/dsl-builder';
import cases from '../../../../analytics-harness-host/plugins/analytics-tools/analysis-cases.json';

const clean = (value: unknown) => JSON.parse(JSON.stringify(value));
describe('Harness DSL to live analysis form', () => {
  it('preserves all event metric, filter and date semantics through the page builder', () => {
    expect(clean(buildEventQuery(eventForm(cases.event)))).toEqual(cases.event);
  });
  it('preserves funnel steps and conversion window', () => {
    expect(clean(buildFunnelQuery(funnelForm(cases.funnel)))).toEqual(cases.funnel);
  });
  it('preserves both retention filters, offsets and cohort', () => {
    expect(clean(buildRetentionQuery(retentionForm(cases.retention)))).toEqual(cases.retention);
  });
  it('rejects options the editor cannot represent instead of silently dropping them', () => {
    expect(() => eventForm({ ...cases.event, limit: 42 })).toThrow('不能完整表达');
    expect(() => funnelForm({ ...cases.funnel, window_seconds: 60 })).toThrow('整天');
    expect(() => retentionForm({ ...cases.retention, groups: [{ scope: 'event', prop: 'module_name' }] })).toThrow('仅支持');
  });
});
