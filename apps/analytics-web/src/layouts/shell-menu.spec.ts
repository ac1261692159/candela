import { describe, expect, it } from 'vitest';
import { SHELL_LOGOUT_KEY, SHELL_PROJECT_KEY, filterMenuByPermissions, isShellRouteMenuKey } from './shell-menu';

describe('isShellRouteMenuKey', () => {
  it('treats settings pages as routes and project/logout as chrome actions', () => {
    expect(isShellRouteMenuKey('/settings/profile')).toBe(true);
    expect(isShellRouteMenuKey('/report/dashboards')).toBe(true);
    expect(isShellRouteMenuKey(SHELL_PROJECT_KEY)).toBe(false);
    expect(isShellRouteMenuKey(SHELL_LOGOUT_KEY)).toBe(false);
  });
});

describe('filterMenuByPermissions', () => {
  it('hides meta for analyst codes', () => {
    const f = filterMenuByPermissions(['dashboard.view', 'model.query', 'cohort.view']);
    expect(f.showMeta).toBe(false);
    expect(f.showAnalysis).toBe(true);
    expect(f.showReport).toBe(true);
  });

  it('数据管理分组按子项裁剪（rbac-v3）：分析师有 metric.view 无 meta.view', () => {
    const analyst = filterMenuByPermissions([
      'dashboard.view',
      'model.query',
      'metric.view',
      'meta.picker.view',
      'cohort.view',
    ]);
    expect(analyst.showMeta).toBe(false);
    expect(analyst.showData).toBe(true);

    const plain = filterMenuByPermissions(['dashboard.view', 'model.query', 'meta.picker.view']);
    expect(plain.showData).toBe(false);

    const owner = filterMenuByPermissions(['meta.view']);
    expect(owner.showMeta).toBe(true);
    expect(owner.showData).toBe(true);
  });

  it('member only sees dashboards', () => {
    const f = filterMenuByPermissions(['dashboard.view', 'dashboard.view_all', 'dashboard.filter']);
    expect(f.showAnalysis).toBe(false);
    expect(f.showUser).toBe(false);
    expect(f.showMeta).toBe(false);
    expect(f.showReport).toBe(true);
  });

  it('project owner sees report analysis meta iam; ops-only super admin sees settings only', () => {
    const owner = filterMenuByPermissions([
      'dashboard.view',
      'model.card_save',
      'model.query',
      'model.sql',
      'cohort.view',
      'meta.view',
      'iam.member.view',
      'ops.owner.assign',
      'ops.apikey.manage',
      'ops.ai_workspace.manage',
    ]);
    expect(owner).toMatchObject({
      showReport: true,
      showCards: true,
      showAnalysis: true,
      showSql: true,
      showUser: true,
      showMeta: true,
      showIam: true,
      showOwners: true,
      showApiKeys: true,
      showAiWorkspace: true,
    });
    const ops = filterMenuByPermissions(['ops.owner.assign', 'ops.apikey.manage', 'ops.ai_workspace.manage']);
    expect(ops).toMatchObject({
      showReport: false,
      showAnalysis: false,
      showMeta: false,
      showIam: false,
      showOwners: true,
      showApiKeys: true,
      showAiWorkspace: true,
    });
  });

  it('external only gets report, member cannot open analysis', () => {
    const ext = filterMenuByPermissions(['dashboard.view', 'model.export']);
    expect(ext.showReport).toBe(true);
    expect(ext.showCards).toBe(false);
    expect(ext.showAnalysis).toBe(false);
    const member = filterMenuByPermissions(['dashboard.view', 'dashboard.view_all', 'dashboard.filter']);
    expect(member.showAnalysis).toBe(false);
    expect(member.showCards).toBe(false);
  });
});
