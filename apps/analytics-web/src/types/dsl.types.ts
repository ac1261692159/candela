export type MetricType =
  | 'count'
  | 'uniq_user'
  | 'agg'
  | 'per_user';

export type AggFunction =
  | 'sum'
  | 'avg'
  | 'max'
  | 'min'
  | 'uniq'
  | 'p50'
  | 'p90'
  | 'p99';

export type PerUserFunction = 'count' | 'uniq_user';

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
export type TimeExtract = 'hour_of_day' | 'day_of_month' | 'minute_of_hour';
export type EventTimeGranularity = TimeGranularity | 'minute' | 'total';

export type FormulaExpr =
  | { type: 'metric'; id: string }
  | { type: 'const'; value: number }
  | { type: 'op'; op: '+' | '-' | '*' | '/'; left: FormulaExpr; right: FormulaExpr };

export type FilterOperator =
  | '='
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

export type GroupScope = 'event' | 'user' | 'time' | 'cohort' | 'tag' | 'dimension';

export type TimeGranularity = 'hour' | 'day' | 'week' | 'month';

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
  n?: number;
  from_offset?: number;
  to_offset?: number;
  anchor_start?: string;
}

export interface TimeRange {
  start: string;
  end: string;
  relative?: TimeRangeRelative;
  /** 展示时区（IANA 名；缺省 = 平台时区，phase: clklog-analytics-timezone-v1） */
  timezone?: string;
}

export interface FilterItem {
  scope: 'event' | 'user' | 'cohort' | 'tag';
  prop: string;
  op: FilterOperator;
  value?: unknown;
}

export interface FilterGroup {
  logic: 'and' | 'or';
  items: (FilterItem | FilterGroup)[];
}

export interface MetricItem {
  id: string;
  kind?: MetricKind;
  analysis?: AnalysisMethod;
  percentile?: number;
  stage_reduce?: StageReduce;
  expression?: FormulaExpr;
  format?: FormulaFormat;
  alias?: string;
  /** 隐藏指标：照常计算供公式引用，但不进结果列 */
  hidden?: boolean;
  /** 数值变换：先乘系数，再保留小数位 */
  /**
   * 数值变换（v3）：先做四则运算，再保留小数位。
   * `factor` 是 v2 的旧写法（等价于 op='mul'），读取侧两种都认。
   */
  transform?: {
    op?: 'mul' | 'div' | 'add' | 'sub';
    value?: number;
    factor?: number;
    decimals?: number;
  };
  event?: string;
  prop?: string;
  filters?: FilterGroup;
  type?: MetricType;
  func?: AggFunction | PerUserFunction;
}

export interface GroupItem {
  scope: GroupScope;
  prop?: string;
  granularity?: EventTimeGranularity;
  extract?: TimeExtract;
  topn?: number;
  alias?: string;
}

export interface EventAnalysisQuery {
  event: string;
  metrics: MetricItem[];
  filters?: FilterGroup;
  groups?: GroupItem[];
  time_range: TimeRange;
  project_name?: string;
  subject_id?: string;
  /** 去重类指标用 uniqCombined(12)；缺省精确 */
  approx?: boolean;
}

export interface FunnelStep {
  name?: string;
  event: string;
  filters?: FilterGroup;
}

export const MIN_FUNNEL_STEPS = 2;
export const MAX_FUNNEL_STEPS = 32;

export interface FunnelQuery {
  steps: FunnelStep[];
  time_range: TimeRange;
  window_seconds: number;
  filters?: FilterGroup;
  groups?: GroupItem[];
  limit_window_in_range?: boolean;
  project_name?: string;
  subject_id?: string;
}

export interface RetentionEvent {
  event: string;
  filters?: FilterGroup;
}

export interface RetentionQuery {
  start_event: RetentionEvent;
  retain_event: RetentionEvent;
  cohort: 'first_day' | 'all';
  granularity: Exclude<TimeGranularity, 'hour'>;
  n_list: number[];
  time_range: TimeRange;
  filters?: FilterGroup;
  groups?: GroupItem[];
  project_name?: string;
  subject_id?: string;
}

export type QueryColumnRole = 'time' | 'dimension' | 'metric';

export interface QueryColumn {
  key: string;
  /**
   * 列角色（phase: clklog-analytics-event-chart-binding-v1）。
   *
   * 事件分析结果必给，由服务端按查询定义判定；漏斗 / 留存结果不下发。
   * 读取一律走 `columnRole()`：本字段优先，缺失时回退 `g_` / `m_` 前缀，
   * 这样升级期间命中的旧缓存结果也能正常绑定。
   */
  role?: QueryColumnRole;
  title: string;
  /**
   * 服务端**固定文案**列名的文案键（i18n phase: clklog-analytics-i18n-v1）。
   * 渲染与导出统一走 `features/query/column-titles.ts`；用户数据列（事件名 / 属性名 /
   * 别名 / 维表显示名）没有本字段，回落中文 `title`（老响应同样如此）。
   */
  title_key?: string;
  /** 文案键插值参数（值为数据：时间粒度 / 第 N 日 / 步骤名等） */
  title_params?: Record<string, unknown>;
  unit?: 'number' | 'duration_sec' | 'percent';
  /** 值映射（数据表 v1 §7）：原始值 → 维表业务名；只含命中的值，未命中回落原始值 */
  value_map?: Record<string, string>;
  /** 值映射用的是维表哪一列的显示名（表头标注「按 X 显示」） */
  value_map_title?: string;
  /** 命中率体检：本列去重值总数与维表命中数（0 命中 = 疑似配错或维表未覆盖） */
  value_map_stats?: { sampled: number; matched: number; truncated?: boolean };
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  elapsed_ms: number;
  sql?: string;
  from_cache?: boolean;
}

export interface FunnelResult extends QueryResult {
  steps?: { key: string; title: string }[];
}

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}
