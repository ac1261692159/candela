// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardWidget } from './CardWidget';
import { changeLocale } from '../../i18n';
import type { DashboardCard } from '../../types/report.types';

const navigate = vi.fn();

// 本文件默认语言固定 zh-CN（vitest.setup）：切到 en-US 的用例结束后复位
afterEach(async () => {
  await changeLocale('zh-CN');
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('../../services/report.service', () => ({
  refreshCard: vi.fn(),
  updateCardDisplay: vi.fn(),
  createCard: vi.fn(),
  updateCard: vi.fn(),
  deleteCard: vi.fn(),
}));

vi.mock('../explore-charts/ExploreChart', () => ({
  ExploreChart: () => <div data-testid="nth-trend">nth</div>,
}));

function retentionCard(partial: Partial<DashboardCard> = {}): DashboardCard {
  return {
    card_id: 'card_ret',
    name: '核心数据 · 留存',
    type: 'retention',
    dsl: {},
    chart_type: 'table',
    refresh_policy: 'auto',
    position_x: 0,
    position_y: 0,
    width: 2,
    height: 2,
    display: { view: 'people_table' },
    cache: {
      result: {
        columns: [
          { key: 'cohort_date', title: '队列日期' },
          { key: 'cohort_size', title: '人数' },
          { key: 'n_1', title: 'D1' },
          { key: 'n_1_rate', title: 'D1 留存率' },
        ],
        rows: [{ cohort_date: '2026-09-10', cohort_size: 10, n_1: null, n_1_rate: null }],
      },
      error: null,
      row_count: 1,
      refreshed_at: '2026-09-10T00:00:00.000Z',
      stale: false,
    },
    ...partial,
  };
}

describe('CardWidget display', () => {
  it('opens retention cards from the title and keeps people/rate tables split', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CardWidget card={retentionCard()} dbId="db1" editable onRemove={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(screen.getByText('核心数据 · 留存'));
    expect(navigate).toHaveBeenCalledWith('/analysis/retention?card=card_ret');
    expect(screen.getAllByText('人数').length).toBeGreaterThan(0);
    expect(screen.queryByText('D1 留存率')).toBeNull();
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: '核心数据 · 留存 面板菜单' }));
    expect(screen.getByText('设置')).toBeTruthy();
    expect(screen.getByText('从看板移除')).toBeTruthy();
    expect(screen.queryByText('刷新数据')).toBeNull();
    expect(screen.queryByText('编辑')).toBeNull();
  });

  it('renders cached column titles in the viewer language (cache stores keys, not languages)', async () => {
    const card = retentionCard();
    (card.cache!.result as { columns: unknown[] }).columns = [
      { key: 'cohort_date', title: '队列日期', title_key: 'analysis:column.cohortDate' },
      { key: 'cohort_size', title: '人数', title_key: 'analysis:column.users' },
      // 用户数据列（没有 key）：别名 / 事件名不翻译，保持原值
      { key: 'n_1', title: 'D1' },
    ];
    await changeLocale('en-US');
    render(
      <MemoryRouter>
        <CardWidget card={card} dbId="db1" />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('Cohort date').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Users').length).toBeGreaterThan(0);
    expect(screen.queryByText('人数')).toBeNull();
    expect(screen.getAllByText('D1').length).toBeGreaterThan(0);
  });
});
