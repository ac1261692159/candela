import { AlertDetectorService } from '../../src/modules/alerting/alert-detector.service';
import { AlertNotifyService } from '../../src/modules/alerting/alert-notify.service';
import { AlertMetricEvalService } from '../../src/modules/alerting/alert-metric-eval.service';
import { AlertTemplateService } from '../../src/modules/alerting/alert-template.service';
import { ClickHouseService } from '../../src/modules/shared/clickhouse.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';
import { appConfig } from '../../src/config/configuration';

/**
 * 检测状态机（phase: clklog-analytics-alerting-v1/v2/v4）。
 *
 * 覆盖 PRD 里靠纯函数测不到的链路：firing/resolved 迁移、连续 N 次窗口、
 * 重复通知间隔、屏蔽抑制、观测失败跳过、通知失败落库、定时器启停、
 * 指标规则求值（alerting-v4：观测源由卡片缓存改为数据管理指标）。
 */

// clickhouse.service / alert-notify.service 顶层会加载 YAML 配置（需要 APP_CONFIG_PATH
// 与真实密钥，CI 里都没有），单测里隔离掉——与 test/ops/slow-query.*.spec.ts 同款处理。
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

jest.mock('../../src/modules/ops/host-metrics', () => ({
  diskUsage: jest.fn(() => ({ path: '/data', totalBytes: 1000, freeBytes: 500, usedPercent: 50 })),
}));

type Row = Record<string, unknown>;

const FIRING_EVENT = { id: 7n, rule_code: 'card_cache_fail', value: 0, status: 'firing', fired_at: new Date(), last_seen_at: new Date(), resolved_at: null };

function rule(overrides: Row = {}): Row {
  return {
    code: 'card_cache_fail',
    name: '卡片缓存刷新连续失败',
    threshold: 0,
    enabled: true,
    severity: 'warning',
    comparator: 'gte',
    unit: '次',
    window_minutes: 1,
    for_windows: 1,
    repeat_minutes: 60,
    notify_on_resolve: true,
    contact_id: null,
    source: 'builtin',
    metric_id: null,
    window_days: 1,
    ...overrides,
  };
}

const DEFAULT_CONTACT = {
  id: 1n,
  name: '值班群',
  kind: 'feishu_webhook',
  webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef',
  address: '',
  enabled: true,
};

function harness(options: {
  rules?: Row[];
  firingEvent?: Row | null;
  lastNotification?: { created_at: Date } | null;
  mute?: Row | null;
  contact?: Row | null;
  /** 指标求值结果：数字=正常取值；null=求值为空；Error=抛错 */
  metricValue?: number | null | Error;
  metricMissing?: boolean;
  cacheCount?: number | Error;
  /** 规则绑定的联系人（[{ contact }] 形态，与 Prisma include 一致） */
  boundContacts?: Array<{ contact: Row }>;
  samples?: Array<{ sampled_at: Date; value: number }>;
} = {}) {
  const prisma = {
    alertRule: { findMany: jest.fn(async () => options.rules ?? [rule()]) },
    alertEvent: {
      findFirst: jest.fn(async () => (options.firingEvent === undefined ? null : options.firingEvent)),
      create: jest.fn(async () => ({ id: 11n })),
      update: jest.fn(async () => ({})),
    },
    alertNotification: {
      findFirst: jest.fn(async () => options.lastNotification ?? null),
      create: jest.fn(async () => ({ id: 1n })),
    },
    alertMute: { findFirst: jest.fn(async () => options.mute ?? null) },
    // 多联系人（2026-09-16 起）：规则绑定优先，未绑定回退到「全部启用联系人」
    alertRuleContact: { findMany: jest.fn(async () => options.boundContacts ?? []) },
    alertContact: {
      findUnique: jest.fn(async () => (options.contact === null ? null : options.contact ?? DEFAULT_CONTACT)),
      findFirst: jest.fn(async () => (options.contact === null ? null : options.contact ?? DEFAULT_CONTACT)),
      findMany: jest.fn(async () => (options.contact === null ? [] : [options.contact ?? DEFAULT_CONTACT])),
    },
    cardCache: {
      count: jest.fn(async () => {
        if (options.cacheCount instanceof Error) throw options.cacheCount;
        return options.cacheCount ?? 0;
      }),
    },
    hostMetricSample: { findMany: jest.fn(async () => options.samples ?? []) },
  } as unknown as PrismaService;

  const clickhouse = {
    queryDataStats: jest.fn(async () => ({ chVersion: '23.2', eventRows: 1, eventBytes: 1, lastWriteAt: '2099-01-01 00:00:00' })),
    querySlowQueries: jest.fn(async () => []),
  } as unknown as ClickHouseService;

  // 新链路：入队投递（限流在队列里做），测试里立即回调成功
  const notify = {
    enqueue: jest.fn((input: { onDone?: (ok: boolean, error?: Error) => void | Promise<void> }) => {
      void input.onDone?.(true);
    }),
    sendNow: jest.fn(async () => undefined),
    warnFailed: jest.fn(),
    channels: jest.fn(async () => ({})),
  } as unknown as AlertNotifyService;

  // 指标求值：默认「指标已删除」（不触发），测试按需给值
  const metricEval = {
    evaluate: jest.fn(async () => {
      if (options.metricValue instanceof Error) throw options.metricValue;
      if (options.metricMissing || options.metricValue === undefined) {
        return { value: null, metric: null };
      }
      return {
        value: options.metricValue,
        metric: { metric_id: 'metric_1', name: 'order_count', display_name: '订单量', kind: 'event' },
      };
    }),
    isBroken: jest.fn(() => false),
    failureOf: jest.fn(() => undefined),
    invalidate: jest.fn(),
  } as unknown as AlertMetricEvalService;

  // 模板渲染：用可见的占位符替换结果断言「通知内容来自模板」
  const templates = {
    render: jest.fn(async (_project: string, _kind: string, _channel: string, ctx: Record<string, unknown>) => ({
      subject: `【${ctx.level_fmt}】${ctx.rule_name}`,
      body: `${ctx.status} ${ctx.rule_name} 当前值 ${ctx.value}${ctx.unit}`,
    })),
  } as unknown as AlertTemplateService;

  return {
    service: new AlertDetectorService(prisma, clickhouse, notify, metricEval, templates),
    prisma: prisma as any,
    clickhouse: clickhouse as any,
    notify: notify as any,
    metricEval: metricEval as any,
    templates: templates as any,
  };
}

