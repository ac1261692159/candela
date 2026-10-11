import { get, post, put, del } from './api';

export interface UserTag {
  tag_id: string;
  project_name: string;
  owner: string;
  name: string;
  display_name: string;
  remark: string | null;
  kind: 'condition';
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

export function getTags(params?: { keyword?: string; status?: string; subject_id?: string }) {
  return get<ListResponse<UserTag>>('/meta/tags', { params });
}

export function getTag(id: string) {
  return get<UserTag>(`/meta/tags/${id}`);
}

export function createTag(body: Record<string, unknown>) {
  return post<UserTag>('/meta/tags', body);
}

export function updateTag(id: string, body: Record<string, unknown>) {
  return put<UserTag>(`/meta/tags/${id}`, body);
}

export function deleteTag(id: string, force = false) {
  return del<{ success: boolean }>(`/meta/tags/${id}${force ? '?force=1' : ''}`);
}

export function refreshTag(id: string) {
  return post<UserTag>(`/meta/tags/${id}/compute`);
}

export function getTagMembers(id: string, limit = 1000) {
  return get<{ items: { uid: string; tag_value: string }[]; total: number }>(`/meta/tags/${id}/members`, {
    params: { limit },
  });
}
