import { MetaSavedMetricService } from '../../src/modules/meta/meta-saved-metric.service';

describe('MetaSavedMetricService.normalizeDefinition', () => {
  const service = new MetaSavedMetricService({} as never, {} as never);

  it('keeps an event metric analysis and rejects formulas', () => {
    const def = service.normalizeDefinition('event', {
      metric: { kind: 'event', analysis: 'total_times', event: 'AppStart', alias: '总次数' },
    });
    expect(def).toMatchObject({ metric: { analysis: 'total_times', event: 'AppStart' } });
    expect(() => service.normalizeDefinition('event', { metric: { kind: 'formula' } })).toThrow();
  });

  it('requires start/return events and n for retention metrics', () => {
    const def = service.normalizeDefinition('retention', {
      start_event: { event: 'A' },
      retain_event: { event: 'B' },
      n: 7,
      measure: 'rate',
      cohort: 'all',
      granularity: 'day',
    });
    expect(def).toMatchObject({ n: 7, measure: 'rate', start_event: { event: 'A' } });
    expect(() => service.normalizeDefinition('retention', { n: 7, measure: 'rate' })).toThrow();
  });
});
