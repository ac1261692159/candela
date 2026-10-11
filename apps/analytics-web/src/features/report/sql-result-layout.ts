import type { ResultView } from '../visualization/chart.types';

export type SqlResultLayout = 'both' | 'chart' | 'table' | 'pivot';

export function sqlLayoutFromPreferredView(view: ResultView | undefined): SqlResultLayout {
  if (view === 'chart') return 'both';
  if (view === 'pivot') return 'pivot';
  return 'table';
}

export function preferredViewFromSqlLayout(layout: SqlResultLayout): ResultView {
  if (layout === 'table') return 'table';
  if (layout === 'pivot') return 'pivot';
  return 'chart';
}

export function sqlLayoutShowsChart(layout: SqlResultLayout): boolean {
  return layout === 'both' || layout === 'chart';
}

export function sqlLayoutShowsTable(layout: SqlResultLayout): boolean {
  return layout === 'both' || layout === 'table';
}
