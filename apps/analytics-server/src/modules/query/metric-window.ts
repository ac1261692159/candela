/**
 * 指标查询时间（phase: clklog-analytics-metric-v2）。
 *
 * 指标自带时间范围后，告警规则不必再为每条规则重配窗口；但指标只允许**相对**范围——
 * 指标要能每天循环求值，写死日期会让指标「过期」。跨度上限 90 天（与自定义 SQL 页同口径，
 * 红线 4 要求分析查询有界）。
 *
 * 解析一律复用 `time-range.ts`（上海时区），不另写一套日历逻辑。
 */
import type { TimeRange, TimeRangeRelative, TimeRangeRelativeKind } from '../../types/dsl.types';
import {
  calendarDaysInclusive,
  DEFAULT_PLATFORM_TZ,
  materializeTimeRange,
  TIME_RANGE_RELATIVE_KINDS,
  todayInTz,
} from '../time/calendar';

export const METRIC_TIME_RANGE_MAX_DAYS = 90;
/** 指标没设查询时间时的兜底（与告警默认窗口一致） */
export const DEFAULT_METRIC_WINDOW_DAYS = 7;

export interface MetricWindow {
  /** 交给查询引擎的时间范围（含 relative，便于模板与界面展示） */
  range: TimeRange;
  start: string;
  end: string;
  /** 窗口天数（含首尾） */
  days: number;
  label: string;
  /** metric=指标自带；rule=跟随告警规则窗口；default=都没有时的默认天数 */
  source: 'metric' | 'rule' | 'default';
}

const KIND_LABEL: Partial<Record<TimeRangeRelativeKind, string>> = {
  today: '今天',
  yesterday: '昨天',
  this_week: '本周',
  last_week: '上周',
  this_month: '本月',
  last_month: '上月',
  from_date_to_today: '从指定日到今天',
  from_date_to_yesterday: '从指定日到昨天',
};

/**
 * 相对范围文案。`recent_n` / `past_n` 的差别容易踩：前者**含今天**、后者不含，
 * 因此文案必须把「含/不含今天」写出来（告警规则的 N 天窗口等价于 recent_n）。
 */
export function relativeRangeLabel(relative: TimeRangeRelative): string {
  if (relative.kind === 'recent_n') return `近 ${relative.n} 天（含今天）`;
  if (relative.kind === 'past_n') return `过去 ${relative.n} 天（不含今天）`;
  if (relative.kind === 'custom_offsets') return `动态区间 D-${relative.from_offset} ~ D-${relative.to_offset}`;
  return KIND_LABEL[relative.kind] ?? String(relative.kind);
}

/**
 * 保存指标时的校验：返回错误文案，合法返回 null（`null`/`undefined` 视为未设置）。
 * `maxDays` 可放宽（留存队列范围允许到 180 天，见 validateRetentionWindow）。
 */
export function validateMetricTimeRange(raw: unknown, options: { maxDays?: number; tz?: string; now?: Date } = {}): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return '查询时间格式不合法';
  const range = raw as TimeRange;
  if (!range.relative) {
    return '指标查询时间必须是相对范围（今天 / 近 N 天 / 本周…），不能用固定日期';
  }
  if (!TIME_RANGE_RELATIVE_KINDS.includes(range.relative.kind)) {
    return '查询时间的相对类型不合法';
  }
  try {
    const live = materializeTimeRange(range, todayInTz(options.tz ?? DEFAULT_PLATFORM_TZ, options.now));
    const days = calendarDaysInclusive(live.start, live.end);
    if (!Number.isFinite(days) || days < 1) return '查询时间跨度不合法';
    const maxDays = options.maxDays ?? METRIC_TIME_RANGE_MAX_DAYS;
    if (days > maxDays) {
      return `查询时间跨度不能超过 ${maxDays} 天（当前 ${days} 天）`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : '查询时间不合法';
  }
  return null;
}

/** 已保存定义里的查询时间（不合法或未设置 → null） */
export function metricTimeRange(raw: unknown): TimeRange | null {
  if (!raw || validateMetricTimeRange(raw) !== null) return null;
  return raw as TimeRange;
}

