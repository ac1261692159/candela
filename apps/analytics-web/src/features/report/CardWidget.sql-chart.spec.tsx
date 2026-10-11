// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CardWidget } from './CardWidget';
import { fxDayEventCount, fxLegacyLine } from '../visualization/chart.fixtures';
import { recommendChart } from '../visualization/chart-recommender';
import { profileColumns } from '../visualization/column-profiler';
import type { DashboardCard } from '../../types/report.types';

const navigate = vi.fn();
const refreshCard = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('../../services/report.service', () => ({
  refreshCard: (...args: unknown[]) => refreshCard(...args),
  createCard: vi.fn(),
  updateCard: vi.fn(),
  deleteCard: vi.fn(),
  updateCardDisplay: vi.fn(),
}));

vi.mock('../visualization/ChartWorkbench', () => ({
  ChartWorkbench: ({ displayMode }: { displayMode: string }) => (
    <div>sql-chart:{displayMode}</div>
  ),
}));

function card(partial: Partial<DashboardCard> = {}): DashboardCard {
  return {
    card_id: 'card_trend',
    name: '按日趋势',
    type: 'sql',
    dsl: {},
    chart_type: 'table',
    refresh_policy: 'auto',
    position_x: 0,
    position_y: 0,
    width: 2,
    height: 2,
    ...partial,
  };
}

function sqlPayload(shape: typeof fxDayEventCount) {
  return {
    card_id: 'card_trend',
    type: 'sql' as const,
    result: {
      query_id: 'q1',
      columns: shape.columns,
      rows: shape.rows,
      row_count: shape.rows.length,
      truncated: false,
      elapsed_ms: 4,
    },
  };
}

describe('CardWidget SQL charts', () => {
  it('reproduces a saved SQL chart as a read-only workbench', async () => {
    const config = recommendChart(
      profileColumns(fxDayEventCount.columns, fxDayEventCount.rows),
      fxDayEventCount.rows,
    ).recommended!.config!;
    refreshCard.mockResolvedValue(sqlPayload(fxDayEventCount));
    render(
      <MemoryRouter>
        <CardWidget card={card({ dsl: { sql: 'select 1', chart_config: config }, chart_type: 'line' })} dbId="db1" />
      </MemoryRouter>,
    );
    expect(await screen.findByText('sql-chart:dashboard')).toBeTruthy();
    await userEvent.click(screen.getByText('按日趋势'));
    expect(navigate).toHaveBeenCalledWith('/report/sql?card=card_trend');
  });

  it('keeps legacy and stale SQL cards on the table', async () => {
    refreshCard.mockResolvedValue(sqlPayload(fxDayEventCount));
    const { rerender } = render(
      <MemoryRouter>
        <CardWidget card={card({ dsl: { sql: 'select 1' } })} dbId="db1" />
      </MemoryRouter>,
    );
    expect((await screen.findAllByText('event_count')).length).toBeGreaterThan(0);
    expect(screen.queryByText('sql-chart:dashboard')).toBeNull();

    rerender(
      <MemoryRouter>
        <CardWidget card={card({ dsl: { sql: 'select 1', chart_config: fxLegacyLine } })} dbId="db1" />
      </MemoryRouter>,
    );
    expect(screen.queryByText('sql-chart:dashboard')).toBeNull();

    const config = recommendChart(
      profileColumns(fxDayEventCount.columns, fxDayEventCount.rows),
      fxDayEventCount.rows,
    ).recommended!.config!;
    rerender(
      <MemoryRouter>
        <CardWidget
          card={card({
            dsl: { sql: 'select 1', chart_config: { ...config, bindings: { ...config.bindings, x: 'missing_col' } } },
          })}
          dbId="db1"
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/图表配置已失效/)).toBeTruthy();
    expect(screen.queryByText('sql-chart:dashboard')).toBeNull();
  });
});
