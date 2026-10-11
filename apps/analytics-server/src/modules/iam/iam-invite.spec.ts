import { IamService } from './iam.service';
import { sha256Hex, TOKEN_PURPOSES } from '../auth/auth-token.service';
import type { AuthUser } from '../auth/auth.service';

/** 项目邀请（AM-5/6/7）：直接入会 / 邮件邀请 / 注册落地 / 邮箱匹配约束 */
function prismaMock() {
  return {
    saUser: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'u-new', ...data })),
    },
    saProjectMember: {
      findUnique: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
    },
    saInvitation: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'inv-1', ...data })),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    saAuthToken: { findFirst: jest.fn().mockResolvedValue(null) },
  };
}
type PrismaMock = ReturnType<typeof prismaMock>;

const mailMock = () => ({
  enabled: true,
  assertConfigured: jest.fn().mockResolvedValue(undefined),
  effectiveConfig: jest.fn().mockResolvedValue({ enabled: true }),
  buildLink: jest.fn().mockImplementation(async (p: string) => `https://a.example.com${p}`),
  sendTemplate: jest.fn().mockResolvedValue(true),
});
const tokensMock = () => ({
  assertEmailQuota: jest.fn().mockResolvedValue(undefined),
});
const auditMock = () => ({ record: jest.fn().mockResolvedValue(undefined) });

const inviter: AuthUser = { id: 'u-admin', username: 'admin', display_name: '管理员', platform_role: 'super_admin' };

function makeIam(prisma: PrismaMock, mail = mailMock(), tokens = tokensMock(), audit = auditMock()) {
  return { iam: new IamService(prisma as never, mail as never, tokens as never, audit as never), mail, tokens, audit };
}

function inviteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    project_name: 'clklogapp',
    email: 'new@x.com',
    role_key: 'analyst',
    token_hash: sha256Hex('plain-token'),
    invited_by: 'admin',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    accepted_at: null,
    ...overrides,
  };
}

