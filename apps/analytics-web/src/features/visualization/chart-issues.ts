import type { ChartIssue, ChartIssueCode } from './chart.types';
import { t as translate, type TFunction } from '../../i18n';

/**
 * 图表问题文案表（i18n `sql` 命名空间）。
 *
 * 由调用方把 `t` 传进来构造：模块作用域取不到「当前语言」的文案。
 * `formatIssue` 保留单参数签名（供 `features/report/` 等既有调用方使用），
 * 默认走 i18n 实例取当前语言；组件内可显式传入自己的 `t`。
 */
export function issueMessages(t: TFunction): Record<ChartIssueCode, (issue: ChartIssue) => string> {
  return {
    NO_ROWS: () => t('sql:issue.noRows'),
    AMBIGUOUS_COLUMN_ROLE: (issue) =>
      t('sql:issue.ambiguousRole', { name: issue.columns?.[0] ?? t('sql:issue.fallbackColumn') }),
    MISSING_TIME: () => t('sql:issue.missingTime'),
    MISSING_DIMENSION: () => t('sql:issue.missingDimension'),
    MISSING_METRIC: () => t('sql:issue.missingMetric'),
    DUPLICATE_KEY: (issue) =>
      issue.columns?.length
        ? t('sql:issue.duplicateKeyColumns', { columns: issue.columns.join(', ') })
        : t('sql:issue.duplicateKey'),
    TOO_MANY_SERIES: (issue) => t('sql:issue.tooManySeries', { max: issue.params?.max ?? 5 }),
    TOO_MANY_ROWS: () => t('sql:issue.tooManyRows'),
    TOO_MANY_POINTS: () => t('sql:issue.tooManyPoints'),
    TOO_MANY_METRICS: (issue) => t('sql:issue.tooManyMetrics', { max: issue.params?.max ?? 8 }),
    NEGATIVE_VALUE: (issue) =>
      issue.columns?.length
        ? t('sql:issue.negativeValueColumns', { columns: issue.columns.join(', ') })
        : t('sql:issue.negativeValue'),
    ZERO_TOTAL: () => t('sql:issue.zeroTotal'),
    NON_ADDITIVE_METRIC: (issue) =>
      t('sql:issue.nonAdditiveMetric', { name: issue.columns?.[0] ?? t('sql:issue.fallbackMetric') }),
    MIXED_UNITS: (issue) => {
      // 轴名复用面板里已有的键，避免同一句「左轴/右轴」在 13 种语言里各译两遍
      const axis = issue.params?.axis === 'right' ? t('analysis:field.axisRight') : t('analysis:field.axisLeft');
      const columns = (issue.columns ?? []).join(t('sql:chart.listSeparator'));
      return t('sql:issue.mixedUnits', { axis, columns });
    },
    UNSAFE_INTEGER: (issue) =>
      t('sql:issue.unsafeInteger', { name: issue.columns?.[0] ?? t('sql:issue.fallbackColumn') }),
    MULTI_ROW_FUNNEL_REQUIRES_SELECTION: (issue) =>
      t('sql:issue.multiRowFunnel', { dimension: issue.params?.dimension ?? t('sql:chart.fallbackGroup') }),
    ROW_SELECTOR_NO_MATCH: () => t('sql:issue.rowSelectorNoMatch'),
    ROW_SELECTOR_NOT_UNIQUE: () => t('sql:issue.rowSelectorNotUnique'),
    NON_MONOTONIC_FUNNEL: () => t('sql:issue.nonMonotonicFunnel'),
    STALE_CONFIG: (issue) =>
      issue.columns?.length
        ? t('sql:issue.staleConfigColumns', { columns: issue.columns.join(t('sql:chart.listSeparator')) })
        : t('sql:issue.staleConfig'),
    UNSUPPORTED_CONFIG_VERSION: () => t('sql:issue.unsupportedConfigVersion'),
    RENDER_ERROR: () => t('sql:issue.renderError'),
    TRUNCATED_RESULT: (issue) => t('sql:issue.truncatedResult', { rows: issue.params?.rows ?? 'N' }),
    RECOMMENDATION_UPGRADE_AVAILABLE: () => t('sql:issue.recommendationUpgrade'),
    AXIS_SPLIT_SUGGESTED: (issue) =>
      t('sql:issue.axisSplitSuggested', {
        ratio: issue.params?.ratio ?? 0,
        metrics: issue.params?.metrics ?? t('sql:issue.fallbackMetric'),
      }),
    SERIES_DIMENSION_UNUSED: (issue) =>
      t('sql:issue.seriesDimensionUnused', { count: Number(issue.params?.count ?? 0) }),
    SERIES_CELL_COLLAPSED: () => t('sql:issue.seriesCellCollapsed'),
    SERIES_LIMIT_EXCEEDED: (issue) =>
      t('sql:issue.seriesLimitExceeded', { max: issue.params?.max ?? 5 }),
    STALE_BINDING: (issue) =>
      issue.columns?.length
        ? t('sql:issue.staleBindingColumns', {
            columns: issue.columns.join(t('sql:chart.listSeparator')),
          })
        : t('sql:issue.staleBinding'),
  };
}

export function createIssue(
  code: ChartIssueCode,
  severity: ChartIssue['severity'] = 'error',
  extra?: Pick<ChartIssue, 'columns' | 'params'>,
): ChartIssue {
  return { code, severity, ...extra };
}

export function formatIssue(issue: ChartIssue, t: TFunction = translate): string {
  return issueMessages(t)[issue.code](issue);
}

export function primaryError(issues: ChartIssue[]): ChartIssue | undefined {
  return issues.find((issue) => issue.severity === 'error');
}
