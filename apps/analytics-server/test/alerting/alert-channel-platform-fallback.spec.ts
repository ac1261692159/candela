// 必须在 import DTO（class-validator 装饰器）之前 polyfill reflect-metadata（同 test/alerting/alert-channels.spec.ts）
import 'reflect-metadata';

/**
 * 告警 email 通道的平台邮件回落（phase: clklog-analytics-account-lifecycle-v3 增补 v3.2 修订）。
 *
 * v3.2 只改了**发送侧**的三级回落，可用性判定（`capabilities()`）与通道列表（`list()`）仍只看告警侧配置，
 * 导致「能发但建不出联系人」（生产现象：平台邮件已配好、通道配置页仍显示「未启用」、联系人里选不到邮件）。
 * 本套用例把判定口径钉住：与发送侧同一条件（`enabled && host && from`）、告警侧优先、缺省不影响其他通道。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    alerting: {
      configKey: '',
      smtp: { host: '', port: 465, user: '', pass: '', from: '', secure: true },
      sms: { secretId: '', secretKey: '', sdkAppId: '', signName: '', templateId: '', region: 'ap-guangzhou' },
    },
    background_workers: false,
    __specConfigMock: true,
  },
}));

import { AlertChannelConfigService } from '../../src/modules/alerting/channels/channel-config.service';
import { CHANNELS } from '../../src/modules/alerting/channels/channel-registry';
import { AlertAuditService } from '../../src/modules/alerting/alert-audit.service';
import { AuthMailService } from '../../src/modules/auth/auth-mail.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';
import { Test } from '@nestjs/testing';

/** 记录实际建出的 SMTP transport：用来断言「用的是哪一套凭证」 */
const mailTransports: Record<string, unknown>[] = [];
jest.mock('nodemailer', () => ({
  createTransport: (opts: Record<string, unknown>) => {
    mailTransports.push(opts);
    return { sendMail: async () => undefined, close: () => undefined, verify: async () => undefined };
  },
}));

/** 平台邮件通道的生效配置（AuthMailService.effectiveConfig 的投影） */
const platformConfig = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  host: 'smtp.163.com',
  port: 465,
  secure: true,
  user: 'wwmonitor@163.com',
  pass: 'secret',
  from: 'wwmonitor@163.com',
  publicBaseUrl: '',
  ...over,
});

const prisma = (row: Record<string, unknown> | null = null) =>
  ({
    alertChannelConfig: {
      // 按 channel 过滤：否则 readConfig('sms_*') 会拿到 smtp 那一行，暂停判定会串通道
      findUnique: async (args?: { where?: { channel?: string } }) =>
        row && (!args?.where?.channel || args.where.channel === row.channel) ? row : null,
      // 支持按 muted 过滤：capabilities() 用一次 findMany({ where: { muted: true } }) 拿暂停集合
      findMany: async (args?: { where?: { muted?: boolean } }) => {
        if (!row) return [];
        if (args?.where?.muted === true && !row.muted) return [];
        return [row];
      },
    },
  }) as never;

const audit = { write: async () => undefined } as never;

const build = (
  platform: Record<string, unknown> | null = platformConfig(),
  row: Record<string, unknown> | null = null,
) => {
  const platformMail = platform ? ({ effectiveConfig: async () => platform } as never) : undefined;
  return new AlertChannelConfigService(prisma(row), audit, platformMail);
};

