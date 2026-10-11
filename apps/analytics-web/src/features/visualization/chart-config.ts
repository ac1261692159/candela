import {
  CHART_CONFIG_MAX_BYTES,
  CHART_CONFIG_SCHEMA_VERSION,
  CHART_RECOMMENDATION_VERSION,
  CHART_TYPES_EVENT,
  CHART_TYPES_SQL,
  DANGEROUS_KEYS,
  FUNNEL_MAX_STEPS,
  FUNNEL_MIN_STEPS,
  LABEL_MAX_LENGTH,
  NUMBER_MAX_METRICS,
  ROW_SELECTOR_STRING_MAX,
  TOP_N_MAX,
  TOP_N_MIN,
  X_LABEL_ROTATE_MAX,
  X_LABEL_ROTATE_MIN,
  X_LABEL_WIDTH_MAX,
  X_LABEL_WIDTH_MIN,
} from './chart.constants';
import { createIssue } from './chart-issues';
import { defaultOptions } from './chart-compatibility';
import type {
  AggregationSemantics,
  ChartAxis,
  ChartBindings,
  ChartConfigV1,
  ChartIssue,
  ChartMode,
  ChartOptions,
  ChartTypeV1,
  ColumnProfile,
  ColumnRole,
  FunnelBinding,
  MetricUnit,
  ResultView,
  RowSelector,
  TrendOptions,
  XLabelOptions,
} from './chart.types';

/**
 * 图表配置的域：图型白名单按域收窄，其余字段两域共用。
 * 缺省 `'sql'` 保持既有调用点行为不变。
 */
export type ChartConfigDomain = 'sql' | 'event';

const CHART_TYPES_BY_DOMAIN: Record<ChartConfigDomain, readonly string[]> = {
  sql: CHART_TYPES_SQL,
  event: CHART_TYPES_EVENT,
};
const VIEWS: ResultView[] = ['table', 'pivot', 'chart'];
const MODES: ChartMode[] = ['auto', 'manual'];
const ROLES: Array<Exclude<ColumnRole, 'pending'>> = ['time', 'dimension', 'metric', 'ignored'];
const UNITS: MetricUnit[] = [
  'number',
  'ratio_0_1',
  'percent_0_100',
  'currency',
  'currency_cny',
  'currency_usd',
  'duration_ms',
  'duration_sec',
  'bytes',
  'bytes_iec',
];
const AGG: AggregationSemantics[] = ['additive', 'non_additive', 'unknown'];
const STAT_CALCS = ['last', 'avg', 'max', 'min', 'first', 'total'] as const;

export class ChartConfigError extends Error {
  constructor(
    message: string,
    readonly issues: ChartIssue[],
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeKey(key: string): void {
  if (DANGEROUS_KEYS.has(key) || key.includes('__')) {
    throw new ChartConfigError('dangerous key', [createIssue('STALE_CONFIG', 'error', { columns: [key] })]);
  }
}

function asString(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || !value) {
    throw new ChartConfigError(`invalid ${field}`, [createIssue('STALE_CONFIG', 'error', { columns: [field] })]);
  }
  if (value.length > max) {
    throw new ChartConfigError(`invalid ${field}`, [createIssue('STALE_CONFIG', 'error', { columns: [field] })]);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, field);
}

function parseRoles(raw: unknown, columns: Set<string>): ChartConfigV1['roles'] {
  if (!isRecord(raw)) {
    throw new ChartConfigError('invalid roles', [createIssue('STALE_CONFIG')]);
  }
  const roles: ChartConfigV1['roles'] = {};
  for (const [key, value] of Object.entries(raw)) {
    assertSafeKey(key);
    if (!columns.has(key)) {
      throw new ChartConfigError('missing column', [createIssue('STALE_CONFIG', 'error', { columns: [key] })]);
    }
    if (!ROLES.includes(value as Exclude<ColumnRole, 'pending'>)) {
      throw new ChartConfigError('invalid role', [createIssue('STALE_CONFIG', 'error', { columns: [key] })]);
    }
    roles[key] = value as Exclude<ColumnRole, 'pending'>;
  }
  return roles;
}

function parseRowSelector(raw: unknown, columns: Set<string>): RowSelector | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ChartConfigError('invalid row_selector', [createIssue('STALE_CONFIG')]);
  const column = asString(raw.column, 'row_selector.column');
  if (!columns.has(column)) {
    throw new ChartConfigError('missing selector column', [createIssue('STALE_CONFIG', 'error', { columns: [column] })]);
  }
  const value = raw.value;
  if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new ChartConfigError('invalid selector value', [createIssue('STALE_CONFIG')]);
  }
  if (typeof value === 'string' && value.length > ROW_SELECTOR_STRING_MAX) {
    throw new ChartConfigError('selector too long', [createIssue('STALE_CONFIG')]);
  }
  return { column, value: value as RowSelector['value'] };
}

