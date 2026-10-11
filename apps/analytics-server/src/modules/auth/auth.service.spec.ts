import { AuthService, AuthUser } from './auth.service';
import { AuthAuditService } from './auth-audit.service';
import { DomainError } from '../../i18n/domain-error';

/**
 * 账号生命周期 v1 服务单测（AL-3 锁定 / AL-4 重置 / AL-5 强制改密 / AL-6 自我保护 / AL-7 删除）。
 * Prisma 全量 mock；审计用 jest.fn 断言动作名。
 */

function prismaMock() {
  return {
    saUser: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn().mockResolvedValue({}),
    },
    saUserToken: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn(),
    },
    saProjectMember: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    saMemberGroupUser: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    saAssetAcl: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    dashboard: { count: jest.fn().mockResolvedValue(0) },
    card: { count: jest.fn().mockResolvedValue(0) },
    metaSavedMetric: { count: jest.fn().mockResolvedValue(0) },
    metaUserCohort: { count: jest.fn().mockResolvedValue(0) },
    metaUserTag: { count: jest.fn().mockResolvedValue(0) },
    metaFunnelTemplate: { count: jest.fn().mockResolvedValue(0) },
    aiWorkspace: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn().mockResolvedValue([]),
  };
}

type PrismaMock = ReturnType<typeof prismaMock>;

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u-1',
    username: 'alice',
    display_name: 'Alice',
    email: null,
    platform_role: 'none',
    status: 'active',
    // 与 password 'correctpw9' 对应的 scrypt 哈希由用例内现用现算，这里仅占位
    password_hash: '',
    default_project: null,
    locale: null,
    timezone: null,
    must_change_password: false,
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    created_by: 'admin',
    created_at: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeService(prisma: PrismaMock, audit?: { record: jest.Mock }) {
  const svc = new AuthService(prisma as never, undefined as never, audit as unknown as AuthAuditService);
  return svc;
}

const actor: AuthUser = { id: 'u-admin', username: 'admin', display_name: '管理员', platform_role: 'super_admin' };

describe('AuthService.login 登录锁定（AL-3）', () => {
  it('用户不存在：401 invalidCredentials，不动失败计数', async () => {
    const prisma = prismaMock();
    prisma.saUser.findUnique.mockResolvedValue(null);
    const svc = makeService(prisma);
    await expect(svc.login('ghost', 'x'.repeat(9))).rejects.toMatchObject({ errorCode: 'auth.login.invalidCredentials' });
    expect(prisma.saUser.update).not.toHaveBeenCalled();
  });

  it('密码错误：计数 +1 并审计 auth_login_failed', async () => {
    const prisma = prismaMock();
    prisma.saUser.findUnique.mockResolvedValue(activeUser({ password_hash: 'a:b' }));
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = makeService(prisma, audit);
    await expect(svc.login('alice', 'wrong-password')).rejects.toMatchObject({ errorCode: 'auth.login.invalidCredentials' });
    expect(prisma.saUser.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failed_login_count: 1 } }),
    );
    expect(audit.record).toHaveBeenCalledWith('auth_login_failed', 'alice', expect.objectContaining({ fail_count: 1 }));
  });

  it('连续第 5 次错误：置锁定 15 分钟、计数清零', async () => {
    const prisma = prismaMock();
    prisma.saUser.findUnique.mockResolvedValue(activeUser({ password_hash: 'a:b', failed_login_count: 4 }));
    const before = Date.now();
    const svc = makeService(prisma, { record: jest.fn().mockResolvedValue(undefined) });
    await expect(svc.login('alice', 'wrong-password')).rejects.toMatchObject({ errorCode: 'auth.login.invalidCredentials' });
    const call = prisma.saUser.update.mock.calls[0][0] as { data: { failed_login_count: number; locked_until: Date } };
    expect(call.data.failed_login_count).toBe(0);
    const lockMs = call.data.locked_until.getTime() - before;
    expect(lockMs).toBeGreaterThan(14 * 60000);
    expect(lockMs).toBeLessThanOrEqual(15 * 60000 + 1000);
  });

  it('锁定期内即使密码正确也 401 locked 并审计', async () => {
    const prisma = prismaMock();
    prisma.saUser.findUnique.mockResolvedValue(
      activeUser({ locked_until: new Date(Date.now() + 10 * 60000) }),
    );
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = makeService(prisma, audit);
    await expect(svc.login('alice', 'whatever123')).rejects.toMatchObject({ errorCode: 'auth.login.locked' });
    expect(audit.record).toHaveBeenCalledWith('auth_login_locked', 'alice', expect.anything());
    expect(prisma.saUserToken.create).not.toHaveBeenCalled();
  });

  it('锁定已过期的账号可以正常走密码校验', async () => {
    const prisma = prismaMock();
    prisma.saUser.findUnique.mockResolvedValue(
      activeUser({ password_hash: 'a:b', locked_until: new Date(Date.now() - 60000) }),
    );
    const svc = makeService(prisma);
    await expect(svc.login('alice', 'wrong-password')).rejects.toMatchObject({ errorCode: 'auth.login.invalidCredentials' });
  });
});

