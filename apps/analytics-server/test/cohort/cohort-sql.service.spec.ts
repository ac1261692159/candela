import { SqlAstGuardService } from '../../src/modules/report/sql-ast-guard.service';
import { DomainError } from '../../src/i18n/domain-error';
import {
  applySqlCohortLimit,
  assertSingleUidColumn,
  CohortSqlService,
} from '../../src/modules/cohort/cohort-sql.service';
import type { SqlDefinition } from '../../src/modules/cohort/cohort-definition';

jest.mock('../../src/modules/shared/clickhouse.service', () => ({ ClickHouseService: class ClickHouseService {} }));

describe('CohortSqlService', () => {
  const guard = new SqlAstGuardService();
  const definition: SqlDefinition = {
    sql_text:
      "SELECT if(user_key != '', user_key, distinct_id) AS uid FROM sa_events WHERE event = 'AppStart' GROUP BY uid",
    time_params: [
      { name: 'start', mode: 'last_n_days', n: 7, bound: 'start' },
      { name: 'end', mode: 'last_n_days', n: 7, bound: 'end' },
    ],
  };

  it('rejects illegal SQL before querying ClickHouse', async () => {
    const querySql = jest.fn();
    const service = new CohortSqlService(guard, { querySql } as never);
    const rejected = service.preview(
      'clklogapp',
      { ...definition, sql_text: 'INSERT INTO sa_events SELECT 1' },
      '2026-09-05',
    );
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 400, errorCode: 'report.sql.singleSelectOnly' });
    expect(querySql).not.toHaveBeenCalled();
  });

  it('rejects sa_cohort_members so circle-of-cohort cannot sneak into user SQL', async () => {
    const querySql = jest.fn();
    const service = new CohortSqlService(guard, { querySql } as never);
    await expect(
      service.preview(
        'clklogapp',
        { sql_text: 'SELECT uid FROM sa_cohort_members', time_params: [] },
        '2026-09-05',
      ),
    ).rejects.toThrow(/sa_events \/ sa_user_profiles/);
    expect(querySql).not.toHaveBeenCalled();
  });

  it('rejects a result that is not exactly one column', async () => {
    const querySql = jest.fn().mockResolvedValue({
      columns: [
        { name: 'uid', type: 'String' },
        { name: 'cnt', type: 'UInt64' },
      ],
      rows: [{ uid: 'a', cnt: 1 }],
    });
    const service = new CohortSqlService(guard, { querySql } as never);
    await expect(service.preview('clklogapp', definition, '2026-09-05')).rejects.toThrow(/恰好一列/);
  });

  it('runs the user SELECT via querySql (readonly) and injects table filters', async () => {
    const querySql = jest.fn().mockResolvedValue({
      columns: [{ name: 'uid', type: 'String' }],
      rows: [{ uid: 'u1' }, { uid: '' }, { uid: 'u1' }],
    });
    const service = new CohortSqlService(guard, { querySql } as never);
    const result = await service.preview('clklogapp', definition, '2026-09-05');
    expect(result.uids).toEqual(['u1']);
    expect(querySql).toHaveBeenCalledTimes(1);
    const [sql, , settings] = querySql.mock.calls[0];
    expect(sql).toContain('clklog_sa.sa_events');
    expect(sql).not.toContain('sa_cohort_members');
    expect(settings.additional_table_filters).toContain('clklogapp');
    expect(settings.max_execution_time).toBe(30);
  });

  it('caps LIMIT and requires a single uid column', () => {
    expect(applySqlCohortLimit('SELECT uid FROM sa_events LIMIT 9999999', 1000)).toBe(
      'SELECT uid FROM sa_events LIMIT 1000',
    );
    expect(() => assertSingleUidColumn([{ name: 'a' }, { name: 'b' }])).toThrow(DomainError);
    expect(() => assertSingleUidColumn([])).toThrow(DomainError);
    expect(() => assertSingleUidColumn([{ name: 'user_id' }])).not.toThrow();
  });
});
