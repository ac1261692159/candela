import { BAR_HORIZONTAL_CATEGORY_THRESHOLD, CHART_MAX_INPUT_ROWS } from './chart.constants';
import { createIssue } from './chart-issues';
import {
  bucketRoles,
  evaluateBar,
  evaluateCompatibility,
  evaluateFunnel,
  evaluateLine,
  evaluateTrend,
  evaluateNumber,
  evaluatePie,
} from './chart-compatibility';
import type {
  ChartCandidate,
  ChartConfigV1,
  ChartInferenceResult,
  ChartTypeV1,
  ColumnProfile,
} from './chart.types';
import { distinctCount } from './column-profiler';
import { detectFunnelShape } from './funnel-shape';
import { t as translate, type TFunction } from '../../i18n';

const CANDIDATE_ORDER: ChartTypeV1[] = ['funnel', 'number', 'line', 'bar', 'pie', 'table'];

function pendingBlocksAuto(profiles: ColumnProfile[], needed: Array<'time' | 'dimension' | 'metric'>): boolean {
  const buckets = bucketRoles(profiles);
  // 只在「必需的槽位一个都没有」时拦住自动推荐。
  // 曾经只要存在未识别的数值列就一律拦住 —— 小结果（如 3 行）几乎总会有未识别列，
  // 结果是「自动」永远停在「请配置字段后生成图表」（2026-09-21 线上实例：11 个数值列里 9 个未识别，
  // 但另有 2 个已识别为指标，完全够画一张柱状图）。未识别的列不猜测、不参与绘图即可，不该拦掉整张图。
  if (profiles.some((profile) => profile.role === 'pending' && profile.confidence === 'pending')) {
    if (needed.includes('metric') && buckets.metric.length === 0) return true;
    if (needed.includes('time') && buckets.time.length === 0) return true;
    if (needed.includes('dimension') && buckets.dimension.length === 0) return true;
  }
  return false;
}

function compatible(candidate: ChartCandidate): candidate is ChartCandidate & { config: ChartConfigV1 } {
  return Boolean(candidate.compatible && candidate.config);
}

