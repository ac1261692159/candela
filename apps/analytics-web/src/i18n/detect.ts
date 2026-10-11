/**
 * 语言解析链（纯函数，可单测）。
 *
 * 优先级（架构文档 §5.2）：
 *   1. URL `?lang=<tag>`（本次会话覆盖，写 sessionStorage，供支持排障与验收）
 *   2. 用户偏好（登录后由服务端下发，缓存到 localStorage；未登录时为本地选择）
 *   3. 浏览器语言
 *   4. 平台默认 zh-CN
 */
import { DEFAULT_LOCALE, resolveLocale } from './config';

export const LOCALE_STORAGE_KEY = 'clklog-analytics-locale';
export const LOCALE_SESSION_KEY = 'clklog-analytics-locale-override';
export const LOCALE_URL_PARAM = 'lang';

export interface DetectInput {
  /** location.search 里的 lang 参数 */
  url?: string | null;
  /** sessionStorage 中的一次性覆盖 */
  session?: string | null;
  /** localStorage 中的用户偏好（登录后来自服务端） */
  stored?: string | null;
  /** navigator.languages（按优先级从高到低） */
  browser?: readonly string[] | null;
}

/** 把 URL 上的 lang 参数固化为本次会话覆盖；返回规范化后的语言或 null。 */
export function captureUrlLocale(search: string | null | undefined): string | null {
  if (!search) return null;
  const params = new URLSearchParams(search);
  const raw = params.get(LOCALE_URL_PARAM);
  const resolved = resolveLocale(raw);
  if (resolved) safeSessionSet(resolved);
  return resolved;
}

export function detectLocale(input: DetectInput): string {
  const fromUrl = resolveLocale(input.url);
  if (fromUrl) return fromUrl;

  const fromSession = resolveLocale(input.session);
  if (fromSession) return fromSession;

  const fromStored = resolveLocale(input.stored);
  if (fromStored) return fromStored;

  for (const tag of input.browser ?? []) {
    const resolved = resolveLocale(tag);
    if (resolved) return resolved;
  }

  return DEFAULT_LOCALE;
}

export function readStoredLocale(): string | null {
  return safeGet('local', LOCALE_STORAGE_KEY);
}

export function writeStoredLocale(tag: string | null): void {
  if (typeof window === 'undefined') return;
  if (tag) safeSet('local', LOCALE_STORAGE_KEY, tag);
  else safeRemove('local', LOCALE_STORAGE_KEY);
}

export function readSessionOverride(): string | null {
  return safeGet('session', LOCALE_SESSION_KEY);
}

export function clearSessionOverride(): void {
  safeRemove('session', LOCALE_SESSION_KEY);
}

export function browserLocales(): string[] {
  if (typeof navigator === 'undefined') return [];
  const langs = navigator.languages;
  if (langs && langs.length) return [...langs];
  return navigator.language ? [navigator.language] : [];
}

/** 启动时按解析链求值（window 不存在时回退默认语言，便于 SSR/测试） */
export function detectInitialLocale(): string {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  return detectLocale({
    url: captureUrlLocale(window.location.search),
    session: readSessionOverride(),
    stored: readStoredLocale(),
    browser: browserLocales(),
  });
}

function safeGet(kind: 'local' | 'session', key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return (kind === 'local' ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function safeSet(kind: 'local' | 'session', key: string, value: string): void {
  try {
    (kind === 'local' ? window.localStorage : window.sessionStorage).setItem(key, value);
  } catch {
    /* 隐私模式禁用存储时忽略：语言仍在本会话内生效 */
  }
}

function safeRemove(kind: 'local' | 'session', key: string): void {
  try {
    (kind === 'local' ? window.localStorage : window.sessionStorage).removeItem(key);
  } catch {
    /* 同上 */
  }
}

function safeSessionSet(value: string): void {
  safeSet('session', LOCALE_SESSION_KEY, value);
}
