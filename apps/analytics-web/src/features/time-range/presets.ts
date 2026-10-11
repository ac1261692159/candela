import type { TimeRange, TimeRangeRelative } from '../../types/dsl.types';
import { t as i18nT, type TFunction } from '../../i18n';
import { defaultPastNDays, materializeTimeRange, offsetFromToday, slashYmd } from './resolve';

export type TimeRangePresetId =
  | 'yesterday'
  | 'today'
  | 'last_week'
  | 'this_week'
  | 'last_month'
  | 'this_month'
  | 'past_7'
  | 'recent_7'
  | 'past_30'
  | 'recent_30'
  | 'from_yesterday'
  | 'from_today'
  | 'custom';

export interface TimeRangePreset {
  id: TimeRangePresetId;
  label: string;
  build: (todayYmd: string, current?: TimeRange) => TimeRange;
}

/** 带参预置的标签键（其余见 PRESET_LABEL_KEYS） */
const PRESET_N_KEYS: Partial<Record<TimeRangePresetId, { key: string; n: number }>> = {
  past_7: { key: 'analysis:timeRange.pastNDays', n: 7 },
  past_30: { key: 'analysis:timeRange.pastNDays', n: 30 },
  recent_7: { key: 'analysis:timeRange.recentNDays', n: 7 },
  recent_30: { key: 'analysis:timeRange.recentNDays', n: 30 },
};

const PRESET_LABEL_KEYS: Record<TimeRangePresetId, string> = {
  yesterday: 'analysis:timeRange.yesterday',
  today: 'analysis:timeRange.today',
  last_week: 'analysis:timeRange.lastWeek',
  this_week: 'common:time.thisWeek',
  last_month: 'analysis:timeRange.lastMonth',
  this_month: 'common:time.thisMonth',
  past_7: 'analysis:timeRange.pastNDays',
  recent_7: 'analysis:timeRange.recentNDays',
  past_30: 'analysis:timeRange.pastNDays',
  recent_30: 'analysis:timeRange.recentNDays',
  from_yesterday: 'analysis:timeRange.fromYesterday',
  from_today: 'analysis:timeRange.fromToday',
  custom: 'analysis:timeRange.custom',
};

export function timeRangePresetLabel(id: TimeRangePresetId, t: TFunction = i18nT): string {
  const withN = PRESET_N_KEYS[id];
  if (withN) return t(withN.key, { n: withN.n });
  return t(PRESET_LABEL_KEYS[id]);
}

const PRESET_BUILDERS: { id: TimeRangePresetId; build: TimeRangePreset['build'] }[] = [
  { id: 'yesterday', build: (today) => materializeTimeRange({ start: '', end: '', relative: { kind: 'yesterday' } }, today) },
  { id: 'today', build: (today) => materializeTimeRange({ start: '', end: '', relative: { kind: 'today' } }, today) },
  { id: 'last_week', build: (today) => materializeTimeRange({ start: '', end: '', relative: { kind: 'last_week' } }, today) },
  { id: 'this_week', build: (today) => materializeTimeRange({ start: '', end: '', relative: { kind: 'this_week' } }, today) },
  { id: 'last_month', build: (today) => materializeTimeRange({ start: '', end: '', relative: { kind: 'last_month' } }, today) },
  { id: 'this_month', build: (today) => materializeTimeRange({ start: '', end: '', relative: { kind: 'this_month' } }, today) },
  { id: 'past_7', build: (today) => defaultPastNDays(7, today) },
  { id: 'recent_7', build: (today) => materializeTimeRange({ start: '', end: '', relative: { kind: 'recent_n', n: 7 } }, today) },
  { id: 'past_30', build: (today) => defaultPastNDays(30, today) },
  { id: 'recent_30', build: (today) => materializeTimeRange({ start: '', end: '', relative: { kind: 'recent_n', n: 30 } }, today) },
  {
    id: 'from_yesterday',
    build: (today, current) => {
      const anchor = current?.start || defaultPastNDays(7, today).start;
      return materializeTimeRange(
        { start: '', end: '', relative: { kind: 'from_date_to_yesterday', anchor_start: anchor } },
        today,
      );
    },
  },
  {
    id: 'from_today',
    build: (today, current) => {
      const anchor = current?.start || defaultPastNDays(7, today).start;
      return materializeTimeRange(
        { start: '', end: '', relative: { kind: 'from_date_to_today', anchor_start: anchor } },
        today,
      );
    },
  },
  {
    id: 'custom',
    build: (today, current) => {
      const snap = current ? materializeTimeRange(current, today) : defaultPastNDays(7, today);
      return { start: snap.start, end: snap.end };
    },
  },
];

