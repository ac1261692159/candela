import { get, post, put, patch, del } from './api';

export interface IamMe {
  platform_role: 'super_admin' | 'none';
  member: boolean;
  role_key: string | null;
  role_label: string | null;
  permissions: string[];
  data_scope: {
    unrestricted: boolean;
    events: { mode: string; keys: string[] };
  };
}

export function getIamMe() {
  return get<IamMe>('/iam/me');
}

export function getIamCatalog() {
  return get<{
    // `*_key` 为 i18n 文案键（服务端下发，前端优先用 key 渲染）；中文字段保留为兜底
    permissions: {
      code: string;
      feature: string;
      feature_key?: string;
      op: string;
      op_key?: string;
      detail: string;
      detail_key?: string;
    }[];
    roles: {
      key: string;
      label: string;
      label_key?: string;
      preset: boolean;
      adjusted: boolean;
      codes: string[];
    }[];
  }>('/iam/catalog');
}

export function listMembers() {
  return get<IamMember[]>('/iam/members');
}

export function listUserDirectory() {
  return get<{ id: string; username: string; display_name: string | null }[]>('/iam/user-directory');
}

export interface IamMember {
  id: string;
  user_id: string;
  role_key: string;
  data_policy_id: string | null;
  expires_at?: string | null;
  expired?: boolean;
  user: { id: string; username: string; display_name: string | null; status: string; platform_role: string };
  data_policy: { id: string; name: string } | null;
}

export function addMember(body: { user_id: string; role_key: string; data_policy_id?: string | null; expires_at?: string | null; project_name?: string }) {
  // project_name 显式指定时按目标项目带头（api 拦截器不覆盖显式头，v3.1）
  const { project_name, ...rest } = body;
  return post('/iam/members', rest, project_name ? { headers: { 'x-project-name': project_name } } : undefined);
}

export function patchMember(id: string, body: { role_key?: string; data_policy_id?: string | null; expires_at?: string | null }) {
  return patch(`/iam/members/${id}`, body);
}

export function removeMember(id: string) {
  return del(`/iam/members/${id}`);
}

// ---- 项目邀请（按邮箱，phase: clklog-analytics-account-lifecycle-v2）----

export interface InviteResult {
  added: boolean;
  invited: boolean;
  email_sent?: boolean;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role_key: string;
  invited_by: string;
  expires_at: string;
}

export function createInvitation(data: { email: string; role_key: string; member_expires_at?: string | null; project_name?: string }) {
  const { project_name, ...rest } = data;
  return post<InviteResult>('/iam/invitations', rest, project_name ? { headers: { 'x-project-name': project_name } } : undefined);
}

export function listInvitations() {
  return get<PendingInvitation[]>('/iam/invitations');
}

// ---- 项目足迹（v3.1 UX-3）----

export interface UserFootprint {
  memberships: { project_name: string; role_key: string; expires_at: string | null; expired: boolean }[];
  groups: { project_name: string; group_name: string; role_key: string }[];
}

export function getUserFootprint(userId: string) {
  return get<UserFootprint>(`/iam/users/${userId}/footprint`);
}

export function revokeInvitation(id: string) {
  return del<{ ok: boolean }>(`/iam/invitations/${id}`);
}

export function listGroups() {
  return get<IamGroup[]>('/iam/groups');
}

export interface IamGroup {
  id: string;
  name: string;
  role_key: string;
  data_policy_id: string | null;
  data_policy: { id: string; name: string } | null;
  _count: { users: number };
  users?: { user_id: string }[];
}

export function createGroup(body: { name: string; role_key: string; data_policy_id?: string | null }) {
  return post('/iam/groups', body);
}

export function patchGroup(id: string, body: { name?: string; role_key?: string; data_policy_id?: string | null }) {
  return patch(`/iam/groups/${id}`, body);
}

export function addGroupUser(id: string, user_id: string) {
  return post(`/iam/groups/${id}/users`, { user_id });
}

export function removeGroupUser(id: string, userId: string) {
  return del(`/iam/groups/${id}/users/${userId}`);
}

export function putAdminRole(grants: string[]) {
  return put('/iam/roles/analysis_admin', { grants });
}

export function listDataPolicies() {
  return get<IamPolicy[]>('/iam/data-policies');
}

export interface IamPolicy {
  id: string;
  name: string;
  definition_json: string;
  _count: { members: number; groups: number };
}

export function createDataPolicy(body: { name: string; definition: unknown }) {
  return post('/iam/data-policies', body);
}

