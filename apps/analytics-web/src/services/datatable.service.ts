import { get, post, patch, del } from './api';

export type DatatableDataType = 'number' | 'string' | 'datetime' | 'boolean';

export interface DatatableColumn {
  field_key: string;
  data_type: DatatableDataType;
  display_name?: string;
  is_primary?: boolean;
  sort_order?: number;
}

export interface ParseResult {
  columns: DatatableColumn[];
  preview_rows: Record<string, string>[];
  success_rows: number;
  dropped_rows: number;
  dropped_detail: {
    line: number;
    reason: string;
    /** 原因的文案键与参数（i18n v1；优先用 key 渲染） */
    reason_key?: string;
    reason_params?: Record<string, unknown>;
  }[];
  duplicated_keys: number;
}

export interface DatatableSummary {
  id: string;
  table_key: string;
  remark?: string | null;
  row_count: number;
  column_count: number;
  active_version: number;
  binding_summary: string;
  updated_by: string;
  updated_at: string;
}

export interface DatatableBinding {
  id: string;
  target_type: 'event_property' | 'event_name' | 'event_time';
  target_prop: string;
  /** 方案 B：join 键列（数据表里与该属性取值匹配的列） */
  key_column?: string;
  /** 派生属性：key_column 之外每列生成 `<target_prop>@<field_key>` */
  field_mappings?: { field_key: string; prop_key: string; data_type: string; display_name: string }[] | null;
  granularity?: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | null;
  status: string;
  /** 服务端按维表规则算出的展示列（值映射按哪一列显示业务名）；null = 不做映射 */
  label_field?: string | null;
  label_title?: string | null;
}

export interface DatatableDetail extends DatatableSummary {
  columns: DatatableColumn[];
  bindings: DatatableBinding[];
  imports: {
    id: string;
    mode: string;
    success_rows: number;
    dropped_rows: number;
    result: string;
    operator: string;
    created_at: string;
  }[];
}

export function parseDatatable(payload: { csv_text: string; columns?: DatatableColumn[] }) {
  return post<ParseResult>('/meta/datatables/parse', payload);
}

export function createDatatable(payload: {
  table_key: string;
  remark?: string;
  csv_text: string;
  columns: DatatableColumn[];
}) {
  return post<DatatableDetail>('/meta/datatables', payload);
}

export function listDatatables() {
  return get<DatatableSummary[]>('/meta/datatables');
}

export function getDatatable(id: string) {
  return get<DatatableDetail>(`/meta/datatables/${id}`);
}

export function downloadDatatable(id: string) {
  return get<{ content: string }>(`/meta/datatables/${id}/download`);
}

export function previewDatatableUpdate(id: string, payload: { csv_text: string; mode: 'incr' | 'replace' }) {
  return post<ParseResult & { current_row_count: number; mode: string }>(
    `/meta/datatables/${id}/update/preview`,
    payload,
  );
}

export function updateDatatable(
  id: string,
  payload: { csv_text: string; mode: 'incr' | 'replace'; columns?: DatatableColumn[] },
) {
  return post<{
    active_version: number;
    row_count: number;
    added: number;
    updated: number;
    dropped: number;
  }>(`/meta/datatables/${id}/update`, payload);
}

export function clearDatatable(id: string) {
  return post<{ active_version: number; row_count: number }>(`/meta/datatables/${id}/clear`, {});
}

export function deleteDatatable(id: string) {
  return del<{ id: string; status: string }>(`/meta/datatables/${id}`);
}

export function getDatatableUsage(id: string) {
  return get<{
    bindings: { target_type: string; target_prop: string; status: string }[];
    referenced_cards: number;
  }>(`/meta/datatables/${id}/usage`);
}

export function createDatatableBinding(
  id: string,
  payload: {
    target_type: 'event_property' | 'event_name' | 'event_time';
    target_prop: string;
    key_column: string;
    label_field?: string;
    granularity?: string;
    field_mappings?: { field_key: string; display_name?: string }[];
  },
) {
  return post<{ id: string; restored: boolean; label_field?: string | null }>(
    `/meta/datatables/${id}/bindings`,
    payload,
  );
}

export function updateDatatableBinding(
  id: string,
  bindingId: string,
  payload: {
    key_column?: string;
    label_field?: string;
    granularity?: string;
    field_mappings?: { field_key: string; display_name?: string }[];
  },
) {
  return patch<{ id: string; label_field: string | null; key_column: string }>(
    `/meta/datatables/${id}/bindings/${bindingId}`,
    payload,
  );
}

export function getDatatableLabels(prop: string) {
  return get<{
    bound: boolean;
    label_title?: string;
    items: { raw: string; label: string }[];
    truncated: boolean;
  }>('/meta/datatables/labels', { params: { prop } });
}

export interface DatatableDimensionProperty {
  prop_key: string;
  display_name: string;
  data_type: string;
}

export function listDatatableDimensions() {
  return get<DatatableDimensionProperty[]>('/meta/datatables/dimension-properties');
}

export function deleteDatatableBinding(id: string, bindingId: string) {
  return del<{ id: string; status: string }>(`/meta/datatables/${id}/bindings/${bindingId}`);
}

/** 只改备注，不动数据与结构 */
export function updateDatatableMeta(id: string, payload: { remark?: string }) {
  return post<{ id: string; remark: string | null }>(`/meta/datatables/${id}/remark`, payload);
}