/** 预置列表：标签按当前语言解析（`t` 缺省用当前语言） */
export function timeRangePresets(t: TFunction = i18nT): TimeRangePreset[] {
  return PRESET_BUILDERS.map((preset) => ({ ...preset, label: timeRangePresetLabel(preset.id, t) }));
}

export function matchTimeRangePreset(range: TimeRange): TimeRangePresetId | undefined {
  const rel = range.relative;
  if (!rel) return range.start && range.end ? 'custom' : undefined;
  switch (rel.kind) {
    case 'yesterday':
      return 'yesterday';
    case 'today':
      return 'today';
    case 'last_week':
      return 'last_week';
    case 'this_week':
      return 'this_week';
    case 'last_month':
      return 'last_month';
    case 'this_month':
      return 'this_month';
    case 'past_n':
      if (rel.n === 7) return 'past_7';
      if (rel.n === 30) return 'past_30';
      return undefined;
    case 'recent_n':
      if (rel.n === 7) return 'recent_7';
      if (rel.n === 30) return 'recent_30';
      return undefined;
    case 'from_date_to_yesterday':
      return 'from_yesterday';
    case 'from_date_to_today':
      return 'from_today';
    case 'custom_offsets':
      if (rel.from_offset === 7 && rel.to_offset === 1) return 'past_7';
      if (rel.from_offset === 30 && rel.to_offset === 1) return 'past_30';
      if (rel.from_offset === 6 && rel.to_offset === 0) return 'recent_7';
      if (rel.from_offset === 29 && rel.to_offset === 0) return 'recent_30';
      if (rel.from_offset === 0 && rel.to_offset === 0) return 'today';
      if (rel.from_offset === 1 && rel.to_offset === 1) return 'yesterday';
      return undefined;
    default:
      return undefined;
  }
}

export function timeRangeTriggerLabel(range: TimeRange, t: TFunction = i18nT): string {
  const preset = matchTimeRangePreset(range);
  if (preset && preset !== 'custom') {
    return timeRangePresetLabel(preset, t);
  }
  if (range.relative) {
    if (range.relative.kind === 'past_n') return t('analysis:timeRange.pastNDays', { n: range.relative.n });
    if (range.relative.kind === 'recent_n') return t('analysis:timeRange.recentNDays', { n: range.relative.n });
    return t('analysis:timeRange.dynamic');
  }
  if (range.start && range.end) return `${slashYmd(range.start)} → ${slashYmd(range.end)}`;
  return t('analysis:timeRange.select');
}

export function timeRangePanelTitle(range: TimeRange, todayYmd: string, t: TFunction = i18nT): string {
  const live = materializeTimeRange(range, todayYmd);
  const name = timeRangeTriggerLabel(range, t);
  return t('analysis:timeRange.panelTitle', { name, start: slashYmd(live.start), end: slashYmd(live.end) });
}

export function toDynamicOffsets(range: TimeRange, todayYmd: string): TimeRangeRelative {
  const live = materializeTimeRange(range, todayYmd);
  return {
    kind: 'custom_offsets',
    from_offset: offsetFromToday(live.start, todayYmd),
    to_offset: offsetFromToday(live.end, todayYmd),
  };
}
