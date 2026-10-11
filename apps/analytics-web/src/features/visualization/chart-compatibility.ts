import {
  BAR_DEFAULT_TOP_N,
  BAR_HORIZONTAL_CATEGORY_THRESHOLD,
  BAR_MAX_METRICS,
  BAR_TOP_N_THRESHOLD,
  CHART_CONFIG_SCHEMA_VERSION,
  CHART_MAX_INPUT_ROWS,
  CHART_RECOMMENDATION_VERSION,
  FUNNEL_MAX_STEPS,
  FUNNEL_MIN_STEPS,
  LINE_MAX_METRICS,
  LINE_MAX_POINTS_PER_SERIES,
  LINE_MAX_SERIES,
  LINE_MAX_TOTAL_POINTS,
  NUMBER_MAX_METRICS,
  PIE_OTHER_MAX_CATEGORIES,
} from './chart.constants';
import { createIssue } from './chart-issues';
import { axisOfMetric, mixedUnitAxes } from './metric-units';
import type {
  AggregationSemantics,
  BindingColumn,
  ChartCandidate,
  ChartConfigV1,
  ChartIssue,
  ChartOptions,
  ChartTypeV1,
  ColumnProfile,
  FunnelShape,
  MetricUnit,
  ResultView,
} from './chart.types';
import { distinctCount, parseStrictNumber } from './column-profiler';
import { detectFunnelShape } from './funnel-shape';
import { t as translate } from '../../i18n';

export interface RoleBuckets {
  time: ColumnProfile[];
  dimension: ColumnProfile[];
  metric: ColumnProfile[];
  pending: ColumnProfile[];
  ignored: ColumnProfile[];
}

export function bucketRoles(profiles: ColumnProfile[]): RoleBuckets {
  const buckets: RoleBuckets = { time: [], dimension: [], metric: [], pending: [], ignored: [] };
  for (const profile of profiles) {
    if (profile.role === 'time') buckets.time.push(profile);
    else if (profile.role === 'dimension') buckets.dimension.push(profile);
    else if (profile.role === 'metric') buckets.metric.push(profile);
    else if (profile.role === 'ignored') buckets.ignored.push(profile);
    else buckets.pending.push(profile);
  }
  return buckets;
}

export function defaultOptions(partial?: Partial<ChartOptions>): ChartOptions {
  return {
    orientation: partial?.orientation ?? 'vertical',
    donut: partial?.donut ?? false,
    sort: partial?.sort,
    top_n: partial?.top_n,
    include_other: partial?.include_other ?? false,
    units: partial?.units ?? {},
    aggregation: partial?.aggregation ?? {},
    // 趋势图配置；非趋势图为 undefined，不影响其它图表
    trend: partial?.trend,
    stat_calcs: partial?.stat_calcs,
    // 事件侧字段绑定：未配置 = 全左轴 + 标签策略自动
    metric_axis: partial?.metric_axis ?? {},
    x_label: partial?.x_label ?? null,
  };
}

export function rolesRecord(profiles: ColumnProfile[]): ChartConfigV1['roles'] {
  const roles: ChartConfigV1['roles'] = {};
  for (const profile of profiles) {
    if (profile.role !== 'pending') roles[profile.key] = profile.role;
  }
  return roles;
}

/**
 * `ColumnProfile` → 字段面板的中性候选列。
 *
 * 面板不认 `ColumnProfile`（它带 `confidence` / `reasons`，事件侧没有、也不该伪造），
 * 只认「key + 展示名 + 角色」；SQL 侧的画像细节压进 `typeLabel` 供用户参考。
 */
export function bindingColumnsFromProfiles(profiles: ColumnProfile[]): BindingColumn[] {
  return profiles.map((profile) => ({
    key: profile.key,
    label: profile.key,
    role: profile.role === 'pending' ? 'dimension' : profile.role,
    typeLabel: `${profile.clickhouseType} · ${profile.role}/${profile.confidence}`,
    numeric: profile.baseType === 'number',
  }));
}

