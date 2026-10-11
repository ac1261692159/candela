import { bindPlatformSmtpResolver, buildEmailFallback } from './platform-mail';

/** 平台邮件回落（v3.2 UX-7）：通道库/告警 env 之后的第三级 */
const ENV = { host: 'env-smtp.x.com', port: 465, secure: true, user: 'env-user', pass: 'env-pass', from: 'env@x.com' };

describe('buildEmailFallback（告警 email 回落链）', () => {
  afterEach(() => bindPlatformSmtpResolver(null));

  it('未绑解析器 → 告警 env 原样回退', async () => {
    const cfg = await buildEmailFallback(ENV);
    expect(cfg).toEqual(ENV);
  });

  it('平台解析器返回有效配置 → 平台优先', async () => {
    bindPlatformSmtpResolver(async () => ({ host: 'platform.x.com', port: 587, secure: false, user: 'u', pass: 'p', from: 'pf@x.com' }));
    const cfg = await buildEmailFallback(ENV);
    expect(cfg.host).toBe('platform.x.com');
    expect(cfg.from).toBe('pf@x.com');
  });

  it('平台未启用（null 或缺 host/from）→ 回落 env；解析器抛错也不炸', async () => {
    bindPlatformSmtpResolver(async () => null);
    expect((await buildEmailFallback(ENV)).host).toBe(ENV.host);
    bindPlatformSmtpResolver(async () => ({ host: '', port: 465, secure: true, user: '', pass: '', from: '' }));
    expect((await buildEmailFallback(ENV)).host).toBe(ENV.host);
    bindPlatformSmtpResolver(async () => {
      throw new Error('db down');
    });
    expect((await buildEmailFallback(ENV)).host).toBe(ENV.host);
  });
});
