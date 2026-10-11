/**
 * 分析时间范围解析（展示时区口径，phase: clklog-analytics-timezone-v1）。
 * 与 analytics-server/src/modules/time/calendar.ts 口径对齐；禁止抽 common 包。
 *
 * 平台时区由登录/me 响应下发并 `setPlatformTimeZone()`；未下发前用默认常量兜底。
 * 展示时区 = time_range.timezone（缺省平台时区）；所有「今天」都在展示日历上。
 */
import type { TimeRange, TimeRangeRelative, TimeRangeRelativeKind } from '../../types/dsl.types';
import { t as i18nT } from '../../i18n';

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

/* ------------------------- 平台/展示时区 holder ------------------------- */

let platformTimeZone = DEFAULT_PLATFORM_TZ;
let userTimeZone: string | null = null;
let projectTimeZone: string | null = null;

/** 登录 / me 响应到达时注入实例级平台时区 */
export function setPlatformTimeZone(tz?: string | null): void {
  if (tz && isValidTimeZoneName(tz)) platformTimeZone = tz;
}

export function getPlatformTimeZone(): string {
  return platformTimeZone;
}

/** 用户显示时区偏好（v2；null = 跟随项目/平台） */
export function setUserTimeZone(tz?: string | null): void {
  userTimeZone = tz && isValidTimeZoneName(tz) ? tz : null;
}

export function getUserTimeZone(): string | null {
  return userTimeZone;
}

/** 当前项目时区（v2；null = 跟随平台） */
export function setProjectTimeZone(tz?: string | null): void {
  projectTimeZone = tz && isValidTimeZoneName(tz) ? tz : null;
}

export function getProjectTimeZone(): string | null {
  return projectTimeZone;
}

/** IANA 名形态 + Intl 双重校验（与后端 calendar.isValidTimeZoneName 同口径） */
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

/**
 * 展示时区（v2 解析链，与后端 resolveChain 同口径）：
 * 显式 timezone → 用户偏好 → 项目时区 → 平台时区。
 * 显式值非法时按平台兜底（后端会再做硬校验拒绝）。
 */
export function resolveDisplayTimeZone(tz?: string | null): string {
  if (tz) {
    const trimmed = tz.trim();
    if (trimmed && isValidTimeZoneName(trimmed)) return trimmed;
    return platformTimeZone;
  }
  return userTimeZone ?? projectTimeZone ?? platformTimeZone;
}

/* --------------------------- tz 日历基础 --------------------------- */

/** tz 日历的今天（YYYY-MM-DD；服务端 time/calendar.todayInTz 同口径） */
export function todayInTz(tz: string, now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: tz });
}

/** epoch 毫秒（或 Date）在 tz 下的日历日 */
export function ymdInTz(tz: string, epoch: number | Date): string {
  return todayInTz(tz, epoch instanceof Date ? epoch : new Date(epoch));
}

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
  // h23 在部分 ICU 下 0 点渲染为 24；归一化到 0-23
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

function wallOffsetMs(tz: string, epochMs: number): number {
  const w = wallClockInTz(tz, epochMs);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(epochMs / 1000) * 1000;
}

/** tz 墙钟分量 → epoch 毫秒（与后端 epochOfWallClock 同算法；静默表单换算用） */
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

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

/**
 * ClickHouse naïve 时间串 → 真实时刻（phase: clklog-analytics-debug-query-v1）。
 *
 * `sa_events.log_time` 这类列由采集侧按**平台时区**渲染成 'YYYY-MM-DD HH:mm:ss[.SSS]'
 * （后端 `time/format.ts` 的 formatChDateTimeMs）。前端两种常见写法都是错的：
 * `new Date(str)` 会按**浏览器本地时区**解释（Safari 直接 Invalid Date），
 * `new Date(str.replace(' ', 'T') + 'Z')` 会按 **UTC** 解释（生产实测恒定偏 8 小时）。
 * 这里按「平台时区墙钟」还原成时刻，再交给 formatDateTime 按显示时区渲染。
 *
 * 只接受墙钟形态（不含 `Z`/时区偏移）；ISO 串与非法串返回 null，由调用方走原路径。
 */
