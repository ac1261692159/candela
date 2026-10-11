import { DomainError } from '../../src/i18n/domain-error';
import {
  collectTagFunctionCalls,
  expandSaTagFunctions,
  tagValuesFromDefinition,
} from '../../src/modules/report/sql-tag-filter';

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

describe('sql-tag-filter', () => {
  it('expands sa_tag_in into members subquery without definition rules', () => {
    const sql = expandSaTagFunctions("SELECT 1 WHERE sa_tag_in('tag_abc123xxxx', '高活')", new Map([
      ['tag_abc123xxxx', { project: 'clklogapp', batchId: 'b_ready' }],
    ]));
    expect(sql).toContain('sa_tag_members');
    expect(sql).toContain("tag_id = 'tag_abc123xxxx'");
    expect(sql).toContain("batch_id = 'b_ready'");
    expect(sql).toContain("'高活'");
    expect(sql).not.toContain('windowFunnel');
    expect(sql).not.toContain('definition_json');
  });

  it('collects function calls and rejects unknown ids on expand', () => {
    expect(collectTagFunctionCalls("WHERE sa_tag_not_in('tag_abc123xxxx', '低活')")).toEqual([
      { tagId: 'tag_abc123xxxx', values: ['低活'], op: 'not_in' },
    ]);
    expectDomainError(
      () => expandSaTagFunctions("sa_tag_in('tag_missingxx')", new Map()),
      'report.sql.tagUnknown',
    );
  });

  it('reads discrete values from definition_json', () => {
    expect(
      tagValuesFromDefinition({
        rules: [{ value: '高活' }, { value: '低活' }],
        default_value: '其他',
      }),
    ).toEqual(['高活', '低活', '其他']);
  });
});
