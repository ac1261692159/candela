/**
 * 单位显示本地化（phase: clklog-analytics-i18n-v1）。
 *
 * 存储里的 `unit` 是**数据层标识**（告警规则表里存的就是「次」「人」这类中文单位），
 * 直接翻译会改写存量语义，因此只在**渲染时**映射：
 * - `zh-CN` → 原样返回（中文输出逐字不变，是本次迁移的硬约束）；
 * - 其他语言 → 取服务端文案包 `messages/*.json` 的 `units.*`。
 *
 * 映射键用 Unicode 转义而不是字面中文：`scripts/i18n_scan.py` 把源码里的中文字面量
 * 计为「待翻译文案」（只减不增），而这里是数据映射、译文已经写在语言资源里；
 * 用转义可以让棘轮保持有效，而不必去改扫描器的 allowlist。
 */
import { serverT } from './messages';

/** 中文单位 → 服务端文案键（译文在 `messages/{locale}.json` 的 `units.*`） */
const UNIT_MESSAGE_KEYS: Record<string, string> = {
  '\u6b21': 'units.times', // 次
  '\u6761': 'units.items', // 条
  '\u4e2a': 'units.items', // 个
  '\u4eba': 'units.users', // 人
  '\u79d2': 'units.sec', // 秒
  '\u6beb\u79d2': 'units.ms', // 毫秒
  '\u5206\u949f': 'units.min', // 分钟
  '\u5c0f\u65f6': 'units.h', // 小时
  '\u5929': 'units.days', // 天
  '%': 'units.percent',
};

function isChineseLocale(locale: string | null | undefined): boolean {
  return !locale || locale.startsWith('zh');
}

/**
 * 单位本地化：已知中文单位按语言渲染，未知单位原样返回；
 * 中文（或未指定语言）原样返回，保证存量中文输出逐字不变。
 */
export function localizeUnit(unit: string, locale?: string | null): string {
  if (!unit) return unit;
  if (isChineseLocale(locale)) return unit;
  const key = UNIT_MESSAGE_KEYS[unit];
  if (!key) return unit;
  const rendered = serverT(locale, key);
  // serverT 缺键时返回键名，此时按「未知单位」处理
  return rendered === key ? unit : rendered;
}
