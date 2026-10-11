/**
 * 指标定义的读/写纯逻辑（phase: clklog-analytics-metric-detail-v1）。
 *
 * 查看与编辑共用同一份口径文案；编辑时**只覆盖表单暴露的字段**，
 * filters / alias / percentile / stage_reduce 等未暴露字段原样保留（PRD M-6）。
 *
 * 口径文案（行名、窗口名、枚举展示名）经 `t` 渲染：组件内传 `useT('metrics')` 的 `t`（随语言刷新），
 * 缺省回落到 i18n 实例的当前语言（口径纯函数的既有调用点与测试保持原行为）。
 */

import { t as translate, type TFunction } from '../../i18n';
import { analysisLabel } from '../query/event-metric-editor/analysis-methods';
import {
  describeTransform,
  isNoopTransform,
  resolveTransformValue,
  type MetricTransformValue,
  type TransformOp,
} from '../query/event-metric-editor/metric-transform';
import type { FilterGroup, TimeRange, TimeRangeRelative, TimeRangeRelativeKind } from '../../types/dsl.types';

/**
 * 指标查询时间的文案（与后端 `metric-window.ts` 的 relativeRangeLabel **逐字一致**）：
 * 告警预览、指标列表、通知模板三处若各写一套，「近 7 天」与「最近7天」就会同时出现。
 */
export function metricWindowLabel(range: TimeRange, t: TFunction = translate): string {
  const relative = range.relative;
  if (!relative) return t('metrics:window.fixed');
  const kind = relative.kind as TimeRangeRelativeKind;
  if (kind === 'today') return t('metrics:window.today');
  if (kind === 'yesterday') return t('metrics:window.yesterday');
  if (kind === 'recent_n') return t('metrics:window.recentN', { n: relative.n });
  if (kind === 'past_n') return t('metrics:window.pastN', { n: relative.n });
  if (kind === 'this_week') return t('metrics:window.thisWeek');
  if (kind === 'last_week') return t('metrics:window.lastWeek');
  if (kind === 'this_month') return t('metrics:window.thisMonth');
  if (kind === 'last_month') return t('metrics:window.lastMonth');
  if (kind === 'custom_offsets') {
    return t('metrics:window.customOffsets', { from: relative.from_offset, to: relative.to_offset });
  }
  if (kind === 'from_date_to_today') return t('metrics:window.fromDateToToday');
  if (kind === 'from_date_to_yesterday') return t('metrics:window.fromDateToYesterday');
  return String(kind);
}

export type MetricKind = 'event' | 'retention';

/**
 * 指标窗口（查询时间 / 队列范围）的**结构**：服务端下发的界面展示载荷（i18n 收口）。
 *
 * 为什么不是文案：指标卡结果进缓存（`CardCache`），服务端按请求语言渲染会把语言固化进缓存。
 * 服务端因此只给「天数 + 相对范围 + 来源」，界面在渲染边界按查看者语言用本文件的
 * `metricWindowPayloadLabel` 生成文案；中文 `label` 原值仍保留（老响应兜底）。
 *
 * `relative` 只在文案由 `relativeRangeLabel` 生成（指标自带查询时间）时下发；
 * 规则窗口 / 默认窗口的中文是短形态「近 N 天」，由 `days` 生成同一形态。
 */
export interface MetricWindowPayload {
  /** 窗口天数（含首尾）；未知/缺省时不按天数生成 */
  days?: number | null;
  /** 服务端中文文案（老响应兜底） */
  label?: string | null;
  source?: 'metric' | 'rule' | 'default';
  /** 指标自带时间范围的相对结构 */
  relative?: TimeRangeRelative | null;
  /** 留存指标：口径串带「队列 {window}」前缀 */
  cohort?: boolean;
}