describe('告警 email 通道的平台邮件回落（v3.2 修订）', () => {
  it('仅平台邮件可用 → email 可用且标记 platform_fallback；短信等其他通道不受影响', async () => {
    const caps = await build().capabilities();
    expect(caps.email).toMatchObject({ available: true, reason: null, reason_key: null, platform_fallback: true });
    expect(caps.sms).toMatchObject({ available: false, platform_fallback: false });
    // 无凭证要求的通道（群机器人）恒可用且与回落无关
    expect(caps.feishu_webhook).toMatchObject({ available: true, platform_fallback: false });
  });

  it('平台邮件未启用 / 缺 host / 缺 from → 回落不成立，回到原有「未配置」原因', async () => {
    for (const broken of [
      { enabled: false },
      { host: '' },
      { from: '' },
    ]) {
      const caps = await build(platformConfig(broken)).capabilities();
      expect(caps.email).toMatchObject({
        available: false,
        platform_fallback: false,
        reason_key: 'alerting:channel.configMissing',
      });
      expect(caps.email.reason).toContain('邮件（SMTP）');
    }
  });

  it('未注入平台邮件服务（AuthModule 缺失）→ 行为与今日一致，不抛错', async () => {
    const caps = await build(null).capabilities();
    expect(caps.email).toMatchObject({ available: false, platform_fallback: false });
  });

  it('平台配置读取抛错 → 视为不可用，不向上抛', async () => {
    const svc = new AlertChannelConfigService(
      prisma(),
      audit,
      { effectiveConfig: async () => { throw new Error('db_down'); } } as never,
    );
    const caps = await svc.capabilities();
    expect(caps.email).toMatchObject({ available: false, platform_fallback: false });
  });

  it('告警侧库内行已启用 → 告警侧优先，platform_fallback 保持 false', async () => {
    const row = {
      channel: 'smtp',
      enabled: true,
      config_json: JSON.stringify({ host: 'alert.example.com', port: 465, secure: true, from: 'a@x.com' }),
      secret_cipher: null,
    };
    const caps = await build(platformConfig(), row).capabilities();
    expect(caps.email).toMatchObject({ available: true, platform_fallback: false });
  });

  it('告警侧库内行存在但已停用 → 仍走平台回落（可用但不标记告警侧）', async () => {
    const row = {
      channel: 'smtp',
      enabled: false,
      config_json: JSON.stringify({ host: 'alert.example.com', port: 465, secure: true, from: 'a@x.com' }),
      secret_cipher: null,
    };
    const caps = await build(platformConfig(), row).capabilities();
    expect(caps.email).toMatchObject({ available: true, platform_fallback: true });
  });
});

describe('装配层：平台邮件服务必须真的被注入（防 DI 元数据退化）', () => {
  /**
   * 回归守卫：`AuthMailService` 若被写成 `import type`，emitDecoratorMetadata 会退化成
   * `Function`，Nest 解析不到 provider，`@Optional()` 静默注入 undefined——生产表现为
   * 「平台邮件已配好但告警侧永远不可用」（2026-10-09 实测）。这条用例走真实 Nest DI 装配。
   */
  it('经 Nest DI 注入 AuthMailService 后，email 通道可用且标记 platform_fallback', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AlertChannelConfigService,
        { provide: PrismaService, useValue: prisma() },
        { provide: AlertAuditService, useValue: audit },
        { provide: AuthMailService, useValue: { effectiveConfig: async () => platformConfig() } },
      ],
    }).compile();

    const svc = moduleRef.get(AlertChannelConfigService);
    const caps = await svc.capabilities();
    expect(caps.email).toMatchObject({ available: true, platform_fallback: true, reason: null });
  });

  it('注入进去的平台服务确实被调用（发送侧回落同样依赖它）', async () => {
    let called = 0;
    const moduleRef = await Test.createTestingModule({
      providers: [
        AlertChannelConfigService,
        { provide: PrismaService, useValue: prisma() },
        { provide: AlertAuditService, useValue: audit },
        {
          provide: AuthMailService,
          useValue: {
            effectiveConfig: async () => {
              called += 1;
              return platformConfig();
            },
          },
        },
      ],
    }).compile();

    await moduleRef.get(AlertChannelConfigService).capabilities();
    expect(called).toBeGreaterThan(0);
  });
});

