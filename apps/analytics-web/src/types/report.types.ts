import type { EventAnalysisQuery, FunnelQuery, TimeRangeRelative } from './dsl.types';
import type { ChartConfigV1 } from '../features/visualization/chart.types';

export type { ChartConfigV1 };

export type CardType = 'event' | 'funnel' | 'retention' | 'sql' | 'text' | 'metric';
export type ChartType =
  | 'line'
  | 'bar'
  | 'table'
  | 'number'
  | 'pie'
  | 'funnel'
  | 'trend'
  | 'stack'
  | 'cumulative'
  | 'distribution'
  | 'nth_trend'
  | 'daily_trend';

export interface CardDsl {
  event: EventAnalysisQuery;
  funnel: FunnelQuery;
  retention: unknown;
  sql: { sql: string; limit?: number };
}

export interface TextCardDsl {
  body: string;
  text_color?: string;
  background_color?: string;
  font_size?: number;
}

export interface CardCachePayload {
  result: CardRefreshResult['result'] | null;
  error: string | null;
  row_count: number;
  refreshed_at: string;
  stale: boolean;
}

export interface DashboardCard {
  card_id: string;
  name?: string;
  type: CardType;
  dsl: unknown;
  chart_type: ChartType;
  refresh_policy: 'auto' | 'manual';
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  display?: { view: string } | null;
  cache?: CardCachePayload | null;
}

/** 全局分析卡片（一等资产，不归属看板） */
export interface AnalysisCard {
  card_id: string;
  name: string;
  description?: string | null;
  type: CardType;
  dsl: unknown;
  chart_type: ChartType;
  refresh_policy: 'auto' | 'manual';
  owner: string;
  dashboard_ids: string[];
  locked?: boolean;
  grant_count?: number;
  can_edit?: boolean;
  ref_count?: number;
  created_at: string;
  updated_at: string;
  /** 仅卡片详情返回，供分析页回填上次结果 */
  cache?: CardCachePayload | null;
  /** 仅卡片列表返回的精简缓存状态（不含结果体） */
  cache_summary?: CardCacheSummary | null;
}

/** 卡片列表的缓存摘要：后端只透出元信息，避免列表搬运大结果体 */
export interface CardCacheSummary {
  has_cache: boolean;
  stale: boolean;
  refreshed_at: string | null;
  error: string | null;
}

export interface DashboardSummary {
  db_id: string;
  name: string;
  description?: string | null;
  layout_json: unknown;
  owner: string;
  share_token: string | null;
  refresh_interval_sec?: number;
  cache_ttl_sec?: number;
  grid_columns?: number;
  show_card_type?: boolean;
  cohort_filter?: { cohort_id: string; op: 'in' | 'not_in' } | null;
  folder_id?: string | null;
  locked?: boolean;
  visibility?: string;
  grant_count?: number;
  can_edit?: boolean;
  created_at: string;
  updated_at: string;
  card_count?: number;
}

export interface DashboardDetail {
  db_id: string;
  name: string;
  description?: string | null;
  layout_json: unknown;
  owner: string;
  share_token: string | null;
  refresh_interval_sec?: number;
  cache_ttl_sec?: number;
  grid_columns?: number;
  show_card_type?: boolean;
  cohort_filter?: { cohort_id: string; op: 'in' | 'not_in' } | null;
  folder_id?: string | null;
  created_at: string;
  updated_at: string;
  cards: DashboardCard[];
}

export interface DashboardShare {
  db_id: string;
  name: string;
  description?: string | null;
  layout_json: unknown;
  show_card_type?: boolean;
  cards: DashboardCard[];
}

export interface CreateDashboardDto {
  name: string;
  description?: string | null;
  layout_json?: unknown;
  create_share_token?: boolean;
  refresh_interval_sec?: number;
  cache_ttl_sec?: number;
  grid_columns?: number;
  show_card_type?: boolean;
  cohort_filter?: { cohort_id: string; op: 'in' | 'not_in' } | null;
  folder_id?: string | null;
}

export interface CreateCardDto {
  name: string;
  description?: string | null;
  type: CardType;
  dsl: unknown;
  chart_type?: ChartType;
  refresh_policy?: 'auto' | 'manual';
}

/** 添加已有卡片到看板（仅布局） */
export interface AddCardToDashboardDto {
  card_id: string;
  position_x?: number;
  position_y?: number;
  width?: number;
  height?: number;
}

export interface CardRefreshResult {
  card_id: string;
  type: CardType;
  result: {
    columns: { key?: string; title?: string; name?: string; type?: string }[];
    rows: Record<string, unknown>[];
    elapsed_ms?: number;
    sql?: string;
    query_id?: string;
    row_count?: number;
    truncated?: boolean;
    read_rows?: number;
    read_bytes?: number;
  };
}

// ---------- 自定义 SQL 分析 ----------

export interface SchemaEvent {
  event_key: string;
  display_name: string;
}

export interface SchemaProperty {
  prop_key: string;
  data_type: string;
  sample_value: string | null;
  event_count?: number;
  materialized: string | null;
}

export interface SchemaColumn {
  name: string;
  type: string;
  desc: string;
  /** 展示名文案键（i18n v1，前端优先用 key 渲染；`desc` 为中文兜底） */
  desc_key?: string;
}

export interface SchemaCohort {
  cohort_id: string;
  name: string;
  display_name: string;
  batch_id: string;
  member_count: number;
}

export interface SchemaTag {
  tag_id: string;
  name: string;
  display_name: string;
  batch_id: string;
  member_count: number;
  values?: string[];
}

export interface SqlSchema {
  events: SchemaEvent[];
  event_properties: SchemaProperty[];
  user_properties: SchemaProperty[];
  system_columns: SchemaColumn[];
  cohorts?: SchemaCohort[];
  tags?: SchemaTag[];
}

export interface SqlTimeRange {
  start: string;
  end: string;
  relative?: TimeRangeRelative;
  /** 展示时区（IANA 名；缺省 = 平台时区，phase: clklog-analytics-timezone-v1） */
  timezone?: string;
}

export type SqlMode = 'sql' | 'builder';

export interface ExecuteSqlDto {
  mode: SqlMode;
  sql?: string;
  dsl?: unknown;
  time_range: SqlTimeRange;
  limit?: number;
}

export interface SqlExecuteResult {
  query_id: string;
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  read_rows: number;
  read_bytes: number;
  /** 本次实际注入 ClickHouse 的日期窗（动态范围已按展示时区解析；phase: clklog-analytics-timezone-v1） */
  applied_time_range?: { start: string; end: string; timezone?: string };
  /** 打开已存卡片时从 CardCache 回填，不是当场执行 */
  from_cache?: boolean;
}

export interface FieldMapItem {
  key: string;
  label: string;
  type?: string;
}

export interface SaveSqlReportDto {
  name: string;
  description?: string | null;
  mode: SqlMode;
  sql_text?: string;
  dsl?: unknown;
  field_map?: FieldMapItem[];
  chart_config?: ChartConfigV1 | null;
  time_range?: SqlTimeRange;
}

export interface SqlReportSummary {
  id: string;
  name: string;
  description?: string | null;
  mode: SqlMode;
  created_at: string;
  updated_at: string;
}

export interface SqlReportDetail {
  id: string;
  name: string;
  description?: string | null;
  mode: SqlMode;
  sql_text: string | null;
  dsl: unknown;
  field_map: FieldMapItem[] | null;
  chart_config: ChartConfigV1 | { chart_type: string } | null;
  schema_version: number;
  created_at: string;
  updated_at: string;
}
