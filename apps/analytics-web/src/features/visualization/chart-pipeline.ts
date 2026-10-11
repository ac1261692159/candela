import { barAdapter } from './adapters/bar.adapter';
import { funnelAdapter } from './adapters/funnel.adapter';
import { lineAdapter } from './adapters/line.adapter';
import { numberAdapter } from './adapters/number.adapter';
import { pieAdapter } from './adapters/pie.adapter';
import { trendAdapter } from './adapters/trend.adapter';
import { CHART_MAX_INPUT_ROWS, CHART_RECOMMENDATION_VERSION } from './chart.constants';
import { applyExplicitRoles, profileColumns } from './column-profiler';
import { bucketRoles, evaluateCompatibility } from './chart-compatibility';
import { BAR_MAX_METRICS } from './chart.constants';
import { readSavedConfig } from './chart-config';
import { applyVisibleTransforms, normalizeChartData, selectRows } from './chart-data';
import { createIssue } from './chart-issues';
import { recommendChart } from './chart-recommender';
import type {
  BuilderDslLike,
  ChartConfigV1,
  ChartIssue,
  ChartTypeV1,
  ProfilerContext,
  QueryColumn,
  ResolvedVisualization,
} from './chart.types';
import { materializeLongFunnel } from './funnel-long';
import { t as translate } from '../../i18n';

export interface ResolveArgs {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  savedConfig?: unknown;
  queryContext?: { builderDsl?: BuilderDslLike; sql?: string };
  truncated?: boolean;
}

function runAdapter(config: ChartConfigV1, data: ReturnType<typeof applyVisibleTransforms>, profiles: ResolvedVisualization['profiles'], extra: ChartIssue[]) {
  if (config.chart_type === 'line') return { ...lineAdapter(config, data, profiles), issues: extra };
  if (config.chart_type === 'bar') return { ...barAdapter(config, data, profiles), issues: extra };
  if (config.chart_type === 'pie') return { ...pieAdapter(config, data, profiles), issues: extra };
  if (config.chart_type === 'number') return { ...numberAdapter(config, data, profiles), issues: extra };
  if (config.chart_type === 'funnel') return funnelAdapter(config, data, profiles, extra);
  if (config.chart_type === 'trend') return { ...trendAdapter(config, data, profiles), issues: extra };
  return undefined;
}

