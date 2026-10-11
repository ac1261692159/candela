/**
 * 联系人偏好的入库规范化（i18n v1 locale / timezone-v2 timezone）。
 *
 * 从 `alerting.service.ts` 抽出：该 service 因 `channels/channel-registry.ts`
 * 引配置链（appConfig），单测只想要这两个纯函数时会被迫拖出 env 依赖
 * （CI 裸环境无 CLICKHOUSE_PASSWORD 时 import 即炸，2026-09-17 CI build-main 实证）。
 * 纯函数文件禁止 import 带副作用的模块（保持可无 env 直接单测）。
 */
import { badRequest } from '../../i18n/domain-error';
import { normalizeLocaleTag } from '../../i18n/locales';
import { isValidTimeZoneName } from '../time/calendar';

/**
 * 联系人语言（`AlertContact.locale`，i18n v1 表单补齐）：
 * 空值 = 平台默认；受支持的标签按规范写法落库（en-GB → en-US、zh_TW → zh-CN）；
 * 不受支持/非法的标签返回 400（加法式收紧：该字段是上一轮新增的，老客户端不受影响）。
 */
export function contactLocale(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const normalized = normalizeLocaleTag(String(raw));
  if (!normalized) {
    throw badRequest({
      code: 'alerting.contact.localeInvalid',
      messageKey: 'alerting:error.contact.localeInvalid',
      params: { locale: String(raw) },
      message: `不支持的语言：${raw}`,
    });
  }
  return normalized;
}

/** 联系人时区（timezone-v2）：空 = 跟随项目/平台；非法 IANA 名 400 */
export function contactTimezone(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const tz = String(raw).trim();
  if (!isValidTimeZoneName(tz)) {
    throw badRequest({
      code: 'alerting.contact.timezoneInvalid',
      messageKey: 'alerting:error.contact.timezoneInvalid',
      params: { timezone: String(raw) },
      message: `不合法的时区：${raw}（须为 IANA 名，如 Asia/Shanghai）`,
    });
  }
  return tz;
}
