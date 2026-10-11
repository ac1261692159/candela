import { FilterGroup } from './dsl.types';

export type EventStatus = 'pending' | 'visible' | 'hidden';
export type EventType = 'report' | 'virtual' | 'preset';
export type AvailabilityStatus = 'available' | 'no_data' | 'hidden' | 'deprecated';
export type DataStatus = 'normal' | 'no_recent_data' | 'abnormal';
export type ConnectionStatus = 'auto' | 'virtual_from' | 'preset';

export type DataType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'datetime'
  | 'list'
  | 'object'
  | 'object_group';

export interface MetaEvent {
  event_key: string;
  display_name?: string;
  status: EventStatus;
  event_type: EventType;
  description?: string;
  remark?: string;
  owner?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  yesterday_count?: number;
  recent_7d_count?: number;
  availability_status: AvailabilityStatus;
  data_status: DataStatus;
  connection_status: ConnectionStatus;
  is_deleted: boolean;
  deleted_at?: string;
  project_name: string;
  created_at: string;
  updated_at: string;
}

export interface MetaEventProperty {
  id: string;
  event_key?: string;
  prop_key: string;
  display_name?: string;
  data_type: DataType;
  is_materialized: boolean;
  sample_value?: string;
  status: EventStatus;
  project_name: string;
  created_at: string;
  updated_at: string;
}

export interface MetaUserProperty {
  id: string;
  prop_key: string;
  display_name?: string;
  data_type: DataType;
  is_materialized: boolean;
  sample_value?: string;
  project_name: string;
  created_at: string;
  updated_at: string;
}

export interface MetaVirtualProperty {
  id: string;
  prop_key: string;
  display_name?: string;
  data_type: DataType;
  expression: string;
  event_key?: string;
  description?: string;
  status: 'active' | 'invalid' | 'hidden';
  invalid_reason?: string;
  project_name: string;
  created_at: string;
  updated_at: string;
}

export interface VirtualEventDefinition {
  events: string[];
  filters?: FilterGroup;
}

export interface MetaVirtualEvent {
  ve_id: string;
  event_key: string;
  display_name?: string;
  status: EventStatus;
  definition_json: VirtualEventDefinition;
  project_name: string;
  created_at: string;
  updated_at: string;
}

export interface SavedMetric {
  metric_id: string;
  project_name: string;
  owner: string;
  name: string;
  display_name: string;
  remark?: string | null;
  kind: 'event' | 'retention';
  definition_json: Record<string, unknown>;
  format: 'number' | 'percent';
  created_at: string;
  updated_at: string;
}

export interface MetaEventAttribute {
  id: string;
  prop_key: string;
  display_name?: string;
  data_type: DataType;
  remark?: string;
  status: EventStatus;
  event_count: number;
  project_name: string;
  created_at: string;
  updated_at: string;
}

/** Debug 实时查询——sa_events 原始行（properties 为 JSON 字符串） */
export interface DebugRecord {
  log_time: string;
  event: string;
  distinct_id: string;
  user_key: string;
  properties: string;
}

/** Debug 查询窗口（phase: clklog-analytics-debug-query-v1）：原「固定 7 天」拆三档，默认 24h */
export type DebugWindow = '1h' | '24h' | '7d';

/** 查询响应：命中总数与返回行数分开（D2），并带上留档状态（F1） */
export interface DebugQueryResponse {
  items: DebugRecord[];
  /** 窗口内真实命中总数（count() OVER ()，不是返回行数） */
  matched_total: number;
  window: DebugWindow;
  limit: number;
  archived: boolean;
  record_id?: string;
  truncated?: boolean;
  /** 项目关闭了留档（与「写失败」区分，文案不同） */
  archive_disabled?: boolean;
}

/** 留档/后台任务状态（phase: clklog-analytics-debug-async-query-v1） */
export type DebugJobStatus = 'pending' | 'running' | 'done' | 'failed';

/** 超预算转后台的响应：没有 items，结果通过轮询该留档获取 */
export interface DebugQueryHandoff {
  status: 'running';
  record_id: string;
  reused?: boolean;
  window: DebugWindow;
  limit: number;
}

/** `POST /meta/debug/query` 的两种返回：快路径结果 / 已转后台 */
export type DebugQueryOutcome = DebugQueryResponse | DebugQueryHandoff;

export function isQueryHandoff(outcome: DebugQueryOutcome): outcome is DebugQueryHandoff {
  return (outcome as DebugQueryHandoff).status === 'running';
}

