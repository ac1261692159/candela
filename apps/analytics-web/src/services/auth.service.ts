import { get, post, put, del } from './api';
import type { AuthUser } from '../stores/auth.store';

export function login(username: string, password: string) {
  return post<{ token: string; user: AuthUser }>('/auth/login', { username, password });
}

export function logout() {
  return post<{ ok: boolean }>('/auth/logout', undefined, { silent: true });
}

export function me() {
  return get<AuthUser>('/auth/me');
}

// ---- 个人设置 ----

export function updatePreferences(data: { default_project?: string | null; locale?: string | null; timezone?: string | null }) {
  return put<{ ok: boolean; default_project: string | null; locale: string | null; timezone: string | null }>('/auth/preferences', data);
}

export function updateProfile(data: { display_name?: string; email?: string | null }) {
  return put<{ ok: boolean; display_name: string | null; email: string | null }>('/auth/profile', data);
}

export function changePassword(data: { old_password: string; new_password: string }) {
  return put<{ ok: boolean }>('/auth/password', data);
}

export function createLoginUser(data: { username: string; password?: string; display_name?: string; email?: string | null; send_setup_email?: boolean }) {
  return post<{ id: string; username: string; display_name: string | null; email: string | null; setup_email_sent?: boolean }>('/auth/users', data);
}

// ---- 邮件通道（phase: clklog-analytics-account-lifecycle-v2）----

export function getMailStatus() {
  return get<{ smtp_configured: boolean }>('/auth/mail-status');
}

// ---- 账号域 SMTP 网页配置（phase 增补 v1.1）----

export interface MailConfigView {
  source: 'db' | 'env' | 'none';
  stored: boolean;
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  has_password: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

export function getMailConfig() {
  return get<MailConfigView>('/auth/mail-config');
}

export function saveMailConfig(data: {
  enabled: boolean;
  host: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
  pass?: string;
}) {
  return put<MailConfigView>('/auth/mail-config', data);
}

export function testMailConfig(to?: string) {
  return post<{ sent: boolean }>('/auth/mail-config/test', { to });
}

export function forgotPassword(identifier: string) {
  return post<{ ok: boolean }>('/auth/forgot-password', { identifier });
}

export function resetPasswordByToken(token: string, new_password: string) {
  return post<{ ok: boolean }>('/auth/reset-password', { token, new_password });
}

export interface InviteInfo {
  email: string;
  project_name: string;
  role_key: string;
  expires_at: string;
}

export function getInviteInfo(token: string) {
  return get<InviteInfo>(`/auth/invite/${token}`);
}

export function registerViaInvite(token: string, data: { username: string; display_name?: string; password: string }) {
  return post<{ ok: boolean }>(`/auth/invite/${token}/register`, data);
}

export function acceptInvite(token: string) {
  return post<{ ok: boolean }>(`/auth/invite/${token}/accept`);
}

// ---- 用户管理（ops.user.manage，phase: clklog-analytics-account-lifecycle-v1）----

export interface UserItem {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  platform_role: 'super_admin' | 'none';
  status: 'active' | 'disabled';
  last_login_at: string | null;
  created_by: string | null;
  created_at: string;
}

export function listUsers() {
  return get<UserItem[]>('/auth/users');
}

export function updateUser(id: string, data: { display_name?: string | null; email?: string | null; platform_role?: 'super_admin' | 'none' }) {
  return put<{ ok: boolean }>(`/auth/users/${id}`, data);
}

export function setUserStatus(id: string, status: 'active' | 'disabled') {
  return put<{ ok: boolean }>(`/auth/users/${id}/status`, { status });
}

export function unlockUser(id: string) {
  return post<{ ok: boolean }>(`/auth/users/${id}/unlock`);
}

export function resetUserPassword(id: string) {
  return post<{ ok: boolean; temporary_password: string }>(`/auth/users/${id}/reset-password`);
}

export function deleteUser(id: string) {
  return del<{ ok: boolean }>(`/auth/users/${id}`);
}

export interface AuditLogItem {
  id: string;
  action: string;
  detail: Record<string, unknown>;
  operator: string;
  created_at: string;
}

export function listAuditLogs(limit = 100, project?: string) {
  return get<AuditLogItem[]>(`/auth/audit-logs?limit=${limit}${project ? `&project=${encodeURIComponent(project)}` : ''}`);
}

// ---- 会话管理（phase: clklog-analytics-account-lifecycle-v3）----

export interface SessionItem {
  id: string;
  created_at: string;
  expires_at: string | null;
  current?: boolean;
}

export function listMySessions() {
  return get<SessionItem[]>('/auth/sessions');
}

export function revokeMySession(id: string) {
  return del<{ ok: boolean }>(`/auth/sessions/${id}`);
}

export function revokeOtherSessions() {
  return del<{ ok: boolean; revoked: number }>('/auth/sessions');
}

export function listUserSessions(userId: string) {
  return get<SessionItem[]>(`/auth/users/${userId}/sessions`);
}

export function adminRevokeSession(userId: string, sessionId: string) {
  return del<{ ok: boolean }>(`/auth/users/${userId}/sessions/${sessionId}`);
}

export function adminRevokeAllSessions(userId: string) {
  return del<{ ok: boolean; revoked: number }>(`/auth/users/${userId}/sessions`);
}

// ---- 外部 AI 只读查询 API Key 管理（admin）----

export interface ApiKeyItem {
  id: string;
  name: string;
  project_name: string;
  status: string; // active / revoked
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface ApiKeyCreated extends Omit<ApiKeyItem, 'status' | 'last_used_at' | 'created_at'> {
  api_key: string; // 明文 key，仅创建时返回一次
}

export function listApiKeys() {
  return get<ApiKeyItem[]>('/auth/api-keys');
}

export function createApiKey(data: { name?: string; project_name?: string; expires_at?: string | null } = {}) {
  return post<ApiKeyCreated>('/auth/api-keys', data);
}

export function revokeApiKey(id: string) {
  return put<{ ok: boolean }>(`/auth/api-keys/${id}/revoke`);
}

export function deleteApiKey(id: string) {
  return del<{ ok: boolean }>(`/auth/api-keys/${id}`);
}
