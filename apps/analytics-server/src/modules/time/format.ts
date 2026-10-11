/**
 * 显式时区的时间格式化（phase: clklog-analytics-timezone-v1）。
 *
 * 展示与落库共用，一律显式 tz；禁止用进程本地分量
 * （原 `common/utils/date.util.ts` 的渲染依赖 Node 进程时区，属 ZQ-1 风险源）。
 */
import { wallClockInTz, ymdInTz } from './calendar';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}

/** 'YYYY-MM-DD HH:mm:ss'（tz 墙钟；告警通知/管理面展示用） */
export function formatInTz(date: Date | number, tz: string): string {
  const ms = typeof date === 'number' ? date : date.getTime();
  const w = wallClockInTz(tz, ms);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)} ${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}`;
}

/** ClickHouse Date 列：'YYYY-MM-DD' */
export function formatChDate(date: Date | number, tz: string): string {
  const ms = typeof date === 'number' ? date : date.getTime();
  return ymdInTz(tz, ms);
}

/** ClickHouse DateTime 列：'YYYY-MM-DD HH:mm:ss'（秒级） */
export function formatChDateTimeSeconds(date: Date | number, tz: string): string {
  return formatInTz(date, tz);
}

/** ClickHouse DateTime64(3) 列：'YYYY-MM-DD HH:mm:ss.SSS' */
export function formatChDateTimeMs(date: Date | number, tz: string): string {
  const ms = Math.floor(typeof date === 'number' ? date : date.getTime());
  return `${formatInTz(ms, tz)}.${pad3(Math.abs(ms) % 1000)}`;
}

/** UTC ISO（epoch 时刻的无歧义表达；日志与审计用） */
export function formatUtcIso(date: Date | number): string {
  return (typeof date === 'number' ? new Date(date) : date).toISOString();
}