/** 窗口文案：有结构按结构渲染，否则按天数生成，最后回落服务端中文原值 */
export function metricWindowPayloadLabel(
  window: MetricWindowPayload | null | undefined,
  t: TFunction = translate,
): string {
  if (!window) return '';
  const days = typeof window.days === 'number' && Number.isFinite(window.days) ? window.days : null;
  let base: string;
  if (window.relative) {
    base = metricWindowLabel({ relative: window.relative } as TimeRange, t);
  } else if (window.source === 'metric' && window.label) {
    // 结构不完整（老响应没有 `relative`）：中文原值兜底。
    // 指标自带查询时间的中文是长形态「近 7 天（含今天）」，按天数生成的短形态对不上，不能硬猜。
    base = window.label;
  } else if (days !== null) {
    // rule / default 路径：中文是短形态「今天 / 近 N 天」（后端 `windowLabel`）
    base = days <= 1 ? t('metrics:window.today') : t('metrics:window.lastNDays', { n: days });
  } else {
    return window.label ?? '';
  }
  return window.cohort ? t('metrics:window.cohortWindow', { window: base }) : base;
}

/**
 * 指标口径摘要的**结构**（i18n 收口）：与后端 `metric-summary.ts` 同形。
 * 告警抽屉的指标下拉只有服务端的 `definition_summary`（中文串），英文界面因此残留中文；
 * 结构下发后由 `metricSummaryText` 按查看者语言拼装（中文逐字等于服务端原值）。
 */
export interface MetricSummaryStructure {
  kind: string;
  event?: string;
  analysis?: string;
  prop?: string;
  window?: MetricWindowPayload | null;
  value_pick?: string;
  start_event?: string;
  retain_event?: string;
  n?: number;
  measure?: 'rate' | 'count';
}

/**
 * 口径摘要：结构 + 文案键按当前语言拼装。
 * 拼装顺序与分隔符必须与后端 `definitionSummary` 的中文串一致（` · ` / ` → `），
 * 否则中文界面会出现「同样的口径两种写法」。
 */
export function metricSummaryText(summary: MetricSummaryStructure, t: TFunction = translate): string {
  if (summary.kind === 'event') {
    return t('metrics:summary.event', {
      event: summary.event ?? t('metrics:summary.noEvent'),
      analysis: summary.analysis ?? '',
      prop: summary.prop ? t('metrics:summary.propSegment', { prop: summary.prop }) : '',
      window: summary.window
        ? t('metrics:summary.windowSegment', { window: metricWindowPayloadLabel(summary.window, t) })
        : '',
      pick: summary.value_pick
        ? t('metrics:summary.pickSegment', { pick: valuePickLabel(summary.value_pick, t) })
        : '',
    });
  }
  if (summary.kind === 'retention') {
    return t('metrics:summary.retention', {
      start: summary.start_event ?? '?',
      retain: summary.retain_event ?? '?',
      period: t('metrics:summary.periodDays', {
        n: Number.isFinite(summary.n) ? summary.n : 0,
      }),
      measure: t(summary.measure === 'count' ? 'metrics:summary.measureCount' : 'metrics:measure.rate'),
    });
  }
  return summary.kind;
}

export interface DefinitionRow {
  label: string;
  value: string;
}

/** 不需要属性的计算方法（其余方法必须选属性） */
const NO_PROP_METHODS = new Set(['total_times', 'trig_user_num', 'per_capita_times']);

export function analysisNeedsProp(method: string): boolean {
  return !NO_PROP_METHODS.has(method);
}

/** 枚举 → 文案键（模块级只放键，文案经 `t` 取，见文件头） */
const MEASURE_LABEL_KEY: Record<string, string> = { rate: 'metrics:measure.rate', count: 'metrics:measure.count' };
const COHORT_LABEL_KEY: Record<string, string> = { all: 'metrics:cohort.all', first_day: 'metrics:cohort.firstDay' };
const GRANULARITY_LABEL_KEY: Record<string, string> = {
  day: 'metrics:granularity.day',
  week: 'metrics:granularity.week',
  month: 'metrics:granularity.month',
};

/** 留存口径（measure）的展示名 */
export function measureLabel(value: string, t: TFunction = translate): string {
  const key = MEASURE_LABEL_KEY[value];
  return key ? t(key) : value;
}

/** 队列（cohort）的展示名 */
export function cohortLabel(value: string, t: TFunction = translate): string {
  const key = COHORT_LABEL_KEY[value];
  return key ? t(key) : value;
}