export function metricUnit(profile: ColumnProfile, options?: ChartOptions): MetricUnit {
  return options?.units[profile.key] ?? profile.metric?.unit ?? 'number';
}

export function metricAggregation(profile: ColumnProfile, options?: ChartOptions): AggregationSemantics {
  return options?.aggregation[profile.key] ?? profile.metric?.aggregation ?? 'unknown';
}

function sameUnits(metrics: ColumnProfile[], options?: ChartOptions): boolean {
  if (metrics.length <= 1) return true;
  const units = new Set(metrics.map((item) => metricUnit(item, options)));
  return units.size === 1;
}

/**
 * 轴内单位判定（phase: clklog-analytics-axis-unit-coherence-v1）。
 *
 * 双轴之后「单位一致」的主语是同一根轴：跨轴不同单位是正确用法，不该报；
 * 同一根轴混两种单位才报，且要能指出是哪根轴、涉及哪些指标。
 */
function mixedUnitIssues(metrics: ColumnProfile[], options?: ChartOptions): ChartIssue[] {
  const entries = metrics.map((item) => ({ key: item.key, unit: metricUnit(item, options) }));
  return mixedUnitAxes(entries, (key) => axisOfMetric(key, options)).map((group) =>
    createIssue('MIXED_UNITS', 'error', { columns: group.columns, params: { axis: group.axis } }),
  );
}

function configOf(
  chartType: ChartTypeV1,
  view: ResultView,
  profiles: ColumnProfile[],
  bindings: ChartConfigV1['bindings'],
  options?: Partial<ChartOptions>,
  reasonCodes: string[] = [],
  issues: ChartIssue[] = [],
): ChartCandidate {
  return {
    chartType,
    compatible: issues.every((issue) => issue.severity !== 'error'),
    reasonCodes,
    issues,
    config: {
      schema_version: CHART_CONFIG_SCHEMA_VERSION,
      recommendation_version: CHART_RECOMMENDATION_VERSION,
      mode: 'auto',
      preferred_view: view,
      chart_type: chartType,
      roles: rolesRecord(profiles),
      bindings,
      options: defaultOptions(options),
    },
  };
}

function linePointIssues(rows: Record<string, unknown>[], x: string, series?: string): ChartIssue[] {
  const issues: ChartIssue[] = [];
  const keys = new Set<string>();
  let seriesCount = 0;
  const seriesSeen = new Set<string>();
  let points = 0;
  const perSeries = new Map<string, number>();
  for (const row of rows) {
    const xValue = row[x];
    if (xValue === null || xValue === undefined || xValue === '') continue;
    const seriesValue = series ? String(row[series] ?? '') : '';
    if (series) {
      seriesSeen.add(seriesValue);
    }
    const key = series ? `${String(xValue)}\u0000${seriesValue}` : String(xValue);
    if (keys.has(key)) {
      issues.push(createIssue('DUPLICATE_KEY', 'error', { columns: series ? [x, series] : [x] }));
      return issues;
    }
    keys.add(key);
    points += 1;
    const seriesKey = series ? seriesValue : '_';
    perSeries.set(seriesKey, (perSeries.get(seriesKey) ?? 0) + 1);
  }
  seriesCount = series ? seriesSeen.size : 1;
  if (seriesCount > LINE_MAX_SERIES) {
    issues.push(createIssue('TOO_MANY_SERIES', 'error', { params: { max: LINE_MAX_SERIES, count: seriesCount } }));
  }
  if (points > LINE_MAX_TOTAL_POINTS) {
    issues.push(createIssue('TOO_MANY_POINTS', 'error', { params: { count: points, max: LINE_MAX_TOTAL_POINTS } }));
  }
  for (const count of perSeries.values()) {
    if (count > LINE_MAX_POINTS_PER_SERIES) {
      issues.push(createIssue('TOO_MANY_POINTS', 'error', { params: { count, max: LINE_MAX_POINTS_PER_SERIES } }));
      break;
    }
  }
  return issues;
}

