import { CohortConditionSqlService } from '../../src/modules/cohort/cohort-condition-sql.service';

describe('CohortConditionSqlService', () => {
  const virtualEvents = { findDefinition: jest.fn().mockResolvedValue(null) };
  const attributes = {
    inferDataType: jest.fn().mockResolvedValue('string'),
    resolve: jest.fn().mockResolvedValue("JSONExtractString(properties, 'vip')"),
  };
  const service = new CohortConditionSqlService(virtualEvents as never, attributes as never, {
    resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_userxxxx', kind: 'preset' }),
  } as never);

  it('inserts members with project_name, time window and LIMIT', async () => {
    const { sql, params } = await service.buildInsertSelect(
      'clklogapp',
      'cohort_abc123xx',
      'b_ready',
      {
        conditions: [
          {
            type: 'did_event',
            polarity: 'did',
            event: 'AppStart',
            metric: 'times',
            op: 'gt',
            value: 0,
            time: { mode: 'last_n_days', n: 7 },
          },
        ],
      },
      '2026-09-05',
    );
    expect(sql).toContain('INSERT INTO clklog_sa.sa_cohort_members');
    expect(sql).toContain('project_name = {project: String}');
    expect(sql).toContain('stat_date BETWEEN');
    expect(sql).toContain('LIMIT 1000000');
    expect(params.project).toBe('clklogapp');
    expect(params.c0_start).toBe('2026-08-29');
    expect(params.c0_end).toBe('2026-09-04');
  });
});