export function resolveVisualization(args: ResolveArgs): ResolvedVisualization {
  const context: ProfilerContext = { builderDsl: args.queryContext?.builderDsl, sql: args.queryContext?.sql };
  let profiles = profileColumns(args.columns, args.rows, context);
  const savedRead = readSavedConfig(args.savedConfig, profiles);
  // 卡片存的是「自动」配置时，它的绑定只是平台上次推荐的产物：跟当前列对不上属于正常，
  // 正确行为是按当前列重算，而不是报「图表配置已失效」。注意 readSavedConfig 在丢弃配置时
  // 连 mode 一起丢了，所以这里看原始对象。
  const savedWasAuto =
    Boolean(args.savedConfig) &&
    typeof args.savedConfig === 'object' &&
    !Array.isArray(args.savedConfig) &&
    (args.savedConfig as { mode?: unknown }).mode === 'auto';
  if (savedRead.config) {
    profiles = applyExplicitRoles(profiles, savedRead.config.roles);
    context.savedRoles = savedRead.config.roles;
  }
  const inference = recommendChart(profiles, args.rows, savedRead.config);
  const issues: ChartIssue[] = [...savedRead.issues, ...inference.issues];
  if (savedWasAuto) {
    for (let i = issues.length - 1; i >= 0; i -= 1) {
      if (issues[i].code === 'STALE_CONFIG') issues.splice(i, 1);
    }
  }
  if (args.truncated) {
    issues.push(createIssue('TRUNCATED_RESULT', 'warning', { params: { rows: args.rows.length } }));
  }

  let config: ChartConfigV1 | null = null;
  if (savedRead.config) {
    let check = evaluateCompatibility(
      savedRead.config.chart_type,
      applyExplicitRoles(profiles, savedRead.config.roles),
      args.rows,
      savedRead.config.options,
      savedRead.config.bindings,
    );
    if (savedRead.config.mode === 'manual') {
      const errors = check.issues.filter((item) => item.severity === 'error');
      if (errors.length > 0 && errors.every((item) => item.code === 'MIXED_UNITS')) {
        check = {
          ...check,
          compatible: true,
          issues: check.issues.map((item) =>
            item.code === 'MIXED_UNITS' ? { ...item, severity: 'warning' as const } : item,
          ),
        };
      }
    }
    if (!check.compatible && savedRead.config.chart_type !== 'funnel') {
      // mode='auto' 的配置按定义就是「平台推荐」：它带着旧 schema 的绑定时（改了 SQL / 换了列名），
      // 正确做法是按当前列重算一张，而不是报「配置已失效」再回退表格 —— 那会让「自动」等于失效。
      if (savedRead.config.mode === 'auto') {
        config =
          inference.recommended?.config ??
          recommendChart(profiles, args.rows).recommended?.config ??
          null;
      } else {
        issues.push(createIssue('STALE_CONFIG', 'error', { columns: check.issues.flatMap((item) => item.columns ?? []) }));
        config = savedRead.config;
        return {
          profiles,
          inference,
          config,
          view: 'table',
          issues,
        };
      }
    } else {
      config = savedRead.config;
      issues.push(...check.issues);
    }
    if (config && config.mode === 'auto' && config.recommendation_version < CHART_RECOMMENDATION_VERSION) {
      issues.push(createIssue('RECOMMENDATION_UPGRADE_AVAILABLE', 'info'));
    }
  } else if (inference.recommended?.config) {
    config = inference.recommended.config;
  } else if (savedWasAuto) {
    // 旧的自动配置解读失败（引用了已消失的列）且推荐器没给方案：用不带旧配置的推荐现算一份
    config = recommendChart(profiles, args.rows).recommended?.config ?? null;
  }

  if (!config || config.preferred_view !== 'chart' || config.chart_type === 'table') {
    // 只有在“确实没出图”时才说明原因；一旦手动配好画出图，这条提示不该再出现
    if (!config && !inference.recommended && bucketRoles(profiles).metric.length > BAR_MAX_METRICS) {
      issues.push(createIssue('TOO_MANY_METRICS', 'warning', { params: { max: BAR_MAX_METRICS } }));
    }
    return {
      profiles,
      inference,
      config,
      view: config?.preferred_view === 'pivot' ? 'pivot' : 'table',
      issues,
    };
  }

  if (args.rows.length > CHART_MAX_INPUT_ROWS) {
    issues.push(createIssue('TOO_MANY_ROWS'));
    return { profiles, inference, config, view: 'table', issues };
  }

  let workingRows = args.rows;
  let extra: ChartIssue[] = [];
  if (config.chart_type === 'funnel' && config.bindings.funnel?.shape === 'long') {
    const long = materializeLongFunnel(config, args.rows);
    if (!('selectedRow' in long)) {
      return { profiles, inference, config, view: 'table', issues: [...issues, ...long.issues] };
    }
    config = {
      ...config,
      bindings: { ...config.bindings, funnel: { ...config.bindings.funnel, steps: long.steps }, metrics: long.steps.map((step) => step.column) },
    };
    workingRows = [long.selectedRow];
  } else if (config.chart_type === 'funnel' || config.chart_type === 'number') {
    const selected = selectRows(args.rows, config.bindings.row_selector);
    extra = selected.issues;
    workingRows = selected.rows.length ? selected.rows : args.rows;
    if (!config.bindings.row_selector && args.rows.length > 1 && config.chart_type === 'funnel') {
      extra = [createIssue('MULTI_ROW_FUNNEL_REQUIRES_SELECTION', 'warning', {
        params: { dimension: inference.recommended?.config?.bindings.row_selector?.column ?? config.bindings.funnel?.steps[0]?.column ?? translate('sql:chart.fallbackGroup') },
      })];
      return { profiles, inference, config, view: 'chart', issues: [...issues, ...extra] };
    }
  }

  const normalized = normalizeChartData(config, workingRows, profiles);
  extra = [...extra, ...normalized.issues];
  if (extra.some((issue) => issue.severity === 'error' && issue.code !== 'MULTI_ROW_FUNNEL_REQUIRES_SELECTION')) {
    return { profiles, inference, config, view: 'table', issues: [...issues, ...extra], data: normalized.data };
  }
  const transformed = applyVisibleTransforms(normalized.data, config, profiles);
  const adapted = runAdapter(config, transformed, profiles, extra);
  if (!adapted) {
    return { profiles, inference, config, view: 'table', issues };
  }
  return {
    profiles,
    inference,
    config,
    view: 'chart',
    issues: [...issues, ...adapted.issues],
    data: transformed,
    adapter: adapted,
  };
}

export function switchChartType(
  current: ChartConfigV1 | null,
  chartType: ChartTypeV1,
  resolved: ResolvedVisualization,
): ChartConfigV1 | null {
  const candidate = resolved.inference.candidates.find((item) => item.chartType === chartType);
  if (!candidate?.config) return current;
  return {
    ...candidate.config,
    mode: 'manual',
    preferred_view: chartType === 'table' ? 'table' : 'chart',
    options: {
      ...candidate.config.options,
      donut: chartType === 'pie' ? current?.options.donut ?? candidate.config.options.donut : false,
      orientation: chartType === 'bar' ? current?.options.orientation ?? candidate.config.options.orientation : 'vertical',
      // 保留趋势图配置，避免切走再切回时丢失用户设置（PRD AC10 保存与复现）
      trend: current?.options.trend ?? candidate.config.options.trend,
    },
  };
}
