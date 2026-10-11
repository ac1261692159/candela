import { t } from '../../i18n';
import { formatIssue } from '../visualization/chart-issues';
import { readSavedConfig } from '../visualization/chart-config';
import { resolveVisualization, switchChartType } from '../visualization/chart-pipeline';
import { profileColumns } from '../visualization/column-profiler';
import type { BuilderDslLike, ChartConfigV1, ChartTypeV1 } from '../visualization/chart.types';
import type { SqlExecuteResult } from '../../types/report.types';

export function isV1ChartConfig(input: unknown): input is ChartConfigV1 {
  return Boolean(input) && typeof input === 'object' && (input as { schema_version?: unknown }).schema_version === 1;
}

export function configAfterExecute(args: {
  result: SqlExecuteResult;
  current: ChartConfigV1 | null;
  legacyCardWithoutChart: boolean;
  openedWithSavedChart: boolean;
  builderDsl?: unknown;
  sql?: string;
}): ChartConfigV1 | null {
  if (args.legacyCardWithoutChart && !args.current) return null;
  if (args.openedWithSavedChart && args.current) return args.current;
  if (args.current?.mode === 'manual') return args.current;
  const resolved = resolveVisualization({
    columns: args.result.columns,
    rows: args.result.rows,
    queryContext: { builderDsl: args.builderDsl as BuilderDslLike | undefined, sql: args.sql },
    truncated: args.result.truncated,
  });
  return resolved.inference.recommended?.config ?? resolved.config ?? null;
}

export function dashboardSqlPresentation(args: {
  columns: SqlExecuteResult['columns'];
  rows: SqlExecuteResult['rows'];
  truncated?: boolean;
  savedConfig: unknown;
  overlayView?: string | null;
}): { mode: 'chart'; config: ChartConfigV1 } | { mode: 'table'; reason?: string } {
  if (args.overlayView === 'table') {
    return { mode: 'table' };
  }
  if (!isV1ChartConfig(args.savedConfig)) {
    return { mode: 'table' };
  }
  const profiles = profileColumns(args.columns, args.rows);
  const saved = readSavedConfig(args.savedConfig, profiles);
  if (!saved.config) {
    const reason = saved.issues.find((issue) => issue.severity === 'error') ?? saved.issues[0];
    return { mode: 'table', reason: reason ? formatIssue(reason) : t('report:card.fallbackConfig') };
  }
  const resolved = resolveVisualization({
    columns: args.columns,
    rows: args.rows,
    savedConfig: saved.config,
    truncated: args.truncated,
  });
  if (args.overlayView && args.overlayView !== saved.config.chart_type) {
    const next = switchChartType(saved.config, args.overlayView as ChartTypeV1, resolved);
    if (next && next.preferred_view === 'chart') {
      const overlay = resolveVisualization({
        columns: args.columns,
        rows: args.rows,
        savedConfig: next,
        truncated: args.truncated,
      });
      if (overlay.view === 'chart' && overlay.adapter) return { mode: 'chart', config: next };
      return { mode: 'table', reason: t('report:card.fallbackIncompatible') };
    }
  }
  if (resolved.view === 'chart' && resolved.adapter) {
    return { mode: 'chart', config: saved.config };
  }
  const reason = resolved.issues.find((issue) => issue.severity === 'error');
  return { mode: 'table', reason: reason ? formatIssue(reason) : t('report:card.fallbackConfig') };
}
