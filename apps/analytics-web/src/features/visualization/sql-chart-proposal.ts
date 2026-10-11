import {
  BAR_MAX_METRICS,
  CHART_CONFIG_SCHEMA_VERSION,
  CHART_RECOMMENDATION_VERSION,
  LINE_MAX_METRICS,
  NUMBER_MAX_METRICS,
} from './chart.constants';
import { defaultOptions } from './chart-compatibility';
import { parseChartConfigV1, pruneStaleOptionRefs, ChartConfigError } from './chart-config';
import { t as translate } from '../../i18n';
import type { ChartConfigV1, ChartOptions, FunnelBinding } from './chart.types';

/**
 * AI 提案只面向自定义 SQL 域（`CHART_TYPES_SQL` 的图型）。
 * `ChartTypeV1` 是两域共享的全集，这里用域子集声明白名单与指标上限，
 * 事件侧独有图型（stack / cumulative / distribution）不在提案范围内。
 */
type SqlProposalChartType = 'table' | 'number' | 'line' | 'bar' | 'pie' | 'funnel' | 'trend';
const CHART_TYPES: SqlProposalChartType[] = [
  'table',
  'number',
  'line',
  'bar',
  'pie',
  'funnel',
  'trend',
];
const METRIC_LIMIT: Record<SqlProposalChartType, number> = {
  table: NUMBER_MAX_METRICS,
  number: NUMBER_MAX_METRICS,
  line: LINE_MAX_METRICS,
  trend: LINE_MAX_METRICS,
  bar: BAR_MAX_METRICS,
  pie: 1,
  funnel: NUMBER_MAX_METRICS,
};

export class SqlChartProposalError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function columnList(value: unknown, field: string, columns: Set<string>): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new SqlChartProposalError(translate('sql:proposal.mustBeArray', { field }));
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item) {
      throw new SqlChartProposalError(translate('sql:proposal.itemInvalid', { field, index }));
    }
    if (!columns.has(item)) throw new SqlChartProposalError(translate('sql:proposal.columnMissing', { name: item }));
    return item;
  });
}

function optionalColumn(value: unknown, field: string, columns: Set<string>): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) {
    throw new SqlChartProposalError(translate('sql:proposal.fieldInvalid', { field }));
  }
  if (!columns.has(value)) throw new SqlChartProposalError(translate('sql:proposal.columnMissing', { name: value }));
  return value;
}

function parseFunnelBinding(raw: unknown, columns: Set<string>): FunnelBinding | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new SqlChartProposalError(translate('sql:proposal.funnelInvalid'));
  const shape = raw.shape === 'long' || raw.shape === 'wide' ? raw.shape : null;
  const family = raw.metric_family === 'uv' || raw.metric_family === 'pv' || raw.metric_family === 'custom'
    ? raw.metric_family
    : null;
  if (!shape || !family) throw new SqlChartProposalError(translate('sql:proposal.funnelShapeInvalid'));
  if (!Array.isArray(raw.steps) || raw.steps.length < 3 || raw.steps.length > 8) {
    throw new SqlChartProposalError(translate('sql:proposal.funnelStepsRange'));
  }
  return {
    shape,
    metric_family: family,
    steps: raw.steps.map((step, index) => {
      if (!isRecord(step)) throw new SqlChartProposalError(translate('sql:proposal.funnelStepInvalid'));
      const column = optionalColumn(step.column, `funnel.steps[${index}].column`, columns);
      if (!column) throw new SqlChartProposalError(translate('sql:proposal.funnelStepColumn'));
      const label = typeof step.label === 'string' && step.label ? step.label : column;
      if (label.length > 100) throw new SqlChartProposalError(translate('sql:proposal.funnelStepLabelTooLong'));
      return { order: index + 1, column, label };
    }),
  };
}

/**
 * 把 Harness 的紧凑绑定提案收成完整 ChartConfigV1。
 * 未点名的列一律 ignored，避免多指标把折线打成「不可用」。
 */
/** 底层校验器给出的英文原因 → 给调用方看的中文短句（只在报错里拼一句，不进 i18n 资源） */
const CONFIG_REASON_TEXT: Record<string, string> = {
  'missing sort': '排序指标不在当前结果列中',
  'invalid sort direction': '排序方向无效',
  'missing selector column': '筛选列不在当前结果列中',
  'missing column': '配置引用了不存在的列',
  'invalid role': '列角色不合法',
  'unknown field': '配置里有无法识别的字段',
  'unknown option': '图形选项里有无法识别的字段',
  'invalid version': '配置版本不匹配',
  'invalid enums': '图形类型或展示方式不合法',
  'invalid top_n': 'TopN 超出允许范围',
  'invalid stat_calcs': '显示值配置不合法',
  'too large': '配置过大',
};

