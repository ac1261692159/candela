/**
 * `features/event-chart` — 事件分析的图表字段绑定。
 *
 * phase: clklog-analytics-event-chart-binding-v1
 *
 * 依赖方向单向：本包依赖 `features/visualization`（共享的 `ChartConfigV1` 契约与字段面板）
 * 与 `features/explore-charts`（图表模型与渲染），反向不允许。
 */
export {
  autoEventChartConfig,
  axisCandidateColumns,
  axisOf,
  bindingColumns,
  chartConfigFromProposal,
  boundMetrics,
  columnRole,
  defaultUnitForColumn,
  metricColumnsOf,
  readEventChartConfig,
  unboundAxisColumns,
  type BindingColumn,
  type EventChartConfigRead,
} from './event-chart-config';

export { useEventChartConfig, type EventChartConfigState } from './use-event-chart-config';

export { buildEventChartModel, type EventChartModel } from './event-binding';

export {
  suggestAxisSplit,
  type AxisSplitCandidate,
  type AxisSplitSuggestion,
} from './axis-suggest';
