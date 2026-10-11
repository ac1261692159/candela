export const PROJECT_ROLES = ['project_owner', 'analysis_admin', 'analyst', 'member', 'external'] as const;
export type ProjectRoleKey = (typeof PROJECT_ROLES)[number];

export const ROLE_RANK: Record<ProjectRoleKey, number> = {
  project_owner: 50,
  analysis_admin: 40,
  analyst: 30,
  member: 20,
  external: 10,
};

export const ROLE_LABELS: Record<ProjectRoleKey, string> = {
  project_owner: '项目 owner',
  analysis_admin: '分析管理员',
  analyst: '分析师',
  member: '普通成员',
  external: '外部人员',
};

/**
 * 角色展示名的前端文案键（`iam` 命名空间，i18n v1 §6.3）。
 *
 * 与 `ROLE_LABELS` 一一对应：服务端只下发 key，中文原值保留为兜底
 * （非浏览器调用方 / 老客户端 / 未覆盖的新语言）。键的文案在前端 `i18n/locales/<语言>/iam.json`。
 */
export const ROLE_LABEL_KEYS: Record<ProjectRoleKey, string> = {
  project_owner: 'iam:role.projectOwner',
  analysis_admin: 'iam:role.analysisAdmin',
  analyst: 'iam:role.analyst',
  member: 'iam:role.member',
  external: 'iam:role.external',
};

export type PermOp = '查看' | '编辑' | '管理' | '功能使用';

export interface PermissionDef {
  code: string;
  feature: string;
  /** `feature` 的文案键（`iam` 命名空间）；中文原值保留为兜底 */
  feature_key: string;
  op: PermOp;
  /** `op` 的文案键；中文原值保留为兜底 */
  op_key: string;
  detail: string;
  /** `detail` 的文案键；中文原值保留为兜底 */
  detail_key: string;
  owner: boolean;
  analysis_admin: boolean;
  analyst: boolean;
  member: boolean;
  external: boolean;
  ops?: boolean;
}

/**
 * 权限目录（平台预置展示名）。
 *
 * 每条同时给出中文原值与 `feature_key` / `op_key` / `detail_key`：
 * 前端优先用 key 渲染（i18n v1 §6.3），中文原值保留给非浏览器调用方与老客户端。
 * key 的文案集合必须与前端 `i18n/locales/<语言>/iam.json` 的 `permission.*` 对齐。
 */
