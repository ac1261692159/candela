/**
 * 本地化格式化（数字 / 百分比 / 时长 / 日期时间）。
 *
 * 由 `src/utils/formatter.ts` 迁入（架构棘轮基线里 `src/utils/` 的退出条件之一）。
 * 与迁入前相比两处演进：① 区域随语言；② 时区随实例平台时区下发
 * （phase: clklog-analytics-timezone-v1——不再随浏览器，D12 登记的独立 phase 落地）。
 */
import i18next from 'i18next';
import { DEFAULT_LOCALE, localeDef, resolveLocale } from './config';
import { getPlatformTimeZone, wallClockInTz } from '../features/time-range/resolve';

function intlLocale(): string {
  return localeDef(resolveLocale(i18next.language) ?? DEFAULT_LOCALE).intl;
}

export function formatNumber(n: number | string | undefined): string {
  if (n === undefined || n === null || n === '') return '-';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString(intlLocale());
}

export function formatPercent(n: number | string | undefined, digits = 2): string {
  if (n === undefined || n === null || n === '') return '-';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (Number.isNaN(num)) return String(n);
  return `${(num * 100).toFixed(digits)}%`;
}

/** 语言无关的固定格式（YYYY-MM-DD），跨语言保持稳定，便于对拍与导出；tz 缺省平台时区 */
export function formatDate(d: string | Date | undefined, tz = getPlatformTimeZone()): string {
  if (!d) return '-';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  const w = wallClockInTz(tz, date.getTime());
  const month = String(w.month).padStart(2, '0');
  const day = String(w.day).padStart(2, '0');
  return `${w.year}-${month}-${day}`;
}

export function formatDurationSec(n: number | string | undefined, plain = false): string {
  if (n === undefined || n === null || n === '') return '—';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (Number.isNaN(num)) return String(n);
  if (plain) return formatNumber(num);
  if (Math.abs(num) < 60) {
    const value = num.toLocaleString(intlLocale(), { maximumFractionDigits: 1 });
    return i18next.t('common:unit.second', { value });
  }
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  const minutes = Math.floor(abs / 60);
  const seconds = abs % 60;
  if (seconds < 0.05) return `${sign}${minutes}m`;
  return `${sign}${minutes}m ${seconds.toLocaleString(intlLocale(), { maximumFractionDigits: 0 })}s`;
}

/** 日期时间：区域随语言、时区随平台（缺省）；传入 tz 可逐次覆盖（展示时区） */
export function formatDateTime(d: string | Date | undefined, tz = getPlatformTimeZone()): string {
  if (!d) return '-';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleString(intlLocale(), {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * 语言无关的固定日期时间（'YYYY-MM-DD HH:mm:ss'），供管理面/审计列表：
 * 承接原「ISO 截断为 UTC 墙钟」展示族，原样形态、平台时区语义（ZQ-8-③/⑦ 清零）。
 */
export function formatDateTimeFixed(d: string | Date | undefined, tz = getPlatformTimeZone()): string {
  if (!d) return '-';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  const w = wallClockInTz(tz, date.getTime());
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}
