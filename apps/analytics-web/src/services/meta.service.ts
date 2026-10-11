import { get, post, put, del } from './api';
import type { TimeRangeRelative } from '../types/dsl.types';
import type {
  MetaEvent,
  MetaEventProperty,
  MetaUserProperty,
  MetaVirtualEvent,
  SavedMetric,
  MetaVirtualProperty,
  MetaEventAttribute,
  DebugRecord,
  DebugWindow,
  DebugQueryOutcome,
  DebugRecordSummary,
  DebugRecordDetail,
  QualityReport,
  ReconcileConfig,
  ReconcileReport,
  ReconcileSnapshot,
  DiscoveryLog,
} from '../types/meta.types';

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListEventsParams {
  status?: string;
  event_type?: string;
  availability_status?: string;
  data_status?: string;
  connection_status?: string;
  keyword?: string;
  sort_by?: string;
  sort_order?: string;
  page?: number;
  pageSize?: number;
  exclude_hidden?: boolean;
}

export function getEvents(params?: ListEventsParams) {
  return get<ListResponse<MetaEvent>>('/meta/events', { params });
}

export function updateEvent(eventKey: string, data: Partial<MetaEvent>) {
  return put<MetaEvent>(`/meta/events/${encodeURIComponent(eventKey)}`, data);
}

export function batchEvents(action: string, eventKeys: string[]) {
  return post<{ success: boolean; affected: number }>('/meta/events/batch', {
    action,
    event_keys: eventKeys,
  });
}

export function refreshEventStats() {
  return post<{ success: boolean }>('/meta/events/refresh-stats');
}

export function getEventProperties(eventKey: string) {
  return get<MetaEventProperty[]>(
    `/meta/events/${encodeURIComponent(eventKey)}/properties`,
  );
}

export function updateProperty(id: string, data: Partial<MetaEventProperty>) {
  return put<MetaEventProperty>(`/meta/properties/${id}`, data);
}

export function materializeProperty(id: string) {
  return post<{ sql?: string; success?: boolean; ddl?: string; columnName?: string }>(
    `/meta/properties/${id}/materialize`,
  );
}

export function materializeUserProperty(id: string) {
  return post<{ sql?: string; success?: boolean; ddl?: string; columnName?: string }>(
    `/meta/user-properties/${id}/materialize`,
  );
}

export function getUserProperties() {
  return get<ListResponse<MetaUserProperty>>('/meta/user-properties');
}

export function updateUserProperty(id: string, data: Partial<MetaUserProperty>) {
  return put<MetaUserProperty>(`/meta/user-properties/${id}`, data);
}

export function getVirtualEvents() {
  return get<ListResponse<MetaVirtualEvent>>('/meta/virtual-events');
}

export function createVirtualEvent(data: Partial<MetaVirtualEvent>) {
  return post<MetaVirtualEvent>('/meta/virtual-events', data);
}

export function updateVirtualEvent(veId: string, data: Partial<MetaVirtualEvent>) {
  return put<MetaVirtualEvent>(`/meta/virtual-events/${veId}`, data);
}

export function deleteVirtualEvent(veId: string) {
  return del<{ success: boolean }>(`/meta/virtual-events/${veId}`);
}

export function getSavedMetrics(kind?: 'event' | 'retention') {
  return get<ListResponse<SavedMetric>>('/meta/metrics', { params: kind ? { kind } : undefined });
}

export function createSavedMetric(data: {
  name: string;
  display_name: string;
  remark?: string;
  kind: 'event' | 'retention';
  definition_json: Record<string, unknown>;
  format?: 'number' | 'percent';
}) {
  return post<SavedMetric>('/meta/metrics', data);
}

/** 指标试算（metric-v2）：按定义真实求值一次，不落库；与告警求值同一实现 */
export function previewSavedMetric(
  definitionJson: Record<string, unknown>,
  project?: string,
  format?: 'number' | 'percent',
) {
  return post<{
    value: number | null;
    value_fmt: string;
    series: { date: string; value: number | null }[];
    pick: string;
    pick_label: string;
    pick_note: string;
    pick_explicit: boolean;
    used_overall: boolean;
    window: {
      start: string;
      end: string;
      days: number;
      label: string;
      source: string;
      /** 指标自带查询时间的相对结构（i18n 收口）：界面按查看者语言渲染窗口文案 */
      relative?: TimeRangeRelative | null;
    };
    elapsed_ms: number;
  }>('/meta/metrics/preview', { definition_json: definitionJson, kind: 'event', format }, {
    params: project ? { project } : undefined,
  });
}

export function getSavedMetric(metricId: string) {
  return get<SavedMetric>(`/meta/metrics/${metricId}`);
}

export function updateSavedMetric(
  metricId: string,
  patch: {
    display_name?: string;
    remark?: string;
    definition_json?: Record<string, unknown>;
    format?: 'number' | 'percent';
  },
) {
  return put<SavedMetric>(`/meta/metrics/${metricId}`, patch);
}

export function deleteSavedMetric(metricId: string) {
  return del<{ success: boolean }>(`/meta/metrics/${metricId}`);
}

export function getVirtualProperties(eventKey?: string) {
  return get<MetaVirtualProperty[]>('/meta/virtual-properties', {
    params: eventKey ? { event_key: eventKey } : undefined,
  });
}

