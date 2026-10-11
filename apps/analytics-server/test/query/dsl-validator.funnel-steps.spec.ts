import { DomainError } from '../../src/i18n/domain-error';
import { DslValidatorService } from '../../src/modules/query/dsl-validator.service';
import { MAX_FUNNEL_STEPS, MIN_FUNNEL_STEPS, type FunnelQuery } from '../../src/types/dsl.types';

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

function makeQuery(stepCount: number): FunnelQuery {
  return {
    project: 'clklogapp',
    window_seconds: 86400,
    time_range: { start: '2026-08-01', end: '2026-09-04' },
    steps: Array.from({ length: stepCount }, (_, i) => ({ event: `step_event_${i}` })),
  };
}

describe('DslValidatorService funnel step limits', () => {
  const service = new DslValidatorService();

  it(`accepts ${MAX_FUNNEL_STEPS} steps`, () => {
    expect(() => service.validateFunnelQuery(makeQuery(MAX_FUNNEL_STEPS))).not.toThrow();
  });

  it(`rejects ${MAX_FUNNEL_STEPS + 1} steps`, () => {
    expectDomainError(
      () => service.validateFunnelQuery(makeQuery(MAX_FUNNEL_STEPS + 1)),
      'analysis.dsl.funnelStepsOutOfRange',
    );
    expect(() => service.validateFunnelQuery(makeQuery(MAX_FUNNEL_STEPS + 1))).toThrow(/2~32/);
  });

  it(`rejects fewer than ${MIN_FUNNEL_STEPS} steps`, () => {
    expect(() => service.validateFunnelQuery(makeQuery(1))).toThrow(/2~32/);
  });
});
