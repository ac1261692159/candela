import { del, get, patch, post, put } from './api';
import type {
  AiPageContext,
  AiWorkspace,
  HarnessHostTicket,
  ModelProviderAdminView,
  ModelProviderDefaults,
  ModelProviderSaveResult,
  ModelProviderTestResponse,
  PageBridgeEvent,
  SaveModelProviderInput,
  WorkspaceTemplateDraftEntry,
} from '../types/ai.types';

export function getAiTabId(): string {
  const key = 'clklog-ai-browser-tab-id-v1';
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const entropy = globalThis.crypto?.randomUUID?.().replace(/-/g, '')
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const id = `tab_${entropy}`;
  sessionStorage.setItem(key, id);
  return id;
}

export function issueHarnessHostTicket(
  tabId: string,
  workspaceId?: string,
): Promise<HarnessHostTicket> {
  return post<HarnessHostTicket>(
    '/assistant/host-ticket',
    { tab_id: tabId, ...(workspaceId ? { workspace_id: workspaceId } : {}) },
    { timeout: 120_000 },
  );
}

export function listAiWorkspaces(): Promise<AiWorkspace[]> {
  return get<AiWorkspace[]>('/assistant/workspaces');
}

export function createPersistentAiWorkspace(displayName: string): Promise<AiWorkspace> {
  return post('/assistant/workspaces/persistent', { display_name: displayName });
}

export function createTemporaryAiWorkspace(): Promise<AiWorkspace> {
  return post('/assistant/workspaces/temporary');
}

export function promoteTemporaryAiWorkspace(
  id: string,
  displayName: string,
): Promise<AiWorkspace> {
  return post(`/assistant/workspaces/${encodeURIComponent(id)}/promote`, {
    display_name: displayName,
  });
}

export function deleteAiWorkspace(id: string): Promise<{ ok: true }> {
  return del(`/assistant/workspaces/${encodeURIComponent(id)}`);
}

export function publishPageBridgeSnapshot(
  tabId: string,
  context: AiPageContext,
  revision: number,
  signal?: AbortSignal,
): Promise<{ ok: true; revision: number; truncated: boolean }> {
  return post(
    '/assistant/page-bridge/snapshot',
    {
      tab_id: tabId,
      page: context.page,
      revision,
      state: context,
    },
    { silent: true, signal },
  );
}

export function pollPageBridgeEvents(
  tabId: string,
  after: number,
  signal?: AbortSignal,
): Promise<{ events: PageBridgeEvent[]; current_revision: number | null }> {
  return get('/assistant/page-bridge/events', {
    params: { tab_id: tabId, after },
    signal,
    timeout: 35_000,
    silent: true,
  });
}

export function disconnectPageBridge(tabId: string, revision: number) {
  return post('/assistant/page-bridge/disconnect', { tab_id: tabId, revision }, { silent: true });
}

export function decidePageBridgeProposal(
  proposalId: string,
  decision: {
    accepted: boolean;
    current_revision: number;
    applied_revision?: number;
    result?: unknown;
    reason?: string;
  },
): Promise<{ ok: true }> {
  return post(`/assistant/page-bridge/proposals/${encodeURIComponent(proposalId)}/decision`, decision, { silent: true });
}

export function getWorkspaceTemplateTree(): Promise<{ entries: WorkspaceTemplateDraftEntry[] }> {
  return get('/admin/ai/workspace-template/draft/tree');
}

export function putWorkspaceTemplateFile(input: {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
  executable?: boolean;
}): Promise<{ ok: true }> {
  return put('/admin/ai/workspace-template/draft/file', input);
}

export function createWorkspaceTemplateDirectory(path: string): Promise<{ ok: true }> {
  return post('/admin/ai/workspace-template/draft/directory', { path });
}

export function patchWorkspaceTemplateEntry(input: {
  path: string;
  new_path?: string;
  policy?: 'managed_readonly' | 'seed_once';
  executable?: boolean;
}): Promise<{ ok: true }> {
  return patch('/admin/ai/workspace-template/draft/entry', input);
}

