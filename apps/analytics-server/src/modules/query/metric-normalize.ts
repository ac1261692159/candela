import {
  ANY_EVENT,
  type AnalysisMethod,
  type FormulaExpr,
  type Metric,
  type StageReduce,
} from '../../types/dsl.types';

const METHODS_NEEDING_PROP = new Set<AnalysisMethod>([
  'sum',
  'avg',
  'per_capita_num',
  'max',
  'min',
  'distinct',
  'true_num',
  'false_num',
  'is_empty',
  'is_not_empty',
  'array_distinct',
  'array_item_distinct',
  'percentile',
  'variance',
  'stddev',
]);

const BOOL_METHODS = new Set<AnalysisMethod>(['true_num', 'false_num']);
const LIST_METHODS = new Set<AnalysisMethod>(['array_distinct', 'array_item_distinct']);
const NUMBER_METHODS = new Set<AnalysisMethod>([
  'sum',
  'avg',
  'per_capita_num',
  'max',
  'min',
  'percentile',
  'variance',
  'stddev',
]);
const NO_PROP_METHODS = new Set<AnalysisMethod>([
  'total_times',
  'trig_user_num',
  'per_capita_times',
]);

export function methodNeedsProp(analysis: AnalysisMethod): boolean {
  return METHODS_NEEDING_PROP.has(analysis);
}

export function isNumericAnalysisMethod(analysis: AnalysisMethod): boolean {
  return NUMBER_METHODS.has(analysis);
}

export function methodAllowedForDataType(analysis: AnalysisMethod, dataType: string): boolean {
  if (analysis === 'distinct' || analysis === 'is_empty' || analysis === 'is_not_empty') return true;
  if (NO_PROP_METHODS.has(analysis)) return true;
  // string 金额（如 pay_amount）上报常被推断成字符串；数值聚合 SQL 已用 Float 解析。
  if (NUMBER_METHODS.has(analysis)) return dataType === 'number' || dataType === 'string';
  if (BOOL_METHODS.has(analysis)) return dataType === 'boolean' || dataType === 'bool';
  if (LIST_METHODS.has(analysis)) return dataType === 'list';
  return false;
}

export function defaultStageReduce(analysis: AnalysisMethod): StageReduce {
  if (analysis === 'trig_user_num' || analysis === 'distinct' || analysis === 'array_distinct' || analysis === 'array_item_distinct') {
    return 'uniq_total';
  }
  if (analysis === 'per_capita_times' || analysis === 'per_capita_num' || analysis === 'avg') {
    return 'weighted';
  }
  if (analysis === 'max') return 'max';
  if (analysis === 'min') return 'min';
  if (analysis === 'percentile' || analysis === 'variance' || analysis === 'stddev') return 'avg';
  return 'sum';
}

export function isDurationProp(prop?: string): boolean {
  if (!prop) return false;
  const key = prop.replace(/^\$/, '');
  return key === 'event_duration';
}

export function isDurationAnalysis(analysis: AnalysisMethod): boolean {
  return analysis === 'sum' || analysis === 'avg' || analysis === 'per_capita_num';
}

const ANALYSIS_TITLES: Record<AnalysisMethod, string> = {
  total_times: '总次数',
  trig_user_num: '触发用户数',
  per_capita_times: '人均次数',
  sum: '总和',
  avg: '均值',
  per_capita_num: '人均值',
  max: '最大值',
  min: '最小值',
  distinct: '去重数',
  true_num: '为真数',
  false_num: '为假数',
  is_empty: '为空数',
  is_not_empty: '不为空数',
  array_distinct: '列表去重数',
  array_item_distinct: '元素去重数',
  percentile: '分位数',
  variance: '方差',
  stddev: '标准差',
};

/**
 * 计算方法展示名的文案键（与前端 `features/query/event-metric-editor/analysis-methods.ts`
 * 的 `ANALYSIS_LABEL_KEYS` 同源同值，i18n 收口时不要另起一套）。
 */
const ANALYSIS_METHOD_KEYS: Record<AnalysisMethod, string> = {
  total_times: 'analysis:analysisMethod.totalTimes',
  trig_user_num: 'analysis:analysisMethod.trigUserNum',
  per_capita_times: 'analysis:analysisMethod.perCapitaTimes',
  sum: 'analysis:analysisMethod.sum',
  avg: 'analysis:analysisMethod.avg',
  per_capita_num: 'analysis:analysisMethod.perCapitaNum',
  max: 'analysis:analysisMethod.max',
  min: 'analysis:analysisMethod.min',
  distinct: 'analysis:analysisMethod.distinct',
  true_num: 'analysis:analysisMethod.trueNum',
  false_num: 'analysis:analysisMethod.falseNum',
  is_empty: 'analysis:analysisMethod.isEmpty',
  is_not_empty: 'analysis:analysisMethod.isNotEmpty',
  array_distinct: 'analysis:analysisMethod.arrayDistinct',
  array_item_distinct: 'analysis:analysisMethod.arrayItemDistinct',
  percentile: 'analysis:analysisMethod.percentile',
  variance: 'analysis:analysisMethod.variance',
  stddev: 'analysis:analysisMethod.stddev',
};