export function createVirtualProperty(data: Partial<MetaVirtualProperty>) {
  return post<MetaVirtualProperty>('/meta/virtual-properties', data);
}

export function updateVirtualProperty(id: string, data: Partial<MetaVirtualProperty>) {
  return put<MetaVirtualProperty>(`/meta/virtual-properties/${id}`, data);
}

export function deleteVirtualProperty(id: string) {
  return del<{ success: boolean }>(`/meta/virtual-properties/${id}`);
}

export function validateVirtualProperty(expression: string) {
  return post<{ valid: boolean; message?: string }>('/meta/virtual-properties/validate', {
    expression,
  });
}

export interface ListEventAttributesParams {
  data_type?: string;
  status?: string;
  keyword?: string;
  sort_by?: string;
  sort_order?: string;
  page?: number;
  pageSize?: number;
}

export function getEventAttributes(params?: ListEventAttributesParams) {
  return get<ListResponse<MetaEventAttribute>>('/meta/event-attributes', { params });
}

/**
 * 全量事件属性。
 *
 * 列表接口的 pageSize 被服务端夹到 100（`Math.min(100, …)`），而属性已有 459 条：
 * 只取第一页会让 `goods_id` 这类属性在「选择属性」下拉里永远搜不到（翻到第 5 页才有）。
 * 需要「列出所有属性」的下拉一律走这里，按 total 翻页取全。
 */
export async function getAllEventAttributes(): Promise<MetaEventAttribute[]> {
  const pageSize = 100;
  const byKey = new Map<string, MetaEventAttribute>();
  for (let page = 1; page <= 20; page++) {
    const res = await getEventAttributes({ page, pageSize }).catch(() => null);
    if (!res?.items?.length) break;
    const before = byKey.size;
    for (const item of res.items) {
      if (!byKey.has(item.prop_key)) byKey.set(item.prop_key, item);
    }
    // 服务端已用 prop_key 兜底排序保证分页稳定；这里再兜一层：
    // 某一页没带来任何新属性就停，避免重复页把循环空转完。
    if (byKey.size === before) break;
    if (res.total > 0 && byKey.size >= res.total) break;
    if (res.items.length < pageSize) break;
  }
  return [...byKey.values()];
}

export function getEventAttributeDetail(propKey: string) {
  return get<{
    prop_key: string;
    display_name?: string;
    data_type?: string;
    remark?: string;
    status?: string;
    event_count: number;
    events: Array<{
      event_key: string;
      display_name?: string;
      data_type: string;
      status: string;
    }>;
  }>(`/meta/event-attributes/${encodeURIComponent(propKey)}`);
}

export function updateEventAttribute(
  propKey: string,
  data: Partial<MetaEventAttribute>,
) {
  return put<MetaEventAttribute>(
    `/meta/event-attributes/${encodeURIComponent(propKey)}`,
    data,
  );
}

export function refreshEventAttributeCounts() {
  return post<{ success: boolean }>('/meta/event-attributes/refresh-counts');
}

export function debugRecent(params?: {
  distinct_id?: string;
  user_key?: string;
  event?: string;
  window?: DebugWindow;
  limit?: number;
}) {
  return get<ListResponse<DebugRecord>>('/meta/debug/recent', { params });
}

/** 查询 + 留档（页面主路径）：快路径直接返回结果；超预算返回 `{ status:'running', record_id }` 由前端轮询 */
export function debugQuery(body: {
  distinct_id?: string;
  user_key?: string;
  event?: string;
  window?: DebugWindow;
  limit?: number;
}) {
  return post<DebugQueryOutcome>('/meta/debug/query', body);
}

export function debugRecords(params?: { page?: number; pageSize?: number }) {
  return get<ListResponse<DebugRecordSummary>>('/meta/debug/records', { params });
}

export function debugRecordDetail(id: string) {
  return get<DebugRecordDetail>(`/meta/debug/records/${id}`);
}

export function debugRecordDelete(id: string) {
  return del<{ deleted: boolean; record_id: string }>(`/meta/debug/records/${id}`);
}

/** 项目级留档开关（写接口需 ops.owner.assign，与项目时区设置同权限） */
export function debugArchiveSetting() {
  return get<{ enabled: boolean }>('/meta/debug/archive-setting');
}

export function setDebugArchiveSetting(enabled: boolean) {
  return put<{ enabled: boolean }>('/meta/debug/archive-setting', { enabled });
}

export function getQualityReport() {
  return get<QualityReport>('/meta/quality/report');
}

/** 最近一次对拍快照（秒开缓存，含上次对拍时间与过期等级） */
export function getReconcileSnapshot() {
  return get<ReconcileSnapshot | null>('/meta/quality/snapshot');
}

export function getReconcileReport(params?: { from?: string; to?: string; threshold_pct?: number }) {
  return get<ReconcileReport>('/meta/quality/reconcile', { params });
}

/** 对拍配置（单例；读取 meta.view，写入仅平台超管） */
export function getReconcileConfig() {
  return get<ReconcileConfig>('/meta/quality/config');
}

export function saveReconcileConfig(patch: Partial<ReconcileConfig>) {
  return put<ReconcileConfig>('/meta/quality/config', patch);
}

export function getDiscoveryLogs(limit = 50) {
  return get<DiscoveryLog[]>('/meta/quality/discovery-logs', { params: { limit } });
}
