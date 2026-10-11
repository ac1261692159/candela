// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CohortEditPage } from './CohortEditPage';
import { getCohort, previewConditionCohort } from '../../services/cohort.service';

vi.mock('../../services/cohort.service', () => ({
  createCohort: vi.fn(),
  getCohort: vi.fn(),
  getCohortTemplate: vi.fn(),
  previewConditionCohort: vi.fn(),
  previewSqlCohort: vi.fn(),
  replaceCohortMembers: vi.fn(),
  updateCohort: vi.fn(),
}));

vi.mock('../../services/meta.service', () => ({
  getUserProperties: vi.fn().mockResolvedValue({ items: [] }),
}));

vi.mock('../../services/subject.service', () => ({
  getSubjects: vi.fn().mockResolvedValue({
    items: [{ subject_id: 'asub_userxxxx', name: 'user', display_name: '用户', kind: 'preset', is_preset: true }],
    total: 1,
  }),
}));

vi.mock('../../stores/project.store', () => ({
  useProjectStore: (select: (s: { currentProject: string }) => unknown) =>
    select({ currentProject: 'clklogapp' }),
}));

vi.mock('../../features/report/SqlReportEditor', () => ({
  SqlReportEditor: ({ value }: { value: string }) => <textarea aria-label="SQL 编辑器" value={value} readOnly />,
}));

// 事件选择器要拉事件列表，这里只关心「选了事件」这一个动作
vi.mock('../../components/EventSelect', () => ({
  EventSelect: ({ onChange }: { onChange?: (value: string) => void }) => (
    <button type="button" onClick={() => onChange?.('AppStart')}>
      选择事件
    </button>
  ),
}));

function renderEdit(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/analysis/cohorts/new" element={<CohortEditPage />} />
        <Route path="/analysis/cohorts/:id" element={<CohortEditPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CohortEditPage SQL', () => {
  it('shows SQL editor and time params instead of condition sentences', () => {
    renderEdit('/analysis/cohorts/new?kind=sql');
    expect(screen.getByText('创建 SQL 分群')).toBeInTheDocument();
    expect(screen.getByLabelText('SQL 编辑器')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /试\s*跑/ })).toBeInTheDocument();
    expect(screen.queryByText('分群条件（且）')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('start')).toBeInTheDocument();
  });
});

describe('条件分群试跑', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(previewConditionCohort).mockResolvedValue({
      count: 1200,
      items: [{ uid: 'u1' }, { uid: 'u2' }],
      limit: 20,
      truncated: false,
    });
  });

  it('条件不完整时拦下试跑，并在对应行内联提示（不弹后端下标式报错）', async () => {
    const user = userEvent.setup();
    renderEdit('/analysis/cohorts/new?kind=condition');
    await user.click(screen.getByRole('button', { name: /试跑并预估人数/ }));
    expect(await screen.findByText('请选择事件')).toBeInTheDocument();
    expect(previewConditionCohort).not.toHaveBeenCalled();
  });

  it('选好事件后试跑，显示预估人数与示例 ID', async () => {
    const user = userEvent.setup();
    renderEdit('/analysis/cohorts/new?kind=condition');
    await user.click(screen.getByRole('button', { name: '选择事件' }));
    await user.click(screen.getByRole('button', { name: /试跑并预估人数/ }));
    expect(await screen.findByText('预估 1200 人')).toBeInTheDocument();
    expect(screen.getByText(/u1, u2/)).toBeInTheDocument();
    expect(previewConditionCohort).toHaveBeenCalledWith({
      definition_json: {
        conditions: [
          {
            type: 'did_event',
            polarity: 'did',
            event: 'AppStart',
            metric: 'times',
            op: 'gt',
            value: 0,
            time: { mode: 'last_n_days', n: 7 },
          },
        ],
      },
      // 表单默认选中的预置主体，与保存时用的是同一个 subject_id
      subject_id: 'asub_userxxxx',
      limit: 20,
    });
  });

  it('编辑已有分群时给出与已保存人数的差值', async () => {
    const user = userEvent.setup();
    vi.mocked(getCohort).mockResolvedValue({
      cohort_id: 'cohort_abc123xx',
      project_name: 'clklogapp',
      owner: 'u1',
      name: 'cohort_active',
      display_name: '活跃用户',
      remark: null,
      kind: 'condition',
      definition_json: {
        conditions: [
          {
            type: 'did_event',
            polarity: 'did',
            event: 'AppStart',
            metric: 'times',
            op: 'gt',
            value: 0,
            time: { mode: 'last_n_days', n: 7 },
          },
        ],
      },
      schedule: 'manual',
      status: 'ready',
      member_count: 1000,
      batch_id: 'b_1',
      last_computed_at: '2026-09-05T05:30:16.000Z',
      compute_error: null,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-05T05:30:16.000Z',
    } as never);
    renderEdit('/analysis/cohorts/cohort_abc123xx');
    await waitFor(() => expect(getCohort).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /试跑并预估人数/ }));
    expect(await screen.findByText('预估 1200 人')).toBeInTheDocument();
    expect(screen.getByText(/当前已保存 1000 人/)).toBeInTheDocument();
    expect(screen.getByText(/比当前多 200 人/)).toBeInTheDocument();
  });
});
