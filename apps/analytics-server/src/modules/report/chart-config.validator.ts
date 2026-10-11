import { badRequest } from '../../i18n/domain-error';

const MAX_BYTES = 32 * 1024;
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * 图型白名单按域收窄（phase: clklog-analytics-event-chart-binding-v1）。
 *
 * `chart_config` 是事件分析与自定义 SQL 共用的同一份契约，但两侧图型集合不同：
 * 事件侧有 `stack` / `cumulative` / `distribution`，SQL 侧有 `funnel`。
 * 用域参数收窄而不是并成一个大集合，避免 SQL 卡存进没有渲染器的图型。
 */
const CHART_TYPES_SQL = new Set(['table', 'number', 'line', 'bar', 'pie', 'funnel', 'trend']);
const CHART_TYPES_EVENT = new Set([
  'table',
  'number',
  'line',
  'bar',
  'pie',
  'trend',
  'stack',
  'cumulative',
  'distribution',
]);
export type ChartConfigDomain = 'sql' | 'event';
const CHART_TYPES_BY_DOMAIN: Record<ChartConfigDomain, Set<string>> = {
  sql: CHART_TYPES_SQL,
  event: CHART_TYPES_EVENT,
};
const AXES = new Set(['left', 'right']);
const X_LABEL_KEYS = ['rotate', 'max_width'];
const ROTATE_MIN = 0;
const ROTATE_MAX = 90;
const X_LABEL_WIDTH_MIN = 24;
const X_LABEL_WIDTH_MAX = 400;
const VIEWS = new Set(['table', 'pivot', 'chart']);
const MODES = new Set(['auto', 'manual']);
const ROLES = new Set(['time', 'dimension', 'metric', 'ignored']);
/**
 * 合法单位清单。导出为数组供 Harness 能力自述使用——模型不知道有哪些合法值时会猜，
 * 猜错直接 400（`report.chart.unitInvalid`），与「bindings 里无法识别的键」是同一类坑。
 */
export const METRIC_UNITS = [
  'number',
  'percent_0_100',
  'ratio_0_1',
  'currency',
  'currency_cny',
  'currency_usd',
  'duration_sec',
  'duration_ms',
  'bytes',
  'bytes_iec',
] as const;
const UNITS = new Set<string>(METRIC_UNITS);
const AGG = new Set(['additive', 'non_additive', 'unknown']);
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

