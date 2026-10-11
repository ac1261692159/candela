import { EventSqlGeneratorService } from '../../src/modules/query/event-sql-generator.service';

describe('event query isolation and binding', () => {
  it('binds event names and enforces project/date/result boundaries', async () => {
    const generator = new EventSqlGeneratorService(
      {} as never, { findDefinition: async () => null } as never, {} as never, {} as never,
      { resolve: async () => ({ kind: 'preset' }) } as never,
    );
    const injected = "purchase'; DROP TABLE x;--";
    const result = await generator.generate({ project: 'fixture', event: injected,
      metrics: [{ id: 'm_0', event: injected, kind: 'event', analysis: 'total_times' }],
      time_range: { start: '2026-08-01', end: '2026-08-02' } });
    expect(result.sql).not.toContain('DROP TABLE');
    expect(result.sql).toContain('project_name =');
    expect(result.sql).toContain('stat_date BETWEEN');
    expect(result.sql).toContain('LIMIT');
    expect(result.params.m0_event).toBe(injected);
    expect(result.params.m0_project).toBe('fixture');
  });
});

describe('boolean property filters', () => {
  it('compares boolean props via string extraction so text values match both storage shapes', async () => {
    const generator = new EventSqlGeneratorService(
      {
        inferDataType: async () => 'boolean',
        resolve: async () => "JSONExtractBool(properties, '$is_first_day')",
      } as never,
      { findDefinition: async () => null } as never,
      {} as never,
      {} as never,
      { resolve: async () => ({ kind: 'preset' }) } as never,
    );
    const result = await generator.generate({
      project: 'clklogapp',
      event: '$AppStart',
      metrics: [{ id: 'm_0', event: '$AppStart', kind: 'event', analysis: 'trig_user_num' }],
      filters: { logic: 'and', items: [
        { scope: 'event', prop: '$is_first_day', op: '=', value: 'true' },
      ] },
      time_range: { start: '2026-09-02', end: '2026-09-08' },
    });
    expect(result.sql).toContain("JSONExtractString(properties, '$is_first_day') = {");
    expect(result.sql).not.toContain('JSONExtractBool');
    expect(Object.values(result.params)).toContain('true');
  });
});

describe('event query time grouping order', () => {
  const generator = new EventSqlGeneratorService(
    {} as never,
    { findDefinition: async () => null } as never,
    {} as never,
    {} as never,
    { resolve: async () => ({ kind: 'preset' }) } as never,
  );

  it('orders a single metric by day ascending instead of the metric', async () => {
    const result = await generator.generate({
      project: 'clklogapp',
      event: '$AppStart',
      metrics: [{ id: 'm_0', event: '$AppStart', kind: 'event', analysis: 'trig_user_num' }],
      groups: [{ scope: 'time', granularity: 'day' }],
      time_range: { start: '2026-09-02', end: '2026-09-08' },
    });
    expect(result.sql).toContain('ORDER BY g_0 ASC');
    expect(result.sql).not.toMatch(/ORDER BY m_0 DESC/);
  });

  it('orders joined metrics by day ascending', async () => {
    const result = await generator.generate({
      project: 'clklogapp',
      event: '$AppStart',
      metrics: [
        { id: 'm_0', event: '$AppStart', kind: 'event', analysis: 'trig_user_num' },
        { id: 'm_1', event: '$AppStart', kind: 'event', analysis: 'total_times' },
      ],
      groups: [{ scope: 'time', granularity: 'day' }],
      time_range: { start: '2026-09-02', end: '2026-09-08' },
    });
    expect(result.sql).toContain('ORDER BY g_0 ASC');
    expect(result.sql).not.toMatch(/ORDER BY m_0 DESC/);
  });
});
