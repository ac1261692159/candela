import { DomainError } from '../../src/i18n/domain-error';
import {
  collectCohortFunctionCalls,
  expandSaInCohortFunctions,
  mergeDashboardCohortFilter,
  parseDashboardCohortFilter,
} from '../../src/modules/report/sql-cohort-filter';

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

describe('sql-cohort-filter', () => {
  it('expands sa_in_cohort into a members subquery without SELECT *', () => {
    const sql = expandSaInCohortFunctions("SELECT 1 WHERE sa_in_cohort('cohort_abc123xxxx')", new Map([
      ['cohort_abc123xxxx', { project: 'clklogapp', batchId: 'b_ready' }],
    ]));
    expect(sql).toContain('sa_cohort_members');
    expect(sql).toContain("cohort_id = 'cohort_abc123xxxx'");
    expect(sql).toContain("batch_id = 'b_ready'");
    expect(sql).not.toContain('SELECT *');
    expect(sql).not.toContain('windowFunnel');
  });

  it('collects function calls and rejects unknown ids on expand', () => {
    expect(collectCohortFunctionCalls("WHERE sa_not_in_cohort('cohort_abc123xxxx')")).toEqual([
      { fn: 'sa_not_in_cohort', cohortId: 'cohort_abc123xxxx' },
    ]);
    expectDomainError(
      () => expandSaInCohortFunctions("sa_in_cohort('cohort_missingxx')", new Map()),
      'report.sql.cohortUnknown',
    );
  });

  it('merges dashboard cohort into analysis DSL and skips duplicate cohort_id', () => {
    const once = mergeDashboardCohortFilter(
      { filters: { logic: 'and', items: [] } },
      'event',
      { cohort_id: 'cohort_abc123xxxx', op: 'in' },
    );
    expect(once.dsl.filters).toMatchObject({
      logic: 'and',
      items: [{ scope: 'cohort', prop: 'cohort_abc123xxxx', op: 'in' }],
    });
    const twice = mergeDashboardCohortFilter(once.dsl, 'event', {
      cohort_id: 'cohort_abc123xxxx',
      op: 'not_in',
    });
    expect((twice.dsl.filters as { items: unknown[] }).items).toHaveLength(1);
  });

  it('does not rewrite handwritten SQL text when merging dashboard filter', () => {
    const merged = mergeDashboardCohortFilter(
      { mode: 'sql', sql_text: 'SELECT count() FROM sa_events' },
      'sql',
      { cohort_id: 'cohort_abc123xxxx', op: 'in' },
    );
    expect(merged.handwrittenSql).toBe(true);
    expect(merged.dsl.sql_text).toBe('SELECT count() FROM sa_events');
  });

  it('parses dashboard cohort_filter json', () => {
    expect(parseDashboardCohortFilter(null)).toBeNull();
    expect(parseDashboardCohortFilter({ cohort_id: 'cohort_abc123xxxx', op: 'not_in' })).toEqual({
      cohort_id: 'cohort_abc123xxxx',
      op: 'not_in',
    });
    expectDomainError(
      () => parseDashboardCohortFilter({ cohort_id: 'nope', op: 'in' }),
      'report.sql.cohortFilterIdInvalid',
    );
  });
});
