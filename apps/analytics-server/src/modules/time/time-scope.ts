/**
 * 查询窗物化（phase: clklog-analytics-timezone-v1）。
 *
 * `sa_events.stat_date` 是**平台时区日历**的物化列；当展示时区 ≠ 平台时区时，
 * 平台日界与展示日界最多错开 26 小时（IANA 极值 -12/+14），直接
 * `stat_date BETWEEN start AND end` 会漏切边界事件。因此：
 *
 * - 恒等路径（展示时区 = 平台时区，即全部既有请求）：SQL 与原逐字节一致
 *   （`stat_date BETWEEN {start}{end}`），保证零行为变化（PRD SC-6）；
 * - 异时区路径：stat_date **宽扫 ±1 天**（分区裁剪仍有效）+ log_time 用 epoch
 *   毫秒参数精确裁切（`fromUnixTimestamp64Milli`，与 AL-01 修复约定同源），
 *   粒度桶带 `{display_tz:String}` 时区参数按展示日历切分。
 */
import { Injectable } from '@nestjs/common';
import type { TimeRange } from '../../types/dsl.types';
import {
  addCalendarDays,
  epochOfDayEndExclusive,
  epochOfDayStart,
  resolveTimeRange,
  todayInTz,
} from './calendar';
import { TimezoneService } from './timezone.service';

export type BucketGranularity = 'minute' | 'hour' | 'day' | 'week' | 'month';

/** ClickHouse 粒度函数；周严格用 toMonday（PRD：周一=周首） */
const BUCKET_FUNCTIONS: Record<BucketGranularity, string> = {
  minute: 'toStartOfMinute',
  hour: 'toStartOfHour',
  day: 'toStartOfDay',
  week: 'toMonday',
  month: 'toStartOfMonth',
};

export interface TimeScope {
  /** 展示时区（IANA） */
  tz: string;
  /** 落库/扫描基准时区（项目 → 平台；v2） */
  statTz: string;
  /** 展示日历起止日（YYYY-MM-DD） */
  startYmd: string;
  endYmd: string;
  /** stat_date 宽扫边界（恒等路径 = 起止日） */
  scanStartYmd: string;
  scanEndYmd: string;
  /** [start 00:00@tz, end+1d 00:00@tz) 的 epoch 毫秒 */
  startEpochMs: number;
  endEpochMsExclusive: number;
  /** 展示时区 = 扫描基准时区（stat_date 日历同一本）：走与历史逐字节一致的快路 */
  isPlatformCalendar: boolean;
}

@Injectable()
export class TimeScopeService {
  constructor(private readonly timezones: TimezoneService) {}

  get platformTz(): string {
    return this.timezones.platformTz;
  }

  /** 项目落库/扫描基准时区（注册表 fail-open 平台，v2） */
  statTzOf(projectName: string | null | undefined): string {
    return this.timezones.statTzOf(projectName);
  }

  /**
   * 解析 time_range（含 relative 与 timezone）为可生成 SQL 的 TimeScope。
   * v2 解析链：range.timezone → authUserTz → 项目时区 → 平台；
   * 缺省参数不变 = v1 行为（全链路缺省 → 平台，恒等快路）。
   */
  materialize(
    range: TimeRange,
    options: { now?: Date; authUserTz?: string | null; projectName?: string | null } = {},
  ): TimeScope {
    const chain = this.timezones.resolveChain({
      explicit: range?.timezone,
      authUserTz: options.authUserTz,
      projectName: options.projectName,
    });
    const tz = chain.displayTz;
    const today = todayInTz(tz, options.now);
    const { start, end } = resolveTimeRange(range, today);
    const isPlatformCalendar = tz === chain.statTz;
    return {
      tz,
      statTz: chain.statTz,
      startYmd: start,
      endYmd: end,
      scanStartYmd: isPlatformCalendar ? start : addCalendarDays(start, -1),
      scanEndYmd: isPlatformCalendar ? end : addCalendarDays(end, 1),
      startEpochMs: epochOfDayStart(tz, start),
      endEpochMsExclusive: epochOfDayEndExclusive(tz, end),
      isPlatformCalendar,
    };
  }
}

/** 时间窗 WHERE 片段 + 参数；恒等路径与旧 SQL 逐字节一致 */
export function timeScopeFilter(
  scope: TimeScope,
  options: { paramPrefix: string; statDateColumn?: string; logTimeColumn?: string },
): { where: string; params: Record<string, string | number> } {
  const { paramPrefix } = options;
  const statDateColumn = options.statDateColumn ?? 'stat_date';
  const logTimeColumn = options.logTimeColumn ?? 'log_time';
  if (scope.isPlatformCalendar) {
    return {
      where: `${statDateColumn} BETWEEN {${paramPrefix}start:String} AND {${paramPrefix}end:String}`,
      params: {
        [`${paramPrefix}start`]: scope.startYmd,
        [`${paramPrefix}end`]: scope.endYmd,
      },
    };
  }
  return {
    where:
      `${statDateColumn} BETWEEN {${paramPrefix}scan_start:String} AND {${paramPrefix}scan_end:String}` +
      ` AND ${logTimeColumn} >= fromUnixTimestamp64Milli({${paramPrefix}start_ms:Int64})` +
      ` AND ${logTimeColumn} < fromUnixTimestamp64Milli({${paramPrefix}end_ms:Int64})`,
    params: {
      [`${paramPrefix}scan_start`]: scope.scanStartYmd,
      [`${paramPrefix}scan_end`]: scope.scanEndYmd,
      [`${paramPrefix}start_ms`]: scope.startEpochMs,
      [`${paramPrefix}end_ms`]: scope.endEpochMsExclusive,
    },
  };
}

/** 粒度桶表达式；异时区路径带 `{display_tz:String}` 参数 */
export function bucketExpression(scope: TimeScope, column: string, granularity: BucketGranularity): string {
  const fn = BUCKET_FUNCTIONS[granularity];
  if (scope.isPlatformCalendar) return `${fn}(${column})`;
  return `${fn}(${column}, {display_tz:String})`;
}

/** 桶参数（异时区路径才有） */
export function bucketParams(scope: TimeScope): Record<string, string> {
  return scope.isPlatformCalendar ? {} : { display_tz: scope.tz };
}

/** toDate 取日（留存入组日等的日历切分） */
export function dateExpression(scope: TimeScope, column: string): string {
  if (scope.isPlatformCalendar) return `toDate(${column})`;
  return `toDate(${column}, {display_tz:String})`;
}

/** 小时/日/分钟等日历抽取（TimeExtract） */
export function extractExpression(scope: TimeScope, fn: 'toHour' | 'toDayOfMonth' | 'toMinute', column: string): string {
  if (scope.isPlatformCalendar) return `${fn}(${column})`;
  return `${fn}(${column}, {display_tz:String})`;
}
