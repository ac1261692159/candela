export const SHELL_LOGOUT_KEY = 'logout';
export const SHELL_PROJECT_KEY = 'settings-project';

/** 只有以 / 开头的菜单 key 才走路由；项目切换和退出登录不是页面。 */
export function isShellRouteMenuKey(key: string): boolean {
  return key.startsWith('/');
}

export function hasPerm(permissions: Iterable<string>, code: string): boolean {
  const set = permissions instanceof Set ? permissions : new Set(permissions);
  return set.has(code);
}

export interface ShellMenuNode {
  key: string;
  label: string;
  children?: { key: string; label: string }[];
}

/** 按权限码裁剪菜单。无项目成员时只留设置。 */
export function filterMenuByPermissions(permissions: Iterable<string>): {
  showReport: boolean;
  showAnalysis: boolean;
  showTimeline: boolean;
  showUser: boolean;
  showMeta: boolean;
  showData: boolean;
  showIam: boolean;
  showApiKeys: boolean;
  showAiWorkspace: boolean;
  showOwners: boolean;
  showCards: boolean;
  showSql: boolean;
  showOps: boolean;
  showUsers: boolean;
} {
  return {
    // 运维：ops.* 只有平台超管持有且禁止下放，故等价于「仅超管可见」
    showOps: hasPerm(permissions, 'ops.runtime.access'),
    showReport: hasPerm(permissions, 'dashboard.view'),
    showCards: hasPerm(permissions, 'model.card_save'),
    showAnalysis: hasPerm(permissions, 'model.query'),
    showTimeline: hasPerm(permissions, 'timeline.view'),
    showSql: hasPerm(permissions, 'model.sql'),
    showUser: hasPerm(permissions, 'cohort.view') || hasPerm(permissions, 'tag.view') || hasPerm(permissions, 'subject.view'),
    showMeta: hasPerm(permissions, 'meta.view'),
    // 数据管理分组按子项裁剪（rbac-v3 §7）：接入指南/Debug/数据质量/数据表要 meta.view，指标要 metric.view
    showData: hasPerm(permissions, 'meta.view') || hasPerm(permissions, 'metric.view'),
    showIam: hasPerm(permissions, 'iam.member.view'),
    showApiKeys: hasPerm(permissions, 'ops.apikey.manage'),
    showAiWorkspace: hasPerm(permissions, 'ops.ai_workspace.manage'),
    showOwners: hasPerm(permissions, 'ops.owner.assign'),
    showUsers: hasPerm(permissions, 'ops.user.manage'),
  };
}
