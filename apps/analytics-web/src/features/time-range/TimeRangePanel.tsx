import { Button, Calendar, DatePicker, InputNumber } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import type { TimeRange } from '../../types/dsl.types';
import { useT } from '../../i18n';
import {
  timeRangePanelTitle,
  timeRangePresets,
  matchTimeRangePreset,
  toDynamicOffsets,
  type TimeRangePresetId,
} from './presets';
import {
  TIME_RANGE_OFFSET_MAX,
  calendarDaysInclusive,
  materializeTimeRange,
  offsetFromToday,
  resolveDisplayTimeZone,
} from './resolve';
import { TimeZoneSelect, gmtOffsetLabel } from './TimeZoneSelect';
import './time-range-panel.css';


interface TimeRangePanelProps {
  draft: TimeRange;
  todayYmd: string;
  maxDays?: number;
  onDraftChange: (next: TimeRange) => void;
  onCancel: () => void;
  onApply: () => void;
}

export function TimeRangePanel({
  draft,
  todayYmd,
  maxDays,
  onDraftChange,
  onCancel,
  onApply,
}: TimeRangePanelProps) {
  const { t } = useT('analysis');
  const presets = timeRangePresets(t);
  const live = materializeTimeRange(draft, todayYmd);
  const presetId = matchTimeRangePreset(draft);
  const dynamic = Boolean(draft.relative);
  const fromOffset = offsetFromToday(live.start, todayYmd);
  const toOffset = offsetFromToday(live.end, todayYmd);
  const span = calendarDaysInclusive(live.start, live.end);
  const spanError = maxDays && span > maxDays ? t('analysis:timeRange.maxSpan', { days: maxDays }) : undefined;
  const showAnchor =
    draft.relative?.kind === 'from_date_to_yesterday' || draft.relative?.kind === 'from_date_to_today';

  const applyPreset = (id: TimeRangePresetId) => {
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    onDraftChange(preset.build(todayYmd, live));
  };

  const setTimeZone = (nextTz?: string) => {
    const next = { ...draft };
    if (nextTz) next.timezone = nextTz;
    else delete next.timezone;
    onDraftChange(next);
  };

  const setDynamic = (next: boolean) => {
    if (next) {
      onDraftChange(materializeTimeRange({ start: '', end: '', relative: toDynamicOffsets(live, todayYmd) }, todayYmd));
      return;
    }
    onDraftChange({ start: live.start, end: live.end });
  };

  const setOffsets = (from: number, to: number) => {
    const fromClamped = clampOffset(from);
    const toClamped = clampOffset(to);
    if (fromClamped < toClamped) return;
    onDraftChange(
      materializeTimeRange(
        { start: '', end: '', relative: { kind: 'custom_offsets', from_offset: fromClamped, to_offset: toClamped } },
        todayYmd,
      ),
    );
  };

  const setAnchor = (anchor: string) => {
    const kind = draft.relative?.kind === 'from_date_to_today' ? 'from_date_to_today' : 'from_date_to_yesterday';
    onDraftChange(materializeTimeRange({ start: '', end: '', relative: { kind, anchor_start: anchor } }, todayYmd));
  };

  const setBound = (which: 'start' | 'end', ymd: string) => {
    if (dynamic) {
      const start = which === 'start' ? ymd : live.start;
      const end = which === 'end' ? ymd : live.end;
      const from = offsetFromToday(start, todayYmd);
      const to = offsetFromToday(end, todayYmd);
      if (from < to) return;
      setOffsets(from, to);
      return;
    }
    const start = which === 'start' ? ymd : live.start;
    const end = which === 'end' ? ymd : live.end;
    onDraftChange({ start: start <= end ? start : end, end: start <= end ? end : start });
  };

  return (
    <div className="time-range-panel">
      <div className="time-range-panel__presets">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`time-range-panel__preset${presetId === preset.id ? ' is-active' : ''}${
              preset.id === 'custom' ? ' time-range-panel__preset--wide' : ''
            }`}
            onClick={() => applyPreset(preset.id)}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="time-range-panel__main">
        <div className="time-range-panel__header">
          {t('analysis:timeRange.dateRange')}
          <div>
            <strong>{timeRangePanelTitle(draft, todayYmd, t)}</strong>
          </div>
        </div>
        <div className="time-range-panel__tabs">
          <button type="button" className={`time-range-panel__tab${dynamic ? ' is-active' : ''}`} onClick={() => setDynamic(true)}>
            {t('analysis:timeRange.dynamic')}
          </button>
          <button type="button" className={`time-range-panel__tab${!dynamic ? ' is-active' : ''}`} onClick={() => setDynamic(false)}>
            {t('analysis:timeRange.static')}
          </button>
        </div>
        {dynamic && showAnchor ? (
          <div className="time-range-panel__offsets">
            {t('analysis:timeRange.from')}
            <DatePicker
              value={dayjs(draft.relative?.anchor_start ?? live.start)}
              allowClear={false}
              onChange={(value) => {
                if (value) setAnchor(value.format('YYYY-MM-DD'));
              }}
            />
            {draft.relative?.kind === 'from_date_to_today' ? t('analysis:timeRange.untilToday') : t('analysis:timeRange.untilYesterday')}
          </div>
        ) : null}
        {dynamic && !showAnchor ? (
          <div className="time-range-panel__offsets">
            <InputNumber
              min={0}
              max={TIME_RANGE_OFFSET_MAX}
              value={fromOffset}
              onChange={(value) => {
                if (typeof value === 'number') setOffsets(value, toOffset);
              }}
            />
            {t('analysis:timeRange.daysAgo')}
            <span>→</span>
            <InputNumber
              min={0}
              max={TIME_RANGE_OFFSET_MAX}
              value={toOffset}
              onChange={(value) => {
                if (typeof value === 'number') setOffsets(fromOffset, value);
              }}
            />
            {t('analysis:timeRange.daysAgo')}
          </div>
        ) : null}
        <div className="time-range-panel__calendars">
          <div className="time-range-panel__calendar">
            <Calendar
              fullscreen={false}
              value={dayjs(live.start)}
              disabledDate={(date) => date.isAfter(dayjs(todayYmd), 'day')}
              onSelect={(date: Dayjs) => setBound('start', date.format('YYYY-MM-DD'))}
            />
          </div>
          <div className="time-range-panel__calendar">
            <Calendar
              fullscreen={false}
              value={dayjs(live.end)}
              disabledDate={(date) => date.isAfter(dayjs(todayYmd), 'day')}
              onSelect={(date: Dayjs) => setBound('end', date.format('YYYY-MM-DD'))}
            />
          </div>
        </div>
        <div className="time-range-panel__footer">
          <span className="time-range-panel__timezone">
            {t('analysis:timeRange.timezone')}
            <TimeZoneSelect value={draft.timezone} onChange={setTimeZone} />
            {draft.timezone ? <span className="time-range-panel__timezone-offset">{gmtOffsetLabel(resolveDisplayTimeZone(draft.timezone))}</span> : null}
          </span>
          {spanError ? <span className="time-range-panel__error">{spanError}</span> : null}
          <Button onClick={onCancel} aria-label={t('common:action.cancel')}>{t('common:action.cancel')}</Button>
          <Button type="primary" onClick={onApply} disabled={Boolean(spanError)} aria-label={t('common:action.apply')}>
            {t('common:action.apply')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function clampOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(TIME_RANGE_OFFSET_MAX, Math.max(0, Math.round(value)));
}