describe('通道暂停投递（增补 v1.1）', () => {
  const mutedSmtpRow = {
    channel: 'smtp',
    enabled: true,
    muted: true,
    config_json: JSON.stringify({ host: 'alert.example.com', port: 465, secure: true, from: 'a@x.com' }),
    secret_cipher: null,
  };

  it('AC-1 暂停即不可用：reason_key 指向「已暂停」，且不再列出未配置项', async () => {    const caps = await build(platformConfig(), mutedSmtpRow).capabilities();
    expect(caps.email).toMatchObject({
      available: false,
      muted: true,
      platform_fallback: false,
      reason_key: 'alerting:channel.muted',
      reason_configs: [],
    });
  });

  it('AC-3 兜底也被挡住：smtp 暂停时即使平台邮件可用，email 也不可用', async () => {
    const caps = await build(platformConfig(), mutedSmtpRow).capabilities();
    expect(caps.email.available).toBe(false);
    expect(caps.email.muted).toBe(true);
  });

  it('AC-4 恢复即生效：muted=false 时立刻回到可用（无需重启）', async () => {
    const resumed = { ...mutedSmtpRow, muted: false };
    const caps = await build(platformConfig(), resumed).capabilities();
    expect(caps.email).toMatchObject({ available: true, muted: false });
  });

  it('AC-5 短信多厂商：只暂停一家不算暂停（全部暂停才判定 muted）', async () => {
    const oneMuted = {
      channel: 'sms_tencent',
      enabled: true,
      muted: true,
      config_json: '{}',
      secret_cipher: null,
    };
    const caps = await build(platformConfig(), oneMuted).capabilities();
    expect(caps.sms.muted).toBe(false);
  });

  it('暂停的通道：isMutedForKind 命中 email；群机器人通道恒不命中', async () => {
    const svc = build(platformConfig(), mutedSmtpRow);
    expect(await svc.isMutedForKind('email')).toBe(true);
    expect(await svc.isMutedForKind('sms')).toBe(false);
    expect(await svc.isMutedForKind('feishu_webhook')).toBe(false);
  });

  it('list() 带上 muted 标记（前端据此显示「已暂停」）', async () => {
    const { items } = await build(platformConfig(), mutedSmtpRow).list();
    const smtp = (items as never as { channel: string; muted: boolean }[]).find((i) => i.channel === 'smtp');
    expect(smtp).toMatchObject({ muted: true });
  });

  it('纯暂停/恢复不校验字段：无库内配置的通道（走平台兜底的邮件）也能被暂停', async () => {
    const recorded: Record<string, unknown>[] = [];
    const spyPrisma = {
      alertChannelConfig: {
        findUnique: async () => null,
        findMany: async () => [],
        upsert: async (args: { create: Record<string, unknown> }) => {
          recorded.push(args.create);
          return args.create;
        },
      },
    } as never;
    const svc = new AlertChannelConfigService(
      spyPrisma,
      { write: async () => undefined } as never,
      { effectiveConfig: async () => platformConfig() } as never,
    );

    // 只传 muted：config/secret 为空也不该 400
    await expect(svc.save('smtp', { muted: true }, 'admin')).resolves.toEqual({ ok: true });
    expect(recorded[0]).toMatchObject({ channel: 'smtp', muted: true });
    // 关键（2026-10-09 生产实测回归）：纯暂停新建的行 enabled 必须是 false——
    // 写成 true 的空配置行会挡住平台邮件兜底，并在发送时抛 smtp_not_configured
    expect(recorded[0]).toMatchObject({ enabled: false });
  });

  it('暂停再恢复也不会把无配置通道「变成已配置」', async () => {
    const rows: Record<string, unknown>[] = [];
    const spyPrisma = {
      alertChannelConfig: {
        findUnique: async () => rows[0] ?? null,
        // 按 muted 过滤：否则暂停集合会把未暂停的行也算进去
        findMany: async (args?: { where?: { muted?: boolean } }) =>
          rows.filter((r) => args?.where?.muted !== true || r.muted === true),
        upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
          if (rows.length === 0) rows.push({ channel: 'smtp', ...args.create });
          else Object.assign(rows[0], args.update);
          return rows[0];
        },
      },
    } as never;
    const svc = new AlertChannelConfigService(
      spyPrisma,
      { write: async () => undefined } as never,
      { effectiveConfig: async () => platformConfig() } as never,
    );

    await svc.save('smtp', { muted: true }, 'admin');
    await svc.save('smtp', { muted: false }, 'admin');

    expect(rows[0]).toMatchObject({ enabled: false, muted: false });
    // 恢复后平台兜底仍然生效（这正是生产上被破坏、又修回来的行为）
    const caps = await svc.capabilities();
    expect(caps.email).toMatchObject({ available: true, platform_fallback: true, muted: false });
  });

  it('只有真的在写配置时才校验字段（纯暂停不豁免带字段的保存）', async () => {
    const svc = build(platformConfig(), null);
    await expect(svc.save('smtp', { muted: true, config: { port: 465 } }, 'admin')).rejects.toThrow();
  });
});