export function deleteWorkspaceTemplateEntry(path: string): Promise<{ ok: true }> {
  return del('/admin/ai/workspace-template/draft/entry', { params: { path } });
}

export function previewWorkspaceTemplate(): Promise<{
  next_version: number;
  manifest: { entries: WorkspaceTemplateDraftEntry[] };
  diff: { added: string[]; modified: string[]; deleted: string[] };
}> {
  return get('/admin/ai/workspace-template/preview');
}

export function publishWorkspaceTemplate() {
  return post<{ template_version: number }>('/admin/ai/workspace-template/publish');
}

export function listWorkspaceTemplateVersions() {
  return get<Array<{
    version: number;
    state: string;
    content_digest: string;
    published_by: string;
    published_at: string;
  }>>('/admin/ai/workspace-template/versions');
}

export function restoreWorkspaceTemplateVersion(version: number): Promise<{ ok: true }> {
  return post(`/admin/ai/workspace-template/versions/${version}/restore-draft`);
}

export function startWorkspaceSync(scope: Record<string, unknown> = {}) {
  return post<{ id: string; planned_count: number }>('/admin/ai/workspace-sync-jobs', scope);
}

export function getWorkspaceSyncJob(id: string) {
  return get<{
    id: string;
    state: string;
    planned_count: number;
    success_count: number;
    failed_count: number;
    items: Array<{ workspace_id: string; state: string; error_code?: string }>;
  }>(`/admin/ai/workspace-sync-jobs/${id}`);
}

export function retryWorkspaceSyncJob(id: string) {
  return post<{ id: string }>(`/admin/ai/workspace-sync-jobs/${id}/retry`);
}

export function listAdminAiWorkspaces(): Promise<AiWorkspace[]> {
  return get('/admin/ai/workspaces');
}

export function initializeLegacyWorkspace(id: string): Promise<{ ok: true }> {
  return post(`/admin/ai/workspaces/${encodeURIComponent(id)}/initialize-legacy`);
}

// ===== 模型供应商设置（phase: clklog-ai-model-providers-v1）=====

export function getModelProviders(): Promise<ModelProviderAdminView> {
  return get<ModelProviderAdminView>('/admin/ai/model-providers');
}

export function createModelProvider(
  input: SaveModelProviderInput & { provider_id: string },
): Promise<ModelProviderSaveResult> {
  return post<ModelProviderSaveResult>('/admin/ai/model-providers', input);
}

export function updateModelProvider(
  providerId: string,
  input: SaveModelProviderInput,
): Promise<ModelProviderSaveResult> {
  return put<ModelProviderSaveResult>(
    `/admin/ai/model-providers/${encodeURIComponent(providerId)}`,
    input,
  );
}

export function deleteModelProvider(providerId: string): Promise<ModelProviderSaveResult> {
  return del<ModelProviderSaveResult>(
    `/admin/ai/model-providers/${encodeURIComponent(providerId)}`,
  );
}

export function saveModelDefaults(
  input: ModelProviderDefaults,
): Promise<ModelProviderSaveResult> {
  return put<ModelProviderSaveResult>('/admin/ai/model-defaults', input);
}

/**
 * 测试连接：不带 model 时逐个测试该供应商下全部模型（结果落库，通过的才可被用户选择）。
 * 超时给足 20 秒，失败也返回 body 由页面展示。
 */
export function testModelProvider(
  providerId: string,
  model?: string,
): Promise<ModelProviderTestResponse> {
  return post<ModelProviderTestResponse>(
    `/admin/ai/model-providers/${encodeURIComponent(providerId)}/test`,
    model ? { model } : {},
    { timeout: 60_000 },
  );
}

export function applyModelProviders(): Promise<{ recycled: number }> {
  return post<{ recycled: number }>('/admin/ai/model-providers/apply');
}
