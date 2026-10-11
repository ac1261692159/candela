import { defaultStatCalcs, parseStatCalcs, type StatCalc } from '../explore-charts/series-stats';

export type RetentionResultLayout = 'both' | 'chart' | 'table';
export type RetentionChartType = 'nth_trend';

export interface RetentionViewState {
  layout: RetentionResultLayout;
  chart: RetentionChartType;
  statCalcs: StatCalc[];
}

function viewFromUnknown(dsl: unknown): Record<string, unknown> {
  if (!dsl || typeof dsl !== 'object') return {};
  const view = (dsl as { _view?: Record<string, unknown> })._view;
  return view && typeof view === 'object' ? view : {};
}

export function parseRetentionResultLayout(raw: unknown): RetentionResultLayout {
  if (raw === 'chart' || raw === 'table') return raw;
  if (raw === 'trend') return 'chart';
  return 'both';
}

export function parseRetentionChartType(raw: unknown, layoutRaw?: unknown): RetentionChartType {
  if (raw === 'nth_trend' || raw === 'trend' || raw === 'line' || raw === 'daily_trend') return 'nth_trend';
  if (layoutRaw === 'trend') return 'nth_trend';
  return 'nth_trend';
}

export function retentionLayoutFromDsl(dsl: unknown): RetentionResultLayout {
  return parseRetentionResultLayout(viewFromUnknown(dsl).retention_layout);
}

export function retentionChartFromDsl(dsl: unknown, cardChartType?: unknown): RetentionChartType {
  const view = viewFromUnknown(dsl);
  return parseRetentionChartType(view.retention_chart ?? cardChartType, view.retention_layout);
}

export function retentionStatCalcsFromDsl(dsl: unknown, chart: RetentionChartType): StatCalc[] {
  return parseStatCalcs(viewFromUnknown(dsl).stat_calcs, chart);
}

export function retentionViewPayload(state: RetentionViewState): Record<string, unknown> {
  return {
    retention_layout: state.layout,
    retention_chart: 'nth_trend',
    stat_calcs: state.statCalcs.length ? state.statCalcs : defaultStatCalcs(state.chart),
  };
}

export function retentionCardChartType(
  layout: RetentionResultLayout,
  _chart: RetentionChartType,
): 'table' | RetentionChartType {
  return layout === 'table' ? 'table' : 'nth_trend';
}
