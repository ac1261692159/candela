// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { EventAnalysisResult } from './EventAnalysisResult';
import type { QueryResult } from '../../types/dsl.types';
import { autoEventChartConfig } from '../event-chart';

vi.mock('../../stores/analysis.store', () => ({
  useAnalysisStore: (selector: (s: { dsl: unknown }) => unknown) =>
    selector({
      dsl: {
        events: [{ event: 'buy' }],
        time_range: { start: '2026-09-02', end: '2026-09-08' },
      },
    }),
}));

vi.mock('../explore-charts/ExploreChart', () => ({
  ExploreChart: () => <div data-testid="chart">chart</div>,
}));

vi.mock('../../components/DataTable', () => ({
  DataTable: () => <div data-testid="table">table</div>,
}));

const sample: QueryResult = {
  columns: [{ key: 'm_0', title: '总次数' }],
  rows: [{ m_0: 10 }],
  elapsed_ms: 12,
  from_cache: false,
  sql: 'SELECT 1',
};

describe('EventAnalysisResult', () => {
  it('keeps view switches inside the result gear', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <EventAnalysisResult
          result={sample}
          loading={false}
          chartConfig={autoEventChartConfig(sample.columns, 'line')}
          onChartConfigChange={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: '结果设置' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: '图表+表格' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '结果设置' }));
    expect(screen.getByRole('radio', { name: '图表+表格' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '折线' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '堆积' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '饼图' })).toBeTruthy();
    expect(screen.getAllByLabelText('Y 轴单位').length).toBeGreaterThan(0);
    expect(screen.queryByText('显示值')).toBeNull();
    expect(screen.getByTestId('chart')).toBeTruthy();
    expect(screen.getByTestId('table')).toBeTruthy();
  });

  /**
   * AI 图表提案条（phase: clklog-ai-event-chart-v1）：
   * 只展示、不自动应用——用户点「应用」才改配置，点「忽略」把回绝回给 AI。
   */
  describe('AI 图表提案条', () => {
    const config = autoEventChartConfig(sample.columns, 'line');
    const renderWith = (props: Partial<Parameters<typeof EventAnalysisResult>[0]> = {}) => {
      const onChartProposalAccept = vi.fn();
      const onChartProposalDismiss = vi.fn();
      const onChartConfigChange = vi.fn();
      render(
        <MemoryRouter>
          <EventAnalysisResult
            result={sample}
            loading={false}
            chartConfig={config}
            onChartConfigChange={onChartConfigChange}
            onChartProposalAccept={onChartProposalAccept}
            onChartProposalDismiss={onChartProposalDismiss}
            {...props}
          />
        </MemoryRouter>,
      );
      return { onChartProposalAccept, onChartProposalDismiss, onChartConfigChange };
    };

    it('没有提案时不出现提案条，也不动配置', () => {
      const spies = renderWith({ chartProposal: null });
      expect(screen.queryByRole('button', { name: /应\s*用/ })).toBeNull();
      expect(spies.onChartConfigChange).not.toHaveBeenCalled();
    });

    it('展示 AI 给的理由；点「应用」只回调，不直接改配置', async () => {
      const user = userEvent.setup();
      const spies = renderWith({ chartProposal: { reason: '付费率被 DAU 压平' } });
      expect(screen.getByText(/付费率被 DAU 压平/)).toBeTruthy();

      await user.click(screen.getByRole('button', { name: /应\s*用/ }));
      expect(spies.onChartProposalAccept).toHaveBeenCalledTimes(1);
      // 真正改配置由页面层的 accept 完成；本组件不自己动配置
      expect(spies.onChartConfigChange).not.toHaveBeenCalled();
    });

    it('点「忽略」只回调 dismiss', async () => {
      const user = userEvent.setup();
      const spies = renderWith({ chartProposal: { reason: '拆到右轴' } });
      await user.click(screen.getByRole('button', { name: /忽\s*略/ }));
      expect(spies.onChartProposalDismiss).toHaveBeenCalledTimes(1);
      expect(spies.onChartProposalAccept).not.toHaveBeenCalled();
      expect(spies.onChartConfigChange).not.toHaveBeenCalled();
    });
  });
});
