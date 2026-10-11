/**
 * 请求语言解析（服务端）：供「读者不是当前会话用户」的场景使用——
 * 告警通知按收件人语言、导出按操作者当前界面语言（见 i18n 设计文档 §7.1）。
 *
 * 只做解析与规范化，不做文案渲染；渲染使用 `messages/<语言>.json`。
 */
import { DEFAULT_LOCALE, SUPPORTED_LOCALE_TAGS, normalizeLocaleTag } from './locales';

export interface RequestLike {
  headers?: Record<string, unknown>;
}

function firstHeaderValue(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return null;
}

/** 解析 `Accept-Language`，按 q 值从高到低取第一个受支持的语言 */
export function parseAcceptLanguage(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw
    .split(',')
    .map((chunk) => {
      const [tag, ...params] = chunk.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 1 };
    })
    .filter((p) => p.tag)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of parts) {
    const resolved = normalizeLocaleTag(tag);
    if (resolved) return resolved;
  }
  return null;
}

/** 请求 → 语言：`x-locale`（前端显式指定，导出场景用）优先，其次 Accept-Language，最后平台默认 */
export function localeFromRequest(req: RequestLike | undefined): string {
  const explicit = normalizeLocaleTag(firstHeaderValue(req?.headers?.['x-locale']));
  if (explicit) return explicit;
  const negotiated = parseAcceptLanguage(firstHeaderValue(req?.headers?.['accept-language']));
  if (negotiated) return negotiated;
  return DEFAULT_LOCALE;
}

export { DEFAULT_LOCALE, SUPPORTED_LOCALE_TAGS };