/** 粒度（granularity）的展示名 */
export function granularityLabel(value: string, t: TFunction = translate): string {
  const key = GRANULARITY_LABEL_KEY[value];
  return key ? t(key) : value;
}

/** 留存编辑抽屉的下拉选项（顺序与后端枚举一致） */
export function measureOptions(t: TFunction): { value: string; label: string }[] {
  return Object.keys(MEASURE_LABEL_KEY).map((value) => ({ value, label: measureLabel(value, t) }));
}

export function cohortOptions(t: TFunction): { value: string; label: string }[] {
  return Object.keys(COHORT_LABEL_KEY).map((value) => ({ value, label: cohortLabel(value, t) }));
}

export function granularityOptions(t: TFunction): { value: string; label: string }[] {
  return Object.keys(GRANULARITY_LABEL_KEY).map((value) => ({ value, label: granularityLabel(value, t) }));
}

const VALUE_PICK_LABEL_KEY: Record<string, string> = {
  sum: 'metrics:valuePick.sum',
  avg: 'metrics:valuePick.avg',
  max: 'metrics:valuePick.max',
  min: 'metrics:valuePick.min',
  uniq_total: 'metrics:valuePick.uniqTotal',
  weighted: 'metrics:valuePick.weighted',
  first_day: 'metrics:valuePick.firstDay',
  last_day: 'metrics:valuePick.lastDay',
};

/** 取值说明文案的键（zh 逐字等于后端 `VALUE_PICK_DESCRIPTION`） */
const VALUE_PICK_NOTE_KEY: Record<string, string> = {
  sum: 'metrics:valuePick.note.sum',
  avg: 'metrics:valuePick.note.avg',
  max: 'metrics:valuePick.note.max',
  min: 'metrics:valuePick.note.min',
  uniq_total: 'metrics:valuePick.note.uniqTotal',
  weighted: 'metrics:valuePick.note.weighted',
  first_day: 'metrics:valuePick.note.firstDay',
  last_day: 'metrics:valuePick.note.lastDay',
};

/** 取值选择的展示名（未登记的值回落原值，与后端 VALUE_PICK_LABEL 同口径） */
export function valuePickLabel(value: string, t: TFunction = translate): string {
  const key = VALUE_PICK_LABEL_KEY[value];
  return key ? t(key) : value;
}

/**
 * 取值选择的**说明文案**（试算结果里的「窗口内各日值相加…」）。
 * 与 `metrics:valuePick.hint.*`（表单下拉提示）分开：后端 `VALUE_PICK_DESCRIPTION`
 * 的措辞与下拉提示不同，中文界面必须逐字保持，所以这里另落一套键。
 * 返回值 null = 未登记的值（调用方回落服务端 `pick_note`）。
 */
export function valuePickNote(value: string, t: TFunction = translate): string | null {
  const key = VALUE_PICK_NOTE_KEY[value];
  return key ? t(key) : null;
}