function categoryKeyIssues(rows: Record<string, unknown>[], category: string): ChartIssue[] {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = String(row[category] ?? '');
    if (keys.has(key)) {
      return [createIssue('DUPLICATE_KEY', 'error', { columns: [category] })];
    }
    keys.add(key);
  }
  return [];
}

function unsafeOrMissingMetrics(metrics: ColumnProfile[]): ChartIssue[] {
  const issues: ChartIssue[] = [];
  if (!metrics.length) issues.push(createIssue('MISSING_METRIC'));
  for (const metric of metrics) {
    if (metric.metric && !metric.metric.safeNumber) {
      issues.push(createIssue('UNSAFE_INTEGER', 'error', { columns: [metric.key] }));
    }
    if (metric.confidence === 'pending' || metric.role === 'pending') {
      issues.push(createIssue('AMBIGUOUS_COLUMN_ROLE', 'error', { columns: [metric.key] }));
    }
  }
  return issues;
}

export function evaluateLine(
  profiles: ColumnProfile[],
  rows: Record<string, unknown>[],
  options?: ChartOptions,
): ChartCandidate {
  const buckets = bucketRoles(profiles);
  const issues: ChartIssue[] = [];
  if (buckets.time.length !== 1) issues.push(createIssue('MISSING_TIME'));
  const metrics = buckets.metric.slice(0, LINE_MAX_METRICS);
  if (buckets.metric.length > LINE_MAX_METRICS) {
    issues.push(createIssue('TOO_MANY_METRICS', 'error', { params: { max: LINE_MAX_METRICS } }));
  }
  issues.push(...unsafeOrMissingMetrics(metrics));
  issues.push(...mixedUnitIssues(metrics, options));
  const time = buckets.time[0];
  const series = buckets.dimension.length === 1 && metrics.length === 1 ? buckets.dimension[0] : undefined;
  if (time && metrics.length) {
    issues.push(...linePointIssues(rows, time.key, series?.key));
  }
  const reasonCodes = series
    ? ['one_time', 'one_category', 'one_metric', 'series_2_to_5']
    : ['one_time', 'metrics_1_to_5'];
  return configOf(
    'line',
    'chart',
    profiles,
    {
      x: time?.key,
      series: series?.key,
      metrics: metrics.map((item) => item.key),
      ignored: buckets.ignored.map((item) => item.key),
    },
    options,
    reasonCodes,
    issues,
  );
}

/** 分类轴要挑「能分类」的维度：全行同值的常数维度画不出有意义的柱/饼。
 *  线上实例：结果里第一维是「数据日期」（3 行同值）而真正的维度是「资源类型」，
 *  按 dimension[0] 取会得到 DUPLICATE_KEY，导致柱/饼候选全部不可用、推荐器只剩 table。 */
function usableCategory(
  dimensions: ColumnProfile[],
  rows: Record<string, unknown>[],
): ColumnProfile | undefined {
  return dimensions.find((item) => distinctCount(rows, item.key) > 1) ?? dimensions[0];
}