/**
 * 指标求值窗口：指标自带 > 跟随规则窗口（fallbackDays）> 默认天数。
 * 三条路径都落到「含今天的 N 天」，与告警既有口径一致。
 */
export function resolveMetricWindow(
  raw: unknown,
  options: { fallbackDays?: number; now?: Date; tz?: string } = {},
): MetricWindow {
  const today = todayInTz(options.tz ?? DEFAULT_PLATFORM_TZ, options.now);
  const own = metricTimeRange(raw);
  if (own?.relative) {
    const live = materializeTimeRange(own, today);
    return {
      // 同时给出具体日期与相对形式：调用方/查询缓存拿到的是可核对的具体区间
      range: { start: live.start, end: live.end, relative: own.relative },
      start: live.start,
      end: live.end,
      days: calendarDaysInclusive(live.start, live.end),
      label: relativeRangeLabel(own.relative),
      source: 'metric',
    };
  }
  const fallback = Number.isInteger(options.fallbackDays) && (options.fallbackDays as number) > 0
    ? (options.fallbackDays as number)
    : undefined;
  const days = fallback ?? DEFAULT_METRIC_WINDOW_DAYS;
  const relative = { kind: 'recent_n' as const, n: days };
  const live = materializeTimeRange({ start: '', end: '', relative }, today);
  return {
    range: { start: live.start, end: live.end, relative },
    start: live.start,
    end: live.end,
    days,
    label: days <= 1 ? '今天' : `近 ${days} 天`,
    source: fallback ? 'rule' : 'default',
  };
}

/** 留存指标队列范围上限：留存的成熟期与分母都靠队列，范围过大既慢又没意义（红线 4 有界查询） */
export const RETENTION_WINDOW_MAX_DAYS = 180;

/**
 * 留存指标的**队列范围**：设置后用指标的相对时间范围，未设置沿用「按周期推导」。
 * 下限 n+1 天——队列要至少跨过 n 天才能看到第 n 日留存，否则分母不成熟。
 */
export function validateRetentionWindow(raw: unknown, n: number): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  // 队列范围放宽到 180 天：留存的成熟期需要跨过周期，90 天的通用上限在这里太紧
  const error = validateMetricTimeRange(raw, { maxDays: RETENTION_WINDOW_MAX_DAYS });
  if (error) return error;
  const days = metricWindowDays(raw);
  if (days === null) return '队列范围不合法';
  if (days < n + 1) return `队列范围至少 ${n + 1} 天（留住第 ${n} 日需要跨过 ${n} 天）`;
  if (days > RETENTION_WINDOW_MAX_DAYS) return `队列范围不能超过 ${RETENTION_WINDOW_MAX_DAYS} 天（当前 ${days} 天）`;
  return null;
}

/**
 * 相对范围 → 天数（不合法返回 null）。
 * 注意不能走 `metricTimeRange()`：它按指标默认上限（90 天）校验，会把留存放宽后的范围判成非法
 * （线上实测：留存队列 120 天报「队列范围不合法」）。
 */
function metricWindowDays(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const range = raw as TimeRange;
  if (!range.relative) return null;
  try {
    const live = materializeTimeRange(range, todayInTz(DEFAULT_PLATFORM_TZ));
    const days = calendarDaysInclusive(live.start, live.end);
    return Number.isFinite(days) && days > 0 ? days : null;
  } catch {
    return null;
  }
}

/** 窗口内每一天（含首尾）的日期列表，用于补齐无数据的日子 */
export function windowDates(window: Pick<MetricWindow, 'start' | 'end'>): string[] {
  const days = calendarDaysInclusive(window.start, window.end);
  if (!Number.isFinite(days) || days < 1 || days > METRIC_TIME_RANGE_MAX_DAYS) return [];
  const dates: string[] = [];
  for (let i = 0; i < days; i += 1) {
    dates.push(new Date(Date.parse(`${window.start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}
