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

describe('EventSqlGeneratorService tag', () => {
  const attributeResolver = {
    inferDataType: jest.fn().mockResolvedValue('string'),
    resolve: jest.fn(async (prop: string) => `JSONExtractString(properties, '${prop}')`),
  };
  const virtualEventService = { findDefinition: jest.fn().mockResolvedValue(null) };
  const cohortBatches = {
    resolve: jest.fn().mockResolvedValue({ batch_id: 'cohort_batch', ready: true }),
  };
  const tagBatches = {
    resolve: jest.fn().mockResolvedValue({ batch_id: 'tag_batch', ready: true }),
  };
  const service = new EventSqlGeneratorService(
    attributeResolver as never,
    virtualEventService as never,
    cohortBatches as never,
    tagBatches as never,
    { resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_userxxxx', kind: 'preset' }) } as never,
  );

  it('filters by sa_tag_members and does not expand tag definition_json', async () => {
    const { sql, params } = await service.generate(
      makeQuery({
        filters: {
          logic: 'and',
          items: [{ scope: 'tag', prop: 'tag_abc123xxxx', op: 'in', value: ['高活'] }],
        },
      }),
    );
    expect(sql).toContain('sa_tag_members');
    expect(sql).toContain('tag_value');
    expect(sql).not.toContain('definition_json');
    expect(sql).not.toContain('windowFunnel');
    expect(Object.values(params)).toContain('tag_batch');
    expect(tagBatches.resolve).toHaveBeenCalledWith('clklogapp', 'tag_abc123xxxx');
  });

  it('groups by tag value including 未打标 via LEFT JOIN', async () => {
    const { sql } = await service.generate(
      makeQuery({
        groups: [{ scope: 'tag', prop: 'tag_abc123xxxx' }],
      }),
    );
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('sa_tag_members');
    expect(sql).toContain('未打标');
    expect(sql).not.toContain('windowFunnel');
  });
});
