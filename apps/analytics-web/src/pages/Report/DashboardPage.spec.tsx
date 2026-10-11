// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';
import { useIamStore } from '../../stores/iam.store';

vi.mock('../../services/report.service', () => ({
  getDashboard: vi.fn().mockResolvedValue({
    db_id: 'db_1',
    name: '看板A',
    cards: [],
    grid_columns: 24,
    refresh_interval_sec: 0,
    cohort_filter: null,
  }),
  updateDashboard: vi.fn(),
  removeCardFromDashboard: vi.fn(),
  saveDashboardLayout: vi.fn(),
}));

vi.mock('../../features/cohort/use-ready-cohorts', () => ({
  useReadyCohorts: () => [
    { cohort_id: 'cohort_abc123xxxx', name: 'high_vip', display_name: '高活' },
  ],
}));

vi.mock('../../features/report/DashboardGrid', () => ({
  DashboardGrid: () => <div>grid</div>,
}));

vi.mock('../../features/report/CardConfigModal', () => ({
  CardConfigModal: () => null,
}));

vi.mock('../../features/report/DashboardSettingsDrawer', () => ({
  DashboardSettingsDrawer: () => null,
}));

describe('DashboardPage cohort filter', () => {
  const setPermissions = (codes: string[]) =>
    useIamStore.setState({ permissions: new Set(codes), me: null, hydrated: true, loading: false });

  it('有 cohort.view 时展示看板级分群筛选', async () => {
    setPermissions(['dashboard.view', 'dashboard.filter', 'cohort.view']);
    render(
      <MemoryRouter initialEntries={['/report/dashboards/db_1']}>
        <Routes>
          <Route path="/report/dashboards/:id" element={<DashboardPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('看板A')).toBeInTheDocument();
    expect(screen.getByText('看板分群')).toBeInTheDocument();
    expect(screen.getByText('属于')).toBeInTheDocument();
  });

  it('无 cohort.view（普通成员）时不渲染分群筛选，避免 cohorts 接口 403', async () => {
    setPermissions(['dashboard.view', 'dashboard.filter']);
    render(
      <MemoryRouter initialEntries={['/report/dashboards/db_1']}>
        <Routes>
          <Route path="/report/dashboards/:id" element={<DashboardPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('看板A')).toBeInTheDocument();
    expect(screen.queryByText('看板分群')).not.toBeInTheDocument();
    expect(screen.queryByText('属于')).not.toBeInTheDocument();
  });
});
