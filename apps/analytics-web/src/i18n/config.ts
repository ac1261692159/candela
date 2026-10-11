/**
 * 语言注册表与命名空间注册表（i18n 唯一权威）。
 *
 * 契约见 `docs/architecture/clklog-analytics-design-i18n-v1.md` §5.3、§5.2。
 * 新增一门语言 = 在 LOCALES 加一行 + 新增 `locales/<tag>/` 目录；不需要改组件。
 */

export const DEFAULT_LOCALE = 'zh-CN';

export interface LocaleDef {
  /** BCP-47 标签，同时是资源目录名 */
  tag: string;
  /** 语言自身书写（选择器直接显示，不翻译） */
  label: string;
  /** antd locale 模块名（`antd/locale/<key>`） */
  antd:
    | 'zh_CN'
    | 'en_US'
    | 'zh_TW'
    | 'ja_JP'
    | 'ko_KR'
    | 'ru_RU'
    | 'fr_FR'
    | 'de_DE'
    | 'es_ES'
    | 'pt_BR'
    | 'vi_VN'
    | 'th_TH'
    | 'id_ID';
  /** dayjs locale 名 */
  dayjs: string;
  /** Intl 数字/日期格式使用的区域 */
  intl: string;
}

export const LOCALES: readonly LocaleDef[] = [
  { tag: 'zh-CN', label: '简体中文', antd: 'zh_CN', dayjs: 'zh-cn', intl: 'zh-CN' },
  { tag: 'en-US', label: 'English', antd: 'en_US', dayjs: 'en', intl: 'en-US' },
  { tag: 'zh-TW', label: '繁體中文', antd: 'zh_TW', dayjs: 'zh-tw', intl: 'zh-TW' },
  { tag: 'ja-JP', label: '日本語', antd: 'ja_JP', dayjs: 'ja', intl: 'ja-JP' },
  { tag: 'ko-KR', label: '한국어', antd: 'ko_KR', dayjs: 'ko', intl: 'ko-KR' },
  { tag: 'ru-RU', label: 'Русский', antd: 'ru_RU', dayjs: 'ru', intl: 'ru-RU' },
  { tag: 'fr-FR', label: 'Français', antd: 'fr_FR', dayjs: 'fr', intl: 'fr-FR' },
  { tag: 'de-DE', label: 'Deutsch', antd: 'de_DE', dayjs: 'de', intl: 'de-DE' },
  { tag: 'es-ES', label: 'Español', antd: 'es_ES', dayjs: 'es', intl: 'es-ES' },
  { tag: 'pt-BR', label: 'Português (Brasil)', antd: 'pt_BR', dayjs: 'pt-br', intl: 'pt-BR' },
  { tag: 'vi-VN', label: 'Tiếng Việt', antd: 'vi_VN', dayjs: 'vi', intl: 'vi-VN' },
  { tag: 'th-TH', label: 'ไทย', antd: 'th_TH', dayjs: 'th', intl: 'th-TH' },
  { tag: 'id-ID', label: 'Bahasa Indonesia', antd: 'id_ID', dayjs: 'id', intl: 'id-ID' },
];

export const LOCALE_TAGS: readonly string[] = LOCALES.map((l) => l.tag);

/**
 * 命名空间注册表（与架构文档 §5.3 一致）。
 * 键一律写成 `ns:key` 全限定形式，便于跨命名空间复用与静态校验。
 */
export const NAMESPACES = [
  'common',
  'shell',
  'auth',
  'errors',
  'report',
  'analysis',
  'cohort',
  'meta',
  'metrics',
  'sql',
  'datatable',
  'iam',
  'alerting',
  'ops',
  'onboarding',
  'ai',
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/** 语言标签的书写/区域回退：zh-Hant/zh-TW → 已支持的同基语言 → null（交给默认语言） */
const SCRIPT_HINTS: Record<string, string> = {
  // 繁体区（含港澳）统一回退到繁中；简体区回退简中
  'zh-hant': 'zh-TW',
  'zh-hk': 'zh-TW',
  'zh-mo': 'zh-TW',
  'zh-hans': 'zh-CN',
};

export function isSupportedLocale(tag: string | null | undefined): boolean {
  if (!tag) return false;
  return LOCALE_TAGS.some((t) => t.toLowerCase() === tag.trim().toLowerCase());
}

/**
 * 把任意语言标签规整到已支持的语言；无法匹配返回 null。
 * `en-GB` → `en-US`；`zh-Hant` / `zh-TW` → `zh-TW`（未上线时返回 null，由调用方回退默认语言）。
 */
export function resolveLocale(raw?: string | null): string | null {
  if (!raw) return null;
  const tag = raw.trim().replace(/_/g, '-');
  if (!tag) return null;
  const lower = tag.toLowerCase();

  const exact = LOCALE_TAGS.find((t) => t.toLowerCase() === lower);
  if (exact) return exact;

  const hint = SCRIPT_HINTS[lower];
  if (hint && isSupportedLocale(hint)) return hint;

  const base = lower.split('-')[0];
  const sameBase = LOCALE_TAGS.find((t) => t.toLowerCase().split('-')[0] === base);
  if (sameBase) return sameBase;

  return null;
}

export function localeDef(tag: string): LocaleDef {
  return LOCALES.find((l) => l.tag === tag) ?? LOCALES[0];
}