describe('AuthService 用户管理（AL-5/6/7）', () => {
  it('createUser：写入 created_by 与 must_change_password，审计 auth_user_create', async () => {
    const prisma = prismaMock();
    prisma.saUser.findUnique.mockResolvedValue(null);
    prisma.saUser.findFirst.mockResolvedValue(null);
    prisma.saUser.create.mockResolvedValue({ id: 'u-2', username: 'bob' });
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = makeService(prisma, audit);
    await svc.createUser('admin', { username: 'bob', password: 'sup3r-secret', email: 'Bob@X.com ' });
    const data = prisma.saUser.create.mock.calls[0][0].data;
    expect(data.created_by).toBe('admin');
    expect(data.must_change_password).toBe(true);
    expect(data.email).toBe('bob@x.com'); // 规整为小写
    expect(audit.record).toHaveBeenCalledWith('auth_user_create', 'admin', expect.objectContaining({ username: 'bob' }));
  });

  it('createUser：弱密码/重名/邮箱重复按码拒绝', async () => {
    const prisma = prismaMock();
    const svc = makeService(prisma);
    await expect(svc.createUser('admin', { username: 'bob', password: '12345678' })).rejects.toMatchObject({
      errorCode: 'auth.password.weak',
    });
    prisma.saUser.findUnique.mockResolvedValue(activeUser({ username: 'bob' }));
    await expect(svc.createUser('admin', { username: 'bob', password: 'sup3r-secret' })).rejects.toMatchObject({
      errorCode: 'auth.username.exists',
    });
    prisma.saUser.findUnique.mockResolvedValue(null);
    prisma.saUser.findFirst.mockResolvedValue(activeUser({ email: 'dup@x.com' }));
    await expect(
      svc.createUser('admin', { username: 'carol', password: 'sup3r-secret', email: 'dup@x.com' }),
    ).rejects.toMatchObject({ errorCode: 'auth.email.exists' });
  });

  it('updateUser：不允许改自己的平台角色', async () => {
    const prisma = prismaMock();
    prisma.saUser.findUnique.mockResolvedValue(activeUser({ id: 'u-admin', username: 'admin' }));
    const svc = makeService(prisma);
    await expect(svc.updateUser(actor, 'u-admin', { platform_role: 'none' })).rejects.toMatchObject({
      errorCode: 'auth.self.forbidden',
    });
  });

  it('setUserStatus / resetUserPassword / deleteUser：对自己一律 409', async () => {
    const prisma = prismaMock();
    const svc = makeService(prisma);
    await expect(svc.setUserStatus(actor, 'u-admin', 'disabled')).rejects.toMatchObject({ errorCode: 'auth.self.forbidden' });
    await expect(svc.resetUserPassword(actor, 'u-admin')).rejects.toMatchObject({ errorCode: 'auth.self.forbidden' });
    await expect(svc.deleteUser(actor, 'u-admin')).rejects.toMatchObject({ errorCode: 'auth.self.forbidden' });
  });

  it('resetUserPassword：返回一次性临时密码、置强制改密、吊销全部会话、审计', async () => {
    const prisma = prismaMock();
    prisma.saUser.findUnique.mockResolvedValue(activeUser({ id: 'u-2' }));
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = makeService(prisma, audit);
    const res = await svc.resetUserPassword(actor, 'u-2');
    expect(res.temporary_password).toHaveLength(12);
    const data = prisma.saUser.update.mock.calls[0][0].data;
    expect(data.must_change_password).toBe(true);
    expect(data.failed_login_count).toBe(0);
    expect(prisma.saUserToken.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'u-2' } });
    expect(audit.record).toHaveBeenCalledWith('auth_password_reset', 'admin', { user_id: 'u-2' });
  });

  it('deleteUser：名下有资产时 409 hasAssets，无资产走事务级联删除', async () => {
    const prisma = prismaMock();
    prisma.saUser.findUnique.mockResolvedValue(activeUser({ id: 'u-2' }));
    prisma.dashboard.count.mockResolvedValue(2);
    const svc = makeService(prisma);
    await expect(svc.deleteUser(actor, 'u-2')).rejects.toMatchObject({ errorCode: 'auth.user.hasAssets' });
    expect(prisma.$transaction).not.toHaveBeenCalled();

    prisma.dashboard.count.mockResolvedValue(0);
    await svc.deleteUser(actor, 'u-2');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('unlockUser：清计数与锁定并审计（幂等）', async () => {
    const prisma = prismaMock();
    prisma.saUser.findUnique.mockResolvedValue(activeUser({ id: 'u-2' }));
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = makeService(prisma, audit);
    await svc.unlockUser(actor, 'u-2');
    expect(prisma.saUser.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failed_login_count: 0, locked_until: null } }),
    );
    expect(audit.record).toHaveBeenCalledWith('auth_user_unlock', 'admin', { user_id: 'u-2' });
  });
});

