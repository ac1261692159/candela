import { TimeRangeControl } from '../time-range/TimeRangeControl';
import type { TimeRange } from '../../types/dsl.types';

/** 结果区上方时间条：动态/静态范围与自定义 SQL 共用同一选择器。 */
export function AnalysisToolbar({
  timeRange,
  onTimeRangeChange,
}: {
  timeRange: TimeRange;
  onTimeRangeChange: (timeRange: TimeRange) => void;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <TimeRangeControl value={timeRange} onChange={onTimeRangeChange} size="small" />
    </div>
  );
}
