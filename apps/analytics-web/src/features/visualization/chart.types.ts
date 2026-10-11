import { CHART_CONFIG_SCHEMA_VERSION, CHART_RECOMMENDATION_VERSION } from './chart.constants';

export { CHART_CONFIG_SCHEMA_VERSION, CHART_RECOMMENDATION_VERSION };

export type ChartMode = 'auto' | 'manual';
export type ResultView = 'table' | 'pivot' | 'chart';
/**
 * 图表类型全集：两个域共用一份 `chart_config` 契约，但各自的白名单不同
 * （见 `chart.constants.ts` 的 `CHART_TYPES_SQL` / `CHART_TYPES_EVENT`）。
 * `stack` / `cumulative` / `distribution` 是事件分析独有；`funnel` 是自定义 SQL 独有。
 */
export type ChartTypeV1 =
  | 'table'
  | 'number'
  | 'line'
  | 'bar'
  | 'pie'
  | 'funnel'
  | 'trend'
  | 'stack'
  | 'cumulative'
  | 'distribution';
export type ColumnRole = 'time' | 'dimension' | 'metric' | 'ignored' | 'pending';
export type Confidence = 'certain' | 'probable' | 'pending' | 'invalid';
export type MetricUnit =
  | 'number'
  | 'ratio_0_1'
  | 'percent_0_100'
  | 'currency'
  | 'currency_cny'
  | 'currency_usd'
  | 'duration_ms'
  | 'duration_sec'
  | 'bytes'
  | 'bytes_iec';
export type AggregationSemantics = 'additive' | 'non_additive' | 'unknown';
export type BaseColumnType = 'time' | 'number' | 'string' | 'boolean' | 'array' | 'object' | 'unknown';

export type ColumnReasonCode =
  | 'saved_role'
  | 'builder_role'
  | 'sql_aggregate_alias'
  | 'clickhouse_time'
  | 'clickhouse_number'
  | 'clickhouse_string'
  | 'alias_time'
  | 'alias_id'
  | 'alias_category'
  | 'alias_metric'
  | 'alias_ratio'
  | 'alias_non_additive'
  | 'strict_time_sample'
  | 'unsafe_integer'
  | 'insufficient_evidence';

export interface ColumnMetricMeta {
  unit: MetricUnit;
  aggregation: AggregationSemantics;
  safeNumber: boolean;
}

export interface ColumnProfile {
  key: string;
  clickhouseType: string;
  baseType: BaseColumnType;
  role: ColumnRole;
  confidence: Confidence;
  reasons: ColumnReasonCode[];
  nonNullCount: number;
  nullCount: number;
  distinctSampleCount: number;
  metric?: ColumnMetricMeta;
}

export interface RowSelector {
  column: string;
  value: string | number | boolean | null;
}

export interface FunnelStepBinding {
  order: number;
  column: string;
  label: string;
}

export interface FunnelLongShape {
  order_column: string;
  label_column: string;
  value_column: string;
}

export interface FunnelBinding {
  shape: 'wide' | 'long';
  metric_family: 'uv' | 'pv' | 'custom';
  steps: FunnelStepBinding[];
  long_shape?: FunnelLongShape;
}

export interface ChartBindings {
  x?: string;
  category?: string;
  series?: string;
  metrics: string[];
  ignored: string[];
  row_selector?: RowSelector;
  funnel?: FunnelBinding;
}

export interface ChartSortOption {
  column: string;
  direction: 'asc' | 'desc';
}

/**
 * 趋势图专属配置（phase: clklog-analytics-trend-chart-v1）。
 * 仅在 `chart_type === 'trend'` 时生效；作为可选字段挂在 ChartOptions 上，
 * 旧配置没有该键时不受影响（AC11）。
 */
export interface TrendOptions {
  /** 外推点数，默认 7；0 表示不外推 */
  forecast_points: number;
  /** 阈值线，用于推演「何时达到 / 跌破」；未设置时为 null */
  threshold: number | null;
  /** 是否显示贯穿全程的回归拟合直线 */
  show_trend_line: boolean;
  /** 是否显示阈值线（threshold 为 null 时忽略） */
  show_threshold: boolean;
}

/** 指标轴归属：左右两条 Y 轴，未列出的指标走左轴 */
export type ChartAxis = 'left' | 'right';

/** X 轴标签策略；两字段都可为 null，表示该维度交回自动判定 */
export interface XLabelOptions {
  rotate: number | null;
  max_width: number | null;
}

export interface ChartOptions {
  orientation: 'vertical' | 'horizontal';
  donut: boolean;
  sort?: ChartSortOption;
  top_n?: number;
  include_other: boolean;
  units: Record<string, MetricUnit>;
  aggregation: Record<string, AggregationSemantics>;
  /** 趋势图配置；可选，旧配置无此键时按默认处理 */
  trend?: TrendOptions;
  /** Grafana 风格显示值；缺省由图形类型决定 */
  stat_calcs?: Array<'last' | 'avg' | 'max' | 'min' | 'first' | 'total'>;
  /**
   * 指标轴归属（phase: clklog-analytics-event-chart-binding-v1）。
   * 仅当至少一个指标为 `'right'` 时才渲染第二条 Y 轴；缺省全部左轴。
   */
  metric_axis?: Record<string, ChartAxis>;
  /** X 轴标签策略；缺省或 null 时按分类数与标签长度自动决定 */
  x_label?: XLabelOptions | null;
}

