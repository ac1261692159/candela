// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryResultPanel } from './QueryResultPanel';
import { fxDayEventCount } from '../visualization/chart.fixtures';
import { recommendChart } from '../visualization/chart-recommender';
import { profileColumns } from '../visualization/column-profiler';
import type { SqlExecuteResult } from '../../types/report.types';

vi.mock('../visualization/ChartWorkbench', () => ({
  ChartWorkbench: ({ tableFallback }: { tableFallback?: string }) => (
    <div>
      chart-workbench
      <span data-testid="wb-fallback">{tableFallback ?? 'table'}</span>
    </div>
  ),
}));

function sqlResult(
  shape: { columns: SqlExecuteResult['columns']; rows: SqlExecuteResult['rows'] },
  extra?: Partial<SqlExecuteResult>,
): SqlExecuteResult {
  return {
    query_id: extra?.query_id ?? 'q1',
    columns: shape.columns,
    rows: shape.rows,
    row_count: extra?.row_count ?? shape.rows.length,
    truncated: extra?.truncated ?? false,
    elapsed_ms: extra?.elapsed_ms ?? 11,
    read_rows: extra?.read_rows ?? shape.rows.length,
    read_bytes: extra?.read_bytes ?? 64,
  };
}

describe('QueryResultPanel', () => {
  it('shows loading, empty and error states', () => {
    const { rerender } = render(
      <QueryResultPanel result={null} loading error={null} config={null} />,
    );
    expect(document.querySelector('.ant-skeleton')).toBeTruthy();
    rerender(<QueryResultPanel result={null} loading={false} error={null} config={null} />);
    expect(screen.getByText('执行 SQL 后展示查询结果')).toBeTruthy();
    rerender(<QueryResultPanel result={null} loading={false} error="查询失败" config={null} />);
    expect(screen.getByText('查询失败')).toBeTruthy();
  });

  it('keeps the last table while loading and surfaces truncation', () => {
    const result = sqlResult(fxDayEventCount, { truncated: true, row_count: 1000 });
    render(<QueryResultPanel result={result} loading error={null} config={null} />);
    expect(screen.getByText(/基于返回的前 3 行/)).toBeTruthy();
    expect(document.querySelector('.ant-spin')).toBeTruthy();
    expect(screen.getAllByText('event_count').length).toBeGreaterThan(0);
  });

  it('shows the recommended chart with the table, and can hide the chart by layout', () => {
    const result = sqlResult(fxDayEventCount);
    const initial = recommendChart(
      profileColumns(result.columns, result.rows),
      result.rows,
    ).recommended!.config!;
    const { rerender } = render(
      <QueryResultPanel result={result} loading={false} error={null} config={initial} />,
    );
    expect(screen.getByText('chart-workbench')).toBeTruthy();
    expect(screen.getAllByText('event_count').length).toBeGreaterThan(0);
    expect(screen.queryByRole('radio', { name: '明细' })).toBeNull();
    rerender(
      <QueryResultPanel result={result} loading={false} error={null} config={initial} layout="table" />,
    );
    expect(screen.queryByText('chart-workbench')).toBeNull();
    expect(screen.getAllByText('event_count').length).toBeGreaterThan(0);
  });

  it('explains ambiguous numeric columns on the table', () => {
    const result = sqlResult({
      columns: [
        { name: 'mystery', type: 'Float64' },
        { name: 'label', type: 'String' },
      ],
      rows: [
        { mystery: 1, label: 'a' },
        { mystery: 2, label: 'b' },
      ],
    });
    render(<QueryResultPanel result={result} loading={false} error={null} config={null} />);
    expect(screen.getByText(/无法可靠判断「mystery」/)).toBeTruthy();
  });

  it('图表+表格并排时不让工作台重复画表（回归：曾出现空占位 + 两张表）', () => {
    const result = sqlResult(fxDayEventCount);
    const config = recommendChart(
      profileColumns(result.columns, result.rows),
      result.rows,
    ).recommended!.config!;

    // preferred_view='chart' → 布局 both（图表 + 表格并排）：工作台必须让出回退表格
    render(<QueryResultPanel result={result} loading={false} error={null} config={config} />);
    expect(screen.getByTestId('wb-fallback').textContent).toBe('none');
    expect(document.querySelectorAll('.ant-table').length).toBe(1);
  });

  it('图表配置失效时表格拿走整块高度，不留大片空白', () => {
    const result = sqlResult(fxDayEventCount);
    const base = recommendChart(
      profileColumns(result.columns, result.rows),
      result.rows,
    ).recommended!.config!;
    // 能解析但不兼容 → resolve 回退 view='table'（与线上「plat 失效」同一形态）。
    // 必须用 mode='manual'：mode='auto' 的配置现在会被平台按当前列重算，不走回退。
    const stale = { ...base, mode: 'manual' as const, chart_type: 'pie' as const, bindings: { ...base.bindings, category: 'event_count' } };
    const scrollY = (): number => {
      const el = document.querySelector('.ant-table-body') as HTMLElement | null;
      return Number((el?.style.maxHeight || '0').replace('px', ''));
    };

    const ok = render(<QueryResultPanel result={result} loading={false} error={null} config={base} tableHeight={600} />);
    const chartSplitY = scrollY();
    ok.unmount();
    render(<QueryResultPanel result={result} loading={false} error={null} config={stale} tableHeight={600} />);
    const noChartY = scrollY();

    expect(noChartY).toBeGreaterThan(chartSplitY);
    expect(noChartY).toBeGreaterThan(400);
  });

  it('加载态切到有结果态不改变 Hook 顺序（回归：Rendered more hooks than during the previous render）', () => {
    const result = sqlResult(fxDayEventCount);
    const { rerender } = render(<QueryResultPanel result={null} loading error={null} config={null} />);
    expect(() =>
      rerender(<QueryResultPanel result={result} loading={false} error={null} config={null} />),
    ).not.toThrow();
    // 再切回空结果：同样必须保持 Hook 顺序
    expect(() =>
      rerender(<QueryResultPanel result={null} loading={false} error={null} config={null} />),
    ).not.toThrow();
  });
});
