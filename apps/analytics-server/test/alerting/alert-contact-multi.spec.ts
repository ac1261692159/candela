/**
 * 联系人多渠道与保留策略（phase: clklog-analytics-alert-channels-v1，2026-09-16 反馈版）。
 *
 * 三件事要守住：
 * 1. 列表接口给的是**脱敏**地址，编辑弹窗不回填；即便前端把掩码原样提交也不能写坏真实地址；
 * 2. 「默认联系人」概念已删除，改为每个联系人自己的「启用」开关，停用即不投递；
 * 3. 规则可以绑定**多个**联系人（多渠道同时发送），只改联系人（不动阈值等标量字段）也要能保存。
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

import { BadRequestException } from '@nestjs/common';
import { AlertingService } from '../../src/modules/alerting/alerting.service';
import { AlertAuditService } from '../../src/modules/alerting/alert-audit.service';
import { AlertMetricEvalService } from '../../src/modules/alerting/alert-metric-eval.service';
import { AlertNotifyService } from '../../src/modules/alerting/alert-notify.service';
import { maskAddress } from '../../src/modules/alerting/alert-eval';
import { PrismaService } from '../../src/modules/shared/prisma.service';

const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdEFGHijkl';
const CONTACT = {
  id: 7n,
  name: '值班群',
  kind: 'feishu_webhook',
  webhook_url: WEBHOOK,
  address: '',
  enabled: true,
  options_json: null,
  is_default: false,
};

function harness(channels: Record<string, unknown> = {}) {
  const prisma = {
    alertRule: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
    alertRuleContact: {
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    alertContact: {
      findUnique: jest.fn(async () => CONTACT),
      findMany: jest.fn(async () => []),
      create: jest.fn(async () => CONTACT),
      update: jest.fn(async () => ({})),
    },
    opsActionLog: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  const notify = { channels: jest.fn(async () => channels), enqueue: jest.fn(), sendNow: jest.fn() } as unknown as AlertNotifyService;
  const metricEval = {} as unknown as AlertMetricEvalService;
  const audit = new AlertAuditService(prisma);
  return { service: new AlertingService(prisma, notify, metricEval, audit), prisma: prisma as any };
}

describe('联系人编辑（脱敏地址不得写坏）', () => {
  it('把列表里的掩码地址原样提交 → 库里仍是原值，且不产生「变更」审计', async () => {
    const { service, prisma } = harness();
    const masked = maskAddress('feishu_webhook', WEBHOOK);

    await service.updateContact('7', { name: '值班群', kind: 'feishu_webhook', webhook_url: masked, enabled: true }, 'admin');

    expect(prisma.alertContact.update.mock.calls[0][0].data.webhook_url).toBe(WEBHOOK);
    expect(prisma.opsActionLog.create).not.toHaveBeenCalled();
  });

  it('留空地址（前端不回填）等同不修改，不会把地址清掉', async () => {
    const { service, prisma } = harness();

    await service.updateContact('7', { name: '值班群改名', webhook_url: '', address: '' }, 'admin');

    const data = prisma.alertContact.update.mock.calls[0][0].data;
    expect(data.webhook_url).toBe(WEBHOOK);
    expect(data.name).toBe('值班群改名');
  });

  it('停用联系人写审计「启用：开 → 关」', async () => {
    const { service, prisma } = harness();

    await service.updateContact('7', { enabled: false }, 'admin');

    expect(prisma.alertContact.update.mock.calls[0][0].data.enabled).toBe(false);
    const audit = prisma.opsActionLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('alert_contact_update');
    expect(audit.detail.changes.enabled).toEqual({ from: true, to: false });
  });
});

describe('规则多联系人绑定', () => {
  const RULE = { code: 'slow_query_spike', name: '慢查询次数突增', enabled: true, source: 'builtin', threshold: 20 };

  it('绑定多个联系人 → 先清后建，并把绑定变化写进审计', async () => {
    const { service, prisma } = harness();
    prisma.alertRule.findUnique.mockResolvedValue(RULE);
    prisma.alertRuleContact.findMany.mockResolvedValue([{ contact_id: 7n }]);
    prisma.alertContact.findMany.mockResolvedValue([{ id: 7n }, { id: 8n }]);

    await service.updateRule('slow_query_spike', { contact_ids: ['7', '8'] }, 'admin');

    expect(prisma.alertRuleContact.deleteMany).toHaveBeenCalledWith({ where: { rule_code: 'slow_query_spike' } });
    const created = prisma.alertRuleContact.createMany.mock.calls[0][0].data;
    expect(created.map((row: { contact_id: bigint }) => String(row.contact_id))).toEqual(['7', '8']);
    // 没有标量字段变更时不应顺手改规则行
    expect(prisma.alertRule.update).not.toHaveBeenCalled();
    const audit = prisma.opsActionLog.create.mock.calls[0][0].data;
    expect(audit.detail.changes.contact_ids).toEqual({ from: ['7'], to: ['7', '8'] });
  });

  it('绑定不存在的联系人 → 400（不做半截写入）', async () => {
    const { service, prisma } = harness();
    prisma.alertRule.findUnique.mockResolvedValue(RULE);
    prisma.alertContact.findMany.mockResolvedValue([{ id: 7n }]);

    await expect(service.updateRule('slow_query_spike', { contact_ids: ['7', '999'] }, 'admin')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.alertRuleContact.deleteMany).not.toHaveBeenCalled();
  });

  it('绑定没变时不写审计（避免点保存就留痕）', async () => {
    const { service, prisma } = harness();
    prisma.alertRule.findUnique.mockResolvedValue(RULE);
    prisma.alertRuleContact.findMany.mockResolvedValue([{ contact_id: 7n }]);
    prisma.alertContact.findMany.mockResolvedValue([{ id: 7n }]);

    await service.updateRule('slow_query_spike', { contact_ids: ['7'] }, 'admin');

    expect(prisma.opsActionLog.create).not.toHaveBeenCalled();
  });
});

/**
 * 联系人校验与语言（i18n v1 补交）：
 * 1. 校验失败返回结构化负载（中文原文兜底 + messageKey/params 由前端本地化）；
 * 2. `locale` 落库前规范化（en-GB → en-US），不受支持的语言 400（不静默改写）。
 */