function parseFunnel(raw: unknown, columns: Set<string>): FunnelBinding | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new ChartConfigError('invalid funnel', [createIssue('STALE_CONFIG')]);
  const shape = raw.shape === 'long' ? 'long' : raw.shape === 'wide' ? 'wide' : null;
  if (!shape) throw new ChartConfigError('invalid funnel shape', [createIssue('STALE_CONFIG')]);
  const family = raw.metric_family === 'uv' || raw.metric_family === 'pv' || raw.metric_family === 'custom' ? raw.metric_family : null;
  if (!family) throw new ChartConfigError('invalid funnel family', [createIssue('STALE_CONFIG')]);
  if (!Array.isArray(raw.steps) || raw.steps.length < FUNNEL_MIN_STEPS || raw.steps.length > FUNNEL_MAX_STEPS) {
    throw new ChartConfigError('invalid funnel steps', [createIssue('STALE_CONFIG')]);
  }
  const used = new Set<string>();
  const steps = raw.steps.map((item, index) => {
    if (!isRecord(item)) throw new ChartConfigError('invalid step', [createIssue('STALE_CONFIG')]);
    const column = asString(item.column, 'funnel.column');
    if (!columns.has(column) || used.has(column)) {
      throw new ChartConfigError('invalid step column', [createIssue('STALE_CONFIG', 'error', { columns: [column] })]);
    }
    used.add(column);
    const label = asString(item.label ?? column, 'funnel.label', LABEL_MAX_LENGTH);
    const order = typeof item.order === 'number' && Number.isInteger(item.order) ? item.order : index + 1;
    return { order, column, label };
  });
  let long_shape: FunnelBinding['long_shape'];
  if (raw.long_shape !== undefined) {
    if (!isRecord(raw.long_shape)) throw new ChartConfigError('invalid long_shape', [createIssue('STALE_CONFIG')]);
    const order_column = asString(raw.long_shape.order_column, 'order_column');
    const label_column = asString(raw.long_shape.label_column, 'label_column');
    const value_column = asString(raw.long_shape.value_column, 'value_column');
    for (const column of [order_column, label_column, value_column]) {
      if (!columns.has(column)) {
        throw new ChartConfigError('missing long column', [createIssue('STALE_CONFIG', 'error', { columns: [column] })]);
      }
    }
    long_shape = { order_column, label_column, value_column };
  }
  return { shape, metric_family: family, steps, long_shape };
}

function parseBindings(raw: unknown, columns: Set<string>): ChartBindings {
  if (!isRecord(raw)) throw new ChartConfigError('invalid bindings', [createIssue('STALE_CONFIG')]);
  const ref = (value: unknown, field: string) => {
    const name = optionalString(value, field);
    if (name && !columns.has(name)) {
      throw new ChartConfigError('missing column', [createIssue('STALE_CONFIG', 'error', { columns: [name] })]);
    }
    return name;
  };
  if (!Array.isArray(raw.metrics) || raw.metrics.length > NUMBER_MAX_METRICS) {
    throw new ChartConfigError('invalid metrics', [createIssue('STALE_CONFIG')]);
  }
  const metrics = raw.metrics.map((item) => {
    const name = asString(item, 'metric');
    if (!columns.has(name)) throw new ChartConfigError('missing metric', [createIssue('STALE_CONFIG', 'error', { columns: [name] })]);
    return name;
  });
  const ignored = Array.isArray(raw.ignored)
    ? raw.ignored.map((item) => {
        const name = asString(item, 'ignored');
        if (!columns.has(name)) throw new ChartConfigError('missing ignored', [createIssue('STALE_CONFIG', 'error', { columns: [name] })]);
        return name;
      })
    : [];
  return {
    x: ref(raw.x, 'x'),
    category: ref(raw.category, 'category'),
    series: ref(raw.series, 'series'),
    metrics,
    ignored,
    row_selector: parseRowSelector(raw.row_selector, columns),
    funnel: parseFunnel(raw.funnel, columns),
  };
}

