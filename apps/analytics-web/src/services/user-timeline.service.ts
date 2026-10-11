import { del, get, post } from './api';
import type {
  UserTimelineNeighbors,
  UserTimelineOutcome,
  UserTimelineProfile,
  UserTimelineRecordDetail,
  UserTimelineRecordSummary,
  UserTimelineQuery,
} from '../types/user-timeline.types';

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 查询 + 落档（两段式：快路径直接返回结果；超预算返回 { status:'running', record_id } 由前端轮询） */
export function queryUserTimeline(body: UserTimelineQuery) {
  return post<UserTimelineOutcome>('/analysis/user-timeline/query', body);
}

/** 用户画像：用户属性 + 标签最新值（失败降级为空，不阻断页面）；按属性定位时返回解析到的标识 */
export function getUserTimelineProfile(params: {
  value: string;
  subject_id?: string;
  id_kind?: 'subject' | 'user_property' | 'event_property';
  id_key?: string;
}) {
  const byProperty = params.id_kind && params.id_kind !== 'subject' && params.id_key;
  return get<UserTimelineProfile>('/analysis/user-timeline/profile', {
    params: {
      value: params.value,
      ...(params.subject_id ? { subject_id: params.subject_id } : {}),
      ...(byProperty ? { id_kind: params.id_kind, id_key: params.id_key } : {}),
    },
  });
}

/** 查看前后行为：以某条事件为锚取前后各 N 条（不落档、不产生记录） */
export function queryUserTimelineNeighbors(body: UserTimelineQuery & { anchor: string; limit?: number }) {
  return post<UserTimelineNeighbors>('/analysis/user-timeline/neighbors', body);
}

export function listUserTimelineRecords(params?: { page?: number; pageSize?: number }) {
  return get<ListResponse<UserTimelineRecordSummary>>('/analysis/user-timeline/records', { params });
}

export function getUserTimelineRecord(id: string) {
  return get<UserTimelineRecordDetail>(`/analysis/user-timeline/records/${id}`);
}

export function deleteUserTimelineRecord(id: string) {
  return del<{ deleted: boolean; record_id: string }>(`/analysis/user-timeline/records/${id}`);
}