export interface ChartConfigV1 {
  schema_version: 1;
  recommendation_version: number;
  mode: 'auto' | 'manual';
  preferred_view: 'table' | 'pivot' | 'chart';
  chart_type:
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
  roles: Record<string, string>;
  bindings: Record<string, unknown>;
  options: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeKey(key: string) {
  if (DANGEROUS.has(key) || key.includes('__')) {
    throw badRequest({
      code: 'report.chart.keyInvalid',
      messageKey: 'report:error.chart.keyInvalid',
      params: { key },
      message: `非法配置键: ${key}`,
    });
  }
}

/**
 * 校验 `chart_config`。
 *
 * @param domain 图型白名单域；缺省 `'sql'`，保证既有 SQL 调用点零行为变更。
 *   仅收窄 `chart_type`，其余字段两个域共用同一套规则。
 */
export function parseChartConfigV1(input: unknown, domain: ChartConfigDomain = 'sql'): ChartConfigV1 {
  if (input == null) {
    throw badRequest({
      code: 'report.chart.required',
      messageKey: 'report:error.chart.required',
      message: 'chart_config 不能为空',
    });
  }
  const json = JSON.stringify(input);
  if (json.length > MAX_BYTES) {
    throw badRequest({
      code: 'report.chart.tooLarge',
      messageKey: 'report:error.chart.tooLarge',
      message: 'chart_config 超过 32KiB',
    });
  }
  if (!isRecord(input)) {
    throw badRequest({
      code: 'report.chart.notObject',
      messageKey: 'report:error.chart.notObject',
      message: 'chart_config 格式错误',
    });
  }
  for (const key of Object.keys(input)) {
    assertSafeKey(key);
    if (!ROOT_KEYS.has(key)) {
      throw badRequest({
        code: 'report.chart.fieldUnsupported',
        messageKey: 'report:error.chart.fieldUnsupported',
        params: { key },
        message: `不支持的字段: ${key}`,
      });
    }
  }
  if (input.schema_version !== 1) {
    throw badRequest({
      code: 'report.chart.schemaVersionUnsupported',
      messageKey: 'report:error.chart.schemaVersionUnsupported',
      message: '不支持的 chart_config schema_version',
    });
  }
  if (typeof input.recommendation_version !== 'number') {
    throw badRequest({
      code: 'report.chart.recommendationVersionInvalid',
      messageKey: 'report:error.chart.recommendationVersionInvalid',
      message: 'recommendation_version 无效',
    });
  }
  if (
    !MODES.has(String(input.mode))
    || !VIEWS.has(String(input.preferred_view))
    || !CHART_TYPES_BY_DOMAIN[domain].has(String(input.chart_type))
  ) {
    throw badRequest({
      code: 'report.chart.enumInvalid',
      messageKey: 'report:error.chart.enumInvalid',
      message: 'chart_config 枚举无效',
    });
  }
  if (!isRecord(input.roles) || !isRecord(input.bindings) || !isRecord(input.options)) {
    throw badRequest({
      code: 'report.chart.sectionsNotObject',
      messageKey: 'report:error.chart.sectionsNotObject',
      message: 'roles/bindings/options 必须是对象',
    });
  }
  for (const key of Object.keys(input.roles)) {
    assertSafeKey(key);
    if (!ROLES.has(String(input.roles[key]))) {
      throw badRequest({
        code: 'report.chart.roleInvalid',
        messageKey: 'report:error.chart.roleInvalid',
        params: { key },
        message: `非法角色: ${key}`,
      });
    }
  }
  const bindings = input.bindings;
  if (!Array.isArray(bindings.metrics) || bindings.metrics.length > 8) {
    throw badRequest({
      code: 'report.chart.metricsInvalid',
      messageKey: 'report:error.chart.metricsInvalid',
      message: 'metrics 无效',
    });
  }
  if (Array.isArray(bindings.ignored) === false && bindings.ignored !== undefined) {
    throw badRequest({
      code: 'report.chart.ignoredInvalid',
      messageKey: 'report:error.chart.ignoredInvalid',
      message: 'ignored 无效',
    });
  }
  const funnel = bindings.funnel;
  if (funnel !== undefined) {
    if (!isRecord(funnel) || !Array.isArray(funnel.steps) || funnel.steps.length < 3 || funnel.steps.length > 8) {
      throw badRequest({
        code: 'report.chart.funnelStepsInvalid',
        messageKey: 'report:error.chart.funnelStepsInvalid',
        message: '漏斗步骤必须为 3 到 8 项',
      });
    }
    for (const step of funnel.steps) {
      if (!isRecord(step) || typeof step.column !== 'string' || typeof step.label !== 'string' || step.label.length > 100) {
        throw badRequest({
          code: 'report.chart.funnelStepInvalid',
          messageKey: 'report:error.chart.funnelStepInvalid',
          message: '漏斗步骤无效',
        });
      }
    }
  }
  if (bindings.row_selector !== undefined) {
    if (!isRecord(bindings.row_selector) || typeof bindings.row_selector.column !== 'string') {
      throw badRequest({
        code: 'report.chart.rowSelectorInvalid',
        messageKey: 'report:error.chart.rowSelectorInvalid',
        message: 'row_selector 无效',
      });
    }
    const value = bindings.row_selector.value;
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw badRequest({
        code: 'report.chart.rowSelectorValueInvalid',
        messageKey: 'report:error.chart.rowSelectorValueInvalid',
        message: 'row_selector.value 必须是 JSON 原始类型',
      });
    }
    if (typeof value === 'string' && value.length > 256) {
      throw badRequest({
        code: 'report.chart.rowSelectorValueTooLong',
        messageKey: 'report:error.chart.rowSelectorValueTooLong',
        message: 'row_selector.value 过长',
      });
    }
  }
  const options = input.options;
  const extra = Object.keys(options).filter(
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
  if (extra.length) {
    throw badRequest({
      code: 'report.chart.optionsUnsupported',
      messageKey: 'report:error.chart.optionsUnsupported',
      params: { keys: extra.join(',') },
      message: `不支持的 options: ${extra.join(',')}`,
    });
  }
  if (options.stat_calcs !== undefined) {
    if (!Array.isArray(options.stat_calcs) || options.stat_calcs.length > 6) {
      throw badRequest({
        code: 'report.chart.statCalcsInvalid',
        messageKey: 'report:error.chart.statCalcsInvalid',
        message: 'stat_calcs 无效',
      });
    }
    const allowed = new Set(['last', 'avg', 'max', 'min', 'first', 'total']);
    const seen = new Set<string>();
    for (const item of options.stat_calcs) {
      if (typeof item !== 'string' || !allowed.has(item) || seen.has(item)) {
        throw badRequest({
          code: 'report.chart.statCalcsInvalid',
          messageKey: 'report:error.chart.statCalcsInvalid',
          message: 'stat_calcs 无效',
        });
      }
      seen.add(item);
    }
  }
  if (options.top_n !== undefined && (typeof options.top_n !== 'number' || options.top_n < 1 || options.top_n > 20)) {
    throw badRequest({
      code: 'report.chart.topNInvalid',
      messageKey: 'report:error.chart.topNInvalid',
      message: 'top_n 仅允许 1..20',
    });
  }
  if (options.units !== undefined) {
    if (!isRecord(options.units)) {
      throw badRequest({
        code: 'report.chart.unitsInvalid',
        messageKey: 'report:error.chart.unitsInvalid',
        message: 'units 无效',
      });
    }
    for (const [key, value] of Object.entries(options.units)) {
      assertSafeKey(key);
      if (!UNITS.has(String(value))) {
        throw badRequest({
          code: 'report.chart.unitInvalid',
          messageKey: 'report:error.chart.unitInvalid',
          params: { key },
          message: `非法单位: ${key}`,
        });
      }
    }
  }
  if (options.aggregation !== undefined) {
    if (!isRecord(options.aggregation)) {
      throw badRequest({
        code: 'report.chart.aggregationInvalid',
        messageKey: 'report:error.chart.aggregationInvalid',
        message: 'aggregation 无效',
      });
    }
    for (const [key, value] of Object.entries(options.aggregation)) {
      assertSafeKey(key);
      if (!AGG.has(String(value))) {
        throw badRequest({
          code: 'report.chart.aggregationSemanticsInvalid',
          messageKey: 'report:error.chart.aggregationSemanticsInvalid',
          params: { key },
          message: `非法聚合语义: ${key}`,
        });
      }
    }
  }
  if (options.metric_axis !== undefined) {
    if (!isRecord(options.metric_axis)) {
      throw badRequest({
        code: 'report.chart.axisInvalid',
        messageKey: 'report:error.chart.axisInvalid',
        message: 'metric_axis 无效',
      });
    }
    for (const [key, value] of Object.entries(options.metric_axis)) {
      assertSafeKey(key);
      if (!AXES.has(String(value))) {
        throw badRequest({
          code: 'report.chart.axisValueInvalid',
          messageKey: 'report:error.chart.axisValueInvalid',
          params: { key },
          message: `非法轴归属: ${key}`,
        });
      }
    }
  }
  if (options.x_label !== undefined && options.x_label !== null) {
    const invalid = () =>
      badRequest({
        code: 'report.chart.xLabelInvalid',
        messageKey: 'report:error.chart.xLabelInvalid',
        message: 'x_label 无效',
      });
    if (!isRecord(options.x_label)) throw invalid();
    for (const key of Object.keys(options.x_label)) {
      if (!X_LABEL_KEYS.includes(key)) throw invalid();
    }
    for (const [key, min, max] of [
      ['rotate', ROTATE_MIN, ROTATE_MAX],
      ['max_width', X_LABEL_WIDTH_MIN, X_LABEL_WIDTH_MAX],
    ] as const) {
      const value = options.x_label[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw invalid();
      }
    }
  }
  if (options.trend !== undefined) {
    if (!isRecord(options.trend)) {
      throw badRequest({
        code: 'report.chart.trendInvalid',
        messageKey: 'report:error.chart.trendInvalid',
        message: 'trend 无效',
      });
    }
    const trend = options.trend;
    for (const key of Object.keys(trend)) {
      if (!['forecast_points', 'threshold', 'show_trend_line', 'show_threshold'].includes(key)) {
        throw badRequest({
          code: 'report.chart.trendOptionUnsupported',
          messageKey: 'report:error.chart.trendOptionUnsupported',
          params: { key },
          message: `不支持的 trend options: ${key}`,
        });
      }
    }
    if (trend.forecast_points !== undefined) {
      const points = trend.forecast_points;
      if (typeof points !== 'number' || !Number.isInteger(points) || points < 0 || points > 90) {
        throw badRequest({
          code: 'report.chart.forecastPointsInvalid',
          messageKey: 'report:error.chart.forecastPointsInvalid',
          message: 'forecast_points 仅允许 0..90 的整数',
        });
      }
    }
    if (trend.threshold !== undefined && trend.threshold !== null
      && (typeof trend.threshold !== 'number' || !Number.isFinite(trend.threshold))) {
      throw badRequest({
        code: 'report.chart.thresholdInvalid',
        messageKey: 'report:error.chart.thresholdInvalid',
        message: 'threshold 仅允许数值或 null',
      });
    }
    for (const flag of ['show_trend_line', 'show_threshold'] as const) {
      if (trend[flag] !== undefined && typeof trend[flag] !== 'boolean') {
        throw badRequest({
          code: 'report.chart.trendFlagInvalid',
          messageKey: 'report:error.chart.trendFlagInvalid',
          params: { flag },
          message: `${flag} 必须是布尔值`,
        });
      }
    }
  }
  if ('option' in input || 'formatter' in input || 'echarts' in input) {
    throw badRequest({
      code: 'report.chart.echartsOptionForbidden',
      messageKey: 'report:error.chart.echartsOptionForbidden',
      message: '不允许保存 ECharts option 或脚本',
    });
  }
  return input as unknown as ChartConfigV1;
}

export function sanitizeStoredChartConfig(
  raw: unknown,
  log: (message: string) => void,
  domain: ChartConfigDomain = 'sql',
): ChartConfigV1 | null {
  if (raw == null) return null;
  if (isRecord(raw) && typeof raw.chart_type === 'string' && raw.schema_version === undefined) {
    return null;
  }
  try {
    return parseChartConfigV1(raw, domain);
  } catch (error) {
    log(error instanceof Error ? error.message : 'invalid chart_config');
    return null;
  }
}

export function resolvedCardChartType(config: ChartConfigV1 | null): string {
  return config?.chart_type ?? 'table';
}