/** 方法名的**文案键**：`P25`/`P75`… 语言无关不下发；P50 在中文里叫「中位数」，走 `median` 键。 */
function analysisMethodKey(analysis: AnalysisMethod, percentile?: number): string | undefined {
  if (analysis !== 'percentile') return ANALYSIS_METHOD_KEYS[analysis];
  if (percentile === 50) return 'analysis:analysisMethod.median';
  if (percentile == null) return ANALYSIS_METHOD_KEYS.percentile;
  return undefined;
}

/** `任意事件` 的中文原值（服务端兜底；界面按 `analysis:column.anyEvent` 渲染） */
const ANY_EVENT_TITLE = '任意事件';

export function analysisTitle(analysis: AnalysisMethod, percentile?: number): string {
  if (analysis === 'percentile') {
    if (percentile === 25) return 'P25';
    if (percentile === 50) return '中位数';
    if (percentile === 75) return 'P75';
    if (percentile === 90) return 'P90';
    if (percentile === 99) return 'P99';
    return percentile != null ? `P${percentile}` : '分位数';
  }
  return ANALYSIS_TITLES[analysis] ?? analysis;
}

export function metricTitle(metric: Metric): string {
  if (metric.alias?.trim()) return metric.alias.trim();
  if (metric.name?.trim()) return metric.name.trim();
  if (metric.kind === 'formula') return '公式';
  const analysis = metric.analysis ?? 'total_times';
  const method = analysisTitle(analysis, metric.percentile);
  const event = metric.event === ANY_EVENT ? ANY_EVENT_TITLE : metric.event || '';
  if (metric.prop) return event ? `${event}.${metric.prop}.${method}` : `${metric.prop}.${method}`;
  return event ? `${event}.${method}` : method;
}

/**
 * 复合指标列标题的「文案键 + 参数」（phase: clklog-analytics-i18n-v1 收口）。
 *
 * 为什么要键：分析结果会进 `CardCache` 缓存，服务端按请求语言渲染会把语言固化进缓存，
 * 其他语言的用户随后看到错的语言（同 §14.3 的列名契约）。因此这里只下发**结构**：
 *
 * - `title_key` 是四种拼装形态之一的模板：`{{event}}.{{prop}}.{{method}}`、`{{event}}.{{method}}`、
 *   `{{prop}}.{{method}}`、`{{method}}`（zh 值逐字等于 `metricTitle` 的拼装结果）；
 * - `event` / `prop` 是用户数据 → 原样作参数；
 * - `method` 传中文原值（老渲染兜底），另带 `method_key`（方法名文案键）由前端解析后覆盖同一插槽；
 * - 事件为 `任意事件` 时同理：`event` 传中文，另带 `event_key`（`analysis:column.anyEvent`）。
 *
 * 别名 / 名称（`alias` / `name`）与「纯公式」的形态不变：前者是用户数据，后者见 `analysis:column.formula`。
 */
export function metricTitleDescriptor(metric: Metric): {
  title: string;
  title_key?: string;
  title_params?: Record<string, unknown>;
} {
  const title = metricTitle(metric);
  if (metric.alias?.trim() || metric.name?.trim()) return { title };
  if (metric.kind === 'formula') return { title, title_key: 'analysis:column.formula' };

  const analysis = metric.analysis ?? 'total_times';
  const method = analysisTitle(analysis, metric.percentile);
  const methodKey = analysisMethodKey(analysis, metric.percentile);
  const methodParams: Record<string, unknown> = {
    method,
    ...(methodKey ? { method_key: methodKey } : {}),
  };
  const anyEvent = metric.event === ANY_EVENT;
  const event = anyEvent ? ANY_EVENT_TITLE : metric.event || '';
  const eventParams: Record<string, unknown> = anyEvent
    ? { event, event_key: 'analysis:column.anyEvent' }
    : { event };

  if (metric.prop) {
    return event
      ? {
          title,
          title_key: 'analysis:column.metricEventPropMethod',
          title_params: { ...eventParams, prop: metric.prop, ...methodParams },
        }
      : {
          title,
          title_key: 'analysis:column.metricPropMethod',
          title_params: { prop: metric.prop, ...methodParams },
        };
  }
  return event
    ? { title, title_key: 'analysis:column.metricEventMethod', title_params: { ...eventParams, ...methodParams } }
    : { title, title_key: 'analysis:column.metricMethod', title_params: methodParams };
}