/** 留档列表项（不含结果行） */
export interface DebugRecordSummary {
  id: string;
  created_at: string;
  created_by: string;
  created_by_name: string | null;
  window: DebugWindow;
  cond_distinct_id: string | null;
  cond_user_key: string | null;
  cond_event: string | null;
  cond_limit: number;
  matched_total: number;
  row_count: number;
  truncated: boolean;
  duration_ms: number | null;
  /** 缺省视为 done（老记录无该字段） */
  status?: DebugJobStatus;
  error_code?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

/** 留档快照行（properties 可能被按字节截断，见后端上限） */
export interface DebugRecordRow extends DebugRecord {
  id: string;
  seq: number;
  properties_truncated: boolean;
}

export interface DebugRecordDetail extends DebugRecordSummary {
  rows: DebugRecordRow[];
}

/** 数据一致性对拍——每日总量对拍行 */
export interface ReconcileDailyItem {
  date: string;
  sa_cnt: number;
  sa_uniq: number;
  raw_cnt: number;
  deviation_pct: number;
  /**
   * skipped = 该日落在已清理区间（一侧数据被主动删除）
   * out_of_retention = 该日超出两侧保留期（数据已被 TTL 删除），同样不参与告警
   */
  status: 'ok' | 'ALERT' | 'skipped' | 'out_of_retention';
  /** 稳定标识（'cleaned'），文案由前端按查看者语言渲染 */
  skipped_reason?: string;
  skipped_source?: string;
}

/** 数据一致性对拍——CRC 唯一性 */
export interface ReconcileCrc {
  total: number;
  uniq: number;
  dup_rows: number;
  pass: boolean;
  /** 该日已被清理：CRC 未实际执行，pass 不代表一致 */
  skipped?: boolean;
}

/** 数据一致性对拍——事件级计数 */
export interface ReconcileEventItem {
  event: string;
  cnt: number;
}

/** 事件级差异（两侧都有但计数不同，按 |差| 排序取前 20） */
export interface ReconcileEventDiff {
  event: string;
  sa_cnt: number;
  raw_cnt: number;
  diff: number;
  deviation_pct: number;
}

/** 仅一侧存在的事件（对侧为 0） */
export interface ReconcileOnlyInOne {
  event: string;
  side: 'sa_events' | 'log_analysis';
  cnt: number;
}

/** 已清理区间（不参与告警判定） */
export interface ReconcileSkippedRange {
  from: string;
  to: string;
  reason: string;
  source: string;
}

/** 对拍配置（单例；写入仅平台超管） */
export interface ReconcileConfig {
  enabled: boolean;
  /** 低峰执行时刻，平台时区 HH:mm */
  run_at: string;
  /** 偏差阈值（百分比，0~100） */
  threshold_pct: number;
  ignore_events: string[];
  skip_empty_event: boolean;
  stale_warn_hours: number;
  stale_error_hours: number;
  updated_by?: string;
  updated_at?: string;
}

/** 元数据自动发现变化记录（新增事件/属性/类型变更） */
export interface DiscoveryLog {
  id: string;
  event: string;
  prop: string | null;
  /**
   * 变化类型（服务端稳定标识）：event_created / property_created / property_type_changed /
   * user_property_created / user_property_type_changed / user_property_hidden / user_property_active；
   * 前端按白名单翻译，未知取值显示原始标识。
   */
  change_type: string;
  /** 稳定 key（eventCreated 等），前端按查看者语言渲染 */
  change_key: string;
  from_value: string | null;
  to_value: string | null;
  created_at: string;
}

/** 事件级差异集（快照里只存这一份，两侧全量清单仅在实时响应里出现） */
export interface ReconcileEventDiffs {
  diffs: ReconcileEventDiff[];
  diff_total: number;
  only_in_one: ReconcileOnlyInOne[];
  ignored_events: string[];
}

/** 数据一致性对拍——完整报告 */
export interface ReconcileReport {
  range: { from: string; to: string };
  /** 偏差阈值（**百分比**，单一语义；历史字段 threshold 是比例，已废弃） */
  threshold_pct: number;
  trigger?: 'auto' | 'manual' | 'cli';
  summary: {
    has_alert: boolean;
    total_days: number;
    alert_days: number;
    skipped_days?: number;
    dup_crc_rows: number;
    crc_pass: boolean;
    recent_changes: number;
    ignored_events?: number;
    skip_empty_event?: boolean;
  };
  daily: { items: ReconcileDailyItem[]; has_alert: boolean };
  crc: ReconcileCrc;
  events: ReconcileEventDiffs & {
    /** 两侧全量事件清单（仅实时对拍响应带回；快照不含） */
    sa_events: ReconcileEventItem[];
    log_analysis: ReconcileEventItem[];
  };
  skipped: ReconcileSkippedRange[];
  discovery_logs: DiscoveryLog[];
  report_path?: string | null;
}

/** 最近一次对拍快照（质量页与数据运维页「健康」同源） */
export interface ReconcileSnapshot {
  ran_at: string;
  range: { from: string; to: string };
  summary: ReconcileReport['summary'] & Record<string, unknown>;
  daily: ReconcileReport['daily'] | null;
  crc: ReconcileCrc | null;
  events: ReconcileEventDiffs | null;
  skipped: ReconcileSkippedRange[] | null;
  threshold_pct: number | null;
  report_path: string | null;
  trigger: string;
  discovery_count: number;
  /** 快照新鲜度：fresh=新鲜 / warn=偏旧（黄）/ error=过期（红） */
  stale_level: 'fresh' | 'warn' | 'error';
  age_hours: number;
  stale_warn_hours: number;
  stale_error_hours: number;
}

export interface QualityReport {
  total_events: number;
  invalid_events: number;
  missing_user_key: number;
  missing_event_time: number;
  top_errors: { reason: string; count: number }[];
}
