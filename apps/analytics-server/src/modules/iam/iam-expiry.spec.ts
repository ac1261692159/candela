import { IamService } from './iam.service';
import { AuthService } from '../auth/auth.service';

/** 成员有效期 + 会话管理（phase: clklog-analytics-account-lifecycle-v3，AL3-1/3/5/6） */

function iamPrismaMock() {
  return {
    saUser: { findUnique: jest.fn(), findFirst: jest.fn() },
    saProjectMember: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'm-1', ...data })),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    saMemberGroupUser: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('成员有效期（AL3-1/AL3-3）', () => {
  it('到期行在 evaluate 中直接角色失效', async () => {
    const prisma = iamPrismaMock();
    prisma.saUser.findUnique.mockResolvedValue({ id: 'u-1', status: 'active', platform_role: 'none' });
    prisma.saProjectMember.findUnique.mockResolvedValue({
      id: 'm-1',
      role_key: 'analyst',
      expires_at: new Date(Date.now() - 1000), // 已到期
      data_policy: null,
    });
    const iam = new IamService(prisma as never);
    const ctx = await iam.evaluate('u-1', 'clklogapp');
    expect(ctx.member).toBe(false);
    expect(ctx.role_key).toBeNull();
  });

  it('未到期行照常生效', async () => {
    const prisma = iamPrismaMock();
    prisma.saUser.findUnique.mockResolvedValue({ id: 'u-1', status: 'active', platform_role: 'none' });
    prisma.saProjectMember.findUnique.mockResolvedValue({
      id: 'm-1',
      role_key: 'analyst',
      expires_at: new Date(Date.now() + 86400_000),
      data_policy: null,
    });
    const iam = new IamService(prisma as never);
    const ctx = await iam.evaluate('u-1', 'clklogapp');
    expect(ctx.member).toBe(true);
    expect(ctx.role_key).toBe('analyst');
  });

  it('patchMember：owner 行禁设有效期；非法时间 400；正常写入并审计', async () => {
    const prisma = iamPrismaMock();
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const iam = new IamService(prisma as never, undefined, undefined, audit as never);
    prisma.saProjectMember.findFirst.mockResolvedValue({ id: 'm-1', role_key: 'project_owner', project_name: 'clklogapp' });
    await expect(
      iam.patchMember('clklogapp', 'm-1', { expires_at: '2026-12-01' }, 'admin'),
    ).rejects.toMatchObject({ errorCode: 'iam.member.ownerRoleForbidden' });

    prisma.saProjectMember.findFirst.mockResolvedValue({ id: 'm-1', role_key: 'analyst', project_name: 'clklogapp' });
    await expect(iam.patchMember('clklogapp', 'm-1', { expires_at: 'not-a-date' }, 'admin')).rejects.toMatchObject({
      errorCode: 'iam.member.expiryInvalid',
    });
    const res = await iam.patchMember('clklogapp', 'm-1', { expires_at: '2026-12-01T00:00:00Z' }, 'admin');
    expect(prisma.saProjectMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expires_at: new Date('2026-12-01T00:00:00Z') }) }),
    );
    expect(audit.record).toHaveBeenCalledWith('auth_member_expiry', 'admin', expect.objectContaining({ member_id: 'm-1' }));
    void res;
  });
});

function authPrismaMock() {
  return {
    saUser: { findUnique: jest.fn() },
    saUserToken: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  };
}

describe('会话管理（AL3-5/6）', () => {
  it('本人：不可吊销当前会话；其余可吊销；批量留当前', async () => {
    const prisma = authPrismaMock();
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = new (AuthService as unknown as { new (p: unknown, tz?: unknown, a?: unknown): AuthService })(prisma, undefined, audit);
    const me = { id: 'u-1', username: 'alice', display_name: null, platform_role: 'none' as const };
    prisma.saUserToken.findUnique.mockResolvedValue({ id: 's-1', user_id: 'u-1', token: 'current-tok', created_at: new Date(), expires_at: null });
    await expect(svc.revokeMySession(me, 's-1', 'current-tok')).rejects.toMatchObject({ errorCode: 'auth.session.revokeCurrent' });

    prisma.saUserToken.findUnique.mockResolvedValue({ id: 's-2', user_id: 'u-1', token: 'other-tok', created_at: new Date(), expires_at: null });
    await svc.revokeMySession(me, 's-2', 'current-tok');
    expect(prisma.saUserToken.deleteMany).toHaveBeenCalledWith({ where: { id: 's-2' } });

    await svc.revokeOtherSessions(me, 'current-tok');
    expect(prisma.saUserToken.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'u-1', token: { not: 'current-tok' } } });
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('管理员：目标即自己当前会话 → 409；可吊销他人会话与整户下线', async () => {
    const prisma = authPrismaMock();
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = new (AuthService as unknown as { new (p: unknown, tz?: unknown, a?: unknown): AuthService })(prisma, undefined, audit);
    const admin = { id: 'u-adm', username: 'admin', display_name: null, platform_role: 'super_admin' as const };
    prisma.saUser.findUnique.mockResolvedValue({ id: 'u-2', username: 'bob' });
    prisma.saUserToken.findUnique.mockResolvedValue({ id: 's-3', user_id: 'u-adm', token: 'my-current', created_at: new Date(), expires_at: null });
    await expect(svc.adminRevokeSession(admin, 'u-adm', 's-3', 'my-current')).rejects.toMatchObject({
      errorCode: 'auth.session.revokeCurrent',
    });

    prisma.saUserToken.findUnique.mockResolvedValue({ id: 's-4', user_id: 'u-2', token: 'bob-tok', created_at: new Date(), expires_at: null });
    await svc.adminRevokeSession(admin, 'u-2', 's-4', 'my-current');
    expect(prisma.saUserToken.deleteMany).toHaveBeenCalledWith({ where: { id: 's-4' } });

    await svc.adminRevokeAllSessions(admin, 'u-2');
    expect(prisma.saUserToken.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'u-2' } });
  });

  it('会话行被冒用（id 属他人）→ 404', async () => {
    const prisma = authPrismaMock();
    const svc = new (AuthService as unknown as { new (p: unknown, tz?: unknown, a?: unknown): AuthService })(prisma, undefined, undefined);
    prisma.saUserToken.findUnique.mockResolvedValue({ id: 's-9', user_id: 'u-x', token: 'x', created_at: new Date(), expires_at: null });
    await expect(
      svc.revokeMySession({ id: 'u-1', username: 'a', display_name: null, platform_role: 'none' }, 's-9', 'current'),
    ).rejects.toMatchObject({ errorCode: 'auth.session.notFound' });
  });
});
