/**
 * 告警数据保留策略（phase: clklog-analytics-alert-channels-v1）。
 *
 * 产品口径（2026-09-16 反馈）：历史 / 通知记录**默认 1 年**，变更记录**默认永久**；三者可分别设置，
 * 留空 = 永久。删除必须批删 + 有界 + 写审计（红线：不可静默删除数据）。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    alerting: { configKey: '', smtp: {}, sms: {} },
    background_workers: false,
    __specConfigMock: true,
  },
}));

import { BadRequestException } from '@nestjs/common';
import { AlertRetentionService } from '../../src/modules/alerting/alert-retention.service';
import { AlertAuditService } from '../../src/modules/alerting/alert-audit.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';

function harness() {
  const prisma = {
    alertRetention: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async () => ({})),
    },
    alertEvent: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => ({ count: 0 })) },
    alertNotification: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => ({ count: 0 })) },
    opsActionLog: {
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async () => ({})),
    },
  } as unknown as PrismaService;
  return { service: new AlertRetentionService(prisma, new AlertAuditService(prisma)), prisma: prisma as any };
}

describe('保留策略默认值', () => {
  it('未配置时：历史与通知记录 1 年、变更记录永久', async () => {
    const { service } = harness();

    const items = await service.list();

    const byScope = Object.fromEntries(items.map((item) => [item.scope, item.retain_days]));
    expect(byScope.events).toBe(365);
    expect(byScope.notifications).toBe(365);
    expect(byScope.audits).toBeNull();
  });

  it('已配置的范围回读配置值（三个范围互不影响）', async () => {
    const { service, prisma } = harness();
    prisma.alertRetention.findMany.mockResolvedValue([
      { scope: 'events', retain_days: 30, updated_by: 'admin', updated_at: new Date('2026-09-16T02:00:00Z') },
    ]);

    const items = await service.list();

    const byScope = Object.fromEntries(items.map((item) => [item.scope, item.retain_days]));
    expect(byScope.events).toBe(30);
    expect(byScope.notifications).toBe(365);
    expect(byScope.audits).toBeNull();
  });
});

describe('保存保留策略', () => {
  it('留空 = 永久：写 null 并记审计', async () => {
    const { service, prisma } = harness();

    await service.save('events', null, 'admin');

    expect(prisma.alertRetention.upsert.mock.calls[0][0].update.retain_days).toBeNull();
    const audit = prisma.opsActionLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('alert_retention_update');
    expect(audit.detail).toMatchObject({ scope: 'events', retain_days: null });
  });

  it('越界或非整数天数 → 400', async () => {
    const { service } = harness();

    await expect(service.save('events', 0, 'admin')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.save('events', 9_999, 'admin')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.save('events', 1.5, 'admin')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.save('unknown', 30, 'admin')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('按策略清理', () => {
  it('永久保留的范围不删任何行', async () => {
    const { service, prisma } = harness();

    const result = await service.cleanup();

    expect(result.audits).toBe(0);
    expect(prisma.opsActionLog.deleteMany).not.toHaveBeenCalled();
  });

  it('历史清理：先删对应通知记录再删事件，并写审计', async () => {
    const { service, prisma } = harness();
    prisma.alertRetention.findMany.mockResolvedValue([
      { scope: 'events', retain_days: 30, updated_by: 'admin', updated_at: new Date() },
    ]);
    prisma.alertEvent.findMany.mockResolvedValue([{ id: 1n }, { id: 2n }]);
    prisma.alertEvent.deleteMany.mockResolvedValue({ count: 2 });

    const result = await service.cleanup();

    expect(prisma.alertNotification.deleteMany).toHaveBeenCalledWith({
      where: { event_id: { in: [1n, 2n] } },
    });
    expect(result.events).toBe(2);
    const audit = prisma.opsActionLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('alert_retention_cleanup');
    expect(audit.operator).toBe('system');
    expect(audit.detail).toMatchObject({ scope: 'events', deleted: 2 });
  });

  it('没有过期数据时不写审计（不留噪声）', async () => {
    const { service, prisma } = harness();
    prisma.alertRetention.findMany.mockResolvedValue([
      { scope: 'notifications', retain_days: 7, updated_by: 'admin', updated_at: new Date() },
    ]);

    const result = await service.cleanup();

    expect(result.notifications).toBe(0);
    expect(prisma.opsActionLog.create).not.toHaveBeenCalled();
  });
});
