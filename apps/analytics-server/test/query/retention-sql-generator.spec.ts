import { RetentionSqlGeneratorService, extendDate } from '../../src/modules/query/retention-sql-generator.service';
import { DslValidatorService } from '../../src/modules/query/dsl-validator.service';
import type { RetentionQuery } from '../../src/types/dsl.types';

function makeQuery(patch: Partial<RetentionQuery> = {}): RetentionQuery {
  return {
    project: 'clklogapp',
    start_event: { event: 'AppLaunch' },
    retain_event: { event: 'AppLaunch' },
    cohort: 'all',
    granularity: 'day',
    n_list: [1, 7, 30],
    time_range: { start: '2026-08-01', end: '2026-08-31' },
    ...patch,
  };
}

describe('RetentionSqlGeneratorService', () => {
  const attributeResolver = {
    inferDataType: jest.fn().mockResolvedValue('string'),
    resolve: jest.fn(async (prop: string) => `JSONExtractString(properties, '${prop}')`),
  };
  const virtualEventService = {
    findDefinition: jest.fn().mockResolvedValue(null),
  };
  const cohortBatches = {
    resolve: jest.fn().mockResolvedValue({ batch_id: 'b1', ready: true }),
  };
  const service = new RetentionSqlGeneratorService(
    attributeResolver as never,
    virtualEventService as never,
    cohortBatches as never,
    { resolve: jest.fn().mockResolvedValue({ batch_id: 'b1', ready: true }) } as never,
    { resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_userxxxx', kind: 'preset' }) } as never,
  );

  it('injects project_name, scan window, LIMIT, and parameterizes event names', async () => {
    const injected = "'; DROP TABLE sa_events;--";
    const { sql, params } = await service.generate(
      makeQuery({ start_event: { event: injected }, retain_event: { event: 'Pay' } }),
    );
    expect(sql).toContain('project_name = {project: String}');
    expect(sql).toContain('stat_date BETWEEN {scan_start: String} AND {scan_end: String}');
    expect(sql).toContain('event IN {retention_events: Array(String)}');
    expect(sql).toContain('LIMIT {limit: UInt32}');
    expect(sql).not.toContain('DROP TABLE');
    expect(params.start_event).toBe(injected);
    expect(params.retention_events).toEqual([injected, 'Pay']);
    expect(params.scan_end).toBe('2026-09-30');
    expect(params.project).toBe('clklogapp');
  });

  it('uses is_first_day column or $is_first_day property for first_day cohort', async () => {
    const { sql } = await service.generate(makeQuery({ cohort: 'first_day' }));
    expect(sql).toContain('is_first_day = 1');
    expect(sql).toContain("JSONExtractString(properties, '$is_first_day')");
  });

  it('extends scan end by week/month offsets', () => {
    expect(extendDate('2026-01-31', 1, 'month')).toBe('2026-02-28');
    expect(extendDate('2026-01-01', 2, 'week')).toBe('2026-01-15');
  });

  it('omits event IN and start event predicate when the start event is any-event', async () => {
    const { sql, params } = await service.generate(
      makeQuery({ start_event: { event: '*' }, retain_event: { event: 'Pay' } }),
    );
    expect(sql).not.toContain('event IN {retention_events: Array(String)}');
    expect(sql).toContain('project_name = {project: String}');
    expect(params.retain_event).toBe('Pay');
    expect(params.start_event).toBeUndefined();
  });

  it('omits event IN when both start and return are any-event', async () => {
    const { sql, params } = await service.generate(
      makeQuery({ start_event: { event: '*' }, retain_event: { event: '*' } }),
    );
    expect(sql).not.toContain('event IN {retention_events: Array(String)}');
    expect(params.start_event).toBeUndefined();
    expect(params.retain_event).toBeUndefined();
  });
});

describe('DslValidatorService.validateRetentionQuery', () => {
  const validator = new DslValidatorService();

  it('rejects empty events and duplicate n_list', () => {
    expect(() => validator.validateRetentionQuery(makeQuery({ start_event: { event: '' } }))).toThrow();
    expect(() => validator.validateRetentionQuery(makeQuery({ n_list: [1, 1] }))).toThrow();
    expect(() => validator.validateRetentionQuery(makeQuery({ cohort: 'nope' as never }))).toThrow();
  });

  it('accepts a valid query', () => {
    expect(() => validator.validateRetentionQuery(makeQuery())).not.toThrow();
  });

  it('accepts any-event on start and return', () => {
    expect(() =>
      validator.validateRetentionQuery(makeQuery({ start_event: { event: '*' }, retain_event: { event: '*' } })),
    ).not.toThrow();
  });
});
