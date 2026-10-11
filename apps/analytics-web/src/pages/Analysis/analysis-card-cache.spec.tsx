// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventAnalysisPage } from './EventAnalysisPage';
import { FunnelAnalysisPage } from './FunnelAnalysisPage';
import { RetentionAnalysisPage } from './RetentionAnalysisPage';
import { useAnalysisStore } from '../../stores/analysis.store';
import { useFunnelStore } from '../../stores/funnel.store';
import { useRetentionStore } from '../../stores/retention.store';

const { getCard, analyzeEvent, analyzeFunnel, analyzeRetention } = vi.hoisted(() => ({
  getCard: vi.fn(),
  analyzeEvent: vi.fn(),
  analyzeFunnel: vi.fn(),
  analyzeRetention: vi.fn(),
}));

vi.mock('../../services/report.service', () => ({
  getCard: (...args: unknown[]) => getCard(...args),
}));

vi.mock('../../services/query.service', () => ({
  analyzeEvent: (...args: unknown[]) => analyzeEvent(...args),
  analyzeFunnel: (...args: unknown[]) => analyzeFunnel(...args),
  analyzeRetention: (...args: unknown[]) => analyzeRetention(...args),
}));

vi.mock('../../features/ai-analysis/useAnalysisProposal', () => ({
  useAnalysisProposal: () => undefined,
}));

vi.mock('../../stores/project.store', () => ({
  useProjectStore: (selector: (s: { currentProject: string }) => unknown) =>
    selector({ currentProject: 'clklogapp' }),
}));

vi.mock('../../features/query/AnalysisWorkbench', () => ({
  AnalysisWorkbench: ({ rail, result }: { rail: unknown; result: unknown }) => (
    <div>
      {rail as never}
      {result as never}
    </div>
  ),
}));

vi.mock('../../features/query/AnalysisToolbar', () => ({
  AnalysisToolbar: () => <div>toolbar</div>,
}));

vi.mock('../../features/query/EventAnalysisForm', () => ({
  EventAnalysisForm: () => <div>event-form</div>,
}));

vi.mock('../../features/query/FunnelEditor', () => ({
  FunnelEditor: () => <div>funnel-form</div>,
}));

vi.mock('../../features/query/RetentionEditor', () => ({
  RetentionEditor: () => <div>retention-form</div>,
}));

vi.mock('../../features/query/EventAnalysisResult', () => ({
  EventAnalysisResult: ({ result, loading }: { result: { from_cache?: boolean } | null; loading: boolean }) => (
    <div>{loading ? 'loading-event' : result?.from_cache ? 'cached-event' : result ? 'live-event' : 'empty-event'}</div>
  ),
}));

vi.mock('../../features/query/FunnelResult', () => ({
  FunnelResult: ({ result, loading }: { result: { from_cache?: boolean } | null; loading: boolean }) => (
    <div>{loading ? 'loading-funnel' : result?.from_cache ? 'cached-funnel' : result ? 'live-funnel' : 'empty-funnel'}</div>
  ),
}));

vi.mock('../../features/query/RetentionResult', () => ({
  RetentionResult: ({ result, loading }: { result: { from_cache?: boolean } | null; loading: boolean }) => (
    <div>{loading ? 'loading-retention' : result?.from_cache ? 'cached-retention' : result ? 'live-retention' : 'empty-retention'}</div>
  ),
}));

const emptyFilters = { logic: 'and' as const, items: [] };
const range = { start: '2026-08-01', end: '2026-09-01' };

