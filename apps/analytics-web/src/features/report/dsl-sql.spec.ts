import { dslToSql } from './dsl-sql';
import type { BuilderDsl } from './GroupByPanel';
import { describe, expect, it } from 'vitest';

describe('dslToSql cohort', () => {
  it('emits sa_in_cohort member predicate and uid uniq, not event-rule SQL', () => {
    const dsl: BuilderDsl = {
      event: 'AppStart',
      groups: [{ kind: 'cohort', prop: 'cohort_abc123xxxx' }],
      metrics: [{ fn: 'uniq' }],
      filters: { logic: 'and', items: [{ scope: 'cohort', prop: 'cohort_abc123xxxx', op: 'in' }] },
    };
    const sql = dslToSql(dsl);
    expect(sql).toContain("sa_in_cohort('cohort_abc123xxxx')");
    expect(sql).toContain("uniqExact(if(user_key != '', user_key, distinct_id))");
    expect(sql).not.toContain('windowFunnel');
    expect(sql).not.toContain('definition_json');
  });

  it('emits sa_tag_in / sa_tag_value and uid uniq, not tag-rule SQL', () => {
    const dsl: BuilderDsl = {
      event: 'AppStart',
      groups: [{ kind: 'tag', prop: 'tag_abc123xxxx' }],
      metrics: [{ fn: 'uniq' }],
      filters: { logic: 'and', items: [{ scope: 'tag', prop: 'tag_abc123xxxx', op: 'in', value: ['高活'] }] },
    };
    const sql = dslToSql(dsl);
    expect(sql).toContain("sa_tag_in('tag_abc123xxxx', '高活')");
    expect(sql).toContain("sa_tag_value('tag_abc123xxxx')");
    expect(sql).toContain("uniqExact(if(user_key != '', user_key, distinct_id))");
    expect(sql).not.toContain('windowFunnel');
    expect(sql).not.toContain('definition_json');
  });
});
