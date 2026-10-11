import { describe, expect, it } from 'vitest';
import { ANALYTICS_LOGIN_HREF, isAnalyticsLoginPath, isSessionExpired401 } from './login-path';

describe('isAnalyticsLoginPath', () => {
  it('accepts the SPA login URL and the unprefixed alias', () => {
    expect(ANALYTICS_LOGIN_HREF).toBe('/sa/login');
    expect(isAnalyticsLoginPath('/sa/login')).toBe(true);
    expect(isAnalyticsLoginPath('/login')).toBe(true);
    expect(isAnalyticsLoginPath('/sa/settings/profile')).toBe(false);
  });
});

describe('isSessionExpired401', () => {
  it('带登录态的 401 才算会话过期（清登录态 + 跳登录）', () => {
    expect(
      isSessionExpired401({ response: { status: 401 }, config: { headers: { Authorization: 'Bearer x' } } }),
    ).toBe(true);
    // axios 的 AxiosHeaders 实例走 get()
    const headers = { get: (name: string) => (name === 'Authorization' ? 'Bearer y' : undefined) };
    expect(isSessionExpired401({ response: { status: 401 }, config: { headers } })).toBe(true);
  });

  it('未带登录态的 401（登录接口自身）不按会话过期处理，交由正常错误提示', () => {
    expect(isSessionExpired401({ response: { status: 401 }, config: { headers: {} } })).toBe(false);
    expect(isSessionExpired401({ response: { status: 401 }, config: {} })).toBe(false);
    expect(isSessionExpired401({ response: { status: 401 } })).toBe(false);
  });

  it('非 401 一律不按会话过期处理', () => {
    const config = { headers: { Authorization: 'Bearer x' } };
    expect(isSessionExpired401({ response: { status: 403 }, config })).toBe(false);
    expect(isSessionExpired401({ response: { status: 500 }, config })).toBe(false);
  });
});
