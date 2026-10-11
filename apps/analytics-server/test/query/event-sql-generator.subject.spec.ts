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

describe('EventSqlGeneratorService subject', () => {
  const attributeResolver = {
    inferDataType: jest.fn().mockResolvedValue('string'),
    resolve: jest.fn(async (prop: string) => `JSONExtractString(properties, '${prop}')`),
  };
  const virtualEventService = { findDefinition: jest.fn().mockResolvedValue(null) };
  const batches = { resolve: jest.fn().mockResolvedValue({ batch_id: 'b1', ready: true, subject_id: '' }) };

  it('dedupes by event-property subject and drops empty values', async () => {
    const service = new EventSqlGeneratorService(
      attributeResolver as never,
      virtualEventService as never,
      batches as never,
      batches as never,
      {
        resolve: jest.fn().mockResolvedValue({
          subject_id: 'asub_acctxx',
          kind: 'property',
          source: { scope: 'event', prop: 'account_id' },
        }),
      } as never,
    );
    const { sql } = await service.generate(makeQuery({ subject_id: 'asub_acctxx' }));
    expect(sql).toContain("JSONExtractString(properties, 'account_id')");
    expect(sql).toContain('uniqExactIf');
    expect(sql).toContain("!= ''");
  });
});