describe('alert-detector 状态机', () => {
  afterEach(() => {
    (appConfig as unknown as Record<string, unknown>).background_workers = true;
  });

  it('配置模块已隔离（CI 无 APP_CONFIG_PATH 与密钥也能跑）', () => {
    expect((appConfig as unknown as Record<string, unknown>).__specConfigMock).toBe(true);
  });

  it('非 server 进程（background_workers=false）不启动检测定时器', () => {
    (appConfig as unknown as Record<string, unknown>).background_workers = false;
    const { service } = harness();
    const detect = jest.spyOn(service, 'detect').mockImplementation(async () => {});
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    service.onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('命中且达到连续窗口后写入 firing 事件并通知 fire', async () => {
    const { service, prisma, notify } = harness({ rules: [rule({ threshold: 0 })], cacheCount: 0 });
    await service.detect();

    expect(prisma.alertEvent.create).toHaveBeenCalledTimes(1);
    const created = prisma.alertEvent.create.mock.calls[0][0].data;
    expect(created.rule_code).toBe('card_cache_fail');
    expect(created.status).toBe('firing');
    expect(notify.enqueue).toHaveBeenCalledTimes(1);
    expect(prisma.alertNotification.create).toHaveBeenCalledTimes(1);
    const notification = prisma.alertNotification.create.mock.calls[0][0].data;
    expect(notification.kind).toBe('fire');
    expect(notification.status).toBe('success');
  });

  it('连续窗口未满不触发：window_minutes × for_windows = 2 时第 1 次检测不写事件', async () => {
    const { service, prisma, notify } = harness({
      rules: [rule({ threshold: 0, window_minutes: 1, for_windows: 2 })],
      cacheCount: 0,
    });

    await service.detect();
    expect(prisma.alertEvent.create).not.toHaveBeenCalled();
    expect(notify.enqueue).not.toHaveBeenCalled();

    await service.detect();
    expect(prisma.alertEvent.create).toHaveBeenCalledTimes(1);
    expect(notify.enqueue).toHaveBeenCalledTimes(1);
  });

  it('未命中会归零连续计数，重新累计后才触发', async () => {
    const { service, prisma } = harness({
      rules: [rule({ threshold: 3, window_minutes: 1, for_windows: 2 })],
      cacheCount: 0,
    });

    await service.detect(); // streak=1
    expect(prisma.alertEvent.create).not.toHaveBeenCalled();

    // 一次未命中（阈值 3、观测值 0）→ streak 归零
    prisma.cardCache.count.mockResolvedValueOnce(0);
    await service.detect();
    expect(prisma.alertEvent.create).not.toHaveBeenCalled();

    await service.detect(); // 重新累计到 1
    expect(prisma.alertEvent.create).not.toHaveBeenCalled();
  });

  it('已 firing 且命中时更新事件并按间隔发送 repeat', async () => {
    const { service, prisma, notify } = harness({
      rules: [rule({ threshold: 0, repeat_minutes: 5 })],
      firingEvent: FIRING_EVENT,
      lastNotification: { created_at: new Date(Date.now() - 6 * 60_000) },
      cacheCount: 0,
    });

    await service.detect();

    expect(prisma.alertEvent.create).not.toHaveBeenCalled();
    expect(prisma.alertEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7n }, data: expect.objectContaining({ value: 0 }) }),
    );
    expect(prisma.alertNotification.create.mock.calls[0][0].data.kind).toBe('repeat');
    expect(notify.enqueue).toHaveBeenCalledTimes(1);
  });

  it('重复通知间隔未到时不外发', async () => {
    const { service, notify, prisma } = harness({
      rules: [rule({ threshold: 0, repeat_minutes: 60 })],
      firingEvent: FIRING_EVENT,
      lastNotification: { created_at: new Date(Date.now() - 60_000) },
      cacheCount: 0,
    });

    await service.detect();

    expect(notify.enqueue).not.toHaveBeenCalled();
    expect(prisma.alertNotification.create).not.toHaveBeenCalled();
  });

  it('屏蔽生效期内不外发，但事件仍保持 firing', async () => {
    const { service, prisma, notify } = harness({
      rules: [rule({ threshold: 0, repeat_minutes: 5 })],
      firingEvent: FIRING_EVENT,
      lastNotification: { created_at: new Date(Date.now() - 30 * 60_000) },
      mute: { id: 3n, rule_code: 'card_cache_fail', starts_at: new Date(Date.now() - 60_000), ends_at: new Date(Date.now() + 60_000) },
      cacheCount: 0,
    });

    await service.detect();

    expect(notify.enqueue).not.toHaveBeenCalled();
    expect(prisma.alertNotification.create).not.toHaveBeenCalled();
    expect(prisma.alertEvent.update).toHaveBeenCalledTimes(1);
  });

  it('恢复时写 resolved 并按开关发送恢复通知', async () => {
    const { service, prisma, notify } = harness({
      rules: [rule({ threshold: 3, notify_on_resolve: true })],
      firingEvent: FIRING_EVENT,
      cacheCount: 0,
    });

    await service.detect();

    const update = prisma.alertEvent.update.mock.calls[0][0];
    expect(update.data.status).toBe('resolved');
    expect(update.data.resolved_at).toBeInstanceOf(Date);
    expect(prisma.alertNotification.create.mock.calls[0][0].data.kind).toBe('resolve');
    expect(notify.enqueue).toHaveBeenCalledTimes(1);
  });

  it('notify_on_resolve 关闭时恢复不外发', async () => {
    const { service, prisma, notify } = harness({
      rules: [rule({ threshold: 3, notify_on_resolve: false })],
      firingEvent: FIRING_EVENT,
      cacheCount: 0,
    });

    await service.detect();

    expect(prisma.alertEvent.update.mock.calls[0][0].data.status).toBe('resolved');
    expect(notify.enqueue).not.toHaveBeenCalled();
    expect(prisma.alertNotification.create).not.toHaveBeenCalled();
  });

  it('没有启用联系人不外发，也不写通知记录', async () => {
    const { service, prisma, notify } = harness({ rules: [rule({ threshold: 0 })], cacheCount: 0, contact: null });

    await service.detect();

    expect(prisma.alertEvent.create).toHaveBeenCalledTimes(1);
    expect(notify.enqueue).not.toHaveBeenCalled();
    expect(prisma.alertNotification.create).not.toHaveBeenCalled();
  });

  it('规则绑定多个联系人 → 一次触发向每个联系人各投递一次（多渠道同时发送）', async () => {
    const { service, prisma, notify } = harness({
      rules: [rule({ threshold: 0 })],
      cacheCount: 0,
      boundContacts: [
        { contact: { ...DEFAULT_CONTACT } },
        { contact: { ...DEFAULT_CONTACT, id: 2n, name: '邮件值班', kind: 'email', address: 'ops@example.com' } },
      ],
    });

    await service.detect();

    expect(notify.enqueue).toHaveBeenCalledTimes(2);
    expect(prisma.alertNotification.create).toHaveBeenCalledTimes(2);
    // 每个联系人各写一行，并带上投递目标（否则多联系人时分不清是哪条通道失败）
    const targets = prisma.alertNotification.create.mock.calls.map(
      (call: Array<{ data: { contact_name: string } }>) => call[0].data.contact_name,
    );
    expect(targets).toEqual(['值班群', '邮件值班']);
  });

  it('绑定的联系人都被停用 → 回退到「全部启用联系人」', async () => {
    const { service, prisma, notify } = harness({
      rules: [rule({ threshold: 0 })],
      cacheCount: 0,
      boundContacts: [{ contact: { ...DEFAULT_CONTACT, enabled: false } }],
    });

    await service.detect();

    expect(notify.enqueue).toHaveBeenCalledTimes(1);
    expect(prisma.alertNotification.create).toHaveBeenCalledTimes(1);
  });

  it('观测失败（null/异常）跳过本轮，不改窗口计数', async () => {
    const { service, prisma } = harness({
      rules: [rule({ threshold: 0, window_minutes: 1, for_windows: 2 })],
      cacheCount: new Error('mysql down'),
    });

    await service.detect();
    await service.detect();

    expect(prisma.alertEvent.create).not.toHaveBeenCalled();
    expect(prisma.alertEvent.update).not.toHaveBeenCalled();
  });

  it('通知失败写入 status=fail 且错误截断在 500 字符内', async () => {
    const { service, prisma, notify } = harness({ rules: [rule({ threshold: 0 })], cacheCount: 0 });
    notify.enqueue.mockImplementation((input: { onDone?: (ok: boolean, error?: Error) => void | Promise<void> }) => { void input.onDone?.(false, new Error('x'.repeat(900))); });

    await service.detect();

    const notification = prisma.alertNotification.create.mock.calls[0][0].data;
    expect(notification.status).toBe('fail');
    expect(notification.error.length).toBeLessThanOrEqual(500);
    expect(notify.warnFailed).toHaveBeenCalled();
  });

  it('规则读取失败时整轮跳过，不抛错', async () => {
    const { service, prisma } = harness();
    prisma.alertRule.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.detect()).resolves.toBeUndefined();
  });

  it('指标规则（alerting-v4）：取到值越线即触发，通知内容来自模板渲染', async () => {
    const metricRule = rule({
      code: 'metric_abc123',
      source: 'metric',
      metric_id: 'metric_1',
      window_days: 1,
      threshold: 100,
      comparator: 'gt',
      unit: '次',
      project_name: 'clklogapp',
    });
    const { service, prisma, notify, templates, metricEval } = harness({
      rules: [metricRule],
      metricValue: 150,
    });

    await service.detect();

    expect(metricEval.evaluate).toHaveBeenCalledTimes(1);
    expect(prisma.alertEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.alertEvent.create.mock.calls[0][0].data.value).toBe(150);
    expect(templates.render).toHaveBeenCalledTimes(1);
    // 模板变量携带指标与窗口口径，供占位符替换
    const ctx = templates.render.mock.calls[0][3];
    expect(ctx).toMatchObject({
      rule_name: '卡片缓存刷新连续失败',
      metric_name: '订单量',
      metric_kind: '事件指标',
      window_fmt: '今天',
      value: '150次',
      status_code: 'fire',
    });
    expect(notify.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        contact: expect.objectContaining({ kind: 'feishu_webhook' }),
        text: expect.stringContaining('150'),
        ruleName: expect.any(String),
      }),
    );
  });

  it('指标规则：求值为空或抛错时跳过本轮，不触发也不改状态', async () => {
    const metricRule = rule({ code: 'metric_abc123', source: 'metric', metric_id: 'metric_1', threshold: 100 });

    const skip = harness({ rules: [metricRule], metricValue: null });
    await skip.service.detect();
    expect(skip.prisma.alertEvent.create).not.toHaveBeenCalled();
    expect(skip.notify.enqueue).not.toHaveBeenCalled();

    const broken = harness({ rules: [metricRule], metricValue: new Error('socket hang up') });
    await broken.service.detect();
    expect(broken.prisma.alertEvent.create).not.toHaveBeenCalled();
    expect(broken.notify.enqueue).not.toHaveBeenCalled();
  });

  it('指标规则：指标已删除（求值返回空指标）不触发，交由健康度提示', async () => {
    const metricRule = rule({ code: 'metric_abc123', source: 'metric', metric_id: 'metric_gone', threshold: 100 });
    const { service, prisma, notify } = harness({ rules: [metricRule], metricMissing: true });

    await service.detect();

    expect(prisma.alertEvent.create).not.toHaveBeenCalled();
    expect(notify.enqueue).not.toHaveBeenCalled();
  });

  it('重入保护：上一轮未结束时跳过本轮，不重复检测', async () => {
    const { service, prisma } = harness({ rules: [rule({ threshold: 0 })], cacheCount: 0 });
    let release: () => void = () => {};
    prisma.cardCache.count.mockImplementation(
      () => new Promise<number>((resolve) => {
        release = () => resolve(0);
      }),
    );

    const first = service.detect();
    await service.detect(); // 第二轮应直接返回
    expect(prisma.alertRule.findMany).toHaveBeenCalledTimes(1);

    // 等第一轮真正进入观测（count 被调用）再放行，否则 release 还是初始空实现
    for (let i = 0; i < 20 && prisma.cardCache.count.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release();
    await first;
    expect(prisma.alertRule.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.alertEvent.create).toHaveBeenCalledTimes(1);
  });

  it('磁盘预计用尽：有增长趋势时按外推天数命中', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00Z');
    const samples = [
      { sampled_at: new Date(t0), value: 500 },
      { sampled_at: new Date(t0 + 3_600_000), value: 600 },
      { sampled_at: new Date(t0 + 7_200_000), value: 700 },
    ];
    // 磁盘总量在 host-metrics mock 里是 1000 字节；每小时 +100 → 距用尽 3 小时 = 0.1 天 < 阈值 30
    const { service, prisma, notify } = harness({
      rules: [rule({ code: 'disk_forecast_full', threshold: 30, comparator: 'lt', unit: '天' })],
      samples,
    });

    await service.detect();

    expect(prisma.alertEvent.create).toHaveBeenCalledTimes(1);
    const created = prisma.alertEvent.create.mock.calls[0][0].data;
    expect(created.rule_code).toBe('disk_forecast_full');
    expect(created.value).toBeLessThanOrEqual(0.2);
    expect(notify.enqueue).toHaveBeenCalledTimes(1);
  });

  it('磁盘预计用尽：无增长趋势视为不会用尽，解除已有事件且不外发', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00Z');
    const samples = [
      { sampled_at: new Date(t0), value: 500 },
      { sampled_at: new Date(t0 + 3_600_000), value: 500 },
      { sampled_at: new Date(t0 + 7_200_000), value: 500 },
    ];
    const { service, prisma, notify } = harness({
      rules: [rule({ code: 'disk_forecast_full', threshold: 30, comparator: 'lt', unit: '天' })],
      firingEvent: { ...FIRING_EVENT, rule_code: 'disk_forecast_full' },
      samples,
    });

    await service.detect();

    expect(prisma.alertEvent.create).not.toHaveBeenCalled();
    expect(prisma.alertEvent.update.mock.calls[0][0].data.status).toBe('resolved');
    // 恢复通知默认开启，因此会发一条 resolve（内容为「不会用尽」的 3650 天）
    expect(notify.enqueue).toHaveBeenCalledTimes(1);
    expect(prisma.alertNotification.create.mock.calls[0][0].data.kind).toBe('resolve');
  });

  it('磁盘预计用尽：采样不足本轮跳过，不改事件状态', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00Z');
    const { service, prisma } = harness({
      rules: [rule({ code: 'disk_forecast_full', threshold: 30, comparator: 'lt', unit: '天' })],
      samples: [{ sampled_at: new Date(t0), value: 500 }],
    });

    await service.detect();

    expect(prisma.alertEvent.create).not.toHaveBeenCalled();
    expect(prisma.alertEvent.update).not.toHaveBeenCalled();
  });

  it('定时器随模块启停，停机后不再检测', async () => {    jest.useFakeTimers();
    try {
      const { service } = harness();
      const detect = jest.spyOn(service, 'detect').mockImplementation(async () => {});
      service.onModuleInit();

      jest.advanceTimersByTime(60_000);
      expect(detect).toHaveBeenCalledTimes(1);

      service.onApplicationShutdown();
      jest.advanceTimersByTime(180_000);
      expect(detect).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
