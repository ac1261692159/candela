import { subjectExpr, subjectForbidsNegativeUniverse, subjectProfileExpr, uniqExactSubject, uniqSubject } from '../../src/modules/subject/subject-expr';
import { JoinRegistry } from '../../src/modules/relation/join-registry';

describe('subjectExpr', () => {
  it('uses the preset user expression', () => {
    expect(subjectExpr({ subject_id: 'asub_user', kind: 'preset' })).toBe(
      "if(user_key != '', user_key, distinct_id)",
    );
    expect(subjectExpr(null)).toBe("if(user_key != '', user_key, distinct_id)");
  });

  it('extracts an event property and drops empty values from uniq', () => {
    const expr = subjectExpr({
      subject_id: 'asub_acct',
      kind: 'property',
      source: { scope: 'event', prop: 'account_id' },
    });
    expect(expr).toContain("JSONExtractString(properties, 'account_id')");
    expect(uniqExactSubject(expr)).toContain('uniqExactIf');
    expect(uniqExactSubject(expr)).toContain("!= ''");
    expect(uniqSubject(expr, true)).toContain('uniqCombinedIf(12)');
    expect(uniqSubject(expr, true)).not.toContain('uniqExact');
  });

  it('extracts $-prefixed system properties（AS-2.property_expr 回归锁定）', () => {
    // 2026-09-17 生产：PROP_KEY 拒绝 `$` 前缀 → propExtract 落到 ''，属性主体统归为 0
    const expr = subjectExpr({
      subject_id: 'asub_os',
      kind: 'property',
      source: { scope: 'event', prop: '$os' },
    });
    expect(expr).toContain("JSONExtractString(properties, '$os')");
    // 危险输入仍被拒绝并落回空主体（不进 JSONExtract，无注入面）
    const bad = subjectExpr({ subject_id: 'x', kind: 'property', source: { scope: 'event', prop: "a' OR 1=1 --" } });
    expect(bad).toBe("nullIf('', '')");
    expect(bad).not.toContain('OR');
  });

  it('reads a user-property subject from the injected profile JOIN', () => {
    const joins = new JoinRegistry();
    const expr = subjectExpr(
      {
        subject_id: 'asub_vip',
        kind: 'property',
        source: { scope: 'user', prop: 'vip_level' },
      },
      joins,
    );

    expect(expr).toBe("nullIf(JSONExtractString(up_1.properties, 'vip_level'), '')");
    expect(expr).not.toContain('sa_events.');
    const rendered = joins.render().join('\n');
    expect(rendered).toContain('LEFT JOIN (SELECT distinct_id AS uid, properties FROM clklog_sa.sa_user_profiles FINAL WHERE project_name = {project: String}) AS up_1');
    expect(rendered).toContain('ON sa_events.distinct_id = up_1.uid');

    // profile 侧（FROM sa_user_profiles）仍走直取列
    expect(
      subjectProfileExpr({
        subject_id: 'asub_vip',
        kind: 'property',
        source: { scope: 'user', prop: 'vip_level' },
      }),
    ).toContain("JSONExtractString(properties, 'vip_level')");
  });

  it('refuses a user-property subject without a JoinRegistry', () => {
    expect(() =>
      subjectExpr({
        subject_id: 'asub_vip',
        kind: 'property',
        source: { scope: 'user', prop: 'vip_level' },
      }),
    ).toThrow(/JoinRegistry/);
  });

  it('forbids 没做过 universe for event-property subjects', () => {
    expect(
      subjectForbidsNegativeUniverse({
        subject_id: 'asub_acct',
        kind: 'property',
        source: { scope: 'event', prop: 'account_id' },
      }),
    ).toBe(true);
    expect(subjectForbidsNegativeUniverse({ subject_id: 'asub_user', kind: 'preset' })).toBe(false);
  });
});
