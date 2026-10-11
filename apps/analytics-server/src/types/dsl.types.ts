export type MetricType = 'count' | 'uniq_user' | 'agg' | 'per_user';
export type AggFunc = 'sum' | 'avg' | 'max' | 'min' | 'uniq' | 'p50' | 'p90' | 'p99';
export type PerUserFunc = 'count' | 'uniq_user';

export const ANY_EVENT = '*';
export const MAX_EVENT_METRICS = 10;

export function isAnyEvent(event?: string | null): boolean {
  return event === ANY_EVENT;
}

export type MetricKind = 'event' | 'formula';
export type AnalysisMethod =
  | 'total_times'
  | 'trig_user_num'
  | 'per_capita_times'
  | 'sum'
  | 'avg'
  | 'per_capita_num'
  | 'max'
  | 'min'
  | 'distinct'
  | 'true_num'
  | 'false_num'
  | 'is_empty'
  | 'is_not_empty'
  | 'array_distinct'
  | 'array_item_distinct'
  | 'percentile'
  | 'variance'
  | 'stddev';
export type StageReduce = 'sum' | 'avg' | 'weighted' | 'max' | 'min' | 'uniq_total';
export type FormulaFormat = 'number' | 'percent' | 'decimal2' | 'decimal3';

export type FormulaExpr =
  | { type: 'metric'; id: string }
  | { type: 'const'; value: number }
  | { type: 'op'; op: '+' | '-' | '*' | '/'; left: FormulaExpr; right: FormulaExpr };

export type FilterOp =
  | '='
  | 'eq'
  | '!='
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'regex'
  | 'not_regex'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_set'
  | 'not_set';

export const ANALYSIS_UID_EXPR = "if(user_key != '', user_key, distinct_id)";

export type FilterScope = 'event' | 'user' | 'cohort' | 'tag';
export type GroupScope = 'event' | 'user' | 'time' | 'cohort' | 'tag';
export type TimeGranularity = 'hour' | 'day' | 'week' | 'month';
export type EventTimeGranularity = TimeGranularity | 'minute' | 'total';
export type TimeExtract = 'hour_of_day' | 'day_of_month' | 'minute_of_hour';
export type CompareType = 'none' | 'last_period' | 'last_year' | 'custom';

export type TimeRangeRelativeKind =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'past_n'
  | 'recent_n'
  | 'from_date_to_yesterday'
  | 'from_date_to_today'
  | 'custom_offsets';

export interface TimeRangeRelative {
  kind: TimeRangeRelativeKind;
  /** past_n / recent_n，1..366 */
  n?: number;
  /** custom_offsets，0 = 今天 */
  from_offset?: number;
  to_offset?: number;
  /** from_date_* 的固定开始日 YYYY-MM-DD */
  anchor_start?: string;
}

export interface TimeRange {
  start: string; // YYYY-MM-DD（最近一次解析快照）
  end: string;   // YYYY-MM-DD
  relative?: TimeRangeRelative;
  /** 展示时区（IANA 名）；缺省 = 平台时区（phase: clklog-analytics-timezone-v1） */
  timezone?: string;
  compare?: CompareType;
  compare_start?: string;
  compare_end?: string;
}

export interface FilterItem {
  scope: FilterScope;
  prop: string;
  op: FilterOp;
  value?: unknown;
}

export interface FilterGroup {
  logic: 'and' | 'or';
  items: (FilterItem | FilterGroup)[];
}

export interface MetricTransform {
  /** 四则运算（v3）：mul=乘 div=除 add=加 sub=减；与 value 成对使用 */
  op?: 'mul' | 'div' | 'add' | 'sub';
  /** 运算数（|value| ≤ 1e6；div 不得为 0） */
  value?: number;
  /** 旧字段（等价 op='mul'）：读时归一化，写回时升级为 op/value */
  factor?: number;
  /** 保留小数位（0..6）；在四则运算之后执行 */
  decimals?: number;
}

export interface Metric {
  id: string;
  kind?: MetricKind;
  analysis?: AnalysisMethod;
  percentile?: number;
  stage_reduce?: StageReduce;
  expression?: FormulaExpr;
  format?: FormulaFormat;
  alias?: string;
  name?: string;
  /** 隐藏指标：照常计算供公式引用，但不进结果列 */
  hidden?: boolean;
  /** 数值变换：先乘系数，再保留小数位（在数据库聚合时应用） */
  transform?: MetricTransform;
  event?: string;
  prop?: string;
  filters?: FilterGroup;
  /** 旧卡片只读兼容，查询前会规范化成 analysis */
  type?: MetricType;
  func?: AggFunc | PerUserFunc;
}

export interface Group {
  scope: GroupScope;
  prop?: string;
  granularity?: EventTimeGranularity;
  extract?: TimeExtract;
}

export interface EventAnalysisQuery {
  project: string;
  event: string;
  metrics: Metric[];
  filters?: FilterGroup;
  groups?: Group[];
  group_limit?: number;
  time_range: TimeRange;
  limit?: number;
  subject_id?: string;
  /** 去重类指标用 uniqCombined(12)；缺省精确 */
  approx?: boolean;
}

export interface FunnelStep {
  event: string;
  alias?: string;
  filters?: FilterGroup;
}

export const MIN_FUNNEL_STEPS = 2;
export const MAX_FUNNEL_STEPS = 32;

export interface FunnelQuery {
  project: string;
  window_seconds: number;
  steps: FunnelStep[];
  filters?: FilterGroup;
  groups?: Group[];
  granularity?: 'total' | TimeGranularity;
  limit_window_in_range?: boolean;
  time_range: TimeRange;
  subject_id?: string;
}

export interface RetentionEvent {
  event: string;
  filters?: FilterGroup;
}

export interface RetentionQuery {
  project: string;
  start_event: RetentionEvent;
  retain_event: RetentionEvent;
  cohort: 'first_day' | 'all';
  granularity: Exclude<TimeGranularity, 'hour'>;
  n_list: number[];
  time_range: TimeRange;
  filters?: FilterGroup;
  groups?: Group[];
  subject_id?: string;
}

export interface SqlReportQuery {
  project: string;
  sql: string;
  limit?: number;
}
