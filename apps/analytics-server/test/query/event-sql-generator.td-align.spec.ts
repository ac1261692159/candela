import { EventSqlGeneratorService } from '../../src/modules/query/event-sql-generator.service';
import { ANY_EVENT, type EventAnalysisQuery, type Metric } from '../../src/types/dsl.types';

function makeQuery(metrics: Metric[], patch: Partial<EventAnalysisQuery> = {}): EventAnalysisQuery {
  return {
    project: 'clklogapp',
    event: 'Pay',
    metrics,
    time_range: { start: '2026-09-01', end: '2026-09-01' },
    ...patch,
  };
}

describe('EventSqlGeneratorService ThinkingData methods', () => {
  const attributeResolver = {
    inferDataType: jest.fn().mockResolvedValue('number'),
    resolve: jest.fn(async (prop: string) => `JSONExtractFloat(properties, '${prop}')`),
  };
  const virtualEventService = {
    findDefinition: jest.fn().mockResolvedValue(null),
  };
  const cohortBatches = {
    resolve: jest.fn().mockResolvedValue({ batch_id: 'b1', ready: true }),
  };
  const service = new EventSqlGeneratorService(
    attributeResolver as never,
    virtualEventService as never,
    cohortBatches as never,
    { resolve: jest.fn().mockResolvedValue({ batch_id: 'b1', ready: true }) } as never,
    { resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_userxxxx', kind: 'preset' }) } as never,
  );

  it('omits event predicate for any-event and still bounds project and date', async () => {
    const { sql, params } = await service.generate(
      makeQuery([{ id: 'm_0', kind: 'event', analysis: 'total_times', event: ANY_EVENT }]),
    );
    expect(sql).not.toMatch(/AND event =/);
    expect(sql).toContain('project_name =');
    expect(sql).toContain('stat_date BETWEEN');
    expect(params.m0_project).toBe('clklogapp');
  });

  it('uses uniqCombined when approx is on', async () => {
    const { sql } = await service.generate(
      makeQuery(
        [
          { id: 'm_0', kind: 'event', analysis: 'trig_user_num', event: 'Pay' },
          {
            id: 'm_1',
            kind: 'event',
            analysis: 'per_capita_num',
            event: 'Pay',
            prop: 'amount',
          },
          { id: 'm_2', kind: 'event', analysis: 'distinct', event: 'Pay', prop: 'sku' },
        ],
        { approx: true },
      ),
    );
    expect(sql).toContain('uniqCombinedIf(12)');
    expect(sql).toContain('uniqCombined(12)');
    expect(sql).not.toContain('uniqExact');
  });

  it('keeps uniqExact when approx is off', async () => {
    const { sql } = await service.generate(
      makeQuery([{ id: 'm_0', kind: 'event', analysis: 'trig_user_num', event: 'Pay' }]),
    );
    expect(sql).toContain('uniqExactIf');
    expect(sql).not.toContain('uniqCombined');
  });

  it('generates per-capita value as sum/uniqExact', async () => {
    const { sql } = await service.generate(
      makeQuery([
        {
          id: 'm_0',
          kind: 'event',
          analysis: 'per_capita_num',
          event: 'Pay',
          prop: 'amount',
        },
      ]),
    );
    expect(sql).toContain('sum(JSONExtractFloat(properties, \'amount\')) / uniqExact');
    expect(sql).toContain("event = {m0_event: String}");
  });

  it('uses toStartOfMinute for minute grouping', async () => {
    const { sql } = await service.generate(
      makeQuery([{ id: 'm_0', type: 'count', event: 'Pay' }], {
        groups: [{ scope: 'time', granularity: 'minute' }],
      }),
    );
    expect(sql).toContain('toStartOfMinute(log_time)');
  });

  it('skips time grouping for total granularity', async () => {
    const { sql } = await service.generate(
      makeQuery([{ id: 'm_0', type: 'count', event: 'Pay' }], {
        groups: [{ scope: 'time', granularity: 'total' }],
      }),
    );
    expect(sql).not.toContain('toStartOfDay');
    expect(sql).not.toContain('GROUP BY');
  });

  it('casts string properties to float for numeric aggregations', async () => {
    attributeResolver.inferDataType.mockResolvedValue('string');
    attributeResolver.resolve.mockImplementation(async (prop: string, ...rest: unknown[]) => {
      const dataType = rest[1];
      return dataType === 'number' || dataType == null
        ? `JSONExtractFloat(properties, '${prop}')`
        : `JSONExtractString(properties, '${prop}')`;
    });
    const { sql } = await service.generate(
      makeQuery([
        { id: 'm_0', kind: 'event', analysis: 'sum', event: 'Pay', prop: 'pay_amount' },
      ]),
    );
    expect(sql).toContain("sum(toFloat64OrZero(toString(JSONExtractFloat(properties, 'pay_amount'))))");
    attributeResolver.inferDataType.mockResolvedValue('number');
    attributeResolver.resolve.mockImplementation(async (prop: string) => `JSONExtractFloat(properties, '${prop}')`);
  });
});