export const PERMISSION_CATALOG: PermissionDef[] = [
  {
    code: 'iam.member.view',
    feature: '项目权限管理', feature_key: 'iam:permission.feature.projectAccess',
    op: '查看', op_key: 'iam:permission.op.view',
    detail: '查看本项目成员、成员组、角色说明、数据权限策略', detail_key: 'iam:permission.detail.iamMemberView',
    // rbac-v4：项目权限域对全员只读开放（含外部人员）；邀请队列与权限审计流水另由 iam.member.edit 把守
    owner: true, analysis_admin: true, analyst: true, member: true, external: true,
  },
  {
    code: 'iam.member.edit',
    feature: '项目权限管理', feature_key: 'iam:permission.feature.projectAccess',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '添加/移除成员与组；分配非 owner 角色', detail_key: 'iam:permission.detail.iamMemberEdit',
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
  {
    code: 'iam.role.edit_admin',
    feature: '项目权限管理', feature_key: 'iam:permission.feature.projectAccess',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '编辑本项目「分析管理员」授权定义', detail_key: 'iam:permission.detail.iamRoleEditAdmin',
    owner: true, analysis_admin: false, analyst: false, member: false, external: false,
  },
  {
    code: 'iam.data_policy.manage',
    feature: '数据权限', feature_key: 'iam:permission.feature.dataPolicy',
    op: '管理', op_key: 'iam:permission.op.manage',
    detail: '新建、编辑、删除策略并赋给成员或组', detail_key: 'iam:permission.detail.iamDataPolicyManage',
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
  {
    code: 'ops.user.manage',
    feature: '运维 · 账号', feature_key: 'iam:permission.feature.opsAccount',
    op: '管理', op_key: 'iam:permission.op.manage',
    detail: '新建、禁用、启用登录账号', detail_key: 'iam:permission.detail.opsUserManage',
    owner: false, analysis_admin: false, analyst: false, member: false, external: false, ops: true,
  },
  {
    code: 'ops.owner.assign',
    feature: '运维 · 项目设置', feature_key: 'iam:permission.feature.opsProjectSettings',
    op: '管理', op_key: 'iam:permission.op.manage',
    detail: '新建分析项目；指定或替换项目唯一 owner', detail_key: 'iam:permission.detail.opsOwnerAssign',
    owner: false, analysis_admin: false, analyst: false, member: false, external: false, ops: true,
  },
  {
    code: 'ops.apikey.manage',
    feature: '运维 · API Key', feature_key: 'iam:permission.feature.opsApiKey',
    op: '管理', op_key: 'iam:permission.op.manage',
    detail: '查看、创建、撤销 Key', detail_key: 'iam:permission.detail.opsApikeyManage',
    owner: false, analysis_admin: false, analyst: false, member: false, external: false, ops: true,
  },
  {
    code: 'ops.ai_workspace.manage',
    feature: '运维 · AI Workspace', feature_key: 'iam:permission.feature.opsAiWorkspace',
    op: '管理', op_key: 'iam:permission.op.manage',
    detail: '模板与同步', detail_key: 'iam:permission.detail.opsAiWorkspaceManage',
    owner: false, analysis_admin: false, analyst: false, member: false, external: false, ops: true,
  },
  {
    code: 'ops.runtime.access',
    feature: '运维 · 后续运维管理', feature_key: 'iam:permission.feature.opsRuntime',
    op: '管理', op_key: 'iam:permission.op.manage',
    detail: '占位，本期无路由', detail_key: 'iam:permission.detail.opsRuntimeAccess',
    owner: false, analysis_admin: false, analyst: false, member: false, external: false, ops: true,
  },
  {
    code: 'subject.view',
    feature: '分析主体', feature_key: 'iam:permission.feature.subject',
    op: '查看', op_key: 'iam:permission.op.view',
    detail: '在分析中切换已有主体', detail_key: 'iam:permission.detail.subjectView',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'subject.edit',
    feature: '分析主体', feature_key: 'iam:permission.feature.subject',
    op: '功能使用', op_key: 'iam:permission.op.use',
    detail: '查看并编辑本项目分析主体', detail_key: 'iam:permission.detail.subjectEdit',
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
  {
    code: 'timeline.view',
    feature: '用户行为序列', feature_key: 'iam:permission.feature.timeline',
    op: '查看', op_key: 'iam:permission.op.view',
    detail: '按用户查看其指定时间段的全部上报事件', detail_key: 'iam:permission.detail.timelineView',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'cohort.view',
    feature: '用户分群管理', feature_key: 'iam:permission.feature.cohort',
    op: '查看', op_key: 'iam:permission.op.view',
    detail: '查看分群列表与成员预览', detail_key: 'iam:permission.detail.cohortView',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'cohort.edit_own',
    feature: '用户分群管理', feature_key: 'iam:permission.feature.cohort',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '新增、编辑、删除自己的分群', detail_key: 'iam:permission.detail.cohortEditOwn',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'cohort.edit_others',
    feature: '用户分群管理', feature_key: 'iam:permission.feature.cohort',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '编辑、删除他人的分群', detail_key: 'iam:permission.detail.cohortEditOthers',
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
  {
    code: 'tag.view',
    feature: '用户标签管理', feature_key: 'iam:permission.feature.tag',
    op: '查看', op_key: 'iam:permission.op.view',
    detail: '查看标签列表与成员预览', detail_key: 'iam:permission.detail.tagView',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'tag.edit_own',
    feature: '用户标签管理', feature_key: 'iam:permission.feature.tag',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '新增、编辑、删除自己的标签', detail_key: 'iam:permission.detail.tagEditOwn',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'tag.edit_others',
    feature: '用户标签管理', feature_key: 'iam:permission.feature.tag',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '编辑、删除他人的标签', detail_key: 'iam:permission.detail.tagEditOthers',
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
  {
    code: 'meta.view',
    feature: '埋点 / 元数据', feature_key: 'iam:permission.feature.meta',
    op: '查看', op_key: 'iam:permission.op.view',
    detail: '查看事件、属性、虚拟对象、指标、Debug、数据质量', detail_key: 'iam:permission.detail.metaView',
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
  {
    // rbac-v3：选择器与治理分离——分析/分群/标签/指标页只读元数据走这枚窄码（清单见 design-rbac-v3 §5）
    code: 'meta.picker.view',
    feature: '埋点 / 元数据', feature_key: 'iam:permission.feature.meta',
    op: '查看', op_key: 'iam:permission.op.view',
    detail: '分析选择器读取已启用的事件、属性与维度表字段（只读）', detail_key: 'iam:permission.detail.metaPickerView',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'meta.edit',
    feature: '埋点 / 元数据', feature_key: 'iam:permission.feature.meta',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '编辑定义、确认/隐藏、Debug', detail_key: 'iam:permission.detail.metaEdit',
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
  {
    code: 'model.query',
    feature: '模型使用', feature_key: 'iam:permission.feature.modelUsage',
    op: '功能使用', op_key: 'iam:permission.op.use',
    detail: '事件 / 漏斗 / 留存查询', detail_key: 'iam:permission.detail.modelQuery',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'model.sql',
    feature: '模型使用', feature_key: 'iam:permission.feature.modelUsage',
    op: '功能使用', op_key: 'iam:permission.op.use',
    detail: '自定义 SQL', detail_key: 'iam:permission.detail.modelSql',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'model.card_save',
    feature: '模型使用', feature_key: 'iam:permission.feature.modelUsage',
    op: '功能使用', op_key: 'iam:permission.op.use',
    detail: '保存卡片', detail_key: 'iam:permission.detail.modelCardSave',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'model.export',
    feature: '模型使用', feature_key: 'iam:permission.feature.modelUsage',
    op: '功能使用', op_key: 'iam:permission.op.use',
    detail: '导出已呈现的查询或看板数据', detail_key: 'iam:permission.detail.modelExport',
    owner: true, analysis_admin: true, analyst: true, member: false, external: true,
  },
  {
    code: 'dashboard.view',
    feature: '看板使用', feature_key: 'iam:permission.feature.dashboard',
    op: '查看', op_key: 'iam:permission.op.view',
    detail: '查看可访问看板及设置', detail_key: 'iam:permission.detail.dashboardView',
    owner: true, analysis_admin: true, analyst: true, member: true, external: true,
  },
  {
    code: 'dashboard.view_all',
    feature: '看板使用', feature_key: 'iam:permission.feature.dashboard',
    op: '查看', op_key: 'iam:permission.op.view',
    detail: '查看本项目全部看板', detail_key: 'iam:permission.detail.dashboardViewAll',
    // rbac-v5：默认全量可见只留 owner / 分析管理员；其余角色默认不可见，靠成员组或文件夹授权开放
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
  {
    code: 'dashboard.edit',
    feature: '看板使用', feature_key: 'iam:permission.feature.dashboard',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '新建看板；尝试编辑（最终以 AssetPolicy 为准）', detail_key: 'iam:permission.detail.dashboardEdit',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'dashboard.filter',
    feature: '看板使用', feature_key: 'iam:permission.feature.dashboard',
    op: '查看', op_key: 'iam:permission.op.view',
    detail: '临时调整看板筛选', detail_key: 'iam:permission.detail.dashboardFilter',
    owner: true, analysis_admin: true, analyst: true, member: true, external: false,
  },
  {
    code: 'dashboard.folder.manage',
    feature: '看板使用', feature_key: 'iam:permission.feature.dashboard',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '新建/重命名/删除文件夹', detail_key: 'iam:permission.detail.dashboardFolderManage',
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
  {
    code: 'asset.lock',
    feature: '看板使用', feature_key: 'iam:permission.feature.dashboard',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '锁定/解锁文件夹、看板、卡片、分群、标签', detail_key: 'iam:permission.detail.assetLock',
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
  {
    code: 'asset.grant',
    feature: '看板使用', feature_key: 'iam:permission.feature.dashboard',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '授予或撤回看板/卡片/文件夹的编辑权与外部查看', detail_key: 'iam:permission.detail.assetGrant',
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
  {
    code: 'metric.view',
    feature: '指标管理', feature_key: 'iam:permission.feature.metric',
    op: '查看', op_key: 'iam:permission.op.view',
    detail: '查看已保存指标', detail_key: 'iam:permission.detail.metricView',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'metric.edit_own',
    feature: '指标管理', feature_key: 'iam:permission.feature.metric',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '新建、编辑、删除自己的指标', detail_key: 'iam:permission.detail.metricEditOwn',
    owner: true, analysis_admin: true, analyst: true, member: false, external: false,
  },
  {
    code: 'metric.edit_others',
    feature: '指标管理', feature_key: 'iam:permission.feature.metric',
    op: '编辑', op_key: 'iam:permission.op.edit',
    detail: '编辑、删除他人的指标', detail_key: 'iam:permission.detail.metricEditOthers',
    owner: true, analysis_admin: true, analyst: false, member: false, external: false,
  },
];

export const OPS_CODES = PERMISSION_CATALOG.filter((p) => p.ops).map((p) => p.code);

export const ADMIN_GRANT_FORBIDDEN = new Set(['iam.role.edit_admin', ...OPS_CODES]);

const ROLE_CATALOG_FLAG: Record<ProjectRoleKey, 'owner' | 'analysis_admin' | 'analyst' | 'member' | 'external'> = {
  project_owner: 'owner',
  analysis_admin: 'analysis_admin',
  analyst: 'analyst',
  member: 'member',
  external: 'external',
};

export function codesForRole(role: ProjectRoleKey): string[] {
  const flag = ROLE_CATALOG_FLAG[role];
  return PERMISSION_CATALOG.filter((p) => p[flag]).map((p) => p.code);
}

export function ownerProjectCodes(): string[] {
  return PERMISSION_CATALOG.filter((p) => p.owner).map((p) => p.code);
}

export function catalogForUi() {
  return PERMISSION_CATALOG.filter((p) => !p.ops).map((p) => ({
    code: p.code,
    feature: p.feature,
    feature_key: p.feature_key,
    op: p.op,
    op_key: p.op_key,
    detail: p.detail,
    detail_key: p.detail_key,
  }));
}
