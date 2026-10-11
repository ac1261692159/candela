/**
 * 告警配置变更审计（phase: clklog-analytics-alerting-v3，PRD AC-5）。
 *
 * 关键约束：规则/联系人/屏蔽的变更都要留痕，且**不写任何密钥原文**。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    alerting: {
      smtp: { host: '', port: 465, user: '', pass: '', from: '', secure: true },
      sms: { secretId: '', secretKey: '', sdkAppId: '', signName: '', templateId: '', region: 'ap-guangzhou' },
    },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { AlertingService } from '../../src/modules/alerting/alerting.service';
import { AlertAuditService } from '../../src/modules/alerting/alert-audit.service';
import { AlertMetricEvalService } from '../../src/modules/alerting/alert-metric-eval.service';
import { AlertNotifyService } from '../../src/modules/alerting/alert-notify.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';

const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdEFGHijkl';

function harness() {
  const prisma = {
    alertRule: {
      findUnique: jest.fn(),
      update: jest.fn(async () => ({})),
    },
    alertContact: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
      delete: jest.fn(async () => ({})),
    },
    alertMute: {
      findUnique: jest.fn(),
      delete: jest.fn(async () => ({})),
    },
    opsActionLog: {
      create: jest.fn(async () => ({})),
      findMany: jest.fn(async () => []),
    },
  } as unknown as PrismaService;
  const notify = {
    channels: jest.fn(async () => ({
      feishu_webhook: { available: true, reason: null },
      email: { available: true, reason: null },
      sms: { available: true, reason: null },
    })),
    enqueue: jest.fn(),
    sendNow: jest.fn(),
  } as unknown as AlertNotifyService;
  const metricEval = {} as unknown as AlertMetricEvalService;
  // 审计写入抽成独立服务（alerting-v4：模板服务同用一份实现）
  const audit = new AlertAuditService(prisma);
  return { service: new AlertingService(prisma, notify, metricEval, audit), prisma: prisma as any };
}

describe('告警配置变更审计', () => {
  it('改阈值记「旧值 → 新值」，且只在确有变化时写审计', async () => {
    const { service, prisma } = harness();
    prisma.alertRule.findUnique.mockResolvedValue({
      code: 'slow_query_spike',
      name: '慢查询次数突增',
      threshold: 20,
      severity: 'warning',
      comparator: 'gt',
      unit: '次',
      window_minutes: 1,
      for_windows: 1,
      repeat_minutes: 60,
      notify_on_resolve: true,
      contact_id: null,
      enabled: true,
      source: 'builtin',
    });

    await service.updateRule('slow_query_spike', { threshold: 200 }, 'admin');

    expect(prisma.opsActionLog.create).toHaveBeenCalledTimes(1);
    const audit = prisma.opsActionLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('alert_rule_update');
    expect(audit.target_table).toBe('alertrule');
    expect(audit.operator).toBe('admin');
    expect(audit.detail.changes.threshold).toEqual({ from: 20, to: 200 });
  });

  it('提交相同值不写审计（避免"点了保存就留痕"的噪声）', async () => {
    const { service, prisma } = harness();
    prisma.alertRule.findUnique.mockResolvedValue({
      code: 'slow_query_spike',
      name: '慢查询次数突增',
      threshold: 20,
      enabled: true,
      source: 'builtin',
      contact_id: null,
    });

    await service.updateRule('slow_query_spike', { threshold: 20 }, 'admin');

    expect(prisma.opsActionLog.create).not.toHaveBeenCalled();
  });

  it('新建联系人只记脱敏地址，不出现 webhook 全文', async () => {
    const { service, prisma } = harness();
    prisma.alertContact.create.mockResolvedValue({ id: 7n, name: '值班群', kind: 'feishu_webhook', is_default: true });

    await service.createContact({ name: '值班群', kind: 'feishu_webhook', webhook_url: WEBHOOK, is_default: true }, 'admin');

    const audit = prisma.opsActionLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('alert_contact_create');
    const serialized = JSON.stringify(audit.detail);
    expect(serialized).not.toContain('abcdEFGHijkl');
    expect(audit.detail.address).toContain('***');
  });

  it('解除屏蔽写审计，含规则码与原因（便于事后解释"为什么当时没发"）', async () => {
    const { service, prisma } = harness();
    prisma.alertMute.findUnique.mockResolvedValue({ id: 3n, rule_code: 'card_cache_fail', reason: '发版窗口' });

    await service.deleteMute('3', 'admin');

    const audit = prisma.opsActionLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('alert_mute_delete');
    expect(audit.target_table).toBe('alertmute');
    expect(audit.detail).toMatchObject({ id: '3', rule_code: 'card_cache_fail', reason: '发版窗口' });
  });

  it('审计查询只取 alert_ 前缀记录（不掺入数据运维动作）', async () => {
    const { service, prisma } = harness();

    await service.listAudits(20);

    const query = prisma.opsActionLog.findMany.mock.calls[0][0];
    expect(query.where.action).toEqual({ startsWith: 'alert_' });
    expect(query.take).toBe(20);
  });

  it('审计写入失败不影响业务结果', async () => {
    const { service, prisma } = harness();
    prisma.alertRule.findUnique.mockResolvedValue({
      code: 'metric_abc',
      name: '指标告警',
      threshold: 1,
      enabled: true,
      source: 'metric',
      contact_id: null,
    });
    prisma.opsActionLog.create.mockRejectedValue(new Error('db down'));

    await expect(service.updateRule('metric_abc', { threshold: 2 }, 'admin')).resolves.toEqual({ ok: true });
    expect(prisma.alertRule.update).toHaveBeenCalledTimes(1);
  });
});