export function patchDataPolicy(id: string, body: { name?: string; definition?: unknown }) {
  return patch(`/iam/data-policies/${id}`, body);
}

export function deleteDataPolicy(id: string) {
  return del(`/iam/data-policies/${id}`);
}

export function assignOwner(project: string, user_id: string) {
  return put(`/iam/ops/owners/${encodeURIComponent(project)}`, { user_id });
}

export function getProjectOwner(project: string) {
  return get<{ user_id: string; username: string; display_name: string | null } | null>(
    `/iam/ops/owners/${encodeURIComponent(project)}`,
  );
}

export interface AccessibleProject {
  name: string;
  display_name: string;
  timezone?: string | null;
}

export function listAccessibleProjects() {
  return get<AccessibleProject[]>('/iam/projects');
}

export interface RegistryProject {
  name: string;
  display_name: string;
  timezone?: string | null;
  owner: { user_id: string; username: string; display_name: string | null } | null;
}

export function listRegistryProjects() {
  return get<RegistryProject[]>('/iam/ops/projects');
}

export function createProject(body: { name: string; display_name?: string; owner_user_id: string }) {
  return post<RegistryProject>('/iam/ops/projects', body);
}

export function seedIamDemo(password: string) {
  return post<{ ok: boolean }>('/iam/ops/demo-seed', { password });
}

export interface AssetAclRow {
  subject_type: string;
  subject_id: string;
  perm: string;
}

export interface FolderTree {
  uncategorized: { name: string; dashboard_count: number };
  folders: FolderNode[];
}

export interface FolderNode {
  folder_id: string;
  name: string;
  parent_id: string | null;
  locked: boolean;
  sort_order: number;
  dashboard_count: number;
  children?: FolderNode[];
}

export function getFolders() {
  return get<FolderTree>('/report/folders');
}

export function createFolder(body: { name: string; parent_id?: string | null }) {
  return post('/report/folders', body);
}

export function patchFolder(id: string, body: { name?: string; parent_id?: string | null }) {
  return patch(`/report/folders/${id}`, body);
}

export function deleteFolder(id: string) {
  return del(`/report/folders/${id}`);
}

export interface SubjectGrantRow {
  asset_type: 'folder' | 'dashboard';
  asset_id: string;
  perm: 'view' | 'edit';
}

/** 主体视角：某成员 / 成员组在文件夹与看板上的直接授权（rbac-v6） */
export function getSubjectDashboardGrants(subjectType: 'user' | 'group', subjectId: string) {
  return get<SubjectGrantRow[]>('/iam/dashboard-grants', {
    params: { subject_type: subjectType, subject_id: subjectId },
  });
}

/** 主体视角反向授权：把该主体在 asset_ids 上的「可查看」置为存在，其余该主体的 view 行删除 */
export function putSubjectDashboardGrants(body: {
  subject_type: 'user' | 'group';
  subject_id: string;
  asset_ids: string[];
}) {
  return put<{ ok: boolean }>('/iam/dashboard-grants', body);
}

export function lockFolder(id: string, locked: boolean) {
  return post(`/report/folders/${id}/lock`, { locked });
}

export function lockDashboard(id: string, locked: boolean, lock_cards?: boolean) {
  return post(`/report/dashboards/${id}/lock`, { locked, lock_cards });
}

export function putDashboardAcl(id: string, grants: { subject_type: string; subject_id: string; perm: string }[]) {
  return put(`/report/dashboards/${id}/acl`, { grants });
}

export function getDashboardAcl(id: string) {
  return get<AssetAclRow[]>(`/report/dashboards/${id}/acl`);
}

export function getFolderAcl(id: string) {
  return get<AssetAclRow[]>(`/report/folders/${id}/acl`);
}

export function putFolderAcl(id: string, grants: { subject_type: string; subject_id: string; perm: string }[]) {
  return put(`/report/folders/${id}/acl`, { grants });
}

export function getCardAcl(id: string) {
  return get<AssetAclRow[]>(`/report/cards/${id}/acl`);
}

export function putCardAcl(id: string, grants: { subject_type: string; subject_id: string; perm: string }[]) {
  return put(`/report/cards/${id}/acl`, { grants });
}

export function lockCard(id: string, locked: boolean, confirm?: boolean) {
  return post(`/report/cards/${id}/lock${confirm ? '?confirm=1' : ''}`, { locked, confirm });
}

export function lockCohort(id: string, locked: boolean) {
  return post(`/meta/cohorts/${id}/lock`, { locked });
}

export function lockTag(id: string, locked: boolean) {
  return post(`/meta/tags/${id}/lock`, { locked });
}