function text(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function eventName(value: unknown): string {
  const event = (value as { event?: unknown } | undefined)?.event;
  return typeof event === 'string' && event ? event : '';
}

/** 定义 → 可读行（查看抽屉与列表摘要共用） */
export function describeMetric(
  kind: string,
  definition: Record<string, unknown>,
  t: TFunction = translate,
): DefinitionRow[] {
  if (kind === 'event') {
    const metric = (definition.metric ?? {}) as Record<string, unknown>;
    const analysis = text(metric.analysis ?? metric.type);
    const percentile = typeof metric.percentile === 'number' ? metric.percentile : undefined;
    const transformText = describeTransform(metric.transform as MetricTransformValue | undefined);
    const pick = typeof metric.value_pick === 'string' ? metric.value_pick : '';
    const filters = metric.filters as FilterGroup | undefined;
    const filterCount = Array.isArray(filters?.items) ? filters.items.length : 0;
    return [
      { label: t('metrics:label.event'), value: text(metric.event) },
      {
        label: t('metrics:label.analysis'),
        value: analysis === '—' ? '—' : analysisLabel(analysis as never, percentile),
      },
      { label: t('metrics:label.prop'), value: text(metric.prop, t('metrics:value.notNeeded')) },
      { label: t('metrics:label.transform'), value: transformText || t('metrics:value.notNeeded') },
      {
        label: t('metrics:label.valuePick'),
        value: pick ? valuePickLabel(pick, t) : t('metrics:valuePick.auto'),
      },
      {
        label: t('metrics:label.timeRange'),
        value: metric.time_range
          ? metricWindowLabel(metric.time_range as TimeRange, t)
          : t('metrics:window.followAlert'),
      },
      {
        label: t('metrics:label.filters'),
        value: filterCount > 0 ? t('metrics:filters.count', { total: filterCount }) : t('metrics:value.none'),
      },
    ];
  }
  if (kind === 'retention') {
    const n = Number(definition.n ?? 0);
    const granularity = text(definition.granularity, 'day');
    const periodKey =
      granularity === 'week'
        ? 'metrics:period.week'
        : granularity === 'month'
          ? 'metrics:period.month'
          : 'metrics:period.day';
    const window = definition.time_range as TimeRange | undefined;
    return [
      { label: t('metrics:label.startEvent'), value: text(eventName(definition.start_event)) },
      { label: t('metrics:label.retainEvent'), value: text(eventName(definition.retain_event)) },
      { label: t('metrics:label.period'), value: Number.isFinite(n) && n > 0 ? t(periodKey, { n }) : '—' },
      { label: t('metrics:label.measure'), value: measureLabel(text(definition.measure, 'rate'), t) },
      { label: t('metrics:label.cohort'), value: cohortLabel(text(definition.cohort, 'all'), t) },
      { label: t('metrics:label.granularity'), value: granularityLabel(granularity, t) },
      // v3：队列范围（未设置时按周期推导）
      {
        label: t('metrics:label.cohortRange'),
        value: window
          ? metricWindowLabel(window, t)
          : t('metrics:detail.cohortRangeDerived', {
              days: Math.max(30, (Number.isFinite(n) ? n : 0) + 30),
            }),
      },
    ];
  }
  return [{ label: t('metrics:label.type'), value: text(kind) }];
}

/** 列表里给的一行摘要（空间有限，只给最关键的一句） */
export function shortSummary(
  kind: string,
  definition: Record<string, unknown>,
  t: TFunction = translate,
): string {
  return describeMetric(kind, definition, t)
    .slice(0, 3)
    .map((row) => `${row.label} ${row.value}`)
    .join(' · ');
}

/** 列表第二行摘要：查询时间 · 取值（指标 v2 的口径关键词） */
export function windowPickSummary(
  kind: string,
  definition: Record<string, unknown>,
  t: TFunction = translate,
): string | null {
  if (kind !== 'event') return null;
  const metric = (definition.metric ?? {}) as Record<string, unknown>;
  const window = metric.time_range
    ? metricWindowLabel(metric.time_range as TimeRange, t)
    : t('metrics:window.followAlert');
  const pick = typeof metric.value_pick === 'string' ? metric.value_pick : '';
  return `${window} · ${pick ? valuePickLabel(pick, t) : t('metrics:valuePick.autoShort')}`;
}

export interface EventMetricPatch {
  event: string;
  analysis: string;
  prop?: string | null;
  percentile?: number | null;
  /** 数值变换（四则运算 + 保留小数位） */
  transform?: MetricTransformValue | null;
  /** 取值选择；null = 自动（按计算方法推荐） */
  value_pick?: string | null;
  /** 查询时间；null = 跟随告警窗口 */
  time_range?: TimeRange | null;
  subject_id?: string | null;
  filters?: FilterGroup | null;
}

/**
 * 事件指标：用表单值覆盖口径字段，**未在表单里出现的字段原样保留**（alias / type / func…）。
 * 显式清空写 `null`：后端把 null 视为「删掉该键」，因此「取消勾选」不会留下残值。
 */
export function buildEventDefinition(
  original: Record<string, unknown>,
  patch: EventMetricPatch,
): Record<string, unknown> {
  const metric = { ...((original.metric ?? {}) as Record<string, unknown>) };
  metric.kind = 'event';
  metric.event = patch.event;
  metric.analysis = patch.analysis;
  const prop = patch.prop?.trim();
  if (prop) metric.prop = prop;
  else delete metric.prop;

  if ('percentile' in patch) {
    if (patch.percentile === null || patch.percentile === undefined) delete metric.percentile;
    else metric.percentile = patch.percentile;
  }
  if ('transform' in patch) {
    // v3：写回统一为 {op,value,decimals}；无操作变换（乘/除 1、加/减 0 且无小数位）不写入
    const resolved = resolveTransformValue(patch.transform as MetricTransformValue | null | undefined);
    if (resolved && !isNoopTransform(patch.transform as MetricTransformValue)) {
      metric.transform = {
        op: resolved.op,
        value: resolved.value,
        ...(resolved.decimals === undefined ? {} : { decimals: resolved.decimals }),
      };
    } else {
      delete metric.transform;
    }
  }
  if ('value_pick' in patch) {
    if (patch.value_pick) metric.value_pick = patch.value_pick;
    else delete metric.value_pick;
  }
  if ('time_range' in patch) {
    if (patch.time_range) metric.time_range = patch.time_range;
    else delete metric.time_range;
  }
  if ('subject_id' in patch) {
    if (patch.subject_id) metric.subject_id = patch.subject_id;
    else delete metric.subject_id;
  }
  if ('filters' in patch) {
    const filters = patch.filters;
    if (filters && Array.isArray(filters.items) && filters.items.length > 0) metric.filters = filters;
    else delete metric.filters;
  }
  return { ...original, metric };
}

/** 留存指标：同样只覆盖口径字段，两侧事件自带的 filters 原样保留 */
export function buildRetentionDefinition(
  original: Record<string, unknown>,
  patch: {
    startEvent: string;
    retainEvent: string;
    n: number;
    measure: 'rate' | 'count';
    cohort: string;
    granularity: string;
    /** 队列范围（v3）：null = 按周期推导 */
    timeRange?: TimeRange | null;
  },
): Record<string, unknown> {
  const start = { ...((original.start_event ?? {}) as Record<string, unknown>) };
  const retain = { ...((original.retain_event ?? {}) as Record<string, unknown>) };
  start.event = patch.startEvent;
  retain.event = patch.retainEvent;
  const next: Record<string, unknown> = {
    ...original,
    start_event: start,
    retain_event: retain,
    n: patch.n,
    measure: patch.measure,
    cohort: patch.cohort,
    granularity: patch.granularity,
  };
  if ('timeRange' in patch) {
    if (patch.timeRange) next.time_range = patch.timeRange;
    else delete next.time_range;
  }
  return next;
}

/** 编辑表单的初值（从定义反推） */
export function toFormValues(kind: string, definition: Record<string, unknown>) {
  if (kind === 'event') {
    const metric = (definition.metric ?? {}) as Record<string, unknown>;
    const resolvedTransform = resolveTransformValue(metric.transform as MetricTransformValue | undefined);
    return {
      event: typeof metric.event === 'string' ? metric.event : undefined,
      analysis: typeof metric.analysis === 'string' ? metric.analysis : 'total_times',
      prop: typeof metric.prop === 'string' ? metric.prop : undefined,
      percentile: typeof metric.percentile === 'number' ? metric.percentile : undefined,
      transform_op: (resolvedTransform?.op ?? 'mul') as TransformOp,
      transform_value: resolvedTransform?.value,
      decimals: resolvedTransform?.decimals,
      value_pick: typeof metric.value_pick === 'string' ? metric.value_pick : undefined,
      time_range: (metric.time_range as TimeRange | undefined) ?? undefined,
      subject_id: typeof metric.subject_id === 'string' ? metric.subject_id : undefined,
      filters: (metric.filters as FilterGroup | undefined) ?? { logic: 'and' as const, items: [] },
    };
  }
  return {
    startEvent: eventName(definition.start_event) || undefined,
    retainEvent: eventName(definition.retain_event) || undefined,
    n: Number(definition.n ?? 1),
    measure: definition.measure === 'count' ? 'count' : 'rate',
    cohort: definition.cohort === 'first_day' ? 'first_day' : 'all',
    granularity: ['week', 'month'].includes(String(definition.granularity)) ? String(definition.granularity) : 'day',
    timeRange: (definition.time_range as TimeRange | undefined) ?? undefined,
  };
}
