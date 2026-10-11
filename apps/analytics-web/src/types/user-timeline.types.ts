/** 单用户行为序列（phase: clklog-analytics-user-timeline-v1） */

/** 查询入参：时间按**平台时区**解释（`YYYY-MM-DD HH:mm`，服务端补秒） */
export interface UserTimelineQuery {
  subject_id?: string;
  /** 标识口径：默认 subject（分析主体：user_key 优先，否则 distinct_id）；也可按用户属性/事件属性查 */
  id_kind?: 'subject' | 'user_property' | 'event_property';
  /** id_kind 为属性时的属性键（如 massid） */
  id_key?: string;
  value: string;
  from: string;
  to: string;
  events?: string[];
  order?: 'asc' | 'desc';
  /** 物化条数（本地分页的数据量，≤5000）—— 与后端 DTO 同名字段 `limit` */
  limit?: number;
  /** 服务端行级筛选（属性等值；会重查） */
  filter_key?: string;
  filter_scope?: 'event' | 'user';
  filter_value?: string;
}

export interface UserTimelineRow {
  log_time: string;
  event: string;
  distinct_id: string;
  user_key: string;
  properties: string;
}

/** 行为概览（聚合查询，不读 properties；明细转后台时也会先返回） */
export interface UserTimelineOverview {
  daily: { date: string; count: number }[];
  events: { event: string; count: number }[];
}

/** 用户画像：用户属性 + 标签最新值 */
export interface UserTimelineProfile {
  attributes: Record<string, unknown>;
  tags: { tag_id: string; name: string; value: string }[];
  /** 按用户属性查时解析到的标识（页面显示「已解析为用户标识 1_14552557」） */
  resolved?: { distinct_id: string; user_key: string } | null;
  /** 按用户属性查时匹配到的标识个数（0 = 属性键或值不对） */
  matched_users?: number;
}

/** 汇总（与明细同一次扫描算出） */
export interface UserTimelineSummary {
  matched_total: number;
  shown_total: number;
  event_kinds: number;
  first_log_time: string | null;
  last_log_time: string | null;
  truncated: boolean;
}

/** 快路径结果 */
export interface UserTimelineResult extends UserTimelineSummary {
  items: UserTimelineRow[];
  overview?: UserTimelineOverview;
  from: string;
  to: string;
  order: 'asc' | 'desc';
  archived: boolean;
  record_id?: string;
  archive_disabled?: boolean;
}

/** 超预算转后台 */
export interface UserTimelineHandoff {
  /** 概览先行：转后台时也已带上 */
  overview?: UserTimelineOverview;
  status: 'running';
  record_id: string;
  reused?: boolean;
  from: string;
  to: string;
}

export type UserTimelineOutcome = UserTimelineResult | UserTimelineHandoff;

export function isTimelineHandoff(outcome: UserTimelineOutcome): outcome is UserTimelineHandoff {
  return (outcome as UserTimelineHandoff).status === 'running';
}

export interface UserTimelineRecordSummary {
  id: string;
  created_at: string;
  created_by: string;
  created_by_name: string | null;
  spec_json: string | null;
  summary_json: string | null;
  matched_total: number;
  row_count: number;
  truncated: boolean;
  duration_ms: number | null;
  status?: 'pending' | 'running' | 'done' | 'failed';
  error_code?: string | null;
}

export interface UserTimelineRecordDetail extends UserTimelineRecordSummary {
  rows: (UserTimelineRow & { id: string; seq: number; properties_truncated: boolean })[];
}

/** 「查看前后行为」结果（窗口 = 当前查询区间） */
export interface UserTimelineNeighbors {
  before: UserTimelineRow[];
  after: UserTimelineRow[];
}
