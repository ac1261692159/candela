import type { QueryColumn } from '../../types/dsl.types';
import type { MetricUnit, XLabelOptions } from '../visualization/chart.types';
import { t as i18nT, type TFunction } from '../../i18n';
import { axisTooltipFormatter, formatChartNumber, yAxisWithUnit } from '../visualization/metric-units';
import {
  X_LABEL_FLAT_MAX_CATEGORIES,
  X_LABEL_NARROW_MAX_CATEGORIES,
  X_LABEL_NARROW_WIDTH,
  X_LABEL_ROTATE_MAX_CATEGORIES,
  X_LABEL_SHORT_LENGTH,
  X_LABEL_WIDE_WIDTH,
} from '../visualization/chart.constants';
import { finiteValues, type StatCalc } from './series-stats';
import { mappedText } from '../query/result-csv';
import { formatTimeAxisLabel } from '../time-axis/format-label';

export type ExploreChartKind =
  | 'line'
  | 'bar'
  | 'number'
  | 'trend'
  | 'stack'
  | 'cumulative'
  | 'distribution'
  | 'pie'
  | 'nth_trend'
  | 'daily_trend';

export interface ExploreSeries {
  name: string;
  values: Array<number | null>;
  /**
   * 走哪条 Y 轴；缺省 `left`。仅当至少一条为 `right` 时才渲染双轴
   * （phase: clklog-analytics-event-chart-binding-v1）。
   */
  axis?: 'left' | 'right';
  /** 该系列的单位；缺省取 model 的全局单位。tooltip 与所属 Y 轴按它格式化 */
  unit?: MetricUnit;
}

export interface ExploreChartModel {
  categories: string[];
  series: ExploreSeries[];
  percent?: boolean;
  /** X 轴标签策略；缺省或 null = 按分类数与标签长度自动决定 */
  xLabel?: XLabelOptions | null;
  /**
   * X 轴是否为时间列；决定轴标签是否走时间格式化（`formatTimeAxisLabel`）。
   * 缺省视为时间列——既有调用方不传该字段，缺省值必须保持改造前的行为。
   */
  timeAxis?: boolean;
}

/** X 轴标签的最终取值：显式覆盖优先，未给的部分回退自动档位 */
export interface ResolvedXLabel {
  rotate: number;
  maxWidth: number | null;
}

const DAILY_TREND_MAX_COHORTS = 8;
const PIE_TOP = 8;

/**
 * 按分类数与标签长度选档：短标签直排，中等截断，长的旋转 + 截断。
 * 截断只影响轴；`tooltip.trigger='axis'` 的表头用完整 `axisValue`，仍可读到全文。
 */
function autoXLabel(categories: string[]): ResolvedXLabel {
  const count = categories.length;
  const longest = categories.reduce((max, item) => Math.max(max, item.length), 0);
  if (count <= X_LABEL_FLAT_MAX_CATEGORIES && longest <= X_LABEL_SHORT_LENGTH) {
    return { rotate: 0, maxWidth: null };
  }
  if (count <= X_LABEL_NARROW_MAX_CATEGORIES) return { rotate: 0, maxWidth: X_LABEL_WIDE_WIDTH };
  if (count <= X_LABEL_ROTATE_MAX_CATEGORIES) return { rotate: 30, maxWidth: X_LABEL_WIDE_WIDTH };
  return { rotate: 45, maxWidth: X_LABEL_NARROW_WIDTH };
}

/**
 * 解析 X 轴标签策略。
 *
 * `override` 为 null/undefined 时全自动；给了 override 时逐字段回退：
 * `rotate === null` 表示旋转角度交回自动，`max_width === null` 表示**不截断**。
 */
export function resolveXLabel(
  categories: string[],
  override?: XLabelOptions | null,
): ResolvedXLabel {
  const auto = autoXLabel(categories);
  if (!override) return auto;
  return {
    rotate: override.rotate ?? auto.rotate,
    maxWidth: override.max_width === undefined ? auto.maxWidth : override.max_width,
  };
}

/** 与 ECharts 默认色板对齐，供图例色点使用 */
export const EXPLORE_COLORS = [
  '#5470c6',
  '#91cc75',
  '#fac858',
  '#ee6666',
  '#73c0de',
  '#3ba272',
  '#fc8452',
  '#9a60b4',
  '#ea7ccc',
];

function parseTimeMs(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  const ms = Date.parse(trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

/** 日粒度去掉 00:00:00，避免轴上出现 6 号 / 4 号这种乱序完整时间戳 */
export function normalizeCategory(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?/);
  if (!match) return value;
  const [, day, hour, minute] = match;
  if (!hour || (hour === '00' && (!minute || minute === '00'))) return day;
  return `${day} ${hour}:${minute}`;
}

export function sortModelByTime(model: ExploreChartModel): ExploreChartModel {
  const times = model.categories.map((category) => parseTimeMs(category));
  if (!times.length || times.some((item) => item == null)) {
    return { ...model, categories: model.categories.map((category) => normalizeCategory(category)) };
  }
  const order = times.map((_, index) => index).sort((a, b) => (times[a] as number) - (times[b] as number));
  return {
    ...model,
    categories: order.map((index) => normalizeCategory(model.categories[index])),
    series: model.series.map((item) => ({ ...item, values: order.map((index) => item.values[index]) })),
  };
}

export function displayRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.filter((row) => row.__stage !== true);
}