export interface ChartConfigV1 {
  schema_version: 1;
  recommendation_version: 1;
  mode: ChartMode;
  preferred_view: ResultView;
  chart_type: ChartTypeV1;
  roles: Record<string, Exclude<ColumnRole, 'pending'>>;
  bindings: ChartBindings;
  options: ChartOptions;
}

export type ChartIssueCode =
  | 'NO_ROWS'
  | 'AMBIGUOUS_COLUMN_ROLE'
  | 'MISSING_TIME'
  | 'MISSING_DIMENSION'
  | 'MISSING_METRIC'
  | 'DUPLICATE_KEY'
  | 'TOO_MANY_SERIES'
  | 'TOO_MANY_ROWS'
  | 'TOO_MANY_POINTS'
  | 'TOO_MANY_METRICS'
  | 'NEGATIVE_VALUE'
  | 'ZERO_TOTAL'
  | 'NON_ADDITIVE_METRIC'
  | 'MIXED_UNITS'
  | 'UNSAFE_INTEGER'
  | 'MULTI_ROW_FUNNEL_REQUIRES_SELECTION'
  | 'ROW_SELECTOR_NO_MATCH'
  | 'ROW_SELECTOR_NOT_UNIQUE'
  | 'NON_MONOTONIC_FUNNEL'
  | 'STALE_CONFIG'
  | 'UNSUPPORTED_CONFIG_VERSION'
  | 'RENDER_ERROR'
  | 'TRUNCATED_RESULT'
  | 'RECOMMENDATION_UPGRADE_AVAILABLE'
  | 'AXIS_SPLIT_SUGGESTED'
  | 'SERIES_DIMENSION_UNUSED'
  | 'SERIES_CELL_COLLAPSED'
  | 'SERIES_LIMIT_EXCEEDED'
  | 'STALE_BINDING';

export interface ChartIssue {
  code: ChartIssueCode;
  severity: 'info' | 'warning' | 'error';
  columns?: string[];
  params?: Record<string, string | number>;
}

export interface ChartCandidate {
  chartType: ChartTypeV1;
  compatible: boolean;
  config?: ChartConfigV1;
  reasonCodes: string[];
  issues: ChartIssue[];
}

export interface ChartInferenceResult {
  profiles: ColumnProfile[];
  recommended: ChartCandidate | null;
  candidates: ChartCandidate[];
  issues: ChartIssue[];
}

export interface QueryColumn {
  name: string;
  type: string;
}

/**
 * 字段绑定面板的候选列（phase: clklog-analytics-event-chart-binding-v1）。
 *
 * 中性地表达「一个可绑定的结果列」，让同一个面板服务两个域：
 * SQL 侧由 `ColumnProfile` 映射（`typeLabel` 带 ClickHouse 类型），
 * 事件侧由结果列直接映射（角色来自服务端 `role`，没有类型可展示）。
 * 类型定义在使用方（面板所在包），避免 `visualization` 反向依赖事件侧。
 */
export interface BindingColumn {
  /** 绑定里写入的值（SQL 侧是列名，事件侧是 `g_0` / `m_0` 这类结果列 key） */
  key: string;
  /** 下拉里显示的列名（SQL 侧就是列名；事件侧是结果列表头，因为 key 对用户没有意义） */
  label: string;
  role: Exclude<ColumnRole, 'pending'>;
  /** 附加展示信息（SQL 侧是「ClickHouse 类型 · 角色/置信度」）；事件侧留空 */
  typeLabel?: string;
  /** 是否为数值列：决定能否出现在「指标」候选中（SQL 侧类型未知时可能是未定列） */
  numeric?: boolean;
}

export interface BuilderGroup {
  kind: 'time' | 'property' | 'column';
  granularity?: string;
  prop?: string;
}

export interface BuilderMetric {
  fn: string;
  prop?: string;
}

export interface BuilderDslLike {
  event?: string;
  groups?: BuilderGroup[];
  metrics?: BuilderMetric[];
}

export interface ProfilerContext {
  savedRoles?: Record<string, Exclude<ColumnRole, 'pending'>>;
  builderDsl?: BuilderDslLike;
  /** 产生该结果的 SQL；用于把聚合别名识别为指标（比名字正则更可靠）。 */
  sql?: string;
}

export interface FunnelShape {
  family: 'uv' | 'pv' | 'custom';
  steps: FunnelStepBinding[];
  dimensionColumns: string[];
}

export interface NormalizedPoint {
  x?: string | number | null;
  category?: string | null;
  series?: string | null;
  values: Record<string, number | null>;
  originalIndex: number;
}

export interface NormalizedChartData {
  points: NormalizedPoint[];
  originalRowCount: number;
  displayedCount: number;
  transforms: string[];
  selectedRow?: Record<string, unknown>;
}

export interface ChartAdapterResult {
  option: Record<string, unknown>;
  summary: string;
  audit: {
    inputRows: number;
    outputPoints: number;
    transforms: string[];
  };
}

export interface ResolvedVisualization {
  profiles: ColumnProfile[];
  inference: ChartInferenceResult;
  config: ChartConfigV1 | null;
  view: ResultView;
  issues: ChartIssue[];
  data?: NormalizedChartData;
  adapter?: ChartAdapterResult;
}

export type CardChartType = 'line' | 'bar' | 'table' | 'number' | 'pie' | 'funnel' | 'trend';