function mapLegacyType(metric: Metric): Pick<Metric, 'kind' | 'analysis' | 'percentile'> {
  if (metric.type === 'uniq_user') return { kind: 'event', analysis: 'trig_user_num' };
  if (metric.type === 'per_user') {
    if (metric.func === 'uniq_user') return { kind: 'event', analysis: 'trig_user_num' };
    return { kind: 'event', analysis: 'per_capita_times' };
  }
  if (metric.type === 'agg') {
    const func = metric.func;
    if (func === 'uniq') return { kind: 'event', analysis: 'distinct' };
    if (func === 'p50') return { kind: 'event', analysis: 'percentile', percentile: 50 };
    if (func === 'p90') return { kind: 'event', analysis: 'percentile', percentile: 90 };
    if (func === 'p99') return { kind: 'event', analysis: 'percentile', percentile: 99 };
    if (func === 'sum' || func === 'avg' || func === 'max' || func === 'min') {
      return { kind: 'event', analysis: func };
    }
    return { kind: 'event', analysis: 'sum' };
  }
  return { kind: 'event', analysis: 'total_times' };
}

export function normalizeMetric(raw: Metric): Metric {
  if (raw.kind === 'formula' || raw.expression) {
    return {
      ...raw,
      kind: 'formula',
      stage_reduce: raw.stage_reduce ?? 'avg',
    };
  }
  const mapped = raw.analysis ? { kind: 'event' as const, analysis: raw.analysis, percentile: raw.percentile } : mapLegacyType(raw);
  const analysis = mapped.analysis ?? 'total_times';
  const percentile = mapped.percentile ?? raw.percentile;
  const needsProp = methodNeedsProp(analysis);
  return {
    ...raw,
    kind: 'event',
    analysis,
    percentile,
    prop: needsProp ? raw.prop : undefined,
    stage_reduce: raw.stage_reduce ?? defaultStageReduce(analysis),
  };
}

export function collectFormulaMetricIds(expr: FormulaExpr | undefined, out = new Set<string>()): Set<string> {
  if (!expr) return out;
  if (expr.type === 'metric') out.add(expr.id);
  if (expr.type === 'op') {
    collectFormulaMetricIds(expr.left, out);
    collectFormulaMetricIds(expr.right, out);
  }
  return out;
}

export function evalFormula(expr: FormulaExpr, values: Record<string, number | null>): number | null {
  if (expr.type === 'const') {
    return Number.isFinite(expr.value) ? expr.value : null;
  }
  if (expr.type === 'metric') {
    const v = values[expr.id];
    return v == null || !Number.isFinite(v) ? null : v;
  }
  const left = evalFormula(expr.left, values);
  const right = evalFormula(expr.right, values);
  if (left == null || right == null) return null;
  if (expr.op === '/' && right === 0) return null;
  if (expr.op === '+') return left + right;
  if (expr.op === '-') return left - right;
  if (expr.op === '*') return left * right;
  return left / right;
}

export function formulaHasCycle(metrics: Metric[]): boolean {
  const formulas = metrics.filter((m) => m.kind === 'formula');
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(metrics.map((m) => [m.id, m]));

  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    const metric = byId.get(id);
    if (!metric || metric.kind !== 'formula') {
      done.add(id);
      return false;
    }
    visiting.add(id);
    for (const ref of collectFormulaMetricIds(metric.expression)) {
      if (visit(ref)) return true;
    }
    visiting.delete(id);
    done.add(id);
    return false;
  };

  return formulas.some((m) => visit(m.id));
}

export function stageReduceNumbers(nums: number[], reduce: StageReduce): number | null {
  if (nums.length === 0) return null;
  if (reduce === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (reduce === 'max') return Math.max(...nums);
  if (reduce === 'min') return Math.min(...nums);
  return nums.reduce((a, b) => a + b, 0);
}

/** uniq_total / weighted 必须用整段查询结果，不能把每日人数相加。 */
export function mixStageMetricValue(
  reduce: StageReduce,
  daily: number[],
  overall: number | null,
): number | null {
  if (reduce === 'uniq_total' || reduce === 'weighted') return overall;
  return stageReduceNumbers(daily, reduce);
}

/** 日历天数（SSOT 在 `../time/calendar`，此处保留原引用点的转发） */
export { calendarDaysInclusive } from '../time/calendar';
