/**
 * 平台/项目/用户三级时区解析（phase: clklog-analytics-timezone-v1/v2）。
 *
 * 平台时区（统计与落库日历）经 `analytics.timezone` 配置进入，非法时启动期
 * fail-fast（静默回退会让口径悄悄错，比不启动更糟）。展示时区逐请求解析，
 * 缺省 = 平台时区；非法走 DomainError（i18n 错误码契约）。
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import { DEFAULT_PLATFORM_TZ, isValidTimeZoneName, todayInTz } from './calendar';
import { ProjectTimeRegistry } from './project-time-registry';

export interface TimeOptions {
  platformTz?: string;
}

export const TIME_OPTIONS = 'CLKLOG_TIME_OPTIONS';

/** 时区解析链的输入：任何位置拿到的显式值 / 用户偏好 / 项目名 */
export interface TimeChainInput {
  explicit?: string | null;
  authUserTz?: string | null;
  projectName?: string | null;
}

/** 解析结果：展示（查询）时区与落库/扫描基准时区 */
export interface TimeChain {
  displayTz: string;
  statTz: string;
}

@Injectable()
export class TimezoneService {
  readonly platformTz: string;

  constructor(
    @Optional() @Inject(TIME_OPTIONS) options?: TimeOptions,
    @Optional() private readonly projectTimes?: ProjectTimeRegistry,
  ) {
    const tz = (options?.platformTz ?? '').trim() || DEFAULT_PLATFORM_TZ;
    if (!isValidTimeZoneName(tz)) {
      throw new Error(`Invalid analytics.timezone: ${tz} (must be an IANA name, e.g. Asia/Shanghai)`);
    }
    this.platformTz = tz;
  }

  /** 平台日历的今天 */
  todayYmd(now: Date = new Date()): string {
    return todayInTz(this.platformTz, now);
  }

  /**
   * 展示时区：空值 → 平台时区；非法 → 400（DomainError）。
   * 返回值保证可直接传给 ClickHouse 时区参数与 Intl。
   */
  resolveDisplayTz(tz?: string | null): string {
    if (tz === undefined || tz === null || tz.trim() === '') return this.platformTz;
    const trimmed = tz.trim();
    if (isValidTimeZoneName(trimmed)) return trimmed;
    throw badRequest({
      code: 'analysis.time_range.timezone_invalid',
      messageKey: 'errors:analysis.timeRange.timezoneInvalid',
      message: `时区不合法: ${tz}（须为 IANA 名，如 Asia/Shanghai）`,
    });
  }

  /** 项目落库/口径时区（注册表缺省时 = 平台时区） */
  statTzOf(projectName: string | null | undefined): string {
    if (!this.projectTimes) return this.platformTz;
    return this.projectTimes.timeZoneOf(projectName, this.platformTz);
  }

  /**
   * 解析链（v2 契约）：
   *   displayTz = explicit → authUserTz → 项目时区 → 平台
   *   statTz    = 项目时区 → 平台
   * 显式/偏好值非法时抛 400；项目值非法时按平台兜底（registry fail-open）。
   */
  resolveChain(input: TimeChainInput): TimeChain {
    const statTz = this.statTzOf(input.projectName);
    const explicit = input.explicit?.trim();
    if (explicit) return { displayTz: this.resolveDisplayTz(explicit), statTz };
    const userTz = input.authUserTz?.trim();
    if (userTz) return { displayTz: this.resolveDisplayTz(userTz), statTz };
    return { displayTz: statTz, statTz };
  }
}
