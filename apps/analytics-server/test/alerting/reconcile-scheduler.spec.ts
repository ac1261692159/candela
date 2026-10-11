/**
 * 对拍定时与告警编排（phase: clklog-data-quality-ops-v1，PRD R1-1 / R1-3）。
 *
 * 锁住四件事：
 * 1. 到点才跑、当日只跑一次（多进程/重启不会重复对拍）；
 * 2. 关掉开关就不跑；
 * 3. 存在超阈偏差 / 执行失败 → 通知全部启用联系人（系统通知，不走规则模板）；
 * 4. 没到点或没联系人时不产生副作用。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: false,
    __specConfigMock: true,
  },
}));

import { ReconcileSchedulerService } from '../../src/modules/alerting/reconcile-scheduler.service';
import type { AlertNotifyService } from '../../src/modules/alerting/alert-notify.service';
import type { QualityService } from '../../src/modules/meta/quality.service';
import type { PrismaService } from '../../src/modules/shared/prisma.service';
import { TimezoneService } from '../../src/modules/time/timezone.service';

const CONFIG = {
  enabled: true,
  run_at: '03:30',
  threshold_pct: 10,
  ignore_events: [],
  skip_empty_event: true,
  stale_warn_hours: 24,
  stale_error_hours: 72,
  updated_by: 'admin',
  updated_at: null,
};

function harness(options: { autoSnapshotsToday?: number; reconcileResult?: unknown; reconcileError?: Error } = {}) {
  const quality = {
    configView: jest.fn(async () => ({ ...CONFIG })),
    reconcile: options.reconcileError
      ? jest.fn(async () => {
          throw options.reconcileError as Error;
        })
      : jest.fn(async () => options.reconcileResult ?? okResult()),
  } as unknown as QualityService;
  const prisma = {
    reconcileSnapshot: { count: jest.fn(async () => options.autoSnapshotsToday ?? 0) },
    alertContact: {
      findMany: jest.fn(async () => [
        { kind: 'feishu_webhook', webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', address: '', name: '值班群' },
      ]),
    },
  } as unknown as PrismaService;
  const notify = { sendNow: jest.fn(async () => undefined) } as unknown as AlertNotifyService;
  const service = new ReconcileSchedulerService(quality, prisma, notify, new TimezoneService(undefined));
  return { service, quality: quality as any, prisma: prisma as any, notify: notify as any };
}

function okResult() {
  return {
    range: { from: '2026-08-26', to: '2026-08-26' },
    threshold_pct: 10,
    trigger: 'auto',
    report_path: '/data/logs/reconcile/reconcile-auto.txt',
    summary: { has_alert: false, alert_days: 0 },
    daily: { items: [{ date: '2026-08-26', sa_cnt: 100, raw_cnt: 100, deviation_pct: 0, status: 'ok' }] },
  };
}

/** 上海 03:31（= UTC 前一日 19:31） */
const AT_0331_SH = new Date('2026-08-26T19:31:00Z');
/** 上海 02:00（= UTC 前一日 18:00）：未到点 */
const AT_0200_SH = new Date('2026-08-26T18:00:00Z');

describe('对拍定时（R1-1）', () => {
  it('未到配置时刻不跑', async () => {
    const { service, quality } = harness();

    const result = await service.tick(AT_0200_SH);

    expect(result).toEqual({ ran: false, reason: 'not_due' });
    expect(quality.reconcile).not.toHaveBeenCalled();
  });

  it('到点且当日没有 auto 快照 → 跑昨日单日对拍', async () => {
    const { service, quality } = harness();

    const result = await service.tick(AT_0331_SH);

    expect(result).toEqual({ ran: true, reason: 'ok' });
    expect(quality.reconcile).toHaveBeenCalledWith({
      project: 'clklogapp',
      from: '2026-08-26',
      to: '2026-08-26',
      trigger: 'auto',
    });
  });

  it('当日已有 auto 快照 → 幂等跳过（多进程/重启不重复跑）', async () => {
    const { service, quality } = harness({ autoSnapshotsToday: 1 });

    const result = await service.tick(AT_0331_SH);

    expect(result).toEqual({ ran: false, reason: 'already_ran' });
    expect(quality.reconcile).not.toHaveBeenCalled();
  });

  it('开关关闭时不跑', async () => {
    const { service, quality } = harness();
    quality.configView.mockResolvedValue({ ...CONFIG, enabled: false });

    expect(await service.tick(AT_0331_SH)).toEqual({ ran: false, reason: 'disabled' });
  });
});

describe('对拍告警（R1-3）', () => {
  it('正常通过时不发通知', async () => {
    const { service, notify } = harness();

    await service.tick(AT_0331_SH);

    expect(notify.sendNow).not.toHaveBeenCalled();
  });

  it('存在超阈偏差 → 通知全部启用联系人，内容含范围/阈值/报告路径', async () => {
    const { service, notify } = harness({
      reconcileResult: {
        ...okResult(),
        summary: { has_alert: true, alert_days: 1 },
        daily: {
          items: [{ date: '2026-08-26', sa_cnt: 0, raw_cnt: 100, deviation_pct: -100, status: 'ALERT' }],
        },
      },
    });

    const result = await service.tick(AT_0331_SH);

    expect(result.ran).toBe(true);
    expect(notify.sendNow).toHaveBeenCalledTimes(1);
    const [, message] = notify.sendNow.mock.calls[0];
    expect(message.subject).toContain('存在超阈值偏差');
    expect(message.text).toContain('2026-08-26');
    expect(message.text).toContain('阈值：10%');
    expect(message.text).toContain('/data/logs/reconcile/reconcile-auto.txt');
  });

  it('对拍执行失败 → 发失败通知并把错误抛回（由定时器兜底）', async () => {
    const { service, notify } = harness({ reconcileError: new Error('查询超时') });

    await expect(service.tick(AT_0331_SH)).rejects.toThrow('查询超时');
    expect(notify.sendNow).toHaveBeenCalledTimes(1);
    expect(notify.sendNow.mock.calls[0][1].subject).toContain('执行失败');
    expect(notify.sendNow.mock.calls[0][1].text).toContain('查询超时');
  });

  it('没有启用联系人时只记日志，不抛错', async () => {
    const { service, prisma, notify } = harness({
      reconcileResult: { ...okResult(), summary: { has_alert: true, alert_days: 1 } },
    });
    prisma.alertContact.findMany.mockResolvedValue([]);

    await expect(service.tick(AT_0331_SH)).resolves.toEqual({ ran: true, reason: 'ok' });
    expect(notify.sendNow).not.toHaveBeenCalled();
  });
});
