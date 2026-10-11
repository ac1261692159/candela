// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisSubjectsPage } from './AnalysisSubjectsPage';

vi.mock('../../services/subject.service', () => ({
  getSubjects: vi.fn().mockResolvedValue({
    items: [
      {
        subject_id: 'asub_userxxxx',
        name: 'user',
        display_name: '用户',
        kind: 'preset',
        source: null,
        is_preset: true,
      },
    ],
    total: 1,
  }),
  createSubject: vi.fn(),
  deleteSubject: vi.fn(),
}));

vi.mock('../../services/meta.service', () => ({
  getEventAttributes: vi.fn().mockResolvedValue({ items: [] }),
  // 页面 2026-09-14 起改用 getAllEventAttributes（属性下拉不再被 pageSize=100 截断），mock 漏了它
  getAllEventAttributes: vi.fn().mockResolvedValue([]),
  getUserProperties: vi.fn().mockResolvedValue({ items: [] }),
}));

vi.mock('../../stores/project.store', () => ({
  useProjectStore: (selector: (s: { currentProject: string }) => unknown) =>
    selector({ currentProject: 'clklogapp' }),
}));

describe('AnalysisSubjectsPage', () => {
  it('lists the preset user subject and create entry', async () => {
    render(
      <MemoryRouter>
        <AnalysisSubjectsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: /新建主体/ })).toBeInTheDocument();
    expect(screen.getByText('分析主体')).toBeInTheDocument();
    expect(await screen.findByText('用户')).toBeInTheDocument();
  });
});