export function recommendChart(
  profiles: ColumnProfile[],
  rows: Record<string, unknown>[],
  saved?: ChartConfigV1 | null,
): ChartInferenceResult {
  const issues = [];
  if (rows.length === 0) {
    issues.push(createIssue('NO_ROWS', 'info'));
    return {
      profiles,
      recommended: null,
      candidates: CANDIDATE_ORDER.map((type) => evaluateCompatibility(type, profiles, rows)),
      issues,
    };
  }
  if (rows.length > CHART_MAX_INPUT_ROWS) {
    issues.push(createIssue('TOO_MANY_ROWS'));
    return {
      profiles,
      recommended: null,
      candidates: CANDIDATE_ORDER.map((type) => evaluateCompatibility(type, profiles, rows)),
      issues,
    };
  }

  const ambiguous = profiles.filter((profile) => profile.confidence === 'pending' && profile.role === 'pending');
  const buckets = bucketRoles(profiles);
  // 自动推荐的门槛按「可用维度」计：全行同值的常数维度当不了分类轴/系列
  // （线上实例：第一维「数据日期」3 行同值 → 维度数算成 2 → 柱/饼门槛全不匹配 → 永远不推荐）
  const usableDimensions = buckets.dimension.filter((item) => distinctCount(rows, item.key) > 1);
  const dims = usableDimensions.length ? usableDimensions : buckets.dimension;
  const funnel = detectFunnelShape(profiles, rows);
  const candidates: ChartCandidate[] = [
    evaluateFunnel(profiles, rows, funnel, saved?.options, saved?.bindings),
    evaluateNumber(profiles, rows, saved?.options, saved?.bindings?.row_selector),
    evaluateLine(profiles, rows, saved?.options),
    evaluateBar(profiles, rows, saved?.options),
    evaluatePie(profiles, rows, saved?.options),
    evaluateCompatibility('table', profiles, rows),
    // 趋势图：必须放在末尾。candidates 索引 [0]~[5] 被下方 recommended 推断硬编码，
    // 放在 [6] 让自动推荐逻辑碰不到它（PRD D4：不参与自动推荐），
    // 但 ChartToolbar 下拉的「兼容」组会读 inference.candidates，
    // 用户就能手动选 trend。
    evaluateTrend(profiles, rows, saved?.options),
  ];

  if (ambiguous.length && (buckets.metric.length === 0 || buckets.time.length + dims.length === 0)) {
    issues.push(createIssue('AMBIGUOUS_COLUMN_ROLE', 'error', { columns: [ambiguous[0].key] }));
  }

  let recommended: ChartCandidate | null = null;

  if (funnel && !pendingBlocksAuto(profiles, ['metric'])) {
    const funnelCandidate = candidates[0];
    const rowOk = rows.length === 1 || Boolean(funnel.dimensionColumns.length);
    if (rowOk && (funnelCandidate.compatible || funnelCandidate.issues.every((issue) => issue.code === 'MULTI_ROW_FUNNEL_REQUIRES_SELECTION'))) {
      recommended = funnelCandidate;
    }
  }

  if (!recommended && rows.length === 1 && buckets.metric.length >= 1 && buckets.metric.length <= 8 && dims.length === 0 && buckets.time.length === 0 && !pendingBlocksAuto(profiles, ['metric'])) {
    const numberCandidate = candidates[1];
    if (compatible(numberCandidate)) recommended = numberCandidate;
  }

  if (!recommended && buckets.time.length === 1 && dims.length === 0 && buckets.metric.length >= 1 && buckets.metric.length <= 5 && !pendingBlocksAuto(profiles, ['time', 'metric'])) {
    const lineCandidate = candidates[2];
    if (compatible(lineCandidate)) recommended = lineCandidate;
  }

  if (!recommended && buckets.time.length === 1 && dims.length === 1 && buckets.metric.length === 1 && !pendingBlocksAuto(profiles, ['time', 'dimension', 'metric'])) {
    const categoryCount = distinctCount(rows, dims[0].key);
    if (categoryCount >= 2 && categoryCount <= 5) {
      const lineCandidate = evaluateLine(profiles, rows, saved?.options);
      if (compatible(lineCandidate)) recommended = lineCandidate;
    } else if (categoryCount > 5) {
      recommended = {
        chartType: 'table',
        compatible: true,
        reasonCodes: ['too_many_series_use_pivot'],
        issues: [createIssue('TOO_MANY_SERIES', 'info', { params: { max: 5, count: categoryCount } })],
        config: {
          ...evaluateCompatibility('table', profiles, rows).config!,
          preferred_view: 'pivot',
        },
      };
    }
  }

  if (!recommended && buckets.time.length === 0 && dims.length === 1 && buckets.metric.length === 1 && !pendingBlocksAuto(profiles, ['dimension', 'metric'])) {
    const barCandidate = evaluateBar(profiles, rows, saved?.options);
    if (compatible(barCandidate)) {
      const categoryCount = distinctCount(rows, dims[0].key);
      if (categoryCount > BAR_HORIZONTAL_CATEGORY_THRESHOLD && barCandidate.config) {
        barCandidate.config.options.orientation = 'horizontal';
      }
      recommended = barCandidate;
    }
  }

  if (!recommended && buckets.time.length === 0 && dims.length === 1 && buckets.metric.length >= 2 && buckets.metric.length <= 4 && !pendingBlocksAuto(profiles, ['dimension', 'metric'])) {
    const barCandidate = evaluateBar(profiles, rows, saved?.options);
    if (compatible(barCandidate)) recommended = barCandidate;
  }

  if (!recommended && buckets.time.length === 1 && dims.length === 1 && buckets.metric.length === 1) {
    recommended = {
      chartType: 'table',
      compatible: true,
      reasonCodes: ['pivot_shape'],
      issues: [],
      config: {
        ...evaluateCompatibility('table', profiles, rows).config!,
        preferred_view: 'pivot',
      },
    };
  }

  return {
    profiles,
    recommended,
    candidates,
    issues: [...issues, ...(recommended?.issues ?? [])],
  };
}

export function recommendationReasonText(result: ChartInferenceResult, t: TFunction = translate): string {
  const recommended = result.recommended;
  if (!recommended) {
    const ambiguous = result.issues.find((issue) => issue.code === 'AMBIGUOUS_COLUMN_ROLE');
    if (ambiguous) {
      return t('sql:recommend.ambiguous', { name: ambiguous.columns?.[0] ?? t('sql:recommend.fallbackColumn') });
    }
    return t('sql:recommend.noUnique');
  }
  const buckets = bucketRoles(result.profiles);
  if (recommended.chartType === 'funnel') {
    return t('sql:recommend.funnelSteps', { count: recommended.config?.bindings.funnel?.steps.length ?? 0 });
  }
  if (recommended.chartType === 'number') {
    return t('sql:recommend.singleRowMetrics', { count: buckets.metric.length });
  }
  if (recommended.chartType === 'line' && recommended.config?.bindings.series) {
    return t('sql:recommend.lineWithSeries');
  }
  if (recommended.chartType === 'line') {
    return t('sql:recommend.line', { count: buckets.metric.length });
  }
  if (recommended.chartType === 'bar') {
    return t('sql:recommend.bar', { count: buckets.metric.length });
  }
  if (recommended.config?.preferred_view === 'pivot') {
    return t('sql:recommend.pivot');
  }
  return t('sql:recommend.defaultView');
}
