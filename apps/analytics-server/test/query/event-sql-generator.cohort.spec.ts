import { EventSqlGeneratorService } from '../../src/modules/query/event-sql-generator.service';
import type { EventAnalysisQuery } from '../../src/types/dsl.types';

function makeQuery(patch: Partial<EventAnalysisQuery> = {}): EventAnalysisQuery {
  return {
    project: 'clklogapp',
    event: 'Pay',
    metrics: [{ id: 'm_0', kind: 'event', analysis: 'trig_user_num', event: 'Pay' }],
    time_range: { start: '2026-09-01', end: '2026-09-01' },
    ...patch,
  };
}

describe('EventSqlGeneratorService cohort', () => {
  const attributeResolver = {
    inferDataType: jest.fn().mockResolvedValue('string'),
    resolve: jest.fn(async (prop: string) => `JSONExtractString(properties, '${prop}')`),
  };
  const virtualEventService = { findDefinition: jest.fn().mockResolvedValue(null) };
  const cohortBatches = {
    resolve: jest.fn().mockResolvedValue({ batch_id: 'batch_ready', ready: true }),
  };
  const service = new EventSqlGeneratorService(
    attributeResolver as never,
    virtualEventService as never,
    cohortBatches as never,
    { resolve: jest.fn().mockResolvedValue({ batch_id: 'tag_batch', ready: true }) } as never,
    { resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_userxxxx', kind: 'preset' }) } as never,
  );

  it('filters by precomputed members and does not expand event predicates from the cohort rule', async () => {
    const { sql, params } = await service.generate(
      makeQuery({
        filters: {
          logic: 'and',
          items: [{ scope: 'cohort', prop: 'cohort_abc123xxxx', op: 'in' }],
        },
      }),
    );
    expect(sql).toContain('sa_cohort_members');
    expect(sql).toContain('batch_id');
    expect(sql).not.toContain('windowFunnel');
    expect(sql).not.toContain('sql_text');
    expect(sql).toContain('project_name =');
    expect(params.m0_project).toBe('clklogapp');
    expect(Object.values(params)).toContain('batch_ready');
    expect(cohortBatches.resolve).toHaveBeenCalledWith('clklogapp', 'cohort_abc123xxxx');
  });

  it('groups by 属于 / 不属于', async () => {
    const { sql } = await service.generate(
      makeQuery({
        groups: [{ scope: 'cohort', prop: 'cohort_abc123xxxx' }],
      }),
    );
    expect(sql).toContain("'属于'");
    expect(sql).toContain("'不属于'");
    expect(sql).toContain('sa_cohort_members');
  });
});