function parseUnits(raw: unknown, columns: Set<string>): Record<string, MetricUnit> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new ChartConfigError('invalid units', [createIssue('STALE_CONFIG')]);
  const units: Record<string, MetricUnit> = {};
  for (const [key, value] of Object.entries(raw)) {
    assertSafeKey(key);
    if (!columns.has(key) || !UNITS.includes(value as MetricUnit)) {
      throw new ChartConfigError('invalid unit', [createIssue('STALE_CONFIG', 'error', { columns: [key] })]);
    }
    units[key] = value as MetricUnit;
  }
  return units;
}

function parseAggregation(raw: unknown, columns: Set<string>): Record<string, AggregationSemantics> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new ChartConfigError('invalid aggregation', [createIssue('STALE_CONFIG')]);
  const aggregation: Record<string, AggregationSemantics> = {};
  for (const [key, value] of Object.entries(raw)) {
    assertSafeKey(key);
    if (!columns.has(key) || !AGG.includes(value as AggregationSemantics)) {
      throw new ChartConfigError('invalid aggregation', [createIssue('STALE_CONFIG', 'error', { columns: [key] })]);
    }
    aggregation[key] = value as AggregationSemantics;
  }
  return aggregation;
}

/** 趋势图配置（phase: clklog-analytics-trend-chart-v1） */
const FORECAST_POINTS_MIN = 0;
const FORECAST_POINTS_MAX = 90;

function parseTrend(raw: unknown): TrendOptions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new ChartConfigError('invalid trend', [createIssue('STALE_CONFIG')]);

  const points = raw.forecast_points;
  if (typeof points !== 'number' || !Number.isInteger(points) || points < FORECAST_POINTS_MIN || points > FORECAST_POINTS_MAX) {
    throw new ChartConfigError('invalid forecast_points', [createIssue('STALE_CONFIG')]);
  }

  const threshold = raw.threshold;
  if (threshold !== null && (typeof threshold !== 'number' || !Number.isFinite(threshold))) {
    throw new ChartConfigError('invalid trend threshold', [createIssue('STALE_CONFIG')]);
  }

  return {
    forecast_points: points,
    threshold: typeof threshold === 'number' ? threshold : null,
    show_trend_line: raw.show_trend_line === true,
    show_threshold: raw.show_threshold !== false,
  };
}

/**
 * 指标轴归属（phase: clklog-analytics-event-chart-binding-v1）。
 * key 必须是本次结果里的真实列，值只能是 left / right。
 */
function parseMetricAxis(raw: unknown, columns: Set<string>): Record<string, ChartAxis> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new ChartConfigError('invalid metric_axis', [createIssue('STALE_CONFIG')]);
  const axis: Record<string, ChartAxis> = {};
  for (const [key, value] of Object.entries(raw)) {
    assertSafeKey(key);
    if (!columns.has(key) || (value !== 'left' && value !== 'right')) {
      throw new ChartConfigError('invalid metric_axis', [
        createIssue('STALE_CONFIG', 'error', { columns: [key] }),
      ]);
    }
    axis[key] = value;
  }
  return axis;
}

/** X 轴标签策略；null 与缺省等价，都表示交回自动判定 */
function parseXLabel(raw: unknown): XLabelOptions | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw new ChartConfigError('invalid x_label', [createIssue('STALE_CONFIG')]);
  const extra = Object.keys(raw).filter((key) => key !== 'rotate' && key !== 'max_width');
  if (extra.length) throw new ChartConfigError('unknown x_label option', [createIssue('STALE_CONFIG', 'error', { columns: extra })]);
  const bound = (value: unknown, min: number, max: number): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new ChartConfigError('invalid x_label bound', [createIssue('STALE_CONFIG')]);
    }
    return value;
  };
  const rotate = bound(raw.rotate, X_LABEL_ROTATE_MIN, X_LABEL_ROTATE_MAX);
  const maxWidth = bound(raw.max_width, X_LABEL_WIDTH_MIN, X_LABEL_WIDTH_MAX);
  return { rotate, max_width: maxWidth };
}

