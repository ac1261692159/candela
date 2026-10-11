/**
 * @Cron 装饰器求值期的平台时区常量（phase: clklog-analytics-timezone-v1，ZQ-5）。
 *
 * 装饰器在模块加载期求值，走不了 DI，只能轻量读取配置。生产 AppModule 引导时
 * TimeModule/TimezoneService 会基于同一配置 fail-fast 校验，本常量只作补充读取，
 * 不承担校验职责（校验失败时进程根本不会起来）。
 */
import { appConfig } from '../../config/configuration';
import { DEFAULT_PLATFORM_TZ, isValidTimeZoneName } from './calendar';

export const PLATFORM_CRON_TIME_ZONE: string = (() => {
  const tz = appConfig.analytics?.timezone?.trim();
  return tz && isValidTimeZoneName(tz) ? tz : DEFAULT_PLATFORM_TZ;
})();
