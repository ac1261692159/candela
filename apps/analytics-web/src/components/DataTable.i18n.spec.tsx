// @vitest-environment jsdom
/**
 * 结果表渲染边界（phase: clklog-analytics-i18n-v1 收口）：
 * - 复合指标列名按查看者语言渲染（服务端固定文案走 `title_key` + `method_key` 子键）；
 * - 引擎插入的**阶段汇总行**（`__stage: true`）分组单元格在 en 下显示 `Stage total`，
 *   zh 下逐字保持服务端原值「阶段汇总」。
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DataTable } from './DataTable';
import { changeLocale } from '../i18n';
import type { QueryColumn } from '../types/dsl.types';

const columns: QueryColumn[] = [
  { key: 'g_0', title: '时间(day)', title_key: 'analysis:column.timeGroup', title_params: { granularity: 'day' } },
  {
    key: 'm_0',
    title: 'pv.金额.均值',
    title_key: 'analysis:column.metricEventPropMethod',
    title_params: { event: 'pv', prop: '金额', method: '均值', method_key: 'analysis:analysisMethod.avg' },
  },
];

const rows: Record<string, unknown>[] = [
  { __stage: true, g_0: '阶段汇总', m_0: 12.5 },
  { g_0: '2026-09-16', m_0: 2 },
];

afterEach(async () => {
  await changeLocale('zh-CN');
});

describe('DataTable 结果列名与阶段行', () => {
  it('中文：列名与阶段行逐字保持服务端原值', () => {
    render(<DataTable columns={columns} rows={rows} />);
    // antd 表头会渲染标题节点两次（单元格 + 排序容器），这里只断言存在
    expect(screen.getAllByText('时间(day)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('pv.金额.均值').length).toBeGreaterThan(0);
    expect(screen.getByText('阶段汇总')).toBeTruthy();
  });

  it('英文：复合指标列名整串本地化，阶段行显示 Stage total 且无中文', async () => {
    await changeLocale('en-US');
    render(<DataTable columns={columns} rows={rows} />);
    expect(screen.getAllByText('Time (day)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('pv.金额.Average').length).toBeGreaterThan(0);
    expect(screen.getByText('Stage total')).toBeTruthy();
    expect(screen.queryByText('阶段汇总')).toBeNull();
  });
});