function parseOptions(raw: unknown, columns: Set<string>): ChartOptions {
  if (!isRecord(raw)) throw new ChartConfigError('invalid options', [createIssue('STALE_CONFIG')]);
  const extra = Object.keys(raw).filter(
    (key) =>
      ![
        'orientation',
        'donut',
        'sort',
        'top_n',
        'include_other',
        'units',
        'aggregation',
        'trend',
        'stat_calcs',
        'metric_axis',
        'x_label',
      ].includes(key),
  );
  if (extra.length) throw new ChartConfigError('unknown option', [createIssue('STALE_CONFIG', 'error', { columns: extra })]);
  let sort: ChartOptions['sort'];
  if (raw.sort !== undefined) {
    if (!isRecord(raw.sort)) throw new ChartConfigError('invalid sort', [createIssue('STALE_CONFIG')]);
    const column = asString(raw.sort.column, 'sort.column');
    if (!columns.has(column)) throw new ChartConfigError('missing sort', [createIssue('STALE_CONFIG', 'error', { columns: [column] })]);
    const direction = raw.sort.direction === 'asc' || raw.sort.direction === 'desc' ? raw.sort.direction : null;
    if (!direction) throw new ChartConfigError('invalid sort direction', [createIssue('STALE_CONFIG')]);
    sort = { column, direction };
  }
  let top_n: number | undefined;
  if (raw.top_n !== undefined) {
    if (typeof raw.top_n !== 'number' || !Number.isInteger(raw.top_n) || raw.top_n < TOP_N_MIN || raw.top_n > TOP_N_MAX) {
      throw new ChartConfigError('invalid top_n', [createIssue('STALE_CONFIG')]);
    }
    top_n = raw.top_n;
  }
  let stat_calcs: ChartOptions['stat_calcs'];
  if (raw.stat_calcs !== undefined) {
    if (!Array.isArray(raw.stat_calcs) || raw.stat_calcs.length > 6) {
      throw new ChartConfigError('invalid stat_calcs', [createIssue('STALE_CONFIG')]);
    }
    const seen = new Set<string>();
    stat_calcs = [];
    for (const item of raw.stat_calcs) {
      if (typeof item !== 'string' || !STAT_CALCS.includes(item as (typeof STAT_CALCS)[number]) || seen.has(item)) {
        throw new ChartConfigError('invalid stat_calcs', [createIssue('STALE_CONFIG')]);
      }
      seen.add(item);
      stat_calcs.push(item as (typeof STAT_CALCS)[number]);
    }
  }
  return defaultOptions({
    orientation: raw.orientation === 'horizontal' ? 'horizontal' : 'vertical',
    donut: raw.donut === true,
    include_other: raw.include_other === true,
    sort,
    top_n,
    units: parseUnits(raw.units, columns),
    aggregation: parseAggregation(raw.aggregation, columns),
    trend: parseTrend(raw.trend),
    stat_calcs,
    metric_axis: parseMetricAxis(raw.metric_axis, columns),
    x_label: parseXLabel(raw.x_label),
  });
}

const ROOT_KEYS = new Set([
  'schema_version',
  'recommendation_version',
  'mode',
  'preferred_view',
  'chart_type',
  'roles',
  'bindings',
  'options',
]);

