import { defaultPastNDays } from '../features/time-range/resolve';
import { TimeRangeControl } from '../features/time-range/TimeRangeControl';
import type { TimeRange } from '../types/dsl.types';

interface TimeRangePickerProps {
  value?: TimeRange;
  onChange?: (value: TimeRange) => void;
}

/** 兼容旧调用方；新页面请用 TimeRangeControl。 */
export function TimeRangePicker({ value, onChange }: TimeRangePickerProps) {
  return (
    <TimeRangeControl
      value={value ?? defaultPastNDays()}
      onChange={(next) => onChange?.(next)}
      size="middle"
    />
  );
}
