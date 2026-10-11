import { get, post, put, del } from './api';

export interface UserCohort {
  cohort_id: string;
  project_name: string;
  owner: string;
  name: string;
  display_name: string;
  remark: string | null;
  kind: 'condition' | 'id_upload' | 'result' | 'sql';
  definition_json: Record<string, unknown>;
  schedule: 'manual' | 'daily';
  status: 'pending' | 'ready' | 'failed';
  member_count: number;
  batch_id: string;
  last_computed_at: string | null;
  compute_error: string | null;
  subject_id?: string;
  locked?: boolean;
  created_at: string;
  updated_at: string;
}

interface ListResponse<T> {
  items: T[];
  total: number;
}

export function getCohorts(params?: { keyword?: string; status?: string; subject_id?: string }) {
  return get<ListResponse<UserCohort>>('/meta/cohorts', { params });
}

export function getCohort(id: string) {
  return get<UserCohort>(`/meta/cohorts/${id}`);
}

export function createCohort(body: Record<string, unknown>) {
  return post<UserCohort>('/meta/cohorts', body);
}

export function createResultCohort(body: Record<string, unknown>) {
  return post<UserCohort>('/meta/cohorts/from-result', body);
}

export function updateCohort(id: string, body: Record<string, unknown>) {
  return put<UserCohort>(`/meta/cohorts/${id}`, body);
}

export function deleteCohort(id: string, force = false) {
  return del<{ success: boolean }>(`/meta/cohorts/${id}${force ? '?force=1' : ''}`);
}

export function refreshCohort(id: string) {
  return post<UserCohort>(`/meta/cohorts/${id}/compute`);
}

export function getCohortMembers(id: string, options: { limit?: number; keyword?: string } = {}) {
  const { limit = 1000, keyword } = options;
  return get<{ items: { uid: string }[]; total: number; keyword?: string; truncated: boolean }>(
    `/meta/cohorts/${id}/members`,
    { params: { limit, ...(keyword ? { keyword } : {}) } },
  );
}

/** ID 分群重传名单（整体替换，不动其他类型） */
export function replaceCohortMembers(id: string, csvText: string) {
  return post<UserCohort>(`/meta/cohorts/${id}/members`, { csv_text: csvText });
}

export function getCohortTemplate() {
  return get<{ filename: string; content: string }>('/meta/cohorts/template.csv');
}

export function previewSqlCohort(body: {
  definition_json: Record<string, unknown>;
  limit?: number;
}) {
  return post<{ items: { uid: string }[]; total: number; truncated?: boolean }>(
    '/meta/cohorts/preview-sql',
    body,
  );
}

/** 条件分群试跑：人数 + 示例成员（只读，不落成员表） */
export function previewConditionCohort(body: {
  definition_json: Record<string, unknown>;
  subject_id?: string;
  limit?: number;
}) {
  return post<{ count: number; items: { uid: string }[]; limit: number; truncated: boolean }>(
    '/meta/cohorts/preview-condition',
    body,
  );
}

export function previewSavedSqlCohort(
  id: string,
  body?: { definition_json?: Record<string, unknown>; limit?: number },
) {
  return post<{ items: { uid: string }[]; total: number; truncated?: boolean }>(
    `/meta/cohorts/${id}/preview-sql`,
    body ?? {},
  );
}

export function previewResultUsers(body: {
  source: 'event' | 'funnel' | 'retention';
  dsl: Record<string, unknown>;
  cell: Record<string, unknown>;
  limit?: number;
}) {
  return post<{ items: { uid: string }[]; total: number }>('/meta/cohorts/preview-result', body);
}
