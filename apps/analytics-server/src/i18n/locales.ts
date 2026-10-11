/**
 * 服务端语言注册表（与前端 `apps/analytics-web/src/i18n/config.ts` 的 LOCALES 保持一致）。
 *
 * 服务端只负责**解析**语言标签与**按语言渲染**服务端产出的内容（通知 / 导出 / 默认模板），
 * 接口错误文案由前端按 `messageKey` 渲染，不在这里翻译。
 */

export const DEFAULT_LOCALE = 'zh-CN';

/** 已上线语言（新增语言时这里与前端注册表同步加一行） */
export const SUPPORTED_LOCALE_TAGS = ['zh-CN', 'en-US', 'zh-TW', 'ja-JP', 'ko-KR', 'ru-RU', 'fr-FR', 'de-DE', 'es-ES', 'pt-BR', 'vi-VN', 'th-TH', 'id-ID'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALE_TAGS)[number];

const LOCALE_TAG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

/**
 * 规整语言标签：精确命中 → 同基语言 → null。
 * `en-GB` → `en-US`；`zh-Hant`/`zh-HK` → `zh-TW`；`ja`/`ko` 按同基语言归到 `ja-JP`/`ko-KR`；
 */
export function normalizeLocaleTag(raw: string | null | undefined): SupportedLocale | null {
  if (!raw) return null;
  const tag = raw.trim().replace(/_/g, '-');
  if (!tag || !LOCALE_TAG_RE.test(tag)) return null;

  const exact = SUPPORTED_LOCALE_TAGS.find((t) => t.toLowerCase() === tag.toLowerCase());
  if (exact) return exact;

  // 繁体区（含港澳）优先归到繁中，其余按同基语言
  const lower2 = tag.toLowerCase();
  if (lower2 === 'zh-hant' || lower2.startsWith('zh-hk') || lower2.startsWith('zh-mo')) {
    return 'zh-TW';
  }

  const base = tag.toLowerCase().split('-')[0];
  const sameBase = SUPPORTED_LOCALE_TAGS.find((t) => t.toLowerCase().split('-')[0] === base);
  return sameBase ?? null;
}
