import { AuthTokenService, TOKEN_PURPOSES, sha256Hex } from './auth-token.service';
import { DomainError } from '../../i18n/domain-error';

/**
 * 一次性令牌（AM-1/3/4）：签发即作废旧令牌、单用、过期、用途隔离、60 秒限流。
 */
function prismaMock() {
  return {
    saAuthToken: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: 't-1', ...data })),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      updateMany2: undefined,
    },
    saInvitation: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}
type PrismaMock = ReturnType<typeof prismaMock>;

describe('AuthTokenService（account-lifecycle-v2）', () => {
  it('签发：作废同邮箱同用途旧令牌，返回明文与 30 分钟期', async () => {
    const prisma = prismaMock();
    const svc = new AuthTokenService(prisma as never);
    const { token, expiresAt } = await svc.issue(TOKEN_PURPOSES.passwordReset, 'u-1', 'a@x.com');
    expect(token).toHaveLength(64);
    expect(prisma.saAuthToken.updateMany).toHaveBeenCalledWith({
      where: { email: 'a@x.com', purpose: 'password_reset', used_at: null },
      data: { used_at: expect.any(Date) },
    });
    const created = prisma.saAuthToken.create.mock.calls[0][0].data;
    expect(created.token_hash).toBe(sha256Hex(token));
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60000);
  });

  it('assertEmailQuota：60 秒内重复签发抛 429，超期放行', async () => {
    const prisma = prismaMock();
    const svc = new AuthTokenService(prisma as never);
    prisma.saAuthToken.findFirst.mockResolvedValue({ created_at: new Date(Date.now() - 30_000) });
    await expect(svc.assertEmailQuota('a@x.com')).rejects.toMatchObject({ errorCode: 'auth.mail.tooOften' });
    prisma.saAuthToken.findFirst.mockResolvedValue({ created_at: new Date(Date.now() - 61_000) });
    await expect(svc.assertEmailQuota('a@x.com')).resolves.toBeUndefined();
  });

  it('assertEmailQuota 覆盖邀请表（both）', async () => {
    const prisma = prismaMock();
    const svc = new AuthTokenService(prisma as never);
    prisma.saInvitation.findFirst.mockResolvedValue({ created_at: new Date(Date.now() - 10_000) });
    await expect(svc.assertEmailQuota('a@x.com', 'both')).rejects.toMatchObject({ errorCode: 'auth.mail.tooOften' });
  });

  it('consume：正常 → 标记 used_at；已用/过期/用途不符 → tokenLink.invalid', async () => {
    const prisma = prismaMock();
    const svc = new AuthTokenService(prisma as never);
    const row = {
      id: 't-1',
      user_id: 'u-1',
      purpose: TOKEN_PURPOSES.passwordReset,
      used_at: null,
      expires_at: new Date(Date.now() + 5 * 60000),
    };
    prisma.saAuthToken.findUnique.mockResolvedValue(row);
    const ok = await svc.consume(TOKEN_PURPOSES.passwordReset, 'plain');
    expect(ok).toBe(row);
    expect(prisma.saAuthToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't-1', used_at: null } }),
    );
    for (const broken of [
      { ...row, used_at: new Date() },
      { ...row, expires_at: new Date(Date.now() - 1000) },
      { ...row, purpose: TOKEN_PURPOSES.accountSetup },
      null,
    ]) {
      prisma.saAuthToken.findUnique.mockResolvedValue(broken);
      await expect(svc.consume(TOKEN_PURPOSES.passwordReset, 'plain')).rejects.toMatchObject({
        errorCode: 'auth.tokenLink.invalid',
      });
    }
  });

  it('并发双次消费：updateMany 命中 0 → tokenLink.invalid', async () => {
    const prisma = prismaMock();
    (prisma.saAuthToken.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    const svc = new AuthTokenService(prisma as never);
    prisma.saAuthToken.findUnique.mockResolvedValue({
      id: 't-1',
      user_id: 'u-1',
      purpose: TOKEN_PURPOSES.passwordReset,
      used_at: null,
      expires_at: new Date(Date.now() + 5 * 60000),
    });
    await expect(svc.consume(TOKEN_PURPOSES.passwordReset, 'plain')).rejects.toMatchObject({
      errorCode: 'auth.tokenLink.invalid',
    });
    void DomainError;
  });
});
