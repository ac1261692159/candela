import { ExploreChart } from '../features/explore-charts/ExploreChart';
import { modelFromEventResult } from '../features/explore-charts/explore-chart-option';
import { defaultStatCalcs } from '../features/explore-charts/series-stats';
import { parseEventChartType, type EventChartType } from '../features/query/event-view';
import type { QueryColumn } from '../types/dsl.types';

interface ChartRendererProps {
  chartType: EventChartType | 'line' | 'bar' | 'number';
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  height?: number;
  durationPlain?: boolean;
}

/** 兼容入口：事件看板与旧调用仍可走这里，实际渲染 ExploreChart。 */
export function ChartRenderer({ chartType, columns, rows, height = 360 }: ChartRendererProps) {
  const kind = parseEventChartType(chartType);
  return (
    <ExploreChart
      kind={kind}
      model={modelFromEventResult(columns, rows)}
      statCalcs={defaultStatCalcs(kind)}
      height={height}
    />
  );
}