export function materializeSqlChartProposal(
  input: unknown,
  columnNames: string[],
  currentOptions?: ChartOptions,
): ChartConfigV1 {
  if (!isRecord(input)) throw new SqlChartProposalError(translate('sql:proposal.bindingsInvalid'));
  const chartType = input.chart_type as SqlProposalChartType;
  if (!CHART_TYPES.includes(chartType)) {
    throw new SqlChartProposalError(translate('sql:proposal.chartTypeUnsupported'));
  }
  const columns = new Set(columnNames);
  if (!columns.size) throw new SqlChartProposalError(translate('sql:proposal.noColumns'));
  if (!isRecord(input.bindings)) throw new SqlChartProposalError(translate('sql:proposal.bindingsMissing'));

  const metrics = columnList(input.bindings.metrics, 'metrics', columns);
  const ignoredNamed = columnList(input.bindings.ignored, 'ignored', columns);
  const x = optionalColumn(input.bindings.x, 'x', columns);
  const category = optionalColumn(input.bindings.category, 'category', columns);
  const series = optionalColumn(input.bindings.series, 'series', columns);
  const limit = METRIC_LIMIT[chartType];
  if (metrics.length > limit) {
    throw new SqlChartProposalError(translate('sql:proposal.metricLimit', { chartType, limit }));
  }
  if ((chartType === 'line' || chartType === 'trend') && !x) {
    throw new SqlChartProposalError(translate('sql:proposal.lineNeedsX'));
  }
  if ((chartType === 'bar' || chartType === 'pie') && !category) {
    throw new SqlChartProposalError(translate('sql:proposal.categoryNeedsCategory'));
  }
  if (chartType !== 'table' && chartType !== 'funnel' && metrics.length < 1) {
    throw new SqlChartProposalError(translate('sql:proposal.metricsRequired'));
  }
  const funnel = parseFunnelBinding(input.bindings.funnel, columns);
  if (chartType === 'funnel' && !funnel) {
    throw new SqlChartProposalError(translate('sql:proposal.funnelBindingRequired'));
  }

  const named = new Set<string>([...metrics, ...ignoredNamed, x, category, series].filter(Boolean) as string[]);
  const roles: ChartConfigV1['roles'] = {};
  if (isRecord(input.roles)) {
    for (const [key, value] of Object.entries(input.roles)) {
      if (!columns.has(key)) throw new SqlChartProposalError(translate('sql:proposal.columnMissing', { name: key }));
      if (value !== 'time' && value !== 'dimension' && value !== 'metric' && value !== 'ignored') {
        throw new SqlChartProposalError(translate('sql:proposal.roleInvalid', { name: key }));
      }
      roles[key] = value;
    }
  }
  for (const name of columnNames) {
    if (roles[name]) continue;
    if (name === x) roles[name] = 'time';
    else if (name === category || name === series) roles[name] = 'dimension';
    else if (metrics.includes(name)) roles[name] = 'metric';
    else roles[name] = 'ignored';
  }
  for (const name of named) {
    if (!roles[name]) {
      if (name === x) roles[name] = 'time';
      else if (name === category || name === series) roles[name] = 'dimension';
      else if (metrics.includes(name)) roles[name] = 'metric';
      else roles[name] = 'ignored';
    }
  }

  const preferred =
    input.preferred_view === 'table' || input.preferred_view === 'pivot' || input.preferred_view === 'chart'
      ? input.preferred_view
      : chartType === 'table'
        ? 'table'
        : 'chart';

  const draft: ChartConfigV1 = {
    schema_version: CHART_CONFIG_SCHEMA_VERSION,
    recommendation_version: CHART_RECOMMENDATION_VERSION,
    mode: 'manual',
    preferred_view: preferred,
    chart_type: chartType,
    roles,
    bindings: {
      ...(x ? { x } : {}),
      ...(category ? { category } : {}),
      ...(series ? { series } : {}),
      metrics,
      ignored: columnNames.filter((name) => roles[name] === 'ignored'),
      ...(isRecord(input.bindings.row_selector)
        ? {
            row_selector: {
              column: String(input.bindings.row_selector.column),
              value: input.bindings.row_selector.value as string | number | boolean | null,
            },
          }
        : {}),
      ...(funnel ? { funnel } : {}),
    },
    // 继承上一版配置的 options 时先剔除指向旧列的引用（sort/units/aggregation）：
    // 旧卡片的 sort.column 会让整条新配置被判无效，表现为「点了没反应 / 不兼容」
    options: defaultOptions(
      pruneStaleOptionRefs(
        {
          ...currentOptions,
          ...(isRecord(input.options) ? (input.options as Partial<ChartOptions>) : {}),
        } as ChartOptions,
        columns,
      ),
    ),
  };

  try {
    return parseChartConfigV1(draft, columnNames);
  } catch (error) {
    if (error instanceof ChartConfigError) {
      if (error.message === 'empty') throw new SqlChartProposalError(translate('sql:proposal.bindingsInvalid'));
      // 带上底层原因：只报「不兼容」会让调用方完全看不出该改哪一项（线上曾因此连续失败 13 次）
      const badColumns = error.issues.flatMap((issue) => issue.columns ?? []);
      const reason = CONFIG_REASON_TEXT[error.message] ?? error.message;
      throw new SqlChartProposalError(
        `${translate('sql:proposal.incompatible')}（原因：${reason}${badColumns.length ? `：${badColumns.join(' / ')}` : ''}）`,
      );
    }
    throw error;
  }
}

export function sameSqlChartConfig(left: ChartConfigV1 | null, right: ChartConfigV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
