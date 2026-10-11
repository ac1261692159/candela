import { unionPermissions, mergePolicies, maxRole, sanitizeAdminOverlay } from './iam-evaluate';
import { codesForRole } from './permission-catalog';
import { emptyScope } from './iam.types';
import { decideAssetWrite } from './asset-policy-decide';
import { eventsPredicate, assertEventsAllowed } from './data-scope';

describe('iam-evaluate', () => {
  it('super_admin without project role only gets ops', () => {
    const set = unionPermissions('super_admin', []);
    expect(set.has('ops.user.manage')).toBe(true);
    expect(set.has('dashboard.view')).toBe(false);
  });

  it('project_owner maps catalog.owner and unions ops for super_admin', () => {
    expect(codesForRole('project_owner')).toContain('dashboard.view');
    expect(codesForRole('project_owner')).toContain('iam.member.view');
    const set = unionPermissions('super_admin', ['project_owner']);
    expect(set.has('dashboard.view')).toBe(true);
    expect(set.has('model.query')).toBe(true);
    expect(set.has('ops.owner.assign')).toBe(true);
  });

  it('direct role union group roles takes widest codes', () => {
    const set = unionPermissions('none', ['analyst', 'member']);
    expect(set.has('model.query')).toBe(true);
    expect(set.has('dashboard.filter')).toBe(true);
    // rbac-v5：看板默认可见只留 owner / 分析管理员，取最宽也不再产生 view_all
    expect(set.has('dashboard.view_all')).toBe(false);
    expect(set.has('meta.edit')).toBe(false);
    expect(maxRole(['analyst', 'member'])).toBe('analyst');
  });

  it('analysis_admin overlay replaces default admin project codes', () => {
    const overlay = sanitizeAdminOverlay(['dashboard.view', 'iam.role.edit_admin', 'ops.user.manage']);
    expect(overlay).toEqual(['dashboard.view']);
    const set = unionPermissions('none', ['analysis_admin'], overlay);
    expect(set.has('dashboard.view')).toBe(true);
    expect(set.has('meta.edit')).toBe(false);
    expect(set.has('iam.role.edit_admin')).toBe(false);
  });

  it('groups cannot produce owner via maxRole of analyst+admin', () => {
    expect(maxRole(['analyst', 'analysis_admin'])).toBe('analysis_admin');
    expect(codesForRole('analysis_admin').includes('iam.role.edit_admin')).toBe(false);
  });

  it('用户行为序列权限 timeline.view：分析师/分析管理员/owner 有，普通成员与外部没有（phase: clklog-analytics-user-timeline-v1）', () => {
    for (const role of ['project_owner', 'analysis_admin', 'analyst'] as const) {
      expect(codesForRole(role)).toContain('timeline.view');
    }
    for (const role of ['member', 'external'] as const) {
      expect(codesForRole(role)).not.toContain('timeline.view');
    }
    // 与 cohort.view 同口径：分析域权限都是**项目域**，超管也要有项目角色才拿到（分项目隔离），
    // 目录里只有 ops.* 五个码带 ops 标记、由超管自动全权。
    const superOnly = unionPermissions('super_admin', []);
    expect(superOnly.has('timeline.view')).toBe(superOnly.has('cohort.view'));
    expect(superOnly.has('timeline.view')).toBe(false);
    expect(unionPermissions('super_admin', ['project_owner']).has('timeline.view')).toBe(true);
  });

  it('mergePolicies intersects allow lists and ANDs row filters', () => {
    const merged = mergePolicies([
      {
        events: { mode: 'allow', keys: ['a', 'b'] },
        event_properties: { mode: 'all', keys: [] },
        user_properties: { mode: 'all', keys: [] },
        row_filter: { rel: 'and', children: [{ prop: 'channel', op: '=', value: 'app' }] },
      },
      {
        events: { mode: 'allow', keys: ['b', 'c'] },
        event_properties: { mode: 'all', keys: [] },
        user_properties: { mode: 'all', keys: [] },
      },
    ]);
    expect(merged.events).toEqual({ mode: 'allow', keys: ['b'] });
    expect(merged.row_filter).toHaveLength(1);
    expect(emptyScope(true).unrestricted).toBe(true);
  });
});

describe('asset-policy-decide', () => {
  const base = {
    isProjectAdmin: false,
    hasLockPerm: false,
    hasGrantPerm: false,
    isCreator: true,
    effectivelyLocked: false,
    hasEditGrant: false,
    hasEditAcls: false,
  };

  it('lock and edit grant are mutually exclusive', () => {
    expect(
      decideAssetWrite({
        ...base,
        action: 'lock',
        locking: true,
        hasLockPerm: true,
        hasEditAcls: true,
      }),
    ).toBe('conflict_lock');
    expect(
      decideAssetWrite({
        ...base,
        action: 'grant',
        grantingEdit: true,
        hasGrantPerm: true,
        effectivelyLocked: true,
      }),
    ).toBe('conflict_grant');
  });

  it('analyst can delete own unlocked draft but not locked or others', () => {
    expect(decideAssetWrite({ ...base, action: 'delete' })).toBe('allow');
    expect(decideAssetWrite({ ...base, action: 'delete', effectivelyLocked: true })).toBe('forbidden');
    expect(decideAssetWrite({ ...base, action: 'delete', isCreator: false, hasEditGrant: true })).toBe(
      'forbidden',
    );
  });

  it('project admin can update locked assets; grantee cannot', () => {
    expect(
      decideAssetWrite({ ...base, action: 'update', isProjectAdmin: true, effectivelyLocked: true }),
    ).toBe('allow');
    expect(
      decideAssetWrite({ ...base, action: 'update', isCreator: false, hasEditGrant: true, effectivelyLocked: true }),
    ).toBe('forbidden');
    expect(decideAssetWrite({ ...base, action: 'update', isCreator: false, hasEditGrant: true })).toBe('allow');
  });
});

describe('data-scope', () => {
  it('eventsPredicate injects allowlist and row filter', () => {
    const sql = eventsPredicate({
      unrestricted: false,
      events: { mode: 'allow', keys: ['AppLaunch'] },
      event_properties: { mode: 'all', keys: [] },
      user_properties: { mode: 'all', keys: [] },
      row_filter: [{ prop: 'channel', op: '=', value: 'app' }],
    });
    expect(sql).toContain("event IN ('AppLaunch')");
    expect(sql).toContain('sa_user_profiles');
  });

  it('assertEventsAllowed rejects keys outside allowlist', () => {
    expect(() =>
      assertEventsAllowed(
        {
          unrestricted: false,
          events: { mode: 'allow', keys: ['a'] },
          event_properties: { mode: 'all', keys: [] },
          user_properties: { mode: 'all', keys: [] },
          row_filter: [],
        },
        ['b'],
      ),
    ).toThrow();
  });

  it('all ∩ allow keeps allow; empty policy list is restricted all-events', () => {
    const merged = mergePolicies([
      {
        events: { mode: 'all', keys: [] },
        event_properties: { mode: 'all', keys: [] },
        user_properties: { mode: 'all', keys: [] },
      },
      {
        events: { mode: 'allow', keys: ['x'] },
        event_properties: { mode: 'all', keys: [] },
        user_properties: { mode: 'all', keys: [] },
      },
    ]);
    expect(merged.events).toEqual({ mode: 'allow', keys: ['x'] });
    expect(merged.unrestricted).toBe(false);
    expect(mergePolicies([]).events.mode).toBe('all');
  });
});
