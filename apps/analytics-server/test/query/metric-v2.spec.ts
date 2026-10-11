/**
 * 指标 v2：契约与求值（phase: clklog-analytics-metric-v2）。
 *
 * 三件事要锁住：
 * 1. 保存指标**不丢口径**（数值变换 / 取值选择 / 查询时间 / 分析主体都要留在 definition_json 里）；
 * 2. 查询时间只允许相对范围且 ≤90 天（红线 4：分析查询必须有界）；
 * 3. 取值归并的边界（无数据 → null 跳过本轮；不可加方法必须整段求值），
 *    并保证「未设取值选择」时走的仍是存量那条整段聚合查询（值不变）。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: false,
    __specConfigMock: true,
  },
}));

import { addCalendarDays, DEFAULT_PLATFORM_TZ, todayInTz } from '../../src/modules/time/calendar';
import { MetaSavedMetricService } from '../../src/modules/meta/meta-saved-metric.service';
import type { MetaSavedMetricRepository } from '../../src/modules/meta/meta-saved-metric.repository';
import { MetricEvalService } from '../../src/modules/query/metric-eval.service';
import {
  resolveMetricWindow,
  validateMetricTimeRange,
  validateRetentionWindow,
  windowDates,
} from '../../src/modules/query/metric-window';
import { resolveTransform } from '../../src/modules/query/metric-transform';
import {
  pickSeriesValue,
  pickNeedsSeries,
  resolveValuePick,
  type SeriesPoint,
} from '../../src/modules/query/metric-value-pick';

function metricService() {
  const repository = {
    findById: jest.fn(),
    findByName: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    list: jest.fn(),
  } as unknown as MetaSavedMetricRepository;
  const prisma = { opsActionLog: { create: jest.fn(async () => ({})) } };
  return new MetaSavedMetricService(repository, prisma as never);
}

const eventMetric = (extra: Record<string, unknown> = {}) => ({
  metric: { kind: 'event', event: 'AppStart', analysis: 'total_times', ...extra },
});

describe('指标定义 v2：保存不丢口径', () => {
  it('数值变换 / 取值选择 / 查询时间 / 分析主体都保留，并写明 version 与 time_source', () => {
    const def = metricService().normalizeDefinition('event', eventMetric({
      transform: { factor: 0.001, decimals: 2 },
      value_pick: 'last_day',
      time_range: { start: '', end: '', relative: { kind: 'recent_n', n: 7 } },
      subject_id: 'subj_1',
      filters: { logic: 'and', items: [{ scope: 'event', prop: 'status', op: 'in', value: ['200'] }] },
    })) as Record<string, any>;

    expect(def.version).toBe(2);
    expect(def.time_source).toBe('metric');
    // v3：写回时升级为四则运算形态（旧 factor 读时仍兼容）
    expect(def.metric.transform).toEqual({ op: 'mul', value: 0.001, decimals: 2 });
    expect(def.metric.value_pick).toBe('last_day');
    expect(def.metric.time_range.relative).toEqual({ kind: 'recent_n', n: 7 });
    expect(def.metric.subject_id).toBe('subj_1');
    expect(def.metric.filters.items).toHaveLength(1);
  });

  it('没设查询时间 → time_source=rule（跟随告警窗口，存量行为）', () => {
    const def = metricService().normalizeDefinition('event', eventMetric()) as Record<string, any>;
    expect(def.time_source).toBe('rule');
    expect(def.metric.time_range).toBeUndefined();
  });

  it('系数为 1 与空小数位不写入定义（避免无意义的变换）', () => {
    const def = metricService().normalizeDefinition('event', eventMetric({
      transform: { factor: 1, decimals: null },
    })) as Record<string, any>;
    expect(def.metric.transform).toBeUndefined();
  });

  it('非法取值选择 / 非法时间范围 / 非法小数位 → 400', () => {
    const svc = metricService();
    expect(() => svc.normalizeDefinition('event', eventMetric({ value_pick: 'p50' }))).toThrow('取值选择不合法');
    expect(() =>
      svc.normalizeDefinition('event', eventMetric({ time_range: { start: '2026-01-01', end: '2026-01-31' } })),
    ).toThrow('相对范围');
    expect(() =>
      svc.normalizeDefinition('event', eventMetric({ time_range: { relative: { kind: 'recent_n', n: 200 } } })),
    ).toThrow('跨度不能超过 90 天');
    expect(() => svc.normalizeDefinition('event', eventMetric({ transform: { decimals: 9 } }))).toThrow(
      '保留小数位必须是 0~6 的整数',
    );
  });
});

describe('查询时间', () => {
  const now = new Date('2026-09-16T04:00:00Z'); // 上海 12:00

  it('recent_n 含今天、past_n 不含今天（文案把差别写出来）', () => {
    const recent = resolveMetricWindow({ relative: { kind: 'recent_n', n: 7 } }, { now });
    const past = resolveMetricWindow({ relative: { kind: 'past_n', n: 7 } }, { now });
    expect(recent).toMatchObject({ start: '2026-09-10', end: '2026-09-16', days: 7, source: 'metric' });
    expect(recent.label).toBe('近 7 天（含今天）');
    expect(past).toMatchObject({ start: '2026-09-09', end: '2026-09-15', days: 7 });
    expect(past.label).toBe('过去 7 天（不含今天）');
  });

  it('没设查询时间时跟随告警窗口（source=rule），没有兜底则用默认 7 天', () => {
    const rule = resolveMetricWindow(undefined, { fallbackDays: 30, now });
    expect(rule).toMatchObject({ days: 30, label: '近 30 天', source: 'rule' });
    expect(rule.start).toBe('2026-08-18');
    const fallback = resolveMetricWindow(undefined, { now });
    expect(fallback).toMatchObject({ days: 7, source: 'default' });
  });

  it('留存队列范围：≥ 周期+1 天、≤ 180 天（放宽上限不能与通用 90 天混用）', () => {
    // 120 天：通用指标上限是 90，但留存允许到 180（线上曾因混用上限报「队列范围不合法」）
    expect(validateRetentionWindow({ relative: { kind: 'recent_n', n: 120 } }, 1)).toBeNull();
    expect(validateRetentionWindow({ relative: { kind: 'recent_n', n: 180 } }, 1)).toBeNull();
    expect(validateRetentionWindow({ relative: { kind: 'recent_n', n: 200 } }, 1)).toContain('180 天');
    expect(validateRetentionWindow({ relative: { kind: 'recent_n', n: 1 } }, 1)).toContain('至少 2 天');
    expect(validateRetentionWindow(undefined, 7)).toBeNull();
    expect(validateRetentionWindow({ start: '2026-01-01', end: '2026-02-01' }, 1)).toContain('相对范围');
  });

  it('固定日期与超长跨度被拒绝；窗口日期补齐含首尾', () => {
    expect(validateMetricTimeRange({ start: '2026-01-01', end: '2026-01-02' })).toContain('相对范围');
    expect(validateMetricTimeRange({ relative: { kind: 'recent_n', n: 91 } })).toContain('90 天');
    expect(validateMetricTimeRange({ relative: { kind: 'recent_n', n: 90 } })).toBeNull();
    // 留存队列范围放宽到 180 天；指标查询时间仍是 90 天
    expect(validateMetricTimeRange({ relative: { kind: 'recent_n', n: 120 } }, { maxDays: 180 })).toBeNull();
    expect(validateMetricTimeRange({ relative: { kind: 'recent_n', n: 120 } })).toContain('90 天');
    expect(windowDates({ start: '2026-09-14', end: '2026-09-16' })).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
    ]);
  });
});

describe('取值选择', () => {
  const series: SeriesPoint[] = [
    { date: '2026-09-14', value: 10 },
    { date: '2026-09-15', value: null },
    { date: '2026-09-16', value: 30 },
  ];

  it('累计与日均把「无数据的日子」按 0 计；日均除以窗口天数', () => {
    expect(pickSeriesValue('sum', series, 3)).toBe(40);
    expect(pickSeriesValue('avg', series, 3)).toBeCloseTo(13.333, 2);
  });

  it('最大/最小/首日/最新一天只用有数据的日子', () => {
    expect(pickSeriesValue('max', series, 3)).toBe(30);
    expect(pickSeriesValue('min', series, 3)).toBe(10);
    expect(pickSeriesValue('first_day', series, 3)).toBe(10);
    expect(pickSeriesValue('last_day', series, 3)).toBe(30);
  });

  it('整段类取值必须走整段查询，不能按日归并；空序列 → null（跳过本轮）', () => {
    expect(pickNeedsSeries('uniq_total')).toBe(false);
    expect(pickNeedsSeries('weighted')).toBe(false);
    expect(() => pickSeriesValue('uniq_total', series, 3)).toThrow('整段查询结果');
    const empty: SeriesPoint[] = [{ date: '2026-09-16', value: null }];
    expect(pickSeriesValue('max', empty, 1)).toBeNull();
    expect(pickSeriesValue('last_day', empty, 1)).toBeNull();
    expect(pickSeriesValue('sum', empty, 1)).toBe(0);
  });

  it('未设取值时按计算方法推荐（存量口径不变）', () => {
    expect(resolveValuePick(undefined, 'total_times')).toBe('sum');
    expect(resolveValuePick(undefined, 'trig_user_num')).toBe('uniq_total');
    expect(resolveValuePick(undefined, 'per_capita_num')).toBe('weighted');
    expect(resolveValuePick('last_day', 'total_times')).toBe('last_day');
  });

  it('数值变换不再在 JS 侧二次计算（由 SQL 侧应用，见 v3 设计 §1）', () => {
    // 这里断言的是「定义里的 transform 会随查询下传」，而不是 JS 结果
    expect(resolveTransform({ factor: 0.001, decimals: 2 })).toEqual({ op: 'mul', value: 0.001, decimals: 2 });
  });
});

describe('MetricEvalService：试算与告警共用同一实现', () => {
  type AnalyzeArgs = [Record<string, any>, string, boolean?];
  const rowsResult = (rows: Record<string, unknown>[]) => ({ rows, columns: [], elapsed_ms: 1, sql: '' });
  const stub = (rows: Record<string, unknown>[]) => {
    const eventQuery = { analyze: jest.fn(async (..._args: AnalyzeArgs) => rowsResult(rows)) };
    return { service: new MetricEvalService(eventQuery as never), eventQuery };
  };

  it('未设取值选择 → 单条整段查询（groups 为空），值取 m_0：与存量告警一致', async () => {
    const { service, eventQuery } = stub([{ m_0: 42 }]);
    const out = await service.evaluateEvent({
      project: 'demo',
      definition: eventMetric({ time_range: { relative: { kind: 'recent_n', n: 7 } } }),
      fallbackWindowDays: 30,
    });
    expect(eventQuery.analyze).toHaveBeenCalledTimes(1);
    expect(eventQuery.analyze.mock.calls[0][0].groups).toEqual([]);
    expect(eventQuery.analyze.mock.calls[0][0].time_range.relative).toEqual({ kind: 'recent_n', n: 7 });
    expect(out.value).toBe(42);
    expect(out.used_overall).toBe(true);
    expect(out.series).toEqual([]);
  });

  it('取值=最新一天 → 按天分组，取最后一个有数据的日子；变换随查询下传（不在本层重算）', async () => {
    // 窗口按「上海今天」推导（与实现同一口径），避免写死日期导致测试随时间腐化
    const today = todayInTz(DEFAULT_PLATFORM_TZ, new Date());
    const firstDay = addCalendarDays(today, -2);
    const middleDay = addCalendarDays(today, -1);
    const { service, eventQuery } = stub([
      { __stage: true, g_0: '阶段汇总', m_0: 99 },
      { g_0: firstDay, m_0: 5 },
      { g_0: today, m_0: 8 },
    ]);
    const out = await service.evaluateEvent({
      project: 'demo',
      definition: eventMetric({
        value_pick: 'last_day',
        transform: { factor: 10 },
        time_range: { relative: { kind: 'recent_n', n: 3 } },
      }),
      withSeries: true,
    });
    expect(eventQuery.analyze.mock.calls[0][0].groups).toEqual([{ scope: 'time', granularity: 'day' }]);
    // 引擎插入的「阶段汇总」行不能当成一天
    expect(out.series.map((point) => point.date)).toEqual([firstDay, middleDay, today]);
    expect(out.series[1].value).toBeNull();
    // 值就是查询返回的原始值：数值变换由 SQL 生成器按 metric.transform 在聚合层算好
    expect(out.value).toBe(8);
    expect(eventQuery.analyze.mock.calls[0][0].metrics[0].transform).toEqual({ factor: 10 });
    expect(out.pick_explicit).toBe(true);
    expect(out.used_overall).toBe(false);
  });

  it('取值=整段去重合计 → 仍走整段查询（不可加方法不能按日相加）', async () => {
    const { service, eventQuery } = stub([{ m_0: 120 }]);
    const out = await service.evaluateEvent({
      project: 'demo',
      definition: eventMetric({ analysis: 'trig_user_num', value_pick: 'uniq_total' }),
    });
    expect(eventQuery.analyze).toHaveBeenCalledTimes(1);
    expect(eventQuery.analyze.mock.calls[0][0].groups).toEqual([]);
    expect(out.value).toBe(120);
  });

  it('未设取值 + 要日序列（试算面板）→ 整段值仍来自整段查询，序列另取', async () => {
    const today = todayInTz(DEFAULT_PLATFORM_TZ, new Date());
    const eventQuery = {
      analyze: jest
        .fn<Promise<ReturnType<typeof rowsResult>>, AnalyzeArgs>()
        .mockResolvedValueOnce(rowsResult([{ m_0: 42 }]))
        .mockResolvedValueOnce(rowsResult([{ g_0: today, m_0: 42 }])),
    };
    const service = new MetricEvalService(eventQuery as never);
    const out = await service.evaluateEvent({
      project: 'demo',
      definition: eventMetric({ time_range: { relative: { kind: 'recent_n', n: 1 } } }),
      withSeries: true,
    });
    expect(eventQuery.analyze).toHaveBeenCalledTimes(2);
    expect(out.value).toBe(42);
    expect(out.series).toEqual([{ date: today, value: 42 }]);
  });

  it('未指定事件 / 非事件指标 → 400（不让试算静默返回空）', async () => {
    const { service } = stub([]);
    await expect(service.evaluateEvent({ project: 'demo', definition: { metric: { analysis: 'sum' } } })).rejects.toThrow(
      '未指定事件',
    );
    await expect(
      service.evaluateEvent({ project: 'demo', definition: {}, kind: 'retention' }),
    ).rejects.toThrow('暂不支持');
  });
});
