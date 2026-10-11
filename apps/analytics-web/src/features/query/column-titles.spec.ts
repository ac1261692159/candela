import { afterEach, describe, expect, it } from 'vitest';
import { changeLocale, t } from '../../i18n';
import type { QueryColumn } from '../../types/dsl.types';
import {
  localizedColumnTitle,
  localizedColumns,
  localizedStageCellValue,
  resolveTitleParams,
} from './column-titles';

// 本文件默认语言固定 zh-CN（vitest.setup）：切到 en-US 的用例结束后复位
afterEach(async () => {
  await changeLocale('zh-CN');
});

/**
 * 结果列名本地化契约（phase: clklog-analytics-i18n-v1）：
 * - 服务端固定文案列名附 `title_key` + `title_params`（值只能是数据）；
 * - **zh 逐字等于服务端中文原值**（下方用例即该断言的证据，含 `D1` / `D1 留存率` 的空格形态）；
 * - 用户数据列 / 老响应没有 key，回落 `title`。
 */
describe('localizedColumnTitle', () => {
  const fixed: Array<[QueryColumn, string]> = [
    [{ key: 'cohort_date', title: '队列日期', title_key: 'analysis:column.cohortDate' }, '队列日期'],
    [{ key: 'group_col', title: '用户标签', title_key: 'analysis:column.userTag' }, '用户标签'],
    [{ key: 'group_col', title: '用户分群', title_key: 'analysis:column.userCohort' }, '用户分群'],
    [{ key: 'cohort_size', title: '人数', title_key: 'analysis:column.users' }, '人数'],
    [
      { key: 'n_1', title: 'D1', title_key: 'analysis:column.retentionDay', title_params: { unit: 'D', n: 1 } },
      'D1',
    ],
    [
      {
        key: 'n_1_rate',
        title: 'D1 留存率',
        title_key: 'analysis:column.retentionRate',
        title_params: { unit: 'D', n: 1 },
      },
      'D1 留存率',
    ],
    [
      {
        key: 'step_2_conversion',
        title: '登录 转化率',
        title_key: 'analysis:column.conversionRate',
        title_params: { step: '登录' },
      },
      '登录 转化率',
    ],
    [
      { key: 'step_2_churn', title: '登录 流失', title_key: 'analysis:column.churn', title_params: { step: '登录' } },
      '登录 流失',
    ],
    [{ key: 'g_0', title: '日期', title_key: 'analysis:column.date' }, '日期'],
    [{ key: 'm_0', title: '公式', title_key: 'analysis:column.formula' }, '公式'],
    [
      {
        key: 'g_0',
        title: '时间(day)',
        title_key: 'analysis:column.timeGroup',
        title_params: { granularity: 'day' },
      },
      '时间(day)',
    ],
    [{ key: 'g_0', title: '未知分组', title_key: 'analysis:column.unknownGroup' }, '未知分组'],
    [
      {
        key: 'g_0',
        title: 'pay_amount(时)',
        title_key: 'analysis:column.hourOfDay',
        title_params: { prop: 'pay_amount' },
      },
      'pay_amount(时)',
    ],
    [
      {
        key: 'g_0',
        title: 'pay_amount(日)',
        title_key: 'analysis:column.dayOfMonth',
        title_params: { prop: 'pay_amount' },
      },
      'pay_amount(日)',
    ],
    [
      {
        key: 'g_0',
        title: 'pay_amount(分)',
        title_key: 'analysis:column.minuteOfHour',
        title_params: { prop: 'pay_amount' },
      },
      'pay_amount(分)',
    ],
  ];

  it('中文逐字等于服务端原值（key 覆盖后界面不变）', async () => {
    await changeLocale('zh-CN');
    for (const [column, expected] of fixed) {
      expect(localizedColumnTitle(column, t), column.key).toBe(expected);
    }
  });

  it('英文按 key 渲染，数据参数原样插入', async () => {
    await changeLocale('en-US');
    const en = (column: QueryColumn) => localizedColumnTitle(column, t);
    expect(en(fixed[0][0])).toBe('Cohort date');
    expect(en(fixed[3][0])).toBe('Users');
    expect(en(fixed[5][0])).toBe('D1 retention');
    expect(en(fixed[6][0])).toBe('登录 conversion rate');
    expect(en(fixed[10][0])).toBe('Time (day)');
  });

  it('用户数据列与老响应回落服务端中文原值', () => {
    const dataColumns: QueryColumn[] = [
      { key: 'm_0', title: 'pv.总次数' },
      { key: 'step_1', title: '启动' },
      { key: 'g_0', title: '$- 系统属性' },
    ];
    for (const column of dataColumns) {
      expect(localizedColumnTitle(column, t)).toBe(column.title);
    }
    expect(localizedColumnTitle(undefined, t)).toBe('');
  });

  it('批量映射只改写带 key 的列，其余列保持原对象', () => {
    const columns: QueryColumn[] = [
      { key: 'cohort_size', title: '人数', title_key: 'analysis:column.users' },
      { key: 'm_0', title: 'pv.总次数' },
    ];
    const mapped = localizedColumns(columns, t);
    expect(mapped[0].title).toBe('人数');
    expect(mapped[0].title_key).toBe('analysis:column.users');
    expect(mapped[1]).toBe(columns[1]);
    // 不修改入参（结果对象在看板缓存里复用）
    expect(columns[0].title).toBe('人数');
  });
});

/**
 * 复合指标列名（`事件名.属性名.方法名`）i18n 收口：服务端 `metricTitleDescriptor` 下发
 * 四种形态的模板 + 参数，固定文案（方法名 / 任意事件）走 `<slot>_key` 子键。
 * zh 期望值 = 服务端 `metricTitle()` 的拼装结果（后端 `metric-title-i18n.spec.ts` 交叉验证）。
 */
