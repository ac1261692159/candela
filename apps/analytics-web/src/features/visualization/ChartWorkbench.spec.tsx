// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChartWorkbench } from './ChartWorkbench';
import { recommendChart } from './chart-recommender';
import { profileColumns } from './column-profiler';
import { fxDayEventCount, fxOsUniq, fxPartyFunnel } from './chart.fixtures';
import type { SqlExecuteResult } from '../../types/report.types';

vi.mock('echarts-for-react', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef(({ option }: { option?: { aria?: { description?: string } } }, _ref) => (
      <div data-testid="echarts">{option?.aria?.description ?? 'chart'}</div>
    )),
  };
});

function sqlResult(
  shape: { columns: SqlExecuteResult['columns']; rows: SqlExecuteResult['rows'] },
): SqlExecuteResult {
  return {
    query_id: 'q1',
    columns: shape.columns,
    rows: shape.rows,
    row_count: shape.rows.length,
    truncated: false,
    elapsed_ms: 8,
    read_rows: shape.rows.length,
    read_bytes: 16,
  };
}

describe('ChartWorkbench', () => {
  it('shows auto reason, compatible pie as a non-default option, and restore-auto', async () => {
    const user = userEvent.setup();
    const onConfigChange = vi.fn();
    render(
      <ChartWorkbench
        result={sqlResult(fxDayEventCount)}
        config={null}
        displayMode="analysis"
        onConfigChange={onConfigChange}
      />,
    );
    expect((await screen.findAllByText(/自动：折线图/)).length).toBeGreaterThan(0);
    expect(screen.getByTestId('echarts').textContent).toMatch(/折线图/);
    expect(screen.getByText('图表摘要')).toBeTruthy();

    await user.click(screen.getByRole('combobox', { name: '选择图形' }));
    expect((await screen.findAllByText('饼图（不可用）')).length).toBeGreaterThan(0);
    expect(onConfigChange).toHaveBeenCalled();
  });

  it('keeps a multi-row funnel on the selector and does not draw series', async () => {
    render(
      <ChartWorkbench result={sqlResult(fxPartyFunnel)} config={null} displayMode="analysis" />,
    );
    expect((await screen.findAllByLabelText(/选择 场景ID/)).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('echarts')).toBeNull();
  });

  it('hides the funnel selector on the dashboard', () => {
    render(
      <ChartWorkbench result={sqlResult(fxPartyFunnel)} config={null} displayMode="dashboard" />,
    );
    expect(screen.queryAllByLabelText(/选择 场景ID/)).toHaveLength(0);
    expect(screen.queryAllByLabelText('选择图形')).toHaveLength(0);
    expect(screen.queryByText('图表摘要')).toBeNull();
  });

  it('keeps the chart summary visually hidden on dashboard charts', async () => {
    render(
      <ChartWorkbench result={sqlResult(fxDayEventCount)} config={null} displayMode="dashboard" />,
    );
    expect(await screen.findByTestId('echarts')).toBeTruthy();
    expect(screen.queryByText('图表摘要')).toBeNull();
  });

  it('lists pie as unavailable for unique-user ranking', async () => {
    const user = userEvent.setup();
    render(
      <ChartWorkbench result={sqlResult(fxOsUniq)} config={null} displayMode="analysis" />,
    );
    expect((await screen.findAllByText(/自动：柱状图/)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('combobox', { name: '选择图形' }));
    expect((await screen.findAllByText('饼图（不可用）')).length).toBeGreaterThan(0);
  });

  it('hides toolbar and field panel when SQL page embeds its own settings gear', () => {
    render(
      <ChartWorkbench
        result={sqlResult(fxDayEventCount)}
        config={null}
        displayMode="analysis"
        hideEmbeddedChrome
      />,
    );
    expect(screen.queryByRole('combobox', { name: '选择图形' })).toBeNull();
    expect(screen.queryByLabelText('字段设置')).toBeNull();
  });

  it('图表配置失效时默认回退表格；tableFallback="none" 时不再重复画表（分析页并排视图）', async () => {
    const base = recommendChart(
      profileColumns(fxDayEventCount.columns, fxDayEventCount.rows),
      fxDayEventCount.rows,
    ).recommended!.config!;
    // 「能解析但不兼容」的失效：饼图把 category 绑到指标列 → resolve 回退 view='table'。
    // 注意用 mode='manual'：自动配置（mode='auto'）现在会被平台按当前列重算，不会走这条回退。
    const stale = { ...base, mode: 'manual' as const, chart_type: 'pie' as const, bindings: { ...base.bindings, category: 'event_count' } };
    const props = { result: sqlResult(fxDayEventCount), config: stale, displayMode: 'analysis' as const, hideEmbeddedChrome: true };

    const first = render(<ChartWorkbench {...props} />);
    expect(await screen.findAllByText(/图表配置已失效/)).toBeTruthy();
    expect(screen.getByText('当前结果以表格查看')).toBeTruthy();
    expect(document.querySelectorAll('.ant-table').length).toBe(1);
    first.unmount();

    render(<ChartWorkbench {...props} tableFallback="none" />);
    expect(await screen.findAllByText(/图表配置已失效/)).toBeTruthy();
    expect(screen.queryByText('当前结果以表格查看')).toBeNull();
    expect(document.querySelectorAll('.ant-table').length).toBe(0);
  });
});
