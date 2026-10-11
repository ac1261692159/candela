/**
 * 指标告警求值（phase: clklog-analytics-alerting-v4，PRD A-3/A-6）。
 *
 * 两层：
 * - 纯函数（窗口口径、取值、格式化、失败计数）——与存储/引擎无关，直接断言；
 * - 服务层——用 mock 的查询服务与 Prisma 断言「口径复用了工作台查询链路」：
 *   项目过滤 + 天窗口 + 不分组单行取值，指标被删/求值失败一律跳过本轮。
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

import { EventQueryService } from '../../src/modules/query/event-query.service';
import { RetentionQueryService } from '../../src/modules/query/retention-query.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';
import { MetricEvalService } from '../../src/modules/query/metric-eval.service';
import { AlertMetricEvalService } from '../../src/modules/alerting/alert-metric-eval.service';
import {
  EvalFailureTracker,
  MAX_METRIC_RULES,
  definitionSummary,
  extractEventMetricValue,
  extractRetentionValue,
  formatMetricValue,
  retentionRange,
  toMetricValue,
  windowLabel,
  windowRange,
} from '../../src/modules/alerting/alert-metric-eval';

describe('窗口口径（上海时区，按天）', () => {
  const now = new Date('2026-09-15T03:00:00Z'); // 上海 11:00

  it('窗口 1 = 今天（单日）', () => {
    expect(windowRange(1, now)).toEqual({ start: '2026-09-15', end: '2026-09-15' });
    expect(windowLabel(1)).toBe('今天');
  });

  it('窗口 N = 含今天在内往前推 N 天', () => {
    expect(windowRange(7, now)).toEqual({ start: '2026-09-09', end: '2026-09-15' });
    expect(windowLabel(7)).toBe('近 7 天');
  });

  it('非法窗口回落默认 1 天（不放大查询）', () => {
    expect(windowRange(999, now)).toEqual({ start: '2026-09-15', end: '2026-09-15' });
  });

  it('留存窗口覆盖 n 天成熟期且有上限（有界查询）', () => {
    expect(retentionRange(1, now)).toEqual({ start: '2026-08-16', end: '2026-09-15' }); // 至少 30 天队列
    expect(retentionRange(90, now)).toEqual({ start: '2026-05-19', end: '2026-09-15' }); // n + 30 天
    expect(retentionRange(365, now).start).toBe('2026-03-20'); // 封顶 180 天
  });

  it('限额常量对得上设计文档', () => {
    expect(MAX_METRIC_RULES).toBe(20);
  });
});

describe('取值与格式化', () => {
  it('事件指标：取聚合单行 m_0', () => {
    expect(extractEventMetricValue([{ m_0: 42 }])).toBe(42);
    expect(extractEventMetricValue([{ m_0: '42' }])).toBe(42);
    expect(extractEventMetricValue([])).toBeNull();
    expect(extractEventMetricValue([{ m_0: null }])).toBeNull();
    expect(extractEventMetricValue([{ m_0: 'abc' }])).toBeNull();
  });

  it('留存 rate：取最新已成熟队列并换算成百分比', () => {
    const rows = [
      { cohort_date: '2026-09-10', n_1: 5, n_1_rate: 0.5 },
      { cohort_date: '2026-09-11', n_1: 4, n_1_rate: 0.4321 },
      { cohort_date: '2026-09-12', n_1: null, n_1_rate: null }, // 未成熟被 mask
    ];
    expect(extractRetentionValue(rows, 1, 'rate')).toBe(43.21);
  });

  it('留存 count：直接取人数，不受 rate 影响', () => {
    const rows = [{ cohort_date: '2026-09-11', n_7: 12, n_7_rate: 0.2 }];
    expect(extractRetentionValue(rows, 7, 'count')).toBe(12);
  });

  it('全部队列未成熟 → null（本轮跳过，不误判为 0）', () => {
    expect(extractRetentionValue([{ n_1: null, n_1_rate: null }], 1, 'rate')).toBeNull();
  });

  it('原始值转换：空串/非数字 → null，数字字符串 → 数字', () => {
    expect(toMetricValue('')).toBeNull();
    expect(toMetricValue(undefined)).toBeNull();
    expect(toMetricValue('12.5')).toBe(12.5);
  });

  it('展示格式：千分位 + 单位，百分比格式带 %', () => {
    expect(formatMetricValue(1204, '次')).toBe('1,204次');
    expect(formatMetricValue(43.21, '%', 'percent')).toBe('43.21%');
    expect(formatMetricValue(0.5, '', 'percent')).toBe('0.5%');
    expect(formatMetricValue(Number.NaN, '次')).toBe('—');
  });

  it('单位按语言本地化（i18n v1）：中文逐字不变，英文映射成英文单位', () => {
    expect(formatMetricValue(1204, '次', undefined, 'zh-CN')).toBe('1,204次');
    expect(formatMetricValue(1204, '次', undefined, 'en-US')).toBe('1,204 times');
    expect(formatMetricValue(30, '天', undefined, 'en-US')).toBe('30 days');
    expect(formatMetricValue(3, '个', undefined, 'en-US')).toBe('3 items');
    expect(formatMetricValue(2, '人', undefined, 'en-US')).toBe('2 users');
    expect(formatMetricValue(90, '秒', undefined, 'en-US')).toBe('90 sec');
    expect(formatMetricValue(1204, '%', 'percent', 'en-US')).toBe('1,204%');
    // 未收录的单位原样保留（不猜、不空格）
    expect(formatMetricValue(1204, '件', undefined, 'en-US')).toBe('1,204件');
    // 第二梯队语言（2026-09-17 上线）用各自的量词：日 回 / 韩 회
    expect(formatMetricValue(1204, '次', undefined, 'ja-JP')).toBe('1,204回');
    expect(formatMetricValue(1204, '次', undefined, 'ko-KR')).toBe('1,204회');
    // 未上线的语言回退原单位：用保留标签 xx-XX（刻意不用某个真实语言，避免语言集扩张后断言过期）
    expect(formatMetricValue(1204, '次', undefined, 'xx-XX')).toBe('1,204次');
  });

  it('窗口文案按语言（i18n v1，中文逐字不变）', () => {
    expect(windowLabel(1, 'en-US')).toBe('Today');
    expect(windowLabel(7, 'en-US')).toBe('Last 7 days');
    expect(windowLabel(1, 'zh-CN')).toBe('今天');
  });

  it('定义摘要能读懂事件指标与留存指标', () => {
    expect(
      definitionSummary('event', { metric: { event: 'Purchase', analysis: 'total_times' } }),
    ).toContain('Purchase');
    expect(
      definitionSummary('retention', {
        start_event: { event: 'SignUp' },
        retain_event: { event: 'Purchase' },
        n: 1,
        measure: 'rate',
      }),
    ).toContain('留存率');
  });

  it('失败计数：连续 3 次才算异常，成功即清零', () => {
    const tracker = new EvalFailureTracker();
    tracker.record('metric_a', 'boom');
    tracker.record('metric_a', 'boom');
    expect(tracker.isBroken('metric_a')).toBe(false);
    tracker.record('metric_a', 'boom');
    expect(tracker.isBroken('metric_a')).toBe(true);
    tracker.clear('metric_a');
    expect(tracker.isBroken('metric_a')).toBe(false);
  });
});

/* ------------------------------- 服务层 ------------------------------- */