describe('IamService.createInvitation（AM-5/6）', () => {
  it('邮箱已有账号 → 直接建成员 + 通知邮件（不走邀请表）', async () => {
    const prisma = prismaMock();
    prisma.saUser.findFirst.mockResolvedValue({ id: 'u-9', email: 'old@x.com', locale: 'zh-CN' });
    prisma.saProjectMember.findUnique.mockResolvedValue(null);
    const { iam, mail, audit } = makeIam(prisma);
    const res = await iam.createInvitation('clklogapp', inviter, { email: 'old@x.com', role_key: 'analyst' });
    expect(res.added).toBe(true);
    expect(prisma.saProjectMember.create).toHaveBeenCalledWith({
      data: { project_name: 'clklogapp', user_id: 'u-9', role_key: 'analyst', expires_at: null },
    });
    expect(mail.sendTemplate).toHaveBeenCalledWith('old@x.com', 'zh-CN', 'inviteNotify', expect.anything());
    expect(audit.record).toHaveBeenCalledWith('auth_invite_create', 'admin', expect.objectContaining({ mode: 'direct' }));
  });

  it('已是成员 → 409 alreadyMember', async () => {
    const prisma = prismaMock();
    prisma.saUser.findFirst.mockResolvedValue({ id: 'u-9' });
    prisma.saProjectMember.findUnique.mockResolvedValue({ id: 'm-1' });
    const { iam } = makeIam(prisma);
    await expect(iam.createInvitation('clklogapp', inviter, { email: 'old@x.com', role_key: 'analyst' })).rejects.toMatchObject({
      errorCode: 'iam.invite.alreadyMember',
    });
  });

  it('未注册邮箱 → 作废旧邀请 + 签发 7 天邀请 + 发信', async () => {
    const prisma = prismaMock();
    prisma.saUser.findFirst.mockResolvedValue(null);
    const { iam, mail, tokens } = makeIam(prisma);
    const res = await iam.createInvitation('clklogapp', inviter, { email: 'new@x.com', role_key: 'member' });
    expect(res.invited).toBe(true);
    expect(tokens.assertEmailQuota).toHaveBeenCalledWith('new@x.com', 'both');
    expect(prisma.saInvitation.updateMany).toHaveBeenCalled(); // 作废旧邀请
    const created = prisma.saInvitation.create.mock.calls[0][0].data;
    expect(created.expires_at.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(mail.sendTemplate).toHaveBeenCalledWith(
      'new@x.com',
      null,
      'invite',
      expect.objectContaining({ link: expect.stringContaining('/sa/invite/'), role: 'member' }),
    );
  });

  it('owner/analysis_admin 角色一律拒放', async () => {
    const prisma = prismaMock();
    const { iam } = makeIam(prisma);
    for (const role of ['project_owner', 'analysis_admin', 'super_admin']) {
      await expect(iam.createInvitation('clklogapp', inviter, { email: 'n@x.com', role_key: role })).rejects.toMatchObject({
        errorCode: 'iam.role.invalid',
      });
    }
  });
});

describe('IamService 邀请接受链路（AM-5/7）', () => {
  it('inviteInfo：有效邀请返回公开字段；过期/已接受 → 404', async () => {
    const prisma = prismaMock();
    prisma.saInvitation.findUnique.mockResolvedValue(inviteRow());
    const { iam } = makeIam(prisma);
    const info = await iam.inviteInfo('plain-token');
    expect(info.email).toBe('new@x.com');
    prisma.saInvitation.findUnique.mockResolvedValue(inviteRow({ expires_at: new Date(Date.now() - 1000) }));
    await expect(iam.inviteInfo('plain-token')).rejects.toMatchObject({ errorCode: 'auth.tokenLink.invalid' });
    prisma.saInvitation.findUnique.mockResolvedValue(inviteRow({ accepted_at: new Date() }));
    await expect(iam.inviteInfo('plain-token')).rejects.toMatchObject({ errorCode: 'auth.tokenLink.invalid' });
  });

  it('registerViaInvite：建号绑定邀请邮箱 + 入会 + 消费', async () => {
    const prisma = prismaMock();
    prisma.saInvitation.findUnique.mockResolvedValue(inviteRow());
    prisma.saUser.findUnique.mockResolvedValue(null);
    const { iam, audit } = makeIam(prisma);
    await iam.registerViaInvite('plain-token', { username: 'neo', display_name: 'Neo', password: 'sup3r-secret' });
    const userData = prisma.saUser.create.mock.calls[0][0].data;
    expect(userData.email).toBe('new@x.com');
    expect(userData.created_by).toBe('admin');
    expect(prisma.saProjectMember.create).toHaveBeenCalledWith({
      data: { project_name: 'clklogapp', user_id: 'u-new', role_key: 'analyst', expires_at: null },
    });
    expect(prisma.saInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { accepted_at: expect.any(Date) } }),
    );
    expect(audit.record).toHaveBeenCalledWith('auth_invite_accept', 'neo', expect.objectContaining({ mode: 'register' }));
  });

  it('registerViaInvite：弱密码拒、重名拒', async () => {
    const prisma = prismaMock();
    prisma.saInvitation.findUnique.mockResolvedValue(inviteRow());
    const { iam } = makeIam(prisma);
    await expect(iam.registerViaInvite('plain-token', { username: 'neo', password: '12345678' })).rejects.toMatchObject({
      errorCode: 'auth.password.weak',
    });
    prisma.saUser.findUnique.mockResolvedValue({ id: 'u-x' });
    await expect(iam.registerViaInvite('plain-token', { username: 'neo', password: 'sup3r-secret' })).rejects.toMatchObject({
      errorCode: 'auth.username.exists',
    });
  });

  it('acceptInvite：邮箱不匹配 403；匹配 → upsert 成员', async () => {
    const prisma = prismaMock();
    prisma.saInvitation.findUnique.mockResolvedValue(inviteRow());
    const { iam } = makeIam(prisma);
    await expect(
      iam.acceptInvite('plain-token', { id: 'u-7', username: 'other', display_name: null, platform_role: 'none', email: 'other@x.com' }),
    ).rejects.toMatchObject({ errorCode: 'iam.invite.emailMismatch' });
    await iam.acceptInvite('plain-token', { id: 'u-7', username: 'match', display_name: null, platform_role: 'none', email: 'New@x.com' });
    expect(prisma.saProjectMember.upsert).toHaveBeenCalled();
  });

  it('撤销：已撤销/已接受 → 404；正常撤销后审计', async () => {
    const prisma = prismaMock();
    prisma.saInvitation.findUnique.mockResolvedValue(inviteRow());
    const { iam, audit } = makeIam(prisma);
    await iam.revokeInvitation(inviter, 'inv-1');
    expect(audit.record).toHaveBeenCalledWith('auth_invite_revoke', 'admin', expect.anything());
    prisma.saInvitation.findUnique.mockResolvedValue(inviteRow({ accepted_at: new Date(0) }));
    await expect(iam.revokeInvitation(inviter, 'inv-1')).rejects.toMatchObject({ errorCode: 'iam.invite.notFound' });
  });

  it('占位作废（accepted_at=epoch）的邀请对接受方同样无效', async () => {
    const prisma = prismaMock();
    prisma.saInvitation.findUnique.mockResolvedValue(inviteRow({ accepted_at: new Date(0) }));
    const { iam } = makeIam(prisma);
    await expect(iam.inviteInfo('plain-token')).rejects.toMatchObject({ errorCode: 'auth.tokenLink.invalid' });
  });
});

void TOKEN_PURPOSES;