describe('localizedColumnTitle（复合指标列名）', () => {
  afterEach(async () => {
    await changeLocale('zh-CN');
  });

  const shapes: Array<{ column: QueryColumn; zh: string; en: string }> = [
    {
      column: {
        key: 'm_0',
        title: 'pv.amount.均值',
        title_key: 'analysis:column.metricEventPropMethod',
        title_params: { event: 'pv', prop: 'amount', method: '均值', method_key: 'analysis:analysisMethod.avg' },
      },
      zh: 'pv.amount.均值',
      en: 'pv.amount.Average',
    },
    {
      column: {
        key: 'm_1',
        title: 'pv.总次数',
        title_key: 'analysis:column.metricEventMethod',
        title_params: { event: 'pv', method: '总次数', method_key: 'analysis:analysisMethod.totalTimes' },
      },
      zh: 'pv.总次数',
      en: 'pv.Total count',
    },
    {
      column: {
        key: 'm_2',
        title: 'amount.均值',
        title_key: 'analysis:column.metricPropMethod',
        title_params: { prop: 'amount', method: '均值', method_key: 'analysis:analysisMethod.avg' },
      },
      zh: 'amount.均值',
      en: 'amount.Average',
    },
    {
      column: {
        key: 'm_3',
        title: '总次数',
        title_key: 'analysis:column.metricMethod',
        title_params: { method: '总次数', method_key: 'analysis:analysisMethod.totalTimes' },
      },
      zh: '总次数',
      en: 'Total count',
    },
    {
      column: {
        key: 'm_4',
        title: '任意事件.总次数',
        title_key: 'analysis:column.metricEventMethod',
        title_params: {
          event: '任意事件',
          event_key: 'analysis:column.anyEvent',
          method: '总次数',
          method_key: 'analysis:analysisMethod.totalTimes',
        },
      },
      zh: '任意事件.总次数',
      en: 'Any event.Total count',
    },
    {
      column: {
        key: 'm_5',
        title: '任意事件.amount.均值',
        title_key: 'analysis:column.metricEventPropMethod',
        title_params: {
          event: '任意事件',
          event_key: 'analysis:column.anyEvent',
          prop: 'amount',
          method: '均值',
          method_key: 'analysis:analysisMethod.avg',
        },
      },
      zh: '任意事件.amount.均值',
      en: 'Any event.amount.Average',
    },
    {
      column: {
        key: 'm_6',
        title: 'pv.amount.中位数',
        title_key: 'analysis:column.metricEventPropMethod',
        title_params: {
          event: 'pv',
          prop: 'amount',
          method: '中位数',
          method_key: 'analysis:analysisMethod.median',
        },
      },
      zh: 'pv.amount.中位数',
      en: 'pv.amount.Median',
    },
    {
      // P75 语言无关：服务端不带 method_key，参数原样插入
      column: {
        key: 'm_7',
        title: 'pv.amount.P75',
        title_key: 'analysis:column.metricEventPropMethod',
        title_params: { event: 'pv', prop: 'amount', method: 'P75' },
      },
      zh: 'pv.amount.P75',
      en: 'pv.amount.P75',
    },
  ];

  it('中文逐字等于服务端拼装结果（key 覆盖后界面不变）', async () => {
    await changeLocale('zh-CN');
    for (const { column, zh } of shapes) {
      expect(localizedColumnTitle(column, t)).toBe(zh);
    }
  });

  it('英文整串本地化：用户数据原样 + 方法名/任意事件按语言', async () => {
    await changeLocale('en-US');
    for (const { column, en } of shapes) {
      expect(localizedColumnTitle(column, t)).toBe(en);
    }
  });

  it('别名 / 老响应（无 title_key）仍是用户数据原值', () => {
    expect(localizedColumnTitle({ title: '订单量' }, t)).toBe('订单量');
  });

  it('参数子键只解析一层，非键形态原样保留', () => {
    expect(resolveTitleParams({ method: '均值', method_key: 'analysis:analysisMethod.avg' }, t)).toEqual({
      method: '均值',
      method_key: 'analysis:analysisMethod.avg',
    });
    const notAKey = { value: 'pv', value_key: 'not-a-key' };
    expect(resolveTitleParams(notAKey, t)).toEqual(notAKey);
    expect(resolveTitleParams(undefined, t)).toEqual({});
  });
});

/**
 * 阶段汇总行的行值（B）：引擎插入 `__stage` 行，服务端把分组单元格写成中文「阶段汇总」，
 * 渲染边界按查看者语言覆盖；空单元格（非时间分组）与非阶段行一律不改写。
 */
describe('localizedStageCellValue', () => {
  afterEach(async () => {
    await changeLocale('zh-CN');
  });

  it('阶段行分组单元格：zh 保持「阶段汇总」，en 为 Stage total', async () => {
    await changeLocale('zh-CN');
    expect(localizedStageCellValue('g_0', '阶段汇总', { __stage: true }, t)).toBe('阶段汇总');
    await changeLocale('en-US');
    expect(localizedStageCellValue('g_0', '阶段汇总', { __stage: true }, t)).toBe('Stage total');
  });

  it('非阶段行 / 指标列 / 空单元格不改写（返回 null）', () => {
    expect(localizedStageCellValue('g_0', '2026-09-01', {}, t)).toBeNull();
    expect(localizedStageCellValue('g_1', '', { __stage: true }, t)).toBeNull();
    expect(localizedStageCellValue('m_0', '阶段汇总', { __stage: true }, t)).toBeNull();
    expect(localizedStageCellValue('g_0', 42, { __stage: true }, t)).toBeNull();
    expect(localizedStageCellValue('g_0', '阶段汇总', undefined, t)).toBeNull();
  });
});