const EVENT_METRIC = {
  metric_id: 'metric_1',
  project_name: 'clklogapp',
  name: 'order_count',
  display_name: '订单量',
  kind: 'event',
  format: 'number',
  remark: null,
  updated_at: new Date('2026-09-15T00:00:00Z'),
  definition_json: JSON.stringify({
    metric: { kind: 'event', analysis: 'total_times', event: 'Purchase', alias: '订单量' },
  }),
};

const RETENTION_METRIC = {
  ...EVENT_METRIC,
  metric_id: 'metric_2',
  name: 'd1_retention',
  display_name: '次日留存',
  kind: 'retention',
  format: 'percent',
  definition_json: JSON.stringify({
    start_event: { event: 'SignUp' },
    retain_event: { event: 'Purchase' },
    cohort: 'all',
    granularity: 'day',
    n: 1,
    measure: 'rate',
  }),
};

function harness(options: { metric?: unknown; eventRows?: unknown[]; retentionRows?: unknown[]; eventThrows?: Error } = {}) {
  const prisma = {
    metaSavedMetric: {
      findUnique: jest.fn(async () => options.metric ?? null),
      findMany: jest.fn(async () => (options.metric ? [options.metric] : [])),
    },
  } as unknown as PrismaService;
  const eventQuery = {
    analyze: jest.fn(async () => {
      if (options.eventThrows) throw options.eventThrows;
      return { rows: options.eventRows ?? [{ m_0: 42 }], columns: [], elapsed_ms: 1, sql: 'SELECT 1' };
    }),
  } as unknown as EventQueryService;
  const retentionQuery = {
    analyze: jest.fn(async () => ({ rows: options.retentionRows ?? [{ n_1: 4, n_1_rate: 0.4321 }], columns: [], elapsed_ms: 1, sql: 'SELECT 1' })),
  } as unknown as RetentionQueryService;
  // 事件指标求值改由 QueryModule 的 MetricEvalService 承担（与指标编辑器试算同一实现）
  const metricEval = new MetricEvalService(eventQuery);
  const service = new AlertMetricEvalService(metricEval, prisma, eventQuery, retentionQuery);
  return { service, prisma: prisma as any, eventQuery: eventQuery as any, retentionQuery: retentionQuery as any };
}

