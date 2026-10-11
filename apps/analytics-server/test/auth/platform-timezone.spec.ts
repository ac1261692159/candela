/** /auth/me 与 login 的平台时区下发（phase: clklog-analytics-timezone-v1，P1） */
import { AuthService } from '../../src/modules/auth/auth.service';
import { hashPassword } from '../../src/modules/auth/password.util';
import { TimezoneService } from '../../src/modules/time/timezone.service';

describe('AuthService platform_timezone', () => {
  it('me() 附实例级平台时区（默认 Asia/Shanghai）', async () => {
    const prisma = {} as never;
    const res = await new AuthService(prisma, new TimezoneService(undefined)).me({
      id: 'u1',
      username: 'neo',
      display_name: null,
      platform_role: 'none',
    });
    expect(res.platform_timezone).toBe('Asia/Shanghai');
  });

  it('me() 反映配置的平台时区', async () => {
    const prisma = {} as never;
    const res = await new AuthService(prisma, new TimezoneService({ platformTz: 'America/New_York' })).me({
      id: 'u1',
      username: 'neo',
      display_name: null,
      platform_role: 'none',
    });
    expect(res.platform_timezone).toBe('America/New_York');
  });

  it('login() 用户载荷带 platform_timezone', async () => {
    const user = {
      id: 'u1',
      username: 'neo',
      display_name: 'Neo',
      platform_role: 'none',
      status: 'active',
      default_project: null,
      locale: 'zh-CN',
      password_hash: hashPassword('secret123'),
    };
    const prisma = {
      saUser: { findUnique: async () => user, update: async () => ({}) },
      saUserToken: { create: async () => ({}) },
    } as never;
    const res = await new AuthService(prisma, new TimezoneService(undefined)).login('neo', 'secret123');
    expect(res.user.platform_timezone).toBe('Asia/Shanghai');
  });
});
