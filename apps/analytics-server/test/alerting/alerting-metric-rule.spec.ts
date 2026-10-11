/**
 * 指标告警规则创建/删除（phase: clklog-analytics-alerting-v4，PRD A-1/A-4/A-6）。
 *
 * 这是「新建分析指标告警 500」的直接替代路径：观测源改为数据管理里的已保存指标，
 * 因此校验点也从「卡片/列是否存在」变成「指标是否存在、是否超过条数上限」。
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

import { plainToInstance } from 'class-transformer';
import { AlertingService } from '../../src/modules/alerting/alerting.service';
import { CreateAlertRuleDto, NotificationListDto, normalizeProjectParam } from '../../src/modules/alerting/dto/alerting.dto';
import { plainToInstance as toDto } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AlertAuditService } from '../../src/modules/alerting/alert-audit.service';
import { AlertMetricEvalService } from '../../src/modules/alerting/alert-metric-eval.service';
import { AlertNotifyService } from '../../src/modules/alerting/alert-notify.service';
import { MAX_METRIC_RULES } from '../../src/modules/alerting/alert-metric-eval';
import { PrismaService } from '../../src/modules/shared/prisma.service';

const METRIC = {
  metric_id: 'metric_1',
  project_name: 'clklogapp',
  name: 'order_count',
  display_name: '订单量',
};

function harness(options: { metric?: unknown; metricCount?: number; ruleSource?: string } = {}) {
  const prisma = {
    metaSavedMetric: { findUnique: jest.fn(async () => options.metric ?? null) },
    alertRule: {
      count: jest.fn(async () => options.metricCount ?? 0),
      create: jest.fn(async () => ({ code: 'metric_new', name: '订单量过低' })),
      findUnique: jest.fn(async () => ({
        code: 'metric_old',
        name: '旧指标规则',
        source: options.ruleSource ?? 'metric',
        metric_id: 'metric_1',
      })),
      delete: jest.fn(async () => ({})),
    },
    alertContact: {
      findUnique: jest.fn(async () => ({ id: 5n })),
      findMany: jest.fn(async () => [{ id: 5n }]),
    },
    alertRuleContact: {
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
    opsActionLog: { create: jest.fn(async () => ({})) },
  } as unknown as PrismaService;
  const notify = { channels: jest.fn(() => ({ email: false, sms: false })) } as unknown as AlertNotifyService;
  const metricEval = {
    catalog: jest.fn(async () => [{ metric_id: 'metric_1', display_name: '订单量', alertable: true }]),
    probe: jest.fn(async () => ({ value: 42, value_fmt: '42', window_days: 1, window_fmt: '今天', unit: '', elapsed_ms: 3 })),
  } as unknown as AlertMetricEvalService;
  const audit = new AlertAuditService(prisma);
  return { service: new AlertingService(prisma, notify, metricEval, audit), prisma: prisma as any, metricEval: metricEval as any };
}

describe('新建指标告警', () => {
  it('绑定数据管理指标：落 source=metric、project 取自指标、默认窗口 1 天', async () => {
    const { service, prisma } = harness({ metric: METRIC });

    const result = await service.createMetricRule(
      { name: '订单量过低', metric_id: 'metric_1', threshold: 100, unit: '次', comparator: 'lt' },
      'admin',
    );

    expect(result).toEqual({ code: 'metric_new' });
    const data = prisma.alertRule.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      source: 'metric',
      metric_id: 'metric_1',
      project_name: 'clklogapp',
      window_days: 1,
      comparator: 'lt',
      unit: '次',
      enabled: true,
    });
    expect(data.card_id).toBeUndefined();
    expect(data.metric_key).toBeUndefined();
  });

  it('窗口天数按入参写入（1/2/7/30）', async () => {
    const { service, prisma } = harness({ metric: METRIC });
    await service.createMetricRule({ name: '近 7 天订单量', metric_id: 'metric_1', threshold: 1, window_days: 7 }, 'admin');
    expect(prisma.alertRule.create.mock.calls[0][0].data.window_days).toBe(7);
  });

  it('指标不存在 → 400，并提示去数据管理创建（不落到 Prisma 外键报错）', async () => {
    const { service } = harness({ metric: null });
    await expect(
      service.createMetricRule({ name: 'x', metric_id: 'metric_missing', threshold: 1 }, 'admin'),
    ).rejects.toThrow('指标不存在（请在「数据管理 → 指标」中先创建）');
  });

  it(`超过 ${MAX_METRIC_RULES} 条上限 → 400（求值有界）`, async () => {
    const { service } = harness({ metric: METRIC, metricCount: MAX_METRIC_RULES });
    await expect(
      service.createMetricRule({ name: 'x', metric_id: 'metric_1', threshold: 1 }, 'admin'),
    ).rejects.toThrow(`指标告警最多 ${MAX_METRIC_RULES} 条`);
  });

  it('联系人不存在 → 400（F3 口径：不要让外键错暴露成 500）', async () => {
    const { service, prisma } = harness({ metric: METRIC });
    prisma.alertContact.findMany.mockResolvedValue([]);
    await expect(
      service.createMetricRule({ name: 'x', metric_id: 'metric_1', threshold: 1, contact_id: '9' }, 'admin'),
    ).rejects.toThrow('联系人不存在');
  });

  it('创建写审计（含指标 id 与窗口，便于事后解释规则来源）', async () => {
    const { service, prisma } = harness({ metric: METRIC });
    await service.createMetricRule({ name: '订单量过低', metric_id: 'metric_1', threshold: 100, window_days: 2 }, 'admin');
    const audit = prisma.opsActionLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('alert_rule_create');
    expect(audit.detail).toMatchObject({ metric_id: 'metric_1', metric_name: '订单量', window_days: 2 });
  });
});

describe('删除规则', () => {
  it('指标规则可删，写审计', async () => {
    const { service, prisma } = harness({ ruleSource: 'metric' });
    await service.deleteRule('metric_old', 'admin');
    expect(prisma.alertRule.delete).toHaveBeenCalledWith({ where: { code: 'metric_old' } });
    expect(prisma.opsActionLog.create.mock.calls[0][0].data.action).toBe('alert_rule_delete');
  });

  it('内置规则拒绝删除', async () => {
    const { service, prisma } = harness({ ruleSource: 'builtin' });
    await expect(service.deleteRule('disk_space_low', 'admin')).rejects.toThrow('内置规则不可删除');
    expect(prisma.alertRule.delete).not.toHaveBeenCalled();
  });
});

describe('可选指标清单与测试取值', () => {
  it('清单透传求值服务的 catalog（含可告警性）', async () => {
    const { service, metricEval } = harness();
    const result = await service.listAlertMetrics('clklogapp');
    expect(metricEval.catalog).toHaveBeenCalledWith('clklogapp');
    expect(result.items[0]).toMatchObject({ metric_id: 'metric_1', alertable: true });
  });

  it('测试取值默认窗口 1 天，可指定窗口', async () => {
    const { service, metricEval } = harness();
    await service.probeMetric('metric_1', 'clklogapp');
    // 第 4 个参数是本规则的时间来源（metric-v2）：未传 = 跟随指标查询时间
    // 第 5 个参数是操作者语言（i18n v1）：未传 = 保留中文兜底
    expect(metricEval.probe).toHaveBeenCalledWith('metric_1', 'clklogapp', 1, undefined, undefined);

    await service.probeMetric('metric_1', 'clklogapp', 7);
    expect(metricEval.probe).toHaveBeenLastCalledWith('metric_1', 'clklogapp', 7, undefined, undefined);

    await service.probeMetric('metric_1', 'clklogapp', 7, 'rule');
    expect(metricEval.probe).toHaveBeenLastCalledWith('metric_1', 'clklogapp', 7, 'rule', undefined);

    await service.probeMetric('metric_1', 'clklogapp', 7, 'rule', 'en-US');
    expect(metricEval.probe).toHaveBeenLastCalledWith('metric_1', 'clklogapp', 7, 'rule', 'en-US');
  });
});

/**
 * 500 根因修复的回归测试。
 *
 * 缺陷链路：前端把 project 同时写进 URL 与 axios params → 请求带两个 project →
 * Express 把重复 query 参数解析成**数组** → 原样传给 Prisma：
 * `Argument project_name: Expected StringFilter or String, provided (String, String)` → 500。
 * 修复点在 DTO 层（对整个告警控制器生效），因此断言直接打在 DTO 转换结果上。
 */
