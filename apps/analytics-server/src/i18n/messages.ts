/**
 * 服务端文案渲染（只用于**服务端产出**的内容：告警通知等）。
 *
 * 与前端的关系：接口错误文案由前端按 `messageKey` 渲染，不在这里；
 * 这里只管「读者不是当前会话用户」的场景——告警通知按收件人语言渲染（设计文档 §7.1）。
 *
 * 资源在构建期静态引入（五门语言体量仍很小），不做懒加载，保证投递路径无 IO。
 * 注意：新增语言时**必须**在这里 import + 注册——tsc 只会把被 import 的 JSON 拷进 dist。
 */
import zhCN from './messages/zh-CN.json';
import enUS from './messages/en-US.json';
import zhTW from './messages/zh-TW.json';
import jaJP from './messages/ja-JP.json';
import koKR from './messages/ko-KR.json';
import ruRU from './messages/ru-RU.json';
import frFR from './messages/fr-FR.json';
import deDE from './messages/de-DE.json';
import esES from './messages/es-ES.json';
import ptBR from './messages/pt-BR.json';
import viVN from './messages/vi-VN.json';
import thTH from './messages/th-TH.json';
import idID from './messages/id-ID.json';
import { DEFAULT_LOCALE, normalizeLocaleTag } from './locales';

type Bundle = Record<string, unknown>;

const BUNDLES: Record<string, Bundle> = {
  'zh-CN': zhCN as Bundle,
  'en-US': enUS as Bundle,
  'zh-TW': zhTW as Bundle,
  'ja-JP': jaJP as Bundle,
  'ko-KR': koKR as Bundle,
  'ru-RU': ruRU as Bundle,
  'fr-FR': frFR as Bundle,
  'de-DE': deDE as Bundle,
  'es-ES': esES as Bundle,
  'pt-BR': ptBR as Bundle,
  'vi-VN': viVN as Bundle,
  'th-TH': thTH as Bundle,
  'id-ID': idID as Bundle,
};

function lookup(bundle: Bundle, key: string): string | null {
  let node: unknown = bundle;
  for (const segment of key.split('.')) {
    if (!node || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' ? node : null;
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * 取服务端文案：目标语言 → 平台默认语言 → 键名兜底。
 * 缺键时返回键名而不是抛错，保证通知投递不因为文案缺失而失败。
 */
export function serverT(locale: string | null | undefined, key: string, params?: Record<string, unknown>): string {
  const tag = normalizeLocaleTag(locale) ?? DEFAULT_LOCALE;
  const primary = lookup(BUNDLES[tag] ?? {}, key);
  if (primary !== null) return interpolate(primary, params);
  const fallback = lookup(BUNDLES[DEFAULT_LOCALE], key);
  if (fallback !== null) return interpolate(fallback, params);
  return key;
}
