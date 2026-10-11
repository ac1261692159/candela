import { type TFunction } from '../../i18n';
import { parseEventChartType, type EventChartType } from '../query/event-view';

export interface CardDisplay {
  view: string;
}

export type RetentionDisplayView = 'nth_trend' | 'people_table' | 'rate_table';

const SQL_VIEWS = ['line', 'trend', 'bar', 'pie', 'number', 'table'] as const;

/** 各卡片类型可选的展示视图（按顺序） */
const DISPLAY_VIEWS: Record<string, readonly string[]> = {
  retention: ['nth_trend', 'people_table', 'rate_table'],
  event: ['line', 'trend', 'bar', 'stack', 'cumulative', 'distribution', 'pie', 'number', 'table'],
  funnel: ['chart', 'table'],
  sql: ['line', 'trend', 'bar', 'pie', 'number', 'table'],
};

const VIEW_LABEL_KEY: Record<string, string> = {
  nth_trend: 'report:cardView.nthTrend',
  people_table: 'report:cardView.peopleTable',
  rate_table: 'report:cardView.rateTable',
  line: 'report:cardView.line',
  trend: 'report:cardView.trend',
  bar: 'report:cardView.bar',
  stack: 'report:cardView.stack',
  cumulative: 'report:cardView.cumulative',
  distribution: 'report:cardView.distribution',
  pie: 'report:cardView.pie',
  number: 'report:cardView.number',
  table: 'report:cardView.table',
  chart: 'report:cardView.funnelChart',
};

export function displayViews(type: string): string[] {
  return [...(DISPLAY_VIEWS[type] ?? [])];
}

export function displayOptions(type: string, t: TFunction): { value: string; label: string }[] {
  return displayViews(type).map((value) => ({ value, label: t(VIEW_LABEL_KEY[value]) }));
}

export function fallbackDisplayView(type: string, chartType: string): string {
  if (type === 'retention') {
    if (chartType === 'table' || chartType === 'people_table') return 'people_table';
    if (chartType === 'rate_table') return 'rate_table';
    return 'nth_trend';
  }
  if (type === 'funnel') return chartType === 'table' ? 'table' : 'chart';
  if (type === 'event') {
    if (chartType === 'table') return 'table';
    return parseEventChartType(chartType);
  }
  if (type === 'sql') {
    return (SQL_VIEWS as readonly string[]).includes(chartType) ? chartType : 'table';
  }
  return 'table';
}

export function resolveDisplayView(card: {
  type: string;
  chart_type: string;
  display?: CardDisplay | null;
}): string | null {
  const allowed = new Set(displayViews(card.type));
  if (card.display?.view && allowed.has(card.display.view)) return card.display.view;
  if (card.type === 'sql') return null;
  return fallbackDisplayView(card.type, card.chart_type);
}

export function settingsDisplayView(card: {
  type: string;
  chart_type: string;
  display?: CardDisplay | null;
}): string {
  return resolveDisplayView(card) ?? fallbackDisplayView(card.type, card.chart_type);
}

export function isEventChartView(view: string): view is EventChartType {
  return view !== 'table' && parseEventChartType(view) === view;
}