const RULE = { code: 'metric_abc', name: '订单量告警', metric_id: 'metric_1', project_name: 'clklogapp', window_days: 1 };

describe('求值服务：事件指标走事件分析（口径与工作台一致）', () => {
  it('项目过滤 + 天窗口 + 不分组，取 m_0', async () => {
    const { service, eventQuery } = harness({ metric: EVENT_METRIC, eventRows: [{ m_0: 7 }] });

    const result = await service.evaluate(RULE);

    expect(result.value).toBe(7);
    expect(result.metric).toMatchObject({ display_name: '订单量', kind: 'event' });
    const [query, project, refresh] = eventQuery.analyze.mock.calls[0];
    expect(project).toBe('clklogapp');
    expect(refresh).toBe(true); // 判定必须基于当前数据，不吃查询缓存
    expect(query.project).toBe('clklogapp');
    expect(query.metrics[0]).toMatchObject({ analysis: 'total_times', event: 'Purchase', id: 'm_metric' });
    expect(query.groups).toEqual([]); // 不分组 → 单行聚合
    expect(query.time_range.start).toBe(query.time_range.end); // 窗口 1 天 = 今天
  });

  it('窗口 7 天时时间范围是近 7 天', async () => {
    const { service, eventQuery } = harness({ metric: EVENT_METRIC });
    await service.evaluate({ ...RULE, window_days: 7 });
    const [query] = eventQuery.analyze.mock.calls[0];
    const span = (Date.parse(query.time_range.end) - Date.parse(query.time_range.start)) / 86_400_000;
    expect(span).toBe(6);
  });

  it('留存指标走留存分析，rate 取百分比', async () => {
    const { service, retentionQuery } = harness({ metric: RETENTION_METRIC });
    const result = await service.evaluate({ ...RULE, metric_id: 'metric_2' });
    expect(result.value).toBe(43.21);
    expect(result.metric?.kind).toBe('retention');
    const [query, , refresh] = retentionQuery.analyze.mock.calls[0];
    expect(query.n_list).toEqual([1]);
    expect(refresh).toBe(true);
  });

  it('指标被删除 → 跳过本轮并记录失败原因（交健康度提示）', async () => {
    const { service } = harness({ metric: null });
    const result = await service.evaluate(RULE);
    expect(result.value).toBeNull();
    expect(result.metric).toBeNull();
    expect(service.failureOf('metric_abc')?.message).toContain('指标不存在');
  });

  it('求值抛错 → 跳过本轮；连续 3 次后健康度异常', async () => {
    const { service } = harness({ metric: EVENT_METRIC, eventThrows: new Error('socket hang up') });

    await service.evaluate(RULE);
    expect(service.isBroken('metric_abc')).toBe(false);
    await service.evaluate(RULE);
    await service.evaluate(RULE);

    expect(service.isBroken('metric_abc')).toBe(true);
    expect(service.failureOf('metric_abc')?.message).toContain('socket hang up');
  });

  it('求值为空也算一次失败，但成功后清零', async () => {
    const empty = harness({ metric: EVENT_METRIC, eventRows: [] });
    await empty.service.evaluate(RULE);
    expect(empty.service.failureOf('metric_abc')?.message).toContain('为空');

    const ok = harness({ metric: EVENT_METRIC, eventRows: [{ m_0: 1 }] });
    await ok.service.evaluate(RULE);
    expect(ok.service.failureOf('metric_abc')).toBeUndefined();
  });

  it('指标缓存：同一轮多次求值只查一次库；invalidate 后重新查', async () => {
    const { service, prisma } = harness({ metric: EVENT_METRIC });
    await service.evaluate(RULE);
    await service.evaluate(RULE);
    expect(prisma.metaSavedMetric.findUnique).toHaveBeenCalledTimes(1);

    service.invalidate('metric_1');
    await service.evaluate(RULE);
    expect(prisma.metaSavedMetric.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('求值服务：测试取值（probe）', () => {
  it('返回数值、窗口与耗时，且不吃缓存（fresh 读）', async () => {
    const { service, prisma } = harness({ metric: EVENT_METRIC, eventRows: [{ m_0: 1204 }] });
    const result = await service.probe('metric_1', 'clklogapp', 1);
    expect(result).toMatchObject({ value: 1204, value_fmt: '1,204', window_days: 1, window_fmt: '今天' });
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(prisma.metaSavedMetric.findUnique).toHaveBeenCalledTimes(1);
  });

  it('指标不存在 → 404（前端可提示去数据管理创建）', async () => {
    const { service } = harness({ metric: null });
    await expect(service.probe('metric_x', 'clklogapp', 1)).rejects.toThrow('指标不存在');
  });

  it('求值失败 → 返回 error 字段而不是抛错（UI 展示原因）', async () => {
    const { service } = harness({ metric: EVENT_METRIC, eventThrows: new Error('limit exceeded') });
    const result = await service.probe('metric_1', 'clklogapp', 1);
    expect(result.value).toBeNull();
    expect(result.error).toContain('limit exceeded');
  });
});

describe('求值服务：可选指标清单', () => {
  it('事件指标与留存指标都可告警，并带出摘要与单位', async () => {
    const { service } = harness({ metric: EVENT_METRIC });
    const [eventItem] = await service.catalog('clklogapp');
    expect(eventItem).toMatchObject({ alertable: true, kind_label: '事件指标', unit: '' });
    expect(eventItem.definition_summary).toContain('Purchase');

    const retention = harness({ metric: RETENTION_METRIC });
    const [retentionItem] = await retention.service.catalog('clklogapp');
    expect(retentionItem).toMatchObject({ alertable: true, kind_label: '留存指标', unit: '%' });
  });

  it('未指定事件的事件指标不可告警，并给出原因', async () => {
    const broken = {
      ...EVENT_METRIC,
      definition_json: JSON.stringify({ metric: { kind: 'event', analysis: 'total_times' } }),
    };
    const { service } = harness({ metric: broken });
    const [item] = await service.catalog('clklogapp');
    expect(item.alertable).toBe(false);
    expect(item.reason).toContain('未指定事件');
  });
});