describe('查询参数规范化（历史 500 的根因）', () => {
  it('重复参数被解析成数组时取首值', () => {
    expect(normalizeProjectParam(['clklogapp', 'clklogapp'])).toBe('clklogapp');
    expect(normalizeProjectParam('clklogapp')).toBe('clklogapp');
    expect(normalizeProjectParam([])).toBeUndefined();
    expect(normalizeProjectParam(undefined)).toBeUndefined();
  });

  it('DTO 转换后 project 一定是字符串（不会把数组送进 Prisma）', () => {
    const dto = plainToInstance(NotificationListDto, { project: ['clklogapp', 'other'], limit: '10' });
    expect(dto.project).toBe('clklogapp');
    expect(dto.limit).toBe(10);
  });
});

/**
 * 阈值上限（2026-09-15 验收实测发现）：原上限 100 万，而当日事件量可达千万级
 * （base_performance_httprequest_report 单日 1000 万+），「大于阈值」类告警永远命中。
 * 上限放宽到 1e12，同时仍然挡住明显的误输入。
 */
describe('阈值上限', () => {
  const build = (threshold: number) =>
    toDto(CreateAlertRuleDto, { name: 'x', metric_id: 'metric_1', threshold });

  it('千万级阈值可用（旧上限会 400）', () => {
    expect(validateSync(build(11_000_000))).toHaveLength(0);
    expect(validateSync(build(500_000_000_000))).toHaveLength(0);
  });

  it('超过 1e12 与负数仍被拒绝', () => {
    expect(validateSync(build(1_000_000_000_001)).length).toBeGreaterThan(0);
    expect(validateSync(build(-1)).length).toBeGreaterThan(0);
  });
});
