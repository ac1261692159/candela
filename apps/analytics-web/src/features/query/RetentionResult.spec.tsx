// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RetentionResult } from './RetentionResult';
import type { QueryResult } from '../../types/dsl.types';

vi.mock('echarts-for-react', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef(() => <div data-testid="echarts">chart</div>),
  };
});

vi.mock('../explore-charts/ExploreChart', () => ({
  ExploreChart: () => <div data-testid="nth-trend">nth</div>,
}));

vi.mock('../../stores/retention.store', () => ({
  useRetentionStore: (selector: (s: { dsl: unknown; error: string | null }) => unknown) =>
    selector({
      dsl: {
        start_event: { event: '$pageview' },
        retain_event: { event: '$pageview' },
        time_range: { start: '2026-08-29', end: '2026-09-04' },
      },
      error: null,
    }),
}));

const sample: QueryResult = {
  columns: [
    { key: 'cohort_date', title: '队列日期' },
    { key: 'cohort_size', title: '人数' },
    { key: 'n_1', title: 'D1' },
    { key: 'n_1_rate', title: 'D1 留存率' },
  ],
  rows: [{ cohort_date: '2026-09-10', cohort_size: 10, n_1: null, n_1_rate: null }],
  elapsed_ms: 12,
  from_cache: false,
  sql: 'SELECT 1',
};

describe('RetentionResult', () => {
  it('keeps layout switches inside the result gear and splits tables', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RetentionResult result={sample} loading={false} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: '结果设置' })).toBeTruthy();
    expect(screen.getByTestId('nth-trend')).toBeTruthy();
    expect(screen.getAllByText('人数').length).toBeGreaterThan(0);
    expect(screen.getByText('留存率')).toBeTruthy();
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
    expect(screen.queryByRole('radio', { name: '每日趋势' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '结果设置' }));
    expect(screen.getByRole('radio', { name: '图表+表格' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: '每日趋势' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '第N日趋势' })).toBeNull();
  });
});
