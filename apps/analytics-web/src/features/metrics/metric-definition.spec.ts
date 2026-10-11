/**
 * 指标定义读/写纯逻辑（phase: clklog-analytics-metric-v2）。
 *
 * 最关键的断言有两条：
 * 1. 「编辑只覆盖表单字段」：filters / alias / stage_reduce 等原样保留；
 * 2. 「清空 = 删键」：取消数值变换 / 取值选择 / 查询时间后定义里不留 null（PRD AC-1/AC-8）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { changeLocale, t } from '../../i18n';
import {
  analysisNeedsProp,
  buildEventDefinition,
  buildRetentionDefinition,
  describeMetric,
  metricSummaryText,
  metricWindowPayloadLabel,
  shortSummary,
  toFormValues,
  valuePickLabel,
  valuePickNote,
  windowPickSummary,
} from './metric-definition';

const EVENT_DEF = {
  metric: {
    id: 'm_0',
    kind: 'event',
    analysis: 'total_times',
    event: 'Purchase',
    alias: '订单量',
    stage_reduce: 'sum',
    filters: { logic: 'and', items: [{ scope: 'event', prop: 'pay_type', op: '=', value: 'alipay' }] },
  },
};

const RETENTION_DEF = {
  start_event: {
    event: 'screen_view',
    filters: { logic: 'and', items: [{ scope: 'event', prop: 'channel', op: '=', value: 'app' }] },
  },
  retain_event: { event: 'scene_trade_sell_event_trigger', filters: undefined },
  cohort: 'all',
  granularity: 'day',
  n: 1,
  measure: 'rate',
};

describe('口径摘要（查看）', () => {
  it('事件指标：事件 / 计算方法 / 属性 / 数值变换 / 取值选择 / 查询时间 / 筛选条件', () => {
    const rows = describeMetric('event', EVENT_DEF);
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['事件', 'Purchase'],
      ['计算方法', '总次数'],
      ['属性', '（不需要）'],
      ['数值变换', '（不需要）'],
      ['取值选择', '自动（按计算方法）'],
      ['查询时间', '跟随告警窗口'],
      ['筛选条件', '1 条'],
    ]);
  });

  it('已设置的取值 / 查询时间 / 数值变换按中文口径展示（PRD AC-11）', () => {
    const rows = describeMetric('event', {
      metric: {
        ...EVENT_DEF.metric,
        transform: { factor: 0.001, decimals: 2 },
        value_pick: 'last_day',
        time_range: { start: '', end: '', relative: { kind: 'recent_n', n: 7 } },
      },
    });
    expect(rows.find((row) => row.label === '取值选择')?.value).toBe('最新一天');
    expect(rows.find((row) => row.label === '查询时间')?.value).toBe('近 7 天（含今天）');
    expect(rows.find((row) => row.label === '数值变换')?.value).toBe('×0.001，保留 2 位');
  });

  it('分位数按 percentile 显示 P 值', () => {
    const rows = describeMetric('event', {
      metric: { analysis: 'percentile', event: 'Purchase', prop: 'amount', percentile: 90 },
    });
    expect(rows.find((row) => row.label === '计算方法')?.value).toBe('P90');
    expect(rows.find((row) => row.label === '属性')?.value).toBe('amount');
  });

  it('留存指标：初始→回访 + 周期 + 口径 + 队列 + 粒度 + 队列范围（v3）', () => {
    const rows = describeMetric('retention', RETENTION_DEF);
    expect(rows).toEqual([
      { label: '初始事件', value: 'screen_view' },
      { label: '回访事件', value: 'scene_trade_sell_event_trigger' },
      { label: '周期', value: '1日' },
      { label: '口径', value: '留存率' },
      { label: '队列', value: '全部用户' },
      { label: '粒度', value: '按日' },
      // 未设置队列范围时说明推导口径（1+30=31 天）
      { label: '队列范围', value: '按周期推导（31 天）' },
    ]);
  });

  it('留存指标设置队列范围后，口径与摘要都显示它（v3）', () => {
    const withWindow = {
      ...RETENTION_DEF,
      time_range: { start: '', end: '', relative: { kind: 'recent_n', n: 90 } },
    };
    const rows = describeMetric('retention', withWindow);
    expect(rows.find((row) => row.label === '队列范围')?.value).toBe('近 90 天（含今天）');
  });

  it('留存编辑：队列范围可设置与清除（不写空对象）', () => {
    const set = buildRetentionDefinition(RETENTION_DEF, {
      startEvent: 'screen_view',
      retainEvent: 'scene_trade_sell_event_trigger',
      n: 1,
      measure: 'rate',
      cohort: 'all',
      granularity: 'day',
      timeRange: { start: '', end: '', relative: { kind: 'recent_n', n: 90 } },
    });
    expect(set.time_range).toEqual({ start: '', end: '', relative: { kind: 'recent_n', n: 90 } });

    const cleared = buildRetentionDefinition(set, {
      startEvent: 'screen_view',
      retainEvent: 'scene_trade_sell_event_trigger',
      n: 1,
      measure: 'rate',
      cohort: 'all',
      granularity: 'day',
      timeRange: null,
    });
    expect('time_range' in cleared).toBe(false);
  });

  it('留存周期按粒度换单位（周/月）', () => {
    const rows = describeMetric('retention', { ...RETENTION_DEF, n: 2, granularity: 'week', measure: 'count' });
    expect(rows.find((row) => row.label === '周期')?.value).toBe('2周');
    expect(rows.find((row) => row.label === '口径')?.value).toBe('留存人数');
  });

  it('字段缺失不崩，回落为 —', () => {
    expect(describeMetric('event', {}).slice(0, 3)).toEqual([
      { label: '事件', value: '—' },
      { label: '计算方法', value: '—' },
      { label: '属性', value: '（不需要）' },
    ]);
  });

  it('列表第二行摘要 = 查询时间 · 取值（PRD AC-11）', () => {
    expect(windowPickSummary('event', EVENT_DEF)).toBe('跟随告警窗口 · 自动取值');
    expect(
      windowPickSummary('event', {
        metric: { ...EVENT_DEF.metric, value_pick: 'avg', time_range: { relative: { kind: 'recent_n', n: 7 } } },
      }),
    ).toBe('近 7 天（含今天） · 日均');
    expect(windowPickSummary('retention', RETENTION_DEF)).toBeNull();
  });

  it('列表摘要取前三行（空间有限）', () => {
    expect(shortSummary('event', EVENT_DEF)).toBe('事件 Purchase · 计算方法 总次数 · 属性 （不需要）');
  });
});

describe('编辑载荷：只覆盖表单字段（M-6）', () => {
  it('事件指标改计算方法时，filters / alias / stage_reduce 原样保留', () => {
    const next = buildEventDefinition(EVENT_DEF, { event: 'Purchase', analysis: 'sum', prop: 'amount' });
    expect(next.version).toBeUndefined();
    const metric = next.metric as Record<string, unknown>;
    expect(metric.analysis).toBe('sum');
    expect(metric.prop).toBe('amount');
    expect(metric.alias).toBe('订单量');
    expect(metric.stage_reduce).toBe('sum');
    expect(metric.filters).toEqual(EVENT_DEF.metric.filters);
  });

  it('v2 字段：设置即写入，清空即删键（不留 null）', () => {
    const withV2 = buildEventDefinition(EVENT_DEF, {
      event: 'Purchase',
      analysis: 'total_times',
      transform: { factor: 0.01, decimals: 2 },
      value_pick: 'avg',
      time_range: { start: '', end: '', relative: { kind: 'recent_n', n: 7 } },
      subject_id: 'subj_1',
    });
    const metric = withV2.metric as Record<string, unknown>;
    // v3：写回统一为四则运算形态
    expect(metric.transform).toEqual({ op: 'mul', value: 0.01, decimals: 2 });
    expect(metric.value_pick).toBe('avg');
    expect(metric.time_range).toEqual({ start: '', end: '', relative: { kind: 'recent_n', n: 7 } });
    expect(metric.subject_id).toBe('subj_1');

    const cleared = buildEventDefinition(withV2, {
      event: 'Purchase',
      analysis: 'total_times',
      transform: null,
      value_pick: null,
      time_range: null,
      subject_id: null,
    });
    const next = cleared.metric as Record<string, unknown>;
    expect('transform' in next).toBe(false);
    expect('value_pick' in next).toBe(false);
    expect('time_range' in next).toBe(false);
    expect('subject_id' in next).toBe(false);
    // 别的东西不受影响
    expect(next.alias).toBe('订单量');
    expect(next.stage_reduce).toBe('sum');
  });

  it('乘以 1 且无小数位视为无操作（不写入）；只填小数位则只写 decimals', () => {
    const noop = buildEventDefinition(EVENT_DEF, {
      event: 'Purchase',
      analysis: 'total_times',
      transform: { op: 'mul', value: 1 },
    });
    expect('transform' in (noop.metric as Record<string, unknown>)).toBe(false);

    const decimalsOnly = buildEventDefinition(EVENT_DEF, {
      event: 'Purchase',
      analysis: 'total_times',
      transform: { op: 'mul', value: 1, decimals: 2 },
    });
    expect((decimalsOnly.metric as Record<string, unknown>).transform).toEqual({ op: 'mul', value: 1, decimals: 2 });
  });

  it('旧定义的 factor 读成「乘以」，写回时升级为 op/value', () => {
    const rows = describeMetric('event', { metric: { ...EVENT_DEF.metric, transform: { factor: 0.001 } } });
    expect(rows.find((row) => row.label === '数值变换')?.value).toBe('×0.001');

    const next = buildEventDefinition(EVENT_DEF, {
      event: 'Purchase',
      analysis: 'total_times',
      transform: { op: 'div', value: 1000, decimals: 2 },
    });
    expect((next.metric as Record<string, unknown>).transform).toEqual({ op: 'div', value: 1000, decimals: 2 });
  });

  it('属性被清空时删除键（而不是写空串）', () => {
    const next = buildEventDefinition(EVENT_DEF, { event: 'Purchase', analysis: 'total_times', prop: '   ' });
    expect('prop' in (next.metric as Record<string, unknown>)).toBe(false);
  });

  it('留存指标改周期/口径时，两侧事件的 filters 原样保留', () => {
    const next = buildRetentionDefinition(RETENTION_DEF, {
      startEvent: 'screen_view',
      retainEvent: 'scene_trade_sell_event_trigger',
      n: 7,
      measure: 'count',
      cohort: 'first_day',
      granularity: 'week',
    });
    expect(next.n).toBe(7);
    expect(next.measure).toBe('count');
    expect(next.cohort).toBe('first_day');
    expect(next.granularity).toBe('week');
    expect((next.start_event as Record<string, unknown>).filters).toEqual(RETENTION_DEF.start_event.filters);
  });

  it('改回访事件不影响初始事件的 filters', () => {
    const next = buildRetentionDefinition(RETENTION_DEF, {
      startEvent: 'screen_view',
      retainEvent: 'OtherEvent',
      n: 1,
      measure: 'rate',
      cohort: 'all',
      granularity: 'day',
    });
    expect((next.retain_event as Record<string, unknown>).event).toBe('OtherEvent');
    expect((next.start_event as Record<string, unknown>).filters).toEqual(RETENTION_DEF.start_event.filters);
  });
});

describe('表单初值与方法约束', () => {
  it('从定义反推表单值（事件，含 v2 字段）', () => {
    expect(toFormValues('event', EVENT_DEF)).toMatchObject({
      event: 'Purchase',
      analysis: 'total_times',
      prop: undefined,
      value_pick: undefined,
      time_range: undefined,
    });
    expect(toFormValues('event', {
      metric: { ...EVENT_DEF.metric, value_pick: 'max', transform: { factor: 2, decimals: 1 } },
    })).toMatchObject({ value_pick: 'max', transform_op: 'mul', transform_value: 2, decimals: 1 });
    expect(toFormValues('event', {
      metric: { ...EVENT_DEF.metric, transform: { op: 'sub', value: 1 } },
    })).toMatchObject({ transform_op: 'sub', transform_value: 1 });
  });

  it('从定义反推表单值（留存），非法粒度回落 day', () => {
    expect(toFormValues('retention', { ...RETENTION_DEF, granularity: 'hour' })).toMatchObject({
      startEvent: 'screen_view',
      retainEvent: 'scene_trade_sell_event_trigger',
      n: 1,
      measure: 'rate',
      cohort: 'all',
      granularity: 'day',
    });
  });

  it('只有三种计数类方法不需要属性', () => {
    expect(analysisNeedsProp('total_times')).toBe(false);
    expect(analysisNeedsProp('trig_user_num')).toBe(false);
    expect(analysisNeedsProp('per_capita_times')).toBe(false);
    expect(analysisNeedsProp('sum')).toBe(true);
    expect(analysisNeedsProp('percentile')).toBe(true);
  });
});

/**
 * 指标口径多语言（i18n 收口）：窗口 / 摘要 / 取值说明都按查看者语言渲染，
 * 服务端只下发**结构**（天数 + 相对范围 + 枚举值）；中文逐字不变是硬要求，
 * 因此下面的 zh 期望值就是后端 `definitionSummary` / `VALUE_PICK_DESCRIPTION` 的原值
 * （交叉验证见后端 `test/query/metric-summary.spec.ts`）。
 */