export function parseChartConfigV1(
  input: unknown,
  columnNames: string[],
  domain: ChartConfigDomain = 'sql',
): ChartConfigV1 {
  if (input == null) {
    throw new ChartConfigError('empty', [createIssue('STALE_CONFIG')]);
  }
  const json = JSON.stringify(input);
  if (json.length > CHART_CONFIG_MAX_BYTES) {
    throw new ChartConfigError('too large', [createIssue('STALE_CONFIG')]);
  }
  if (!isRecord(input)) throw new ChartConfigError('invalid config', [createIssue('STALE_CONFIG')]);
  for (const key of Object.keys(input)) {
    assertSafeKey(key);
    if (!ROOT_KEYS.has(key)) {
      throw new ChartConfigError('unknown field', [createIssue('STALE_CONFIG', 'error', { columns: [key] })]);
    }
  }
  if (input.schema_version !== CHART_CONFIG_SCHEMA_VERSION) {
    if (typeof input.schema_version === 'number' && input.schema_version > CHART_CONFIG_SCHEMA_VERSION) {
      throw new ChartConfigError('future version', [createIssue('UNSUPPORTED_CONFIG_VERSION')]);
    }
    throw new ChartConfigError('invalid version', [createIssue('STALE_CONFIG')]);
  }
  if (input.recommendation_version !== CHART_RECOMMENDATION_VERSION && typeof input.recommendation_version !== 'number') {
    throw new ChartConfigError('invalid recommendation version', [createIssue('STALE_CONFIG')]);
  }
  if (
    !MODES.includes(input.mode as ChartMode)
    || !VIEWS.includes(input.preferred_view as ResultView)
    || !CHART_TYPES_BY_DOMAIN[domain].includes(input.chart_type as string)
  ) {
    throw new ChartConfigError('invalid enums', [createIssue('STALE_CONFIG')]);
  }
  const columns = new Set(columnNames);
  return {
    schema_version: 1,
    recommendation_version: 1,
    mode: input.mode as ChartMode,
    preferred_view: input.preferred_view as ResultView,
    chart_type: input.chart_type as ChartTypeV1,
    roles: parseRoles(input.roles, columns),
    bindings: parseBindings(input.bindings, columns),
    options: parseOptions(input.options, columns),
  };
}

/**
 * 丢掉指向「已不存在列」的 option 引用。
 *
 * 旧卡片配置（改了 SQL、列名换了之后）里常留着 `sort.column` / `units` / `aggregation` 的旧列名；
 * 这些引用一旦被继承进新配置，`parseChartConfigV1` 会整条拒绝，表现成「配置无效/不兼容」——
 * 用户看到的却是「点了没反应」，AI 看到的是一句误导性的「图表绑定与当前列不兼容」。
 * 因此凡是要把「上一版配置」与「当前列」拼在一起的地方，都先过这一层。
 */
export function pruneStaleOptionRefs(options: ChartOptions, columns: Set<string> | string[]): ChartOptions {
  const names = columns instanceof Set ? columns : new Set(columns);
  const keep = <T>(record: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => names.has(key)));
  const sort = options.sort && names.has(options.sort.column) ? options.sort : undefined;
  return {
    ...options,
    sort,
    units: keep(options.units),
    aggregation: keep(options.aggregation),
    metric_axis: keep(options.metric_axis),
  };
}

export function isLegacyChartConfig(input: unknown): input is { chart_type: string } {
  return isRecord(input) && typeof input.chart_type === 'string' && input.schema_version === undefined;
}

export function readSavedConfig(
  input: unknown,
  profiles: ColumnProfile[],
  domain: ChartConfigDomain = 'sql',
): { config: ChartConfigV1 | null; issues: ChartIssue[]; legacy?: { chart_type: string } } {
  if (input == null) return { config: null, issues: [] };
  if (isLegacyChartConfig(input)) {
    return { config: null, issues: [], legacy: { chart_type: input.chart_type } };
  }
  if (isRecord(input) && typeof input.schema_version === 'number' && input.schema_version > CHART_CONFIG_SCHEMA_VERSION) {
    return { config: null, issues: [createIssue('UNSUPPORTED_CONFIG_VERSION')] };
  }
  try {
    return {
      config: parseChartConfigV1(input, profiles.map((profile) => profile.key), domain),
      issues: [],
    };
  } catch (error) {
    if (error instanceof ChartConfigError) return { config: null, issues: error.issues };
    return { config: null, issues: [createIssue('STALE_CONFIG')] };
  }
}

export function cloneConfig(config: ChartConfigV1): ChartConfigV1 {
  return JSON.parse(JSON.stringify(config)) as ChartConfigV1;
}

export function toCardChartType(config: ChartConfigV1 | null): ChartTypeV1 {
  return config?.chart_type ?? 'table';
}
