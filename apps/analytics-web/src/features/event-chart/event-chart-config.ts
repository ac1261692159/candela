/**
 * 事件分析图表字段绑定：配置的读取、自动合成与列角色解释。
 *
 * phase: clklog-analytics-event-chart-binding-v1
 *
 * 事件侧复用自定义 SQL 的 `ChartConfigV1`（同名字段 `dsl.chart_config`、同一份前后端校验），
 * 差别只在「列角色从哪来」：事件侧由服务端按查询定义下发 `role`，
 * 不需要像 SQL 侧那样靠 ClickHouse 类型与别名正则反推。
 */
import type { QueryColumn, QueryColumnRole } from '../../types/dsl.types';
import type {
  BindingColumn,
  ChartAxis,
  ChartConfigV1,
  ChartIssue,
  ChartOptions,
  ChartTypeV1,
  MetricUnit,
} from '../visualization/chart.types';
import {
  CHART_CONFIG_SCHEMA_VERSION,
  CHART_RECOMMENDATION_VERSION,
} from '../visualization/chart.constants';
import { defaultOptions } from '../visualization/chart-compatibility';
import { isLegacyChartConfig, parseChartConfigV1 } from '../visualization/chart-config';
import { createIssue } from '../visualization/chart-issues';

export type { BindingColumn };

/**
 * 列角色：服务端下发的 `role` 优先，缺失时回退列名前缀。
 *
 * 回退分支服务于两处：升级期间命中的旧缓存结果（服务端还没有 `role`），
 * 以及漏斗 / 留存结果（它们本来就只给 `g_` / `m_` 前缀）。
 */
export function columnRole(column: QueryColumn): QueryColumnRole {
  if (column.role) return column.role;
  if (column.key.startsWith('m_') || column.key.endsWith('_rate')) return 'metric';
  if (column.key.startsWith('g_') || column.key === 'cohort_date') return 'dimension';
  return 'dimension';
}

/** 可作为 X 轴 / 拆分系列的列：时间与维度 */
export function axisCandidateColumns(columns: QueryColumn[]): QueryColumn[] {
  return columns.filter((column) => columnRole(column) !== 'metric');
}

export function metricColumnsOf(columns: QueryColumn[]): QueryColumn[] {
  return columns.filter((column) => columnRole(column) === 'metric');
}

/**
 * 指标单位的缺省值：比率 → 0–1，时长 → 秒，其余 → 数值。
 * 列上带的单位是服务端按指标口径算出来的，比「整张图一个单位」准确。
 */
export function defaultUnitForColumn(column: QueryColumn): MetricUnit {
  if (column.unit === 'percent') return 'ratio_0_1';
  if (column.unit === 'duration_sec') return 'duration_sec';
  if (column.key.endsWith('_rate')) return 'ratio_0_1';
  return 'number';
}

/**
 * 自动绑定（`mode: 'auto'`）：不写回，只作为「卡片还没有 `chart_config`」时的合成结果。
 *
 * X 轴取第一个时间列，没有时间列再取第一个维度列；指标取全部指标列；
 * **不自动设拆分系列**——自动改变既有卡片的图形属于静默改写，
 * 发现路径改为 `SERIES_DIMENSION_UNUSED` 提示，由用户主动选择。
 */
export function autoEventChartConfig(
  columns: QueryColumn[],
  chartType: ChartTypeV1,
  legacyUnit?: MetricUnit,
): ChartConfigV1 {
  const usable = columns.filter((column) => column.key !== 'cohort_date');
  const roles: ChartConfigV1['roles'] = {};
  for (const column of usable) roles[column.key] = columnRole(column);

  const x = usable.find((column) => columnRole(column) === 'time')
    ?? usable.find((column) => columnRole(column) === 'dimension')
    // 没有时间 / 维度列时沿用改造前的回退（第一列）：无分组的「数值」类卡片就是这种形状，
    // 它的图只画 series，X 轴取什么不影响显示；少这一层回退会让这类旧卡变成「暂无数据」。
    ?? usable[0];
  const metrics = metricColumnsOf(usable);

  // 旧卡只有「整张图一个单位」（`_view.y_unit`）。它只在非缺省时才携带用户意图，
  // 缺省的 'number' 交给按列推导，这样时长 / 比率指标能各自格式化。
  const inherited = legacyUnit && legacyUnit !== 'number' ? legacyUnit : null;
  const units: Record<string, MetricUnit> = {};
  for (const column of metrics) units[column.key] = inherited ?? defaultUnitForColumn(column);

  const bindings: ChartConfigV1['bindings'] = {
    metrics: metrics.map((column) => column.key),
    ignored: [],
  };
  if (x) bindings.x = x.key;

  return {
    schema_version: CHART_CONFIG_SCHEMA_VERSION,
    recommendation_version: CHART_RECOMMENDATION_VERSION,
    mode: 'auto',
    preferred_view: 'chart',
    chart_type: chartType,
    roles,
    bindings,
    options: defaultOptions({ units }),
  };
}

