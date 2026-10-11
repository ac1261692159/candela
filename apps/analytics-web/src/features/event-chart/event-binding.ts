/**
 * 事件结果 → `ExploreChartModel` 的翻译层。
 *
 * phase: clklog-analytics-event-chart-binding-v1
 *
 * 这一层是纯函数：输入结果列 / 行 / 图表配置，输出 `explore-charts` 能直接渲染的模型。
 * 它承担三件 `explore-charts` 不该知道的事：
 * 1. 按 `bindings` 选轴（X 轴 / 拆分系列 / 指标），而不是按 `g_` / `m_` 前缀猜；
 * 2. 拆分系列时的**透视**（把一个维度列的行转成多条线）；
 * 3. 轴与单位按 `options` 落到每条系列上。
 *
 * 绑定是纯展示层：所有值都已经在返回的行里，换绑定不触发后端查询。
 */
import type { QueryColumn } from '../../types/dsl.types';
import type { ChartConfigV1, ChartIssue, MetricUnit } from '../visualization/chart.types';
import { BAR_MAX_METRICS, LINE_MAX_SERIES } from '../visualization/chart.constants';
import { createIssue } from '../visualization/chart-issues';
import { mappedText } from '../query/result-csv';
import {
  sortModelByTime,
  type ExploreChartModel,
  type ExploreSeries,
} from '../explore-charts/explore-chart-option';
import { axisOf, boundMetrics, columnRole, unboundAxisColumns } from './event-chart-config';

/** 线数上限：折线与柱类分别对齐 SQL 侧的既有约束 */
const SERIES_LIMIT_BY_KIND: Record<string, number> = {
  line: LINE_MAX_SERIES,
  trend: LINE_MAX_SERIES,
  cumulative: LINE_MAX_SERIES,
  bar: BAR_MAX_METRICS,
  stack: BAR_MAX_METRICS,
  distribution: BAR_MAX_METRICS,
};

/** 透视单元格的复合键分隔符：用不会出现在维度取值里的控制字符 */
const CELL_SEPARATOR = '\u0000';

export interface EventChartModel {
  model: ExploreChartModel;
  issues: ChartIssue[];
}

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function finiteSum(values: Array<number | null>): number {
  return values.reduce<number>((sum, value) => (value == null ? sum : sum + Math.abs(value)), 0);
}

/** 一次渲染里反复用到的列解释结果 */
interface BindingContext {
  config: ChartConfigV1;
  metrics: QueryColumn[];
  /** 维度 / 时间列的展示名（已本地化） */
  titleOf: (key: string) => string;
  /** 维度 / 时间列的单元格文本（走维表映射） */
  textOf: (row: Record<string, unknown>, key: string) => string;
  unitOf: (key: string) => MetricUnit;
}

export function buildEventChartModel(
  columns: QueryColumn[],
  rows: Record<string, unknown>[],
  config: ChartConfigV1,
): EventChartModel {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const ctx: BindingContext = {
    config,
    metrics: boundMetrics(config, columns),
    titleOf: (key) => byKey.get(key)?.title ?? key,
    textOf: (row, key) => {
      const column = byKey.get(key);
      return column ? mappedText(column, row[key]) : String(row[key] ?? '');
    },
    unitOf: (key) => config.options.units[key] ?? 'number',
  };

  // 阶段汇总行不是数据点；它在表格里有意义，在图上会把 Y 轴拉爆
  const shown = rows.filter((row) => row.__stage !== true);
  const xKey = config.bindings.x;
  const seriesKey = config.bindings.series;
  const xColumn = xKey ? byKey.get(xKey) : undefined;
  const timeAxis = xColumn ? columnRole(xColumn) === 'time' : true;
  const categories = xKey ? uniqueInOrder(shown.map((row) => ctx.textOf(row, xKey))) : [];

  const issues: ChartIssue[] = [];
  if (!xKey) issues.push(createIssue('MISSING_DIMENSION', 'warning'));

  const raw = seriesKey
    ? pivotSeries(shown, seriesKey, xKey!, categories, ctx, issues)
    : directSeries(shown, ctx);

  const limit = SERIES_LIMIT_BY_KIND[config.chart_type];
  const series = limit ? capSeries(raw, limit, issues) : raw;

  if (!seriesKey) {
    const unbound = unboundAxisColumns(config, columns);
    if (unbound.length) {
      issues.push(createIssue('SERIES_DIMENSION_UNUSED', 'info', { params: { count: unbound.length } }));
    }
  }

  const model: ExploreChartModel = {
    categories,
    series,
    timeAxis,
    xLabel: config.options.x_label ?? null,
  };
  // 时间列要按时间升序（TopN 返回的是指标降序）；维度列保持服务端顺序
  return { model: timeAxis ? sortModelByTime(model) : model, issues };
}