describe('联系人校验与语言（i18n v1）', () => {
  const asError = (err: unknown) => err as Record<string, unknown> & { getStatus: () => number };
  const failed = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('应当被 400 拦下');
      },
      asError,
    );

  it('地址不合法 → 400 DomainError（中文逐字 + messageKey）', async () => {
    const { service } = harness();
    const error = await failed(
      service.createContact({ name: '值班群', kind: 'feishu_webhook', webhook_url: '' }, 'admin'),
    );

    expect(error.getStatus()).toBe(400);
    expect(error.errorCode).toBe('alerting.contact.invalid');
    expect(error.messageKey).toBe('alerting:error.validate.webhookRequired');
    expect(error.message).toBe('请填写 Webhook 地址');
  });

  it('locale 规范化后落库；不传 = 平台默认（null）', async () => {
    const { service, prisma } = harness();

    await service.createContact(
      { name: '值班群', kind: 'feishu_webhook', webhook_url: WEBHOOK, locale: 'en-GB' },
      'admin',
    );
    expect(prisma.alertContact.create.mock.calls[0][0].data.locale).toBe('en-US');

    await service.createContact({ name: '值班群', kind: 'feishu_webhook', webhook_url: WEBHOOK }, 'admin');
    expect(prisma.alertContact.create.mock.calls[1][0].data.locale).toBeNull();

    // zh_TW（下划线）规范化到 BCP-47 的 zh-TW；繁中自 2026-09-17 起是受支持语言
    await service.updateContact('7', { locale: 'zh_TW' }, 'admin');
    expect(prisma.alertContact.update.mock.calls[0][0].data.locale).toBe('zh-TW');

    // 繁体区域变体统一归到繁中（而不是落到简中）
    await service.updateContact('7', { locale: 'zh-Hant' }, 'admin');
    expect(prisma.alertContact.update.mock.calls[1][0].data.locale).toBe('zh-TW');

    await service.updateContact('7', { locale: null }, 'admin');
    expect(prisma.alertContact.update.mock.calls[2][0].data.locale).toBeNull();
  });

  it('locale 不受支持 → 400（不静默改写）', async () => {
    const { service, prisma } = harness();
    const error = await failed(
      service.createContact(
        { name: '值班群', kind: 'feishu_webhook', webhook_url: WEBHOOK, locale: 'xx-XX' },
        'admin',
      ),
    );

    expect(error.getStatus()).toBe(400);
    expect(error.messageKey).toBe('alerting:error.contact.localeInvalid');
    expect(error.params).toEqual({ locale: 'xx-XX' });
    expect(error.message).toBe('不支持的语言：xx-XX');
    expect(prisma.alertContact.create).not.toHaveBeenCalled();
  });

  it('通道不可用 → 400：通道名以中文兜底 + channel_key 成对下发（英文界面不再露中文）', async () => {
    const { service } = harness({ email: { available: false, reason: '未配置：邮件' } });
    const error = await failed(
      service.createContact({ name: '值班邮箱', kind: 'email', address: 'ops@example.com' }, 'admin'),
    );

    expect(error.getStatus()).toBe(400);
    expect(error.messageKey).toBe('alerting:error.channel.unavailable');
    expect(error.params).toEqual({ channel: '邮件', channel_key: 'alerting:channel.email' });
  });
});