export function evaluateBar(
  profiles: ColumnProfile[],
  rows: Record<string, unknown>[],
  options?: ChartOptions,
): ChartCandidate {
  const buckets = bucketRoles(profiles);
  const issues: ChartIssue[] = [];
  if (buckets.dimension.length < 1) issues.push(createIssue('MISSING_DIMENSION'));
  const metrics = buckets.metric.slice(0, BAR_MAX_METRICS);
  if (buckets.metric.length > BAR_MAX_METRICS) {
    issues.push(createIssue('TOO_MANY_METRICS', 'error', { params: { max: BAR_MAX_METRICS } }));
  }
  issues.push(...unsafeOrMissingMetrics(metrics));
  // 柱状/条形没有双轴：全部指标共用一根刻度，整图判定在这里是正确语义（保持不动）
  if (metrics.length && !sameUnits(metrics, options)) issues.push(createIssue('MIXED_UNITS'));
  const category = usableCategory(buckets.dimension, rows);
  if (category) issues.push(...categoryKeyIssues(rows, category.key));
  const categoryCount = category ? distinctCount(rows, category.key) : 0;
  if (category && categoryCount === 0) issues.push(createIssue('MISSING_DIMENSION', 'error', { columns: [category.key] }));
  const orientation =
    options?.orientation ?? (categoryCount > BAR_HORIZONTAL_CATEGORY_THRESHOLD ? 'horizontal' : 'vertical');
  const topN =
    options?.top_n ?? (categoryCount > BAR_TOP_N_THRESHOLD ? BAR_DEFAULT_TOP_N : undefined);
  return configOf(
    'bar',
    'chart',
    profiles,
    {
      category: category?.key,
      metrics: metrics.map((item) => item.key),
      ignored: buckets.ignored.map((item) => item.key),
    },
    { ...options, orientation, top_n: topN, sort: options?.sort ?? (metrics[0] ? { column: metrics[0].key, direction: 'desc' } : undefined) },
    ['one_category', metrics.length > 1 ? 'metrics_2_to_4' : 'one_metric'],
    issues,
  );
}

export function evaluatePie(
  profiles: ColumnProfile[],
  rows: Record<string, unknown>[],
  options?: ChartOptions,
): ChartCandidate {
  const buckets = bucketRoles(profiles);
  const issues: ChartIssue[] = [];
  const category = usableCategory(buckets.dimension, rows);
  const metric = buckets.metric[0];
  if (!category) issues.push(createIssue('MISSING_DIMENSION'));
  if (!metric) issues.push(createIssue('MISSING_METRIC'));
  if (buckets.metric.length !== 1 && metric) {
    issues.push(createIssue('TOO_MANY_METRICS', 'error', { params: { max: 1 } }));
  }
  if (metric) issues.push(...unsafeOrMissingMetrics([metric]));
  if (metric && metricAggregation(metric, options) !== 'additive') {
    issues.push(createIssue('NON_ADDITIVE_METRIC', 'error', { columns: [metric.key] }));
  }
  if (category) issues.push(...categoryKeyIssues(rows, category.key));
  const categoryCount = category ? distinctCount(rows, category.key) : 0;
  if (categoryCount > PIE_OTHER_MAX_CATEGORIES) {
    issues.push(createIssue('TOO_MANY_SERIES', 'error', { params: { max: PIE_OTHER_MAX_CATEGORIES, count: categoryCount } }));
  }
  let total = 0;
  let hasNegative = false;
  if (metric) {
    for (const row of rows) {
      const parsed = parseStrictNumber(row[metric.key]);
      if (parsed === 'unsafe') continue;
      if (parsed === null) continue;
      if (parsed < 0) hasNegative = true;
      total += parsed;
    }
  }
  if (hasNegative) issues.push(createIssue('NEGATIVE_VALUE', 'error', { columns: metric ? [metric.key] : undefined }));
  if (metric && total <= 0 && !hasNegative) issues.push(createIssue('ZERO_TOTAL'));
  return configOf(
    'pie',
    'chart',
    profiles,
    {
      category: category?.key,
      metrics: metric ? [metric.key] : [],
      ignored: buckets.ignored.map((item) => item.key),
    },
    {
      ...options,
      donut: options?.donut ?? false,
      include_other: categoryCount > 6,
      top_n: categoryCount > 6 ? 5 : undefined,
    },
    ['one_category', 'one_additive_metric'],
    issues,
  );
}

