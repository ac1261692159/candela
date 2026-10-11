import { get, post, put, del } from './api';

export interface AnalysisSubject {
  subject_id: string;
  project_name: string;
  name: string;
  display_name: string;
  kind: 'preset' | 'property';
  source: { scope: 'event' | 'user'; prop: string } | null;
  sort_order: number;
  is_preset: boolean;
  created_at: string;
  updated_at: string;
}

interface ListResponse<T> {
  items: T[];
  total: number;
}

export function getSubjects() {
  return get<ListResponse<AnalysisSubject>>('/meta/subjects');
}

export function createSubject(body: {
  name: string;
  display_name: string;
  source: { scope: 'event' | 'user'; prop: string };
}) {
  return post<AnalysisSubject>('/meta/subjects', body);
}

export function updateSubject(id: string, body: { display_name?: string; source?: { scope: 'event' | 'user'; prop: string } }) {
  return put<AnalysisSubject>(`/meta/subjects/${id}`, body);
}

export function deleteSubject(id: string) {
  return del<{ success: boolean }>(`/meta/subjects/${id}`);
}

export function sortSubjects(ids: string[]) {
  return put<AnalysisSubject[]>('/meta/subjects/sort', { ids });
}