export interface EventChartConfigRead {
  config: ChartConfigV1;
  /** true = 来自卡片已保存的配置；false = 本次按结果合成 */
  saved: boolean;
  issues: ChartIssue[];
}

/**
 * 读取卡片的 `chart_config`，读不出来就回退自动合成。
 *
 * 失败一律**不覆盖原配置**：调用方只在用户改动后才写回，避免「打开一次卡片就静默改写」。
 */
export function readEventChartConfig(args: {
  raw: unknown;
  columns: QueryColumn[];
  chartType: ChartTypeV1;
  legacyUnit?: MetricUnit;
}): EventChartConfigRead {
  const { raw, columns, chartType, legacyUnit } = args;
  const fallback = () => ({
    config: autoEventChartConfig(columns, chartType, legacyUnit),
    saved: false,
  });

  if (raw == null) return { ...fallback(), issues: [] };
  if (isLegacyChartConfig(raw)) return { ...fallback(), issues: [] };
  if (
    typeof raw === 'object'
    && raw !== null
    && typeof (raw as { schema_version?: unknown }).schema_version === 'number'
    && (raw as { schema_version: number }).schema_version > CHART_CONFIG_SCHEMA_VERSION
  ) {
    return { ...fallback(), issues: [createIssue('UNSUPPORTED_CONFIG_VERSION')] };
  }

  try {
    const config = parseChartConfigV1(
      raw,
      columns.map((column) => column.key),
      'event',
    );
    return { config, saved: true, issues: [] };
  } catch (error) {
    // 列引用失效（改了分组 / 指标顺序）与配置损坏都落到这里；
    // 记下引用不到的列名，便于用户知道是哪些绑定过期了。
    const stale = staleColumnsOf(error);
    return {
      ...fallback(),
      issues: [createIssue('STALE_BINDING', 'warning', stale.length ? { columns: stale } : undefined)],
    };
  }
}

function staleColumnsOf(error: unknown): string[] {
  const issues = (error as { issues?: ChartIssue[] } | null)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue) => issue.columns ?? []);
}

/** 把结果列映射成字段面板要的中性列（事件侧没有 ClickHouse 类型可展示） */
export function bindingColumns(columns: QueryColumn[], roles: ChartConfigV1['roles']): BindingColumn[] {
  return columns.map((column) => ({
    key: column.key,
    label: column.title,
    role: roles[column.key] ?? columnRole(column),
  }));
}

/**
 * AI 提案 → 完整 `ChartConfigV1`（phase: clklog-ai-event-chart-v1）。
 *
 * 服务端返回的是**提案形状**（只含 AI 会改的字段），这里补齐 schema 版本、列角色与
 * options 缺省值，再过一遍两域共用的校验器——域白名单、列引用、指标上限都在那里兜底，
 * 不在客户端重复实现一遍规则。
 *
 * 解析失败会抛出（调用方据此拒绝提案，而不是把半份配置塞进图表）。
 */
export function chartConfigFromProposal(
  proposal: Record<string, unknown>,
  columns: QueryColumn[],
): ChartConfigV1 {
  const roles: ChartConfigV1['roles'] = {};
  for (const column of columns) roles[column.key] = columnRole(column);
  const bindings = isPlainRecord(proposal.bindings) ? proposal.bindings : {};
  const options = isPlainRecord(proposal.options) ? (proposal.options as Partial<ChartOptions>) : {};
  return parseChartConfigV1(
    {
      schema_version: CHART_CONFIG_SCHEMA_VERSION,
      recommendation_version: CHART_RECOMMENDATION_VERSION,
      mode: 'manual',
      preferred_view: 'chart',
      chart_type: proposal.chart_type,
      roles,
      bindings: { metrics: [], ignored: [], ...bindings },
      options: defaultOptions(options),
    },
    columns.map((column) => column.key),
    'event',
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 绑定里用到的指标列（保持 bindings.metrics 的顺序） */
export function boundMetrics(config: ChartConfigV1, columns: QueryColumn[]): QueryColumn[] {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  return config.bindings.metrics.flatMap((key) => {
    const column = byKey.get(key);
    return column ? [column] : [];
  });
}

/** 未被用作 X 轴 / 拆分系列的维度与时间列（用于提示「可设为拆分系列」） */
export function unboundAxisColumns(
  config: ChartConfigV1,
  columns: QueryColumn[],
): QueryColumn[] {
  const ignored = new Set(config.bindings.ignored ?? []);
  return axisCandidateColumns(columns).filter(
    (column) =>
      column.key !== config.bindings.x
      && column.key !== config.bindings.series
      && !ignored.has(column.key),
  );
}

export function axisOf(config: ChartConfigV1, key: string): ChartAxis {
  return config.options.metric_axis?.[key] ?? 'left';
}