describe('发送侧：不完整的告警配置行必须回落，而不是投递失败', () => {
  /** 2026-10-09 生产实测：暂停再恢复在「本来没有配置行」的通道上留了一行 enabled 空配置 */
  const emptyEnabledRow = {
    channel: 'smtp',
    enabled: true,
    muted: false,
    config_json: '{}',
    secret_cipher: null,
  };

  const sendWith = async (svc: AlertChannelConfigService) => {
    mailTransports.length = 0;
    await CHANNELS.email.send({
      contact: { kind: 'email', address: 'ops@example.com', webhook_url: '', options: {} },
      text: '正文',
      subject: '标题',
      vars: {},
      readConfig: (key: string) => svc.readConfig(key),
    });
    return mailTransports[mailTransports.length - 1];
  };

  it('enabled=true 但缺 host/from → 用平台邮件通道发（不再抛 smtp_not_configured）', async () => {
    const transport = await sendWith(build(platformConfig(), emptyEnabledRow));
    expect(transport).toMatchObject({ host: 'smtp.163.com' });
  });

  it('告警侧配置齐备时仍优先用它（回落不越权）', async () => {
    const row = {
      channel: 'smtp',
      enabled: true,
      muted: false,
      config_json: JSON.stringify({ host: 'alert.example.com', port: 465, secure: true, from: 'a@x.com' }),
      secret_cipher: null,
    };
    const transport = await sendWith(build(platformConfig(), row));
    expect(transport).toMatchObject({ host: 'alert.example.com' });
  });
});

describe('通道配置列表的平台邮件回落标记（v3.2 修订）', () => {
  const smtpOf = (items: { channel: string }[]) => items.find((item) => item.channel === 'smtp');

  it('仅平台邮件可用 → smtp 项 enabled=false 但 platform_fallback=true（徽标显示「平台邮件通道」）', async () => {
    const { items } = await build().list();
    expect(smtpOf(items as never)).toMatchObject({ enabled: false, platform_fallback: true });
    // 其他凭证级通道不得被牵连
    expect((items as never as { channel: string; platform_fallback: boolean }[]).filter((i) => i.platform_fallback)).toHaveLength(1);
  });

  it('告警侧已配置并启用 → enabled=true 且 platform_fallback=false', async () => {
    const row = {
      channel: 'smtp',
      enabled: true,
      config_json: JSON.stringify({ host: 'alert.example.com' }),
      secret_cipher: null,
      updated_by: 'ops-config',
      updated_at: new Date('2026-10-01T00:00:00Z'),
    };
    const { items } = await build(platformConfig(), row).list();
    expect(smtpOf(items as never)).toMatchObject({ enabled: true, platform_fallback: false });
  });

  it('平台邮件不可用且告警侧未配置 → 保持现状（enabled=false、platform_fallback=false）', async () => {
    const { items } = await build(null).list();
    expect(smtpOf(items as never)).toMatchObject({ enabled: false, platform_fallback: false });
  });
});
