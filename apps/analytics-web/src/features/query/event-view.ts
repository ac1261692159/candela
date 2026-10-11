import { defaultStatCalcs, parseStatCalcs, type StatCalc } from '../explore-charts/series-stats';
import type { MetricUnit } from '../visualization/chart.types';
import { parseMetricUnit } from '../visualization/metric-units';

export type EventResultLayout = 'both' | 'chart' | 'table';
export type EventChartType =
  | 'line'
  | 'bar'
  | 'number'
  | 'trend'
  | 'stack'
  | 'cumulative'
  | 'distribution'
  | 'pie';

const EVENT_CHARTS: EventChartType[] = [
  'line',
  'bar',
  'number',
  'trend',
  'stack',
  'cumulative',
  'distribution',
  'pie',
];

export interface EventViewState {
  layout: EventResultLayout;
  chart: EventChartType;
  durationPlain: boolean;
  statCalcs: StatCalc[];
  yUnit: MetricUnit;
}

function viewFromUnknown(dsl: unknown): Record<string, unknown> {
  if (!dsl || typeof dsl !== 'object') return {};
  const view = (dsl as { _view?: Record<string, unknown> })._view;
  return view && typeof view === 'object' ? view : {};
}

export function parseEventResultLayout(raw: unknown): EventResultLayout {
  return raw === 'chart' || raw === 'table' ? raw : 'both';
}

export function parseEventChartType(raw: unknown): EventChartType {
  return EVENT_CHARTS.includes(raw as EventChartType) ? (raw as EventChartType) : 'line';
}

export function parseDurationPlain(raw: unknown): boolean {
  return raw === true;
}

export function eventLayoutFromDsl(dsl: unknown): EventResultLayout {
  return parseEventResultLayout(viewFromUnknown(dsl).event_layout);
}

export function eventChartFromDsl(dsl: unknown, cardChartType?: unknown): EventChartType {
  const fromView = viewFromUnknown(dsl).event_chart;
  if (EVENT_CHARTS.includes(fromView as EventChartType)) return fromView as EventChartType;
  return parseEventChartType(cardChartType);
}

export function durationPlainFromDsl(dsl: unknown): boolean {
  return parseDurationPlain(viewFromUnknown(dsl).duration_plain);
}

export function eventStatCalcsFromDsl(dsl: unknown, chart: EventChartType): StatCalc[] {
  return parseStatCalcs(viewFromUnknown(dsl).stat_calcs, chart);
}

export function eventYUnitFromDsl(dsl: unknown): MetricUnit {
  return parseMetricUnit(viewFromUnknown(dsl).y_unit, 'number');
}

export function eventViewPayload(state: EventViewState): Record<string, unknown> {
  return {
    event_layout: state.layout,
    event_chart: state.chart,
    duration_plain: state.durationPlain,
    stat_calcs: state.statCalcs.length ? state.statCalcs : defaultStatCalcs(state.chart),
    y_unit: state.yUnit,
  };
}

export function eventCardChartType(layout: EventResultLayout, chart: EventChartType): EventChartType | 'table' {
  return layout === 'table' ? 'table' : chart;
}