export function parseWallClock(value: string | null | undefined, tz = getPlatformTimeZone()): Date | null {
  const m = WALL_CLOCK.exec((value ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) return null;
  const ms = epochOfWallClock(tz, +y, +mo, +d, +h, +mi, +s);
  return new Date(ms + Number((frac ?? '0').padEnd(3, '0')));
}

/* ------------------------------ 日历日运算 ------------------------------ */

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
export function parseYmd(value: string): [number, number, number] {
  const match = YMD.exec(value);
  if (!match) throw new Error(i18nT('analysis:timeRange.error.dateFormatInvalid'));
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error(i18nT('analysis:timeRange.error.dateFormatInvalid'));
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

export function addCalendarDays(ymd: string, delta: number): string {
  const [year, month, day] = parseYmd(ymd);
  return utcYmd(year, month - 1, day + delta);
}

export function calendarDaysInclusive(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.floor((b - a) / 86400000) + 1;
}

export function offsetFromToday(ymd: string, todayYmd: string): number {
  return Math.max(0, calendarDaysInclusive(ymd, todayYmd) - 1);
}

export function slashYmd(ymd: string): string {
  return ymd.split('-').join('/');
}

/* --------------------------- 时间范围解析 --------------------------- */

/** 展示日历的今天：time_range.timezone（缺省平台时区） */
export function displayTodayYmd(range?: Pick<TimeRange, 'timezone'>, now = new Date()): string {
  return todayInTz(resolveDisplayTimeZone(range?.timezone), now);
}

export function defaultPastNDays(n = 7, todayYmd = displayTodayYmd()): TimeRange {
  return materializeTimeRange({ start: '', end: '', relative: { kind: 'past_n', n } }, todayYmd);
}

export function materializeTimeRange(range: TimeRange, todayYmd?: string): TimeRange {
  // today 缺省走展示日历：timezone 存在时按它解析（与后端 TimeScope.materialize 一致）
  const today = todayYmd ?? displayTodayYmd(range);
  const { start, end } = resolveTimeRange(range, today);
  const next: TimeRange = { ...range, start, end };
  return next;
}

export function resolveTimeRange(range: TimeRange, todayYmd: string): { start: string; end: string } {
  if (range.relative) {
    return resolveRelative(range.relative, todayYmd);
  }
  if (!range.start || !range.end) {
    throw new Error(i18nT('analysis:timeRange.error.startEndRequired'));
  }
  parseYmd(range.start);
  parseYmd(range.end);
  if (range.start > range.end) {
    throw new Error(i18nT('analysis:timeRange.error.endBeforeStart'));
  }
  return { start: range.start, end: range.end };
}

function resolveRelative(relative: TimeRangeRelative, today: string): { start: string; end: string } {
  const kind = relative.kind;
  if (!TIME_RANGE_RELATIVE_KINDS.includes(kind)) {
    throw new Error(i18nT('analysis:timeRange.error.kindInvalid'));
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
        throw new Error(i18nT('analysis:timeRange.error.dynamicStartAfterEnd'));
      }
      start = addCalendarDays(today, -from);
      end = addCalendarDays(today, -to);
      break;
    }
  }
  if (start > end) {
    throw new Error(i18nT('analysis:timeRange.error.endBeforeStart'));
  }
  return { start, end };
}

function requireN(n: number | undefined): number {
  if (!Number.isInteger(n) || !n || n < 1 || n > TIME_RANGE_OFFSET_MAX) {
    throw new Error(i18nT('analysis:timeRange.error.nRange', { max: TIME_RANGE_OFFSET_MAX }));
  }
  return n;
}

function requireOffset(value: number | undefined, field: string): number {
  if (!Number.isInteger(value) || value === undefined || value < 0 || value > TIME_RANGE_OFFSET_MAX) {
    throw new Error(i18nT('analysis:timeRange.error.offsetRange', { field, max: TIME_RANGE_OFFSET_MAX }));
  }
  return value;
}

function requireAnchor(value: string | undefined): string {
  if (!value) throw new Error(i18nT('analysis:timeRange.error.anchorRequired'));
  parseYmd(value);
  return value;
}

function mondayOnOrBefore(ymd: string): string {
  const [year, month, day] = parseYmd(ymd);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dow = utc.getUTCDay();
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  return addCalendarDays(ymd, -daysFromMonday);
}

function monthStart(ymd: string): string {
  const [year, month] = parseYmd(ymd);
  return utcYmd(year, month - 1, 1);
}