export function evaluateNumber(
  profiles: ColumnProfile[],
  rows: Record<string, unknown>[],
  options?: ChartOptions,
  rowSelector?: ChartConfigV1['bindings']['row_selector'],
): ChartCandidate {
  const buckets = bucketRoles(profiles);
  const issues: ChartIssue[] = [];
  const metrics = buckets.metric.slice(0, NUMBER_MAX_METRICS);
  if (buckets.metric.length > NUMBER_MAX_METRICS) {
    issues.push(createIssue('TOO_MANY_METRICS', 'error', { params: { max: NUMBER_MAX_METRICS } }));
  }
  issues.push(...unsafeOrMissingMetrics(metrics));
  if (rows.length > 1 && !rowSelector) {
    issues.push(createIssue('MULTI_ROW_FUNNEL_REQUIRES_SELECTION', 'error', {
      params: { dimension: buckets.dimension[0]?.key ?? translate('sql:chart.fallbackRow') },
    }));
  }
  return configOf(
    'number',
    'chart',
    profiles,
    {
      metrics: metrics.map((item) => item.key),
      ignored: buckets.ignored.map((item) => item.key),
      row_selector: rowSelector,
    },
    options,
    ['single_row', 'metrics_1_to_8'],
    issues,
  );
}

export function evaluateFunnel(
  profiles: ColumnProfile[],
  rows: Record<string, unknown>[],
  shape: FunnelShape | null,
  options?: ChartOptions,
  bindings?: ChartConfigV1['bindings'],
): ChartCandidate {
  const issues: ChartIssue[] = [];
  const funnel = bindings?.funnel ?? (shape
    ? { shape: 'wide' as const, metric_family: shape.family, steps: shape.steps }
    : undefined);
  if (!funnel || funnel.steps.length < FUNNEL_MIN_STEPS || funnel.steps.length > FUNNEL_MAX_STEPS) {
    issues.push(createIssue('MISSING_METRIC'));
  }
  const dim = bindings?.row_selector?.column ?? shape?.dimensionColumns[0];
  if (rows.length > 1 && !bindings?.row_selector) {
    issues.push(createIssue('MULTI_ROW_FUNNEL_REQUIRES_SELECTION', 'warning', {
      params: { dimension: dim ?? translate('sql:chart.fallbackGroup') },
    }));
  }
  return configOf(
    'funnel',
    'chart',
    profiles,
    {
      metrics: funnel?.steps.map((step) => step.column) ?? [],
      ignored: [],
      row_selector: bindings?.row_selector,
      funnel,
    },
    options,
    ['funnel_shape'],
    issues,
  );
}

/**
 * 趋势图兼容性（phase: clklog-analytics-trend-chart-v1）。
 *
 * 条件与折线图一致：恰好 1 个时间列 + 至少 1 个指标——趋势图本质就是
 * 「等距时间轴 + 外推」的折线图，数据形态要求相同。
 *
 * 注意：**不**要求数据点 ≥ 3。点数不足时趋势图仍可选，只是不作外推
 * （PRD AC9：应给出「数据点不足，无法预测」提示，而不是禁用整个图形）。
 */
export function evaluateTrend(
  profiles: ColumnProfile[],
  rows: Record<string, unknown>[],
  options?: ChartOptions,
): ChartCandidate {
  const buckets = bucketRoles(profiles);
  const issues: ChartIssue[] = [];
  if (buckets.time.length !== 1) issues.push(createIssue('MISSING_TIME'));
  const metrics = buckets.metric.slice(0, LINE_MAX_METRICS);
  if (buckets.metric.length > LINE_MAX_METRICS) {
    issues.push(createIssue('TOO_MANY_METRICS', 'error', { params: { max: LINE_MAX_METRICS } }));
  }
  issues.push(...unsafeOrMissingMetrics(metrics));
  issues.push(...mixedUnitIssues(metrics, options));
  const time = buckets.time[0];
  const series = buckets.dimension.length === 1 && metrics.length === 1 ? buckets.dimension[0] : undefined;
  if (time && metrics.length) {
    issues.push(...linePointIssues(rows, time.key, series?.key));
  }
  const reasonCodes = series
    ? ['one_time', 'one_category', 'one_metric', 'series_2_to_5']
    : ['one_time', 'metrics_1_to_5'];
  return configOf(
    'trend',
    'chart',
    profiles,
    {
      x: time?.key,
      series: series?.key,
      metrics: metrics.map((item) => item.key),
      ignored: buckets.ignored.map((item) => item.key),
    },
    options,
    reasonCodes,
    issues,
  );
}

