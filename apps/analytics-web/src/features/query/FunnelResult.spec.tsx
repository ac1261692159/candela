// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { FunnelResult, funnelSeriesFromResult } from './FunnelResult';
import type { FunnelResult as FunnelResultData } from '../../types/dsl.types';

vi.mock('echarts-for-react', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef(() => <div data-testid="echarts">chart</div>),
  };
});

vi.mock('../../stores/funnel.store', () => ({
  useFunnelStore: (selector: (s: { dsl: unknown }) => unknown) =>
    selector({
      dsl: {
        steps: [{ event: '$pageview' }, { event: 'AppLaunch' }],
        window_seconds: 604800,
        time_range: { start: '2026-08-29', end: '2026-09-04' },
      },
    }),
}));

const sample: FunnelResultData = {
  columns: [
    { key: 'step_1', title: '第 1 步' },
    { key: 'step_2', title: '第 2 步' },
  ],
  rows: [{ step_1: 10, step_2: 4 }],
  elapsed_ms: 12,
  steps: [
    { key: 'step_1', title: '第 1 步' },
    { key: 'step_2', title: '第 2 步' },
  ],
};

describe('funnelSeriesFromResult', () => {
  it('maps first row counts onto step titles', () => {
    expect(funnelSeriesFromResult(sample)).toEqual([
      { name: '第 1 步', value: 10, stepNo: 1 },
      { name: '第 2 步', value: 4, stepNo: 2 },
    ]);
  });

  it('returns empty when there is no result yet', () => {
    expect(funnelSeriesFromResult(null)).toEqual([]);
  });
});

describe('FunnelResult', () => {
  it('keeps the same hook order when a query finishes', () => {
    const { rerender } = render(
      <MemoryRouter>
        <FunnelResult result={null} loading />
      </MemoryRouter>,
    );
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();

    rerender(
      <MemoryRouter>
        <FunnelResult result={sample} loading={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText('漏斗结果')).toBeTruthy();
    expect(screen.getByTestId('echarts')).toBeTruthy();
    expect(screen.getByText('保存为卡片')).toBeTruthy();
    expect(screen.getByRole('button', { name: '结果设置' })).toBeTruthy();
  });

  it('shows values on the first row and conversion on the second', async () => {
    const user = userEvent.setup();
    const withRates: FunnelResultData = {
      columns: [
        { key: 'step_1', title: '启动 人数' },
        { key: 'step_2', title: '登录 人数' },
        { key: 'step_2_conversion', title: '登录 转化率' },
        { key: 'step_2_churn', title: '登录 流失' },
      ],
      rows: [{ step_1: 100, step_2: 80, step_2_conversion: 0.8, step_2_churn: 20 }],
      elapsed_ms: 12,
      steps: [
        { key: 'step_1', title: '启动' },
        { key: 'step_2', title: '登录' },
      ],
    };
    render(
      <MemoryRouter>
        <FunnelResult result={withRates} loading={false} />
      </MemoryRouter>,
    );
    expect(screen.getAllByText('启动').length).toBeGreaterThan(0);
    expect(screen.getAllByText('登录').length).toBeGreaterThan(0);
    expect(screen.queryByText('启动 人数')).toBeNull();
    expect(screen.getAllByText('数值').length).toBeGreaterThan(0);
    expect(screen.getAllByText('100').length).toBeGreaterThan(0);
    expect(screen.getAllByText('80').length).toBeGreaterThan(0);
    expect(screen.getAllByText('转化率').length).toBeGreaterThan(0);
    expect(screen.getAllByText('100.0%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('80.0%').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: '结果设置' }));
    expect(screen.getByText('横向')).toBeTruthy();
    expect(screen.getByText('纵向')).toBeTruthy();
    expect(screen.getByText('表格列宽')).toBeTruthy();
    await user.click(screen.getByText('流失率'));
    expect(screen.getAllByText('流失率').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0.0%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('20.0%').length).toBeGreaterThan(0);
  });

  it('shows overwrite and save-as when opened from an existing card', () => {
    render(
      <MemoryRouter>
        <FunnelResult result={sample} loading={false} cardId="card_funnel" cardName="登录漏斗" />
      </MemoryRouter>,
    );
    expect(screen.getByText('覆盖保存')).toBeTruthy();
    expect(screen.getByText('另存为卡片')).toBeTruthy();
    expect(screen.queryByText('保存为卡片')).toBeNull();
  });
});