describe('analysis pages card cache', () => {
  beforeEach(() => {
    getCard.mockReset();
    analyzeEvent.mockReset();
    analyzeFunnel.mockReset();
    analyzeRetention.mockReset();
    useAnalysisStore.getState().reset();
    useFunnelStore.getState().reset();
    useRetentionStore.getState().reset();
  });

  afterEach(() => {
    useAnalysisStore.getState().reset();
    useFunnelStore.getState().reset();
    useRetentionStore.getState().reset();
  });

  it('opens an event card from cache without querying', async () => {
    getCard.mockResolvedValue({
      card_id: 'card_event',
      name: 'DAU',
      type: 'event',
      dsl: {
        _form: {
          metrics: [{ id: 'm1', event: '$AppStart', analysis: 'total_times' }],
          filters: emptyFilters,
          groups: [],
          timeRange: range,
        },
      },
      chart_type: 'line',
      cache: {
        result: { columns: [{ key: 'm_0', title: '总次数' }], rows: [{ m_0: 8 }], elapsed_ms: 3 },
        error: null,
        row_count: 1,
        refreshed_at: '2026-09-11T00:00:00.000Z',
        stale: false,
      },
    });
    render(
      <MemoryRouter initialEntries={['/analysis/event?card=card_event']}>
        <EventAnalysisPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('cached-event')).toBeTruthy();
    expect(analyzeEvent).not.toHaveBeenCalled();
  });

  it('opens a funnel card from cache without querying', async () => {
    getCard.mockResolvedValue({
      card_id: 'card_funnel',
      name: '转化',
      type: 'funnel',
      dsl: {
        _form: {
          steps: [{ event: 'a' }, { event: 'b' }],
          timeRange: range,
          windowDays: 7,
          filters: emptyFilters,
        },
      },
      chart_type: 'funnel',
      cache: {
        result: {
          columns: [{ key: 'step_1', title: 'a' }],
          rows: [{ step_1: 10 }],
          steps: [{ key: 'step_1', title: 'a' }],
          elapsed_ms: 5,
        },
        error: null,
        row_count: 1,
        refreshed_at: '2026-09-11T00:00:00.000Z',
        stale: false,
      },
    });
    render(
      <MemoryRouter initialEntries={['/analysis/funnel?card=card_funnel']}>
        <FunnelAnalysisPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('cached-funnel')).toBeTruthy();
    expect(analyzeFunnel).not.toHaveBeenCalled();
  });

  it('opens a retention card from cache without querying', async () => {
    getCard.mockResolvedValue({
      card_id: 'card_ret',
      name: '次留',
      type: 'retention',
      dsl: {
        _form: {
          startEvent: '$AppStart',
          returnEvent: '$AppStart',
          startFilters: emptyFilters,
          returnFilters: emptyFilters,
          cohort: 'first_day',
          granularity: 'day',
          nList: [1],
          timeRange: range,
        },
      },
      chart_type: 'nth_trend',
      cache: {
        result: {
          columns: [{ key: 'cohort_date', title: '日期' }, { key: 'n_1_rate', title: '次日留存' }],
          rows: [{ cohort_date: '2026-09-01', n_1_rate: 0.4 }],
          elapsed_ms: 6,
        },
        error: null,
        row_count: 1,
        refreshed_at: '2026-09-11T00:00:00.000Z',
        stale: false,
      },
    });
    render(
      <MemoryRouter initialEntries={['/analysis/retention?card=card_ret']}>
        <RetentionAnalysisPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('cached-retention')).toBeTruthy();
    expect(analyzeRetention).not.toHaveBeenCalled();
  });

  it('falls back to a live event query when the card has no cache', async () => {
    analyzeEvent.mockResolvedValue({
      columns: [{ key: 'm_0', title: '总次数' }],
      rows: [{ m_0: 1 }],
      elapsed_ms: 20,
    });
    getCard.mockResolvedValue({
      card_id: 'card_fresh',
      name: '无缓存',
      type: 'event',
      dsl: {
        _form: {
          metrics: [{ id: 'm1', event: '$AppStart', analysis: 'total_times' }],
          filters: emptyFilters,
          groups: [],
          timeRange: range,
        },
      },
      chart_type: 'line',
    });
    render(
      <MemoryRouter initialEntries={['/analysis/event?card=card_fresh']}>
        <EventAnalysisPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(analyzeEvent).toHaveBeenCalled());
    expect(await screen.findByText('live-event')).toBeTruthy();
  });
});