describe('AuthService.changePassword（AL-2/AL-4）', () => {
  it('新密码按策略校验，成功后解强制改密并保留当前会话', async () => {
    const prisma = prismaMock();
    // 先用真实哈希，保证旧密码校验通过
    const { hashPassword } = jest.requireActual('./password.util') as typeof import('./password.util');
    prisma.saUser.findUnique.mockResolvedValue(activeUser({ id: 'u-2', password_hash: hashPassword('old-secret-9') }));
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = makeService(prisma, audit);
    await expect(
      svc.changePassword({ ...actor, id: 'u-2', username: 'alice' }, { old_password: 'old-secret-9', new_password: '12345678' }, 'tok'),
    ).rejects.toMatchObject({ errorCode: 'auth.password.weak' });
    await svc.changePassword({ ...actor, id: 'u-2', username: 'alice' }, { old_password: 'old-secret-9', new_password: 'n3w-secret-9' }, 'tok');
    const data = prisma.saUser.update.mock.calls[0][0].data;
    expect(data.must_change_password).toBe(false);
    expect(data.failed_login_count).toBe(0);
    expect(prisma.saUserToken.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'u-2', token: { not: 'tok' } } });
    expect(audit.record).toHaveBeenCalledWith('auth_password_change', 'alice', { user_id: 'u-2' });
  });
});

describe('AuthAuditService：写失败不阻断主流程', () => {
  it('opsActionLog.create 抛错时 record 静默吞掉', async () => {
    const { AuthAuditService: RealAudit } = jest.requireActual('./auth-audit.service') as typeof import('./auth-audit.service');
    const prisma = { opsActionLog: { create: jest.fn().mockRejectedValue(new Error('db down')) } };
    const audit = new RealAudit(prisma as never);
    await expect(audit.record('auth_login_success', 'alice', { username: 'alice' })).resolves.toBeUndefined();
  });
});