export function metricColumns(columns: QueryColumn[]): QueryColumn[] {
  return columns.filter((col) => col.key.startsWith('m_') || col.key.endsWith('_rate'));
}

export function groupColumns(columns: QueryColumn[]): QueryColumn[] {
  return columns.filter((col) => col.key.startsWith('g_') || col.key === 'cohort_date');
}

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

export function modelFromEventResult(
  columns: QueryColumn[],
  rows: Record<string, unknown>[],
): ExploreChartModel {
  const shown = displayRows(rows);
  const metrics = metricColumns(columns);
  const groups = groupColumns(columns);
  const x = groups[0] ?? columns[0];
  return sortModelByTime({
    categories: shown.map((row) => mappedText(x, row[x?.key ?? ''])),
    series: metrics.map((col) => ({
      name: col.title,
      values: shown.map((row) => asNumber(row[col.key])),
    })),
    percent: metrics.some((col) => col.unit === 'percent' || col.key.endsWith('_rate')),
  });
}

export function modelFromRetentionNth(columns: QueryColumn[], rows: Record<string, unknown>[]): ExploreChartModel {
  const shown = displayRows(rows);
  const rates = columns.filter((col) => col.key.endsWith('_rate'));
  return sortModelByTime({
    categories: shown.map((row) => String(row.cohort_date ?? '')),
    series: rates.map((col) => ({
      name: col.title,
      values: shown.map((row) => asNumber(row[col.key])),
    })),
    percent: true,
  });
}

export function modelFromRetentionDaily(
  columns: QueryColumn[],
  rows: Record<string, unknown>[],
  limit = DAILY_TREND_MAX_COHORTS,
): ExploreChartModel {
  const shown = displayRows(rows);
  const rates = columns.filter((col) => col.key.endsWith('_rate'));
  const recent = shown.slice(0, limit);
  return {
    categories: rates.map((col) => col.title),
    series: recent.map((row) => ({
      name: String(row.cohort_date ?? ''),
      values: rates.map((col) => asNumber(row[col.key])),
    })),
    percent: true,
  };
}

function runningSum(values: Array<number | null>): Array<number | null> {
  let acc = 0;
  let seen = false;
  return values.map((value) => {
    if (value == null) return seen ? acc : null;
    acc += value;
    seen = true;
    return acc;
  });
}

function distributionSeries(model: ExploreChartModel, t: TFunction): ExploreChartModel {
  const first = model.series[0];
  if (!first) return { categories: [], series: [], percent: true };
  const total = finiteValues(first.values).reduce((sum, value) => sum + value, 0);
  const pairs = model.categories.map((category, index) => ({
    category,
    value: first.values[index],
  }));
  pairs.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const head = pairs.slice(0, PIE_TOP);
  const tail = pairs.slice(PIE_TOP);
  const other = tail.reduce((sum, item) => sum + (item.value ?? 0), 0);
  const categories = head.map((item) => item.category);
  const values = head.map((item) => (total ? (item.value ?? 0) / total : null));
  if (tail.length) {
    categories.push(t('analysis:chart.other'));
    values.push(total ? other / total : null);
  }
  return {
    categories,
    series: [{ name: first.name, values }],
    percent: true,
  };
}

