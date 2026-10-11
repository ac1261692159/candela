/** 分析 SPA 挂在 /sa，登录页的浏览器地址必须带此前缀。 */
export const ANALYTICS_LOGIN_HREF = '/sa/login';

export function isAnalyticsLoginPath(pathname: string): boolean {
  return pathname === ANALYTICS_LOGIN_HREF || pathname === '/login';
}

export function redirectToAnalyticsLogin(): void {
  if (typeof window === 'undefined') return;
  if (!isAnalyticsLoginPath(window.location.pathname)) {
    window.location.assign(ANALYTICS_LOGIN_HREF);
  }
}

function headerValue(headers: unknown, name: string): unknown {
  if (!headers) return undefined;
  const bag = headers as { get?: (key: string) => unknown } & Record<string, unknown>;
  if (typeof bag.get === 'function') return bag.get(name);
  return bag[name] ?? bag[name.toLowerCase()];
}

/**
 * 401 是否按「会话过期」处理（清登录态 + 跳登录）。
 *
 * 判据是**请求当时是否带着登录态**：带 `Authorization` 的 401 = 会话失效，跳登录；
 * 不带（登录页调 `/auth/login`）的 401 = 凭据有误 / 账号被锁 / 账号被禁用，必须走正常
 * 错误提示——否则用户点了登录「没有任何反应」（2026-09-20 实测）。
 */
export function isSessionExpired401(error: {
  response?: { status?: number };
  config?: { headers?: unknown };
}): boolean {
  if (error.response?.status !== 401) return false;
  return Boolean(headerValue(error.config?.headers, 'Authorization'));
}