describe('指标口径多语言（窗口 / 摘要 / 取值说明）', () => {
  afterEach(async () => {
    await changeLocale('zh-CN');
  });

  it('窗口文案：相对结构优先，其次按天数生成短形态，最后回落服务端原文', async () => {
    await changeLocale('zh-CN');
    expect(
      metricWindowPayloadLabel({ days: 7, relative: { kind: 'recent_n', n: 7 }, source: 'metric' }, t),
    ).toBe('近 7 天（含今天）');
    expect(
      metricWindowPayloadLabel({ days: 30, relative: { kind: 'past_n', n: 30 }, source: 'metric' }, t),
    ).toBe('过去 30 天（不含今天）');
    // rule / default 路径的中文是短形态（后端 `windowLabel(days)`）
    expect(metricWindowPayloadLabel({ days: 7, relative: null, source: 'default' }, t)).toBe('近 7 天');
    expect(metricWindowPayloadLabel({ days: 1, relative: null, source: 'rule' }, t)).toBe('今天');
    // 留存口径带「队列」前缀
    expect(
      metricWindowPayloadLabel(
        { days: 7, relative: { kind: 'recent_n', n: 7 }, source: 'metric', cohort: true },
        t,
      ),
    ).toBe('队列 近 7 天（含今天）');
    // 老响应只剩中文串时回落原文
    expect(metricWindowPayloadLabel({ label: '近 9 天' }, t)).toBe('近 9 天');
    expect(metricWindowPayloadLabel(null, t)).toBe('');

    await changeLocale('en-US');
    expect(
      metricWindowPayloadLabel({ days: 7, relative: { kind: 'recent_n', n: 7 }, source: 'metric' }, t),
    ).toBe('Last 7 days (including today)');
    expect(metricWindowPayloadLabel({ days: 7, relative: null, source: 'default' }, t)).toBe('Last 7 days');
    expect(metricWindowPayloadLabel({ days: 1, relative: null, source: 'rule' }, t)).toBe('Today');
    expect(metricWindowPayloadLabel({ days: 7, relative: null, cohort: true }, t)).toBe('Cohort Last 7 days');
  });

  it('口径摘要：zh 逐字等于后端 definitionSummary', async () => {
    await changeLocale('zh-CN');
    expect(
      metricSummaryText(
        {
          kind: 'event',
          event: 'pv',
          analysis: 'sum',
          prop: 'amount',
          window: { days: 7, relative: { kind: 'recent_n', n: 7 }, source: 'metric' },
          value_pick: 'sum',
        },
        t,
      ),
    ).toBe('事件 pv · 计算 sum · amount · 近 7 天（含今天） · 累计');
    expect(metricSummaryText({ kind: 'event', event: 'pv', analysis: 'total_times' }, t)).toBe(
      '事件 pv · 计算 total_times',
    );
    expect(metricSummaryText({ kind: 'event', analysis: 'total_times' }, t)).toBe(
      '事件 (未指定事件) · 计算 total_times',
    );
    expect(
      metricSummaryText(
        {
          kind: 'event',
          event: 'pv',
          analysis: 'sum',
          window: { days: 7, relative: null, source: 'default' },
        },
        t,
      ),
    ).toBe('事件 pv · 计算 sum · 近 7 天');
    expect(
      metricSummaryText(
        { kind: 'retention', start_event: 'pv', retain_event: 'pv2', n: 7, measure: 'rate' },
        t,
      ),
    ).toBe('留存 pv → pv2 · 7 天 · 留存率');
    expect(
      metricSummaryText(
        { kind: 'retention', start_event: 'pv', retain_event: 'pv2', n: 7, measure: 'count' },
        t,
      ),
    ).toBe('留存 pv → pv2 · 7 天 · 人数');
    // 未知 kind 只兜底原值（老响应）
    expect(metricSummaryText({ kind: 'sql' }, t)).toBe('sql');
  });

  it('口径摘要：英文无中文（事件 / 方法 / 窗口 / 取值都本地化）', async () => {
    await changeLocale('en-US');
    expect(
      metricSummaryText(
        {
          kind: 'event',
          event: 'pv',
          analysis: 'sum',
          prop: 'amount',
          window: { days: 7, relative: { kind: 'recent_n', n: 7 }, source: 'metric' },
          value_pick: 'sum',
        },
        t,
      ),
    ).toBe('Event pv · Method sum · amount · Last 7 days (including today) · Cumulative');
    expect(metricSummaryText({ kind: 'event', analysis: 'total_times' }, t)).toBe(
      'Event (no event specified) · Method total_times',
    );
    expect(
      metricSummaryText(
        { kind: 'retention', start_event: 'pv', retain_event: 'pv2', n: 7, measure: 'count' },
        t,
      ),
    ).toBe('Retention pv → pv2 · 7 days · Users');
  });

  it('取值说明：zh 逐字等于后端 VALUE_PICK_DESCRIPTION（与下拉提示分开落键）', async () => {
    await changeLocale('zh-CN');
    expect(valuePickNote('sum', t)).toBe('窗口内各日值相加；没有数据的日子按 0 计');
    expect(valuePickNote('avg', t)).toBe('各日值之和 ÷ 窗口天数；没有数据的日子按 0 计');
    expect(valuePickNote('max', t)).toBe('窗口内有数据的日子的最大值（完全无数据 → 本轮跳过）');
    expect(valuePickNote('uniq_total', t)).toBe(
      '用整段时间整体求值，不按日相加（去重数/触发用户数唯一正确的取值）',
    );
    expect(valuePickNote('weighted', t)).toBe(
      '按分母加权（人均次数/人均值唯一正确的取值），用整段时间整体求值',
    );
    expect(valuePickNote('last_day', t)).toBe('窗口内最近一个有数据的日子的值（常用于「今天到目前为止」）');
    expect(valuePickNote('bogus', t)).toBeNull();

    await changeLocale('en-US');
    expect(valuePickNote('last_day', t)).toBe(
      'Value of the most recent day with data in the window (often used for "today so far")',
    );
    // 取值展示名与后端 VALUE_PICK_LABEL 同值（zh 逐字一致）
    await changeLocale('zh-CN');
    expect(valuePickLabel('uniq_total', t)).toBe('整段去重合计');
    expect(valuePickLabel('last_day', t)).toBe('最新一天');
  });
});
