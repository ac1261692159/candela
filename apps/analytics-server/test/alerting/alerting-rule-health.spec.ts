/**
 * 规则健康度判定（phase: clklog-analytics-alerting-v4）。
 *
 * 判定优先级：metric_missing > metric_eval_failed > no_contact > ok。
 * 这类「规则看起来在守，其实永远不会响」的静默失效是要消灭的核心问题；
 * v4 把观测源从卡片缓存换成数据管理指标，因此失效原因也换成「指标被删 / 求值连续失败」。
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

const METRIC_RULE = {
  code: 'metric_abc123',
  name: '订单量过低',
  threshold: 100,
  enabled: true,
  severity: 'warning',
  comparator: 'lt',
  unit: '次',
  window_minutes: 1,
  window_days: 1,
  for_windows: 1,
  repeat_minutes: 60,
  notify_on_resolve: true,
  contact_id: null,
  source: 'metric',
  metric_id: 'metric_1',
  project_name: 'demo',
  contact: null,
};

const BUILTIN_RULE = {
  ...METRIC_RULE,
  code: 'disk_space_low',
  name: '磁盘可用空间不足',
  source: 'builtin',
  metric_id: null,
};

const METRIC_ROW = {
  metric_id: 'metric_1',
  project_name: 'demo',
  name: 'order_count',
  display_name: '订单量',
};

function harness(options: {
  rules: unknown[];
  metrics?: unknown[];
  /** 系统里是否有启用中的联系人 */
  enabledContacts?: boolean;
  failures?: Record<string, { count: number; message: string }>;
}) {
  const prisma = {
    alertRule: { findMany: jest.fn(async () => options.rules) },
    alertEvent: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      groupBy: jest.fn(async () => []),
    },
    alertNotification: { count: jest.fn(async () => 0) },
    metaSavedMetric: { findMany: jest.fn(async () => options.metrics ?? []) },
    alertContact: {
      findFirst: jest.fn(async () => (options.enabledContacts ? { id: 1n } : null)),
      count: jest.fn(async () => (options.enabledContacts ? 1 : 0)),
    },
  } as unknown as PrismaService;
  const notify = {} as unknown as AlertNotifyService;
  const audit = new AlertAuditService(prisma);
  const metricEval = {
    isBroken: jest.fn((code: string) => Boolean(options.failures?.[code] && options.failures[code].count >= 3)),
    failureOf: jest.fn((code: string) => options.failures?.[code]),
  } as unknown as AlertMetricEvalService;
  return { service: new AlertingService(prisma, notify, metricEval, audit), prisma: prisma as any };
}

describe('规则健康度（指标口径）', () => {
  it('指标被删除 → metric_missing（这条规则再也不会触发）', async () => {
    const { service } = harness({ rules: [METRIC_RULE], metrics: [], enabledContacts: true });

    const { items } = await service.listRules();

    expect(items[0].health).toBe('metric_missing');
    expect(items[0].health_detail).toContain('metric_1');
    expect(items[0].metric_name).toBeNull();
  });

  it('指标存在且求值正常 → ok，并带出指标显示名', async () => {
    const { service } = harness({ rules: [METRIC_RULE], metrics: [METRIC_ROW], enabledContacts: true });

    const { items } = await service.listRules();

    expect(items[0].health).toBe('ok');
    expect(items[0].metric_name).toBe('订单量');
    expect(items[0].window_days).toBe(1);
  });

  it('求值连续失败达到阈值 → metric_eval_failed 并带出失败次数与原因', async () => {
    const { service } = harness({
      rules: [METRIC_RULE],
      metrics: [METRIC_ROW],
      enabledContacts: true,
      failures: { metric_abc123: { count: 4, message: 'socket hang up' } },
    });

    const { items } = await service.listRules();

    expect(items[0].health).toBe('metric_eval_failed');
    expect(items[0].health_detail).toContain('4');
    expect(items[0].health_detail).toContain('socket hang up');
  });

  it('偶发失败（未达阈值）不报健康度异常，避免抖动误报', async () => {
    const { service } = harness({
      rules: [METRIC_RULE],
      metrics: [METRIC_ROW],
      enabledContacts: true,
      failures: { metric_abc123: { count: 1, message: 'temporary' } },
    });

    const { items } = await service.listRules();

    expect(items[0].health).toBe('ok');
  });

  it('内置规则未绑定联系人且系统无启用联系人 → no_contact', async () => {
    const { service } = harness({ rules: [BUILTIN_RULE], enabledContacts: false });

    const { items } = await service.listRules();

    expect(items[0].health).toBe('no_contact');
  });

  it('有启用联系人时未绑定联系人 → ok；停用的规则不算 no_contact', async () => {
    const withEnabled = harness({ rules: [BUILTIN_RULE], enabledContacts: true });
    expect((await withEnabled.service.listRules()).items[0].health).toBe('ok');

    const disabled = harness({
      rules: [{ ...BUILTIN_RULE, enabled: false }],
      enabledContacts: false,
    });
    expect((await disabled.service.listRules()).items[0].health).toBe('ok');
  });

  it('概览健康汇总：失效规则数与无联系人规则数', async () => {
    const { service } = harness({
      rules: [
        METRIC_RULE,
        { ...METRIC_RULE, code: 'metric_gone_one', name: '指标已删的规则', metric_id: 'metric_deleted' },
        BUILTIN_RULE,
      ],
      metrics: [METRIC_ROW],
      enabledContacts: false,
    });

    const overview = await service.overview();

    expect(overview.health.broken_rules).toBe(1);
    expect(overview.health.broken_rule_names).toEqual(['指标已删的规则']);
    expect(overview.health.no_contact_rules).toBe(1);
    expect(overview.health.has_enabled_contact).toBe(false);
    expect(overview.health.enabled_contacts).toBe(0);
  });
});
