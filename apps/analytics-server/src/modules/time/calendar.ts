/**
 * 时区日历纯函数（phase: clklog-analytics-timezone-v1）。
 *
 * 自 `query/time-range.ts` 整组迁入并时区参数化；与 analytics-web
 * `src/features/time-range/resolve.ts` 口径对齐；禁止抽 common 包。
 *
 * 纪律（AL-01 教训）：
 * - 「今天」「日历日」一律显式 IANA 时区，禁止读进程本地时区分量；
 * - 日历日 ↔ epoch 的换算只准走本文件的 epochOfDayStart（Intl 偏移迭代）。
 */
import type { TimeRange, TimeRangeRelative, TimeRangeRelativeKind } from '../../types/dsl.types';

/** 平台时区缺省值；实例口径以配置 `analytics.timezone` 为准（TimezoneService）。 */
export const DEFAULT_PLATFORM_TZ = 'Asia/Shanghai';
export const TIME_RANGE_OFFSET_MAX = 366;
export const TIME_RANGE_RELATIVE_KINDS: TimeRangeRelativeKind[] = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'past_n',
  'recent_n',
  'from_date_to_yesterday',
  'from_date_to_today',
  'custom_offsets',
];

/** IANA 名形态（拒绝 Factory/Local/空段），再经 Intl 试构兜底 */
const TZ_NAME_PATTERN = /^[A-Za-z_]+\/[A-Za-z0-9_+\-\/]+$/;