/** 不拆分系列：每个指标一条线，与改造前一致 */
function directSeries(shown: Record<string, unknown>[], ctx: BindingContext): ExploreSeries[] {
  return ctx.metrics.map((metric) => ({
    name: ctx.titleOf(metric.key),
    values: shown.map((row) => asNumber(row[metric.key])),
    unit: ctx.unitOf(metric.key),
    axis: axisOf(ctx.config, metric.key),
  }));
}

/**
 * 拆分系列：按某个维度列的取值把一个指标画成多条线。
 *
 * 同一 (X, 拆分取值) 命中多行，说明结果里还有第三个分组列没绑定——
 * 此时按**求和**合并（唯一不丢数的降级），并出 `SERIES_CELL_COLLAPSED` 让用户知道该收敛分组。
 * 求和只对可加指标成立，这正是要提示而不是静默处理的原因。
 */
function pivotSeries(
  shown: Record<string, unknown>[],
  seriesKey: string,
  xKey: string,
  categories: string[],
  ctx: BindingContext,
  issues: ChartIssue[],
): ExploreSeries[] {
  const cells = new Map<string, Record<string, number>>();
  let collapsed = false;

  for (const row of shown) {
    const key = `${ctx.textOf(row, seriesKey)}${CELL_SEPARATOR}${ctx.textOf(row, xKey)}`;
    const existing = cells.get(key);
    if (existing) collapsed = true;
    const bucket = existing ?? {};
    cells.set(key, bucket);
    for (const metric of ctx.metrics) {
      const value = asNumber(row[metric.key]);
      if (value == null) continue;
      bucket[metric.key] = (bucket[metric.key] ?? 0) + value;
    }
  }
  if (collapsed) issues.push(createIssue('SERIES_CELL_COLLAPSED', 'warning'));

  const seriesValues = uniqueInOrder(shown.map((row) => ctx.textOf(row, seriesKey)));
  const multiMetric = ctx.metrics.length > 1;
  const out: ExploreSeries[] = [];
  for (const seriesValue of seriesValues) {
    for (const metric of ctx.metrics) {
      out.push({
        name: multiMetric ? `${seriesValue} · ${ctx.titleOf(metric.key)}` : seriesValue,
        values: categories.map(
          (category) => cells.get(`${seriesValue}${CELL_SEPARATOR}${category}`)?.[metric.key] ?? null,
        ),
        unit: ctx.unitOf(metric.key),
        axis: axisOf(ctx.config, metric.key),
      });
    }
  }
  return out;
}

/**
 * 线数超限时按「跨分类的总量」降序保留前 N 条。
 * 不合成「其他」系列——对折线求和没有业务含义，少画几条比画一条假的更诚实。
 */
function capSeries(series: ExploreSeries[], limit: number, issues: ChartIssue[]): ExploreSeries[] {
  if (series.length <= limit) return series;
  const ranked = series
    .map((item, index) => ({ item, index, total: finiteSum(item.values) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index);
  issues.push(createIssue('SERIES_LIMIT_EXCEEDED', 'warning', { params: { max: limit } }));
  return ranked.map((entry) => entry.item);
}