function pieSlices(model: ExploreChartModel, t: TFunction): Array<{ name: string; value: number }> {
  const first = model.series[0];
  if (!first) return [];
  const pairs = model.categories
    .map((category, index) => ({ name: category, value: first.values[index] ?? 0 }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);
  const head = pairs.slice(0, PIE_TOP);
  const other = pairs.slice(PIE_TOP).reduce((sum, item) => sum + item.value, 0);
  if (other > 0) head.push({ name: t('analysis:chart.other'), value: other });
  return head;
}

export function buildExploreOption(
  kind: ExploreChartKind,
  model: ExploreChartModel,
  statCalcs: StatCalc[],
  yUnit?: MetricUnit,
  t: TFunction = i18nT,
): Record<string, unknown> {
  const unit: MetricUnit = yUnit ?? (model.percent ? 'ratio_0_1' : 'number');

  if (kind === 'pie') {
    const data = pieSlices(model, t);
    const bottom = 28 + Math.max(data.length, 1) * 22;
    return {
      color: EXPLORE_COLORS,
      aria: { enabled: true, decal: { show: false } },
      tooltip: { trigger: 'item' },
      legend: { show: false },
      grid: { left: 8, right: 8, top: 16, bottom, containLabel: true },
      series: [
        {
          type: 'pie',
          radius: statCalcs.includes('total') ? ['36%', '58%'] : '58%',
          center: ['50%', '42%'],
          label: { formatter: '{b}: {d}%' },
          data,
        },
      ],
    };
  }

  const working: ExploreChartModel =
    kind === 'distribution'
      ? distributionSeries(model, t)
      : kind === 'cumulative'
        ? { ...model, series: model.series.map((item) => ({ ...item, values: runningSum(item.values) })) }
        : model;

  const stack = kind === 'stack' ? 'total' : undefined;
  const type = kind === 'bar' || kind === 'stack' || kind === 'distribution' ? 'bar' : 'line';
  const lineLegend = kind === 'line' || kind === 'trend' || kind === 'nth_trend' || kind === 'daily_trend' || kind === 'cumulative';
  const connectNulls = kind === 'trend' || kind === 'cumulative';
  const showStatsMarks = !lineLegend && (statCalcs.includes('max') || statCalcs.includes('min') || statCalcs.includes('avg'));

  const markPoint =
    showStatsMarks && (statCalcs.includes('max') || statCalcs.includes('min'))
      ? {
          data: [
            ...(statCalcs.includes('max') ? [{ type: 'max', name: t('analysis:statCalc.max') }] : []),
            ...(statCalcs.includes('min') ? [{ type: 'min', name: t('analysis:statCalc.min') }] : []),
          ],
        }
      : undefined;

  const markLine =
    showStatsMarks && statCalcs.includes('avg') ? { data: [{ type: 'average', name: t('analysis:statCalc.avg') }] } : undefined;

  const bottom = lineLegend ? 40 : 28 + Math.max(working.series.length, 1) * 22;

  const unitOf = (item: ExploreSeries): MetricUnit => item.unit ?? unit;
  const axisOf = (item: ExploreSeries): 'left' | 'right' => item.axis ?? 'left';
  const unitOn = (axis: 'left' | 'right'): MetricUnit => {
    const found = working.series.find((item) => axisOf(item) === axis);
    return found ? unitOf(found) : unit;
  };
  // 双轴：只要有一条系列指定右轴就渲染两条刻度轴（phase: clklog-analytics-event-chart-binding-v1）
  const hasRightAxis = working.series.some((item) => axisOf(item) === 'right');
  const yAxis = hasRightAxis
    ? [yAxisWithUnit(unitOn('left')), yAxisWithUnit(unitOn('right'))]
    : yAxisWithUnit(unitOn('left'));

  const xLabel = resolveXLabel(working.categories, model.xLabel);
  // 时间列走日期文案（既有行为，缺省即此）；维度列用原文，截断交给 ECharts
  const timeAxis = model.timeAxis !== false;

  // 单位全相同时沿用单单位 valueFormatter——既有调用方的 tooltip 逐字不变；
  // 每指标单位不同（或双轴）时才换成按系列查单位的 formatter。
  const unitBySeries = new Map<string, MetricUnit>();
  for (const item of working.series) {
    if (!unitBySeries.has(item.name)) unitBySeries.set(item.name, unitOf(item));
  }
  const distinctUnits = new Set(unitBySeries.values());
  const tooltip =
    distinctUnits.size <= 1
      ? {
          trigger: 'axis',
          valueFormatter: (value: unknown) =>
            formatChartNumber(typeof value === 'number' ? value : Number(value), unit),
        }
      : {
          trigger: 'axis',
          formatter: axisTooltipFormatter((name) => unitBySeries.get(name) ?? unit),
        };

  return {
    color: EXPLORE_COLORS,
    aria: { enabled: true, decal: { show: false } },
    tooltip,
    legend: lineLegend ? { bottom: 0, type: 'scroll', selectedMode: true } : { show: false },
    grid: { left: 12, right: hasRightAxis ? 48 : 16, top: 28, bottom, containLabel: true },
    xAxis: {
      type: 'category',
      data: working.categories,
      boundaryGap: type === 'bar',
      axisLabel: {
        hideOverlap: true,
        rotate: xLabel.rotate,
        ...(xLabel.maxWidth == null ? {} : { width: xLabel.maxWidth, overflow: 'truncate' }),
        formatter: (value: string) => (timeAxis ? formatTimeAxisLabel(value, t) : value),
      },
    },
    yAxis,
    series: working.series.map((item) => ({
      name: item.name,
      type,
      stack,
      connectNulls,
      showSymbol: working.series.length > 2,
      symbol: 'circle',
      lineStyle: type === 'line' ? { type: 'solid', width: 2 } : undefined,
      data: item.values,
      markPoint,
      markLine,
      ...(hasRightAxis ? { yAxisIndex: item.axis === 'right' ? 1 : 0 } : {}),
    })),
  };
}