/**
 * 按配置绑定对齐画像角色：图表实际绘制的就是 bindings 里的列，
 * 其余列一律视为 ignored —— 判定「能不能画」时不应该被未绑定的角色干扰。
 */
export function rolesFromBindings(
  profiles: ColumnProfile[],
  bindings: ChartConfigV1['bindings'],
): ColumnProfile[] {
  const time = new Set<string>();
  if (bindings.x) time.add(bindings.x);
  const dimensions = new Set<string>();
  if (bindings.category) dimensions.add(bindings.category);
  if (bindings.series) dimensions.add(bindings.series);
  const metrics = new Set<string>(Array.isArray(bindings.metrics) ? bindings.metrics : []);
  return profiles.map((profile) => {
    if (time.has(profile.key)) return { ...profile, role: 'time' as const };
    if (dimensions.has(profile.key)) return { ...profile, role: 'dimension' as const };
    if (metrics.has(profile.key)) return { ...profile, role: 'metric' as const };
    return { ...profile, role: 'ignored' as const };
  });
}

/**
 * 「在字段面板里改一下就能用」的阻塞项：指标数超上限、单位混用。
 * 这类问题不该让整个图型判死（用户只是还没选指标/设单位），用于「图表类型」列表的可选性判定。
 */
const PANEL_FIXABLE_CODES = new Set(['TOO_MANY_METRICS', 'MIXED_UNITS']);

export function fixableInPanel(issues: ChartIssue[]): boolean {
  const errors = issues.filter((issue) => issue.severity === 'error');
  return errors.length > 0 && errors.every((issue) => PANEL_FIXABLE_CODES.has(issue.code));
}

export function evaluateCompatibility(
  chartType: ChartTypeV1,
  profiles: ColumnProfile[],
  rows: Record<string, unknown>[],
  options?: ChartOptions,
  bindings?: ChartConfigV1['bindings'],
): ChartCandidate {
  if (rows.length > CHART_MAX_INPUT_ROWS) {
    return {
      chartType,
      compatible: false,
      reasonCodes: ['too_many_rows'],
      issues: [createIssue('TOO_MANY_ROWS')],
    };
  }
  if (chartType === 'table') {
    return configOf('table', 'table', profiles, { metrics: [], ignored: [] }, options, ['fallback_table'], []);
  }
  // 有具体配置时，按「配置声明要画什么」校验：绑定的 x/category/series/metrics 才参与判定，
  // 角色里多标的 metric/dimension 既不绘制也不该计入上限。否则字段面板的默认基线（把每个数值列都
  // 标成 metric、把日期列标成 dimension）会让任何配置被判 TOO_MANY_METRICS / DUPLICATE_KEY，
  // 图表一律回退成表格（2026-09-21 线上「图表配置已失效」，AI 侧同样连撞 13 次）。
  if (chartType === 'line' || chartType === 'trend' || chartType === 'bar' || chartType === 'pie') {
    const scoped = bindings ? rolesFromBindings(profiles, bindings) : profiles;
    if (chartType === 'line') return evaluateLine(scoped, rows, options);
    if (chartType === 'trend') return evaluateTrend(scoped, rows, options);
    if (chartType === 'bar') return evaluateBar(scoped, rows, options);
    return evaluatePie(scoped, rows, options);
  }
  if (chartType === 'number') return evaluateNumber(profiles, rows, options, bindings?.row_selector);
  return evaluateFunnel(profiles, rows, detectFunnelShape(profiles, rows), options, bindings);
}

export { detectFunnelShape };
