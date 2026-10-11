import { AuthMailService } from './auth-mail.service';
import { decryptSecret, parseMasterKey } from '../alerting/channels/channel-crypto';
import { generateMasterKey } from '../alerting/channels/channel-crypto';

/** 网页 SMTP 配置（v1.1 增补：AM-11/12/13） */
const KEY_B64 = generateMasterKey();

function boot(configKey = KEY_B64) {
  return {
    env: {
      enabled: false,
      host: '',
      port: 465,
      user: '',
      pass: '',
      from: '',
      secure: true,
      publicBaseUrl: 'https://a.example.com',
    },
    configKey,
  };
}

function prismaMock() {
  return {
    saAuthMailConfig: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
}
type PrismaMock = ReturnType<typeof prismaMock>;

function makeService(prisma: PrismaMock, bootCfg = boot()) {
  const svc = new AuthMailService(bootCfg as never, prisma as never);
  return svc;
}

describe('AuthMailService.saveConfig（AM-11/13）', () => {
  it('写入新密码 → AES-256-GCM 密文入库且可解密，明文不出现', async () => {
    const prisma = prismaMock();
    const svc = makeService(prisma);
    await svc.saveConfig('admin', { enabled: true, host: 'smtp.x.com', user: 'u', from: 'noreply@x.com', pass: 'p@ss-word' });
    const saved = prisma.saAuthMailConfig.upsert.mock.calls[0][0].create;
    expect(saved.secret_cipher).toBeTruthy();
    expect(saved.secret_cipher).not.toContain('p@ss-word');
    const key = parseMasterKey(KEY_B64)!;
    expect(decryptSecret(saved.secret_cipher, key)).toBe('p@ss-word');
  });

  it('不传 pass → 保留旧密文；主密钥缺失时传 pass → 400 configKeyMissing', async () => {
    const prisma = prismaMock();
    prisma.saAuthMailConfig.findUnique.mockResolvedValue({
      secret_cipher: 'v1:iv:tag:data',
      enabled: false,
      host: 'x',
      port: 465,
      secure: true,
      user: '',
      mail_from: '',
      updated_by: 'admin',
      updated_at: new Date('2026-09-18T00:00:00Z'),
    });
    const svc = makeService(prisma);
    await svc.saveConfig('admin', { enabled: true, host: 'smtp.x.com' });
    expect(prisma.saAuthMailConfig.upsert.mock.calls[0][0].update.secret_cipher).toBe('v1:iv:tag:data');

    const svcNoKey = makeService(prismaMock(), boot(''));
    await expect(svcNoKey.saveConfig('admin', { enabled: true, host: 'smtp.x.com', pass: 'x' })).rejects.toMatchObject({
      errorCode: 'auth.mail.configKeyMissing',
    });
  });

  it('启用但 host 为空 → 400 hostRequired', async () => {
    const prisma = prismaMock();
    const svc = makeService(prisma);
    await expect(svc.saveConfig('admin', { enabled: true, host: '  ' })).rejects.toMatchObject({
      errorCode: 'auth.mail.hostRequired',
    });
  });
});

describe('AuthMailService.effectiveConfig（AM-12：库内优先，env 兜底）', () => {
  it('库内 enabled → 用库值（含解密密码）；库内不存在/未启用 → 回落 env', async () => {
    const prisma = prismaMock();
    // 库内行：enabled + host + 密文
    const key = parseMasterKey(KEY_B64)!;
    const { encryptSecret } = jest.requireActual('../alerting/channels/channel-crypto') as typeof import('../alerting/channels/channel-crypto');
    prisma.saAuthMailConfig.findUnique.mockResolvedValue({
      enabled: true,
      host: 'db-smtp.x.com',
      port: 587,
      secure: false,
      user: 'dbuser',
      mail_from: 'db@x.com',
      secret_cipher: encryptSecret('db-pass', key),
    });
    const envBoot = boot();
    envBoot.env = { ...envBoot.env, enabled: true, host: 'env-smtp.x.com', user: 'envuser', pass: 'env-pass', from: 'env@x.com' };
    const svc = makeService(prisma, envBoot);
    const cfg = await svc.effectiveConfig();
    expect(cfg.host).toBe('db-smtp.x.com');
    expect(cfg.pass).toBe('db-pass');
    // 缓存：第二次不再查库
    await svc.effectiveConfig();
    expect(prisma.saAuthMailConfig.findUnique).toHaveBeenCalledTimes(1);

    // 库内行未启用 → 回落 env
    const prisma2 = prismaMock();
    prisma2.saAuthMailConfig.findUnique.mockResolvedValue({ enabled: false, host: 'db-smtp.x.com' });
    const svc2 = makeService(prisma2, envBoot);
    const cfg2 = await svc2.effectiveConfig();
    expect(cfg2.host).toBe('env-smtp.x.com');
    expect(cfg2.pass).toBe('env-pass');
  });

  it('密文解密失败 → 整体按未配置处理并告警，不炸主流程', async () => {
    const prisma = prismaMock();
    prisma.saAuthMailConfig.findUnique.mockResolvedValue({
      enabled: true,
      host: 'db-smtp.x.com',
      port: 465,
      secure: true,
      user: 'dbuser',
      mail_from: 'db@x.com',
      secret_cipher: 'bad:cipher:here',
    });
    const envBoot = boot();
    envBoot.env = { ...envBoot.env, enabled: true, host: 'env-smtp.x.com', pass: 'env-pass', from: 'env@x.com' };
    const svc = makeService(prisma, envBoot);
    const cfg = await svc.effectiveConfig();
    expect(cfg.enabled).toBe(false); // 损坏时按未配置处理（设计增补 v1.1）
  });
});

describe('AuthMailService.adminView（AM-11：永不回显秘密）', () => {
  it('库内视图只有 has_password 标记；env 视图标注 source=env', async () => {
    const prisma = prismaMock();
    prisma.saAuthMailConfig.findUnique.mockResolvedValue({
      enabled: true,
      host: 'h',
      port: 465,
      secure: true,
      user: 'u',
      mail_from: 'f',
      secret_cipher: 'v1:iv:tag:data',
      updated_by: 'admin',
      updated_at: new Date('2026-09-18T00:00:00Z'),
    });
    const svc = makeService(prisma);
    const view = await svc.adminView();
    expect(view.source).toBe('db');
    expect(view.has_password).toBe(true);
    expect(JSON.stringify(view)).not.toContain('v1:iv:tag');

    const prisma2 = prismaMock();
    const envBoot = boot();
    envBoot.env = { ...envBoot.env, enabled: true, host: 'env-h', pass: 'env-pass', from: 'f' };
    const svc2 = makeService(prisma2, envBoot);
    const view2 = await svc2.adminView();
    expect(view2.source).toBe('env');
    expect(JSON.stringify(view2)).not.toContain('env-pass');
  });
});

void decryptSecret;
