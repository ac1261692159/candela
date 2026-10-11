import { DomainError } from '../../src/i18n/domain-error';
import { DslValidatorService } from '../../src/modules/query/dsl-validator.service';
import {
  ANY_EVENT,
  MAX_EVENT_METRICS,
  type EventAnalysisQuery,
  type Metric,
} from '../../src/types/dsl.types';
import { evalFormula, mixStageMetricValue, normalizeMetric } from '../../src/modules/query/metric-normalize';

/** i18n v1：同步抛错断言统一为「DomainError + HTTP 状态 + 机器码」 */
function expectDomainError(fn: () => unknown, errorCode: string, status = 400) {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DomainError);
  expect(thrown).toMatchObject({ status, errorCode });
}

function makeQuery(metrics: Metric[], patch: Partial<EventAnalysisQuery> = {}): EventAnalysisQuery {
  return {
    project: 'clklogapp',
    event: 'Pay',
    metrics,
    time_range: { start: '2026-09-01', end: '2026-09-03' },
    ...patch,
  };
}

describe('event analysis ThinkingData alignment', () => {
  const service = new DslValidatorService();

  it('maps legacy count/uniq_user/per_user and accepts 10 metrics', () => {
    const mapped = normalizeMetric({ id: 'm_0', type: 'count' });
    expect(mapped.analysis).toBe('total_times');
    expect(normalizeMetric({ id: 'm_1', type: 'uniq_user' }).analysis).toBe('trig_user_num');
    expect(normalizeMetric({ id: 'm_2', type: 'per_user', func: 'count', prop: 'x' }).analysis).toBe(
      'per_capita_times',
    );
    expect(normalizeMetric({ id: 'm_3', type: 'per_user', func: 'uniq_user' }).analysis).toBe(
      'trig_user_num',
    );
    const metrics = Array.from({ length: MAX_EVENT_METRICS }, (_, i) => ({
      id: `m_${i}`,
      type: 'count' as const,
      event: 'Pay',
    }));
    expect(() => service.validateEventQuery(makeQuery(metrics))).not.toThrow();
  });

  it('rejects non-boolean approx and normalizes true', () => {
    expectDomainError(
      () =>
        service.validateEventQuery(
          makeQuery([{ id: 'm_0', kind: 'event', analysis: 'total_times', event: 'Pay' }], { approx: 'yes' as never }),
        ),
      'analysis.dsl.approxInvalid',
    );
    const q = makeQuery([{ id: 'm_0', kind: 'event', analysis: 'trig_user_num', event: 'Pay' }], { approx: true });
    service.validateEventQuery(q);
    expect(q.approx).toBe(true);
  });

  it('rejects 11 metrics and per_capita_num without prop', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      id: `m_${i}`,
      type: 'count' as const,
      event: 'Pay',
    }));
    expect(() => service.validateEventQuery(makeQuery(eleven))).toThrow(/最多 10/);
    expectDomainError(
      () =>
        service.validateEventQuery(
          makeQuery([{ id: 'm_0', kind: 'event', analysis: 'per_capita_num', event: 'Pay' }]),
        ),
      'analysis.dsl.metricPropRequired',
    );
  });

  it('accepts `$`-prefixed system properties (e.g. $is_first_day) and still rejects broken names', () => {
    const metrics: Metric[] = [
      { id: 'm_0', event: 'Pay', analysis: 'true_num', prop: '$is_first_day' },
    ];
    expect(() => service.validateEventQuery(makeQuery(metrics, { metrics }))).not.toThrow();
    const broken: Metric[] = [{ id: 'm_1', event: 'Pay', analysis: 'true_num', prop: 'has space' }];
    expect(() => service.validateEventQuery(makeQuery(broken, { metrics: broken }))).toThrow(/属性名不合法/);
  });

  it('accepts any-event and rejects minute range over 1 day', () => {
    expect(() =>
      service.validateEventQuery(
        makeQuery([{ id: 'm_0', kind: 'event', analysis: 'total_times', event: ANY_EVENT }]),
      ),
    ).not.toThrow();
    expect(() =>
      service.validateEventQuery(
        makeQuery([{ id: 'm_0', type: 'count', event: 'Pay' }], {
          groups: [{ scope: 'time', granularity: 'minute' }],
          time_range: { start: '2026-09-01', end: '2026-09-02' },
        }),
      ),
    ).toThrow(/1 天/);
  });

  it('rejects cyclic formulas and eval treats divide-by-zero as null', () => {
    expect(() =>
      service.validateEventQuery(
        makeQuery([
          { id: 'base', type: 'count', event: 'Pay' },
          {
            id: 'a',
            kind: 'formula',
            expression: { type: 'metric', id: 'b' },
          },
          {
            id: 'b',
            kind: 'formula',
            expression: { type: 'metric', id: 'a' },
          },
        ]),
      ),
    ).toThrow(/循环/);
    expect(
      evalFormula(
        { type: 'op', op: '/', left: { type: 'const', value: 1 }, right: { type: 'const', value: 0 } },
        {},
      ),
    ).toBeNull();
  });
});

describe('stage reduce', () => {
  it('does not add daily unique users for uniq_total', () => {
    expect(mixStageMetricValue('sum', [10, 10], 12)).toBe(20);
    expect(mixStageMetricValue('uniq_total', [10, 10], 12)).toBe(12);
  });
});