export function isValidTimeZoneName(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  if (tz !== 'UTC' && tz !== 'GMT' && !TZ_NAME_PATTERN.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseYmd(value: string): [number, number, number] {
  const match = YMD.exec(value);
  if (!match) throw new Error('时间范围日期格式不合法');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error('时间范围日期格式不合法');
  }
  return [year, month, day];
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function utcYmd(year: number, monthIndex: number, day: number): string {
  const utc = new Date(Date.UTC(year, monthIndex, day));
  return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}`;
}

/* --------------------------- tz 墙钟换算（Intl） --------------------------- */

const WALL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = WALL_FORMATTERS.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    WALL_FORMATTERS.set(tz, fmt);
  }
  return fmt;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** epoch 毫秒时刻在 tz 下的墙钟分量 */
export function wallClockInTz(tz: string, epochMs: number): WallClock {
  const parts = wallFormatter(tz).formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  // h23 在某些 ICU 版本下 0 点渲染为 24；归一化到 0-23
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/** tz 墙钟当作 UTC 的差值（毫秒，正 = 墙钟领先 UTC） */
function wallOffsetMs(tz: string, epochMs: number): number {
  const w = wallClockInTz(tz, epochMs);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(epochMs / 1000) * 1000;
}

/** tz 日历某日 00:00:00.000 的 epoch 毫秒（DST 附近迭代收口） */
export function epochOfDayStart(tz: string, ymd: string): number {
  const [year, month, day] = parseYmd(ymd);
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - wallOffsetMs(tz, guess);
  return guess - wallOffsetMs(tz, first);
}

/** tz 墙钟字面分量 → epoch 毫秒（ClickHouse 无时区时间串的显式解析口径） */
export function epochOfWallClock(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = guess - wallOffsetMs(tz, guess);
  return guess - wallOffsetMs(tz, first);
}

const CH_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

/**
 * 解析 ClickHouse 无时区时间串（'YYYY-MM-DD HH:mm:ss[.fffff]'）为 epoch 毫秒。
 * CH 服务端时区 = 平台时区是既定部署事实；解析侧必须显式带上它（ZQ-4：
 * 同一列曾经一边是本地解释、一边是 +Z UTC 解释）。非法输入返回 null。
 */
export function parseChDateTimeInTz(text: string, tz: string): number | null {
  const match = CH_DATETIME.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac] = match;
  const ms = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  return epochOfWallClock(tz, Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s)) + ms;
}

/** tz 日历次日 00:00（右开区间上界） */
export function epochOfDayEndExclusive(tz: string, ymd: string): number {
  return epochOfDayStart(tz, addCalendarDays(ymd, 1));
}

export function ymdInTz(tz: string, epochMs: number | Date): string {
  const ms = typeof epochMs === 'number' ? epochMs : epochMs.getTime();
  const w = wallClockInTz(tz, ms);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

/** tz 日历的今天（YYYY-MM-DD） */
export function todayInTz(tz: string, now: Date = new Date()): string {
  return ymdInTz(tz, now.getTime());
}

/* ------------------------------ 日历日运算 ------------------------------ */

export function addCalendarDays(ymd: string, delta: number): string {
  const [year, month, day] = parseYmd(ymd);
  return utcYmd(year, month - 1, day + delta);
}

export function calendarDaysInclusive(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.floor((b - a) / 86_400_000) + 1;
}

export function mondayOnOrBefore(ymd: string): string {
  const [year, month, day] = parseYmd(ymd);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  return addCalendarDays(ymd, -daysFromMonday);
}

export function monthStart(ymd: string): string {
  const [year, month] = parseYmd(ymd);
  return utcYmd(year, month - 1, 1);
}

/* --------------------------- 时间范围解析 --------------------------- */

export function defaultPastNDays(n = 7, todayYmd: string): TimeRange {
  return materializeTimeRange({ start: '', end: '', relative: { kind: 'past_n', n } }, todayYmd);
}

export function materializeTimeRange(range: TimeRange, todayYmd: string): TimeRange {
  const { start, end } = resolveTimeRange(range, todayYmd);
  const next: TimeRange = { ...range, start, end };
  return next;
}

export function resolveTimeRange(range: TimeRange, todayYmd: string): { start: string; end: string } {
  if (range.relative) {
    return resolveRelative(range.relative, todayYmd);
  }
  if (!range.start || !range.end) {
    throw new Error('time_range.start/end 必填');
  }
  parseYmd(range.start);
  parseYmd(range.end);
  if (range.start > range.end) {
    throw new Error('时间范围结束早于开始');
  }
  return { start: range.start, end: range.end };
}

function resolveRelative(relative: TimeRangeRelative, today: string): { start: string; end: string } {
  const kind = relative.kind;
  if (!TIME_RANGE_RELATIVE_KINDS.includes(kind)) {
    throw new Error('time_range.relative.kind 不合法');
  }
  let start: string;
  let end: string;
  switch (kind) {
    case 'today':
      start = today;
      end = today;
      break;
    case 'yesterday':
      start = end = addCalendarDays(today, -1);
      break;
    case 'past_n': {
      const n = requireN(relative.n);
      start = addCalendarDays(today, -n);
      end = addCalendarDays(today, -1);
      break;
    }
    case 'recent_n': {
      const n = requireN(relative.n);
      start = addCalendarDays(today, -(n - 1));
      end = today;
      break;
    }
    case 'this_week':
      start = mondayOnOrBefore(today);
      end = today;
      break;
    case 'last_week': {
      const thisMonday = mondayOnOrBefore(today);
      start = addCalendarDays(thisMonday, -7);
      end = addCalendarDays(thisMonday, -1);
      break;
    }
    case 'this_month':
      start = monthStart(today);
      end = today;
      break;
    case 'last_month': {
      const [year, month] = parseYmd(today);
      const prevMonthIndex = month - 2;
      start = utcYmd(year, prevMonthIndex, 1);
      end = utcYmd(year, prevMonthIndex + 1, 0);
      break;
    }
    case 'from_date_to_yesterday':
      start = requireAnchor(relative.anchor_start);
      end = addCalendarDays(today, -1);
      break;
    case 'from_date_to_today':
      start = requireAnchor(relative.anchor_start);
      end = today;
      break;
    case 'custom_offsets': {
      const from = requireOffset(relative.from_offset, 'from_offset');
      const to = requireOffset(relative.to_offset, 'to_offset');
      if (from < to) {
        throw new Error('动态时间起始不能晚于结束');
      }
      start = addCalendarDays(today, -from);
      end = addCalendarDays(today, -to);
      break;
    }
  }
  if (start > end) {
    throw new Error('时间范围结束早于开始');
  }
  return { start, end };
}

function requireN(n: number | undefined): number {
  if (!Number.isInteger(n) || !n || n < 1 || n > TIME_RANGE_OFFSET_MAX) {
    throw new Error(`过去/最近天数必须是 1~${TIME_RANGE_OFFSET_MAX} 的整数`);
  }
  return n;
}

function requireOffset(value: number | undefined, field: string): number {
  if (!Number.isInteger(value) || value === undefined || value < 0 || value > TIME_RANGE_OFFSET_MAX) {
    throw new Error(`${field} 必须是 0~${TIME_RANGE_OFFSET_MAX} 的整数`);
  }
  return value;
}

function requireAnchor(value: string | undefined): string {
  if (!value) throw new Error('自某日需要选择开始日期');
  parseYmd(value);
  return value;
}
