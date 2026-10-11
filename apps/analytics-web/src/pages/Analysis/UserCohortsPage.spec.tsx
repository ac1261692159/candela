// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserCohortsPage } from './UserCohortsPage';
import { getCohortMembers, getCohorts } from '../../services/cohort.service';

vi.mock('../../services/cohort.service', () => ({
  getCohorts: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  deleteCohort: vi.fn(),
  getCohortMembers: vi.fn().mockResolvedValue({ items: [], total: 0, truncated: false }),
  refreshCohort: vi.fn(),
}));

vi.mock('../../services/meta.service', () => ({
  getEvents: vi.fn().mockResolvedValue({
    items: [{ event_key: 'AppStart', display_name: '启动' }],
    total: 1,
  }),
  getUserProperties: vi.fn().mockResolvedValue({
    items: [{ prop_key: 'vip_level', display_name: '会员等级' }],
    total: 1,
  }),
}));

vi.mock('../../services/subject.service', () => ({
  getSubjects: vi.fn().mockResolvedValue({
    items: [{ subject_id: 'asub_userxxxx', name: 'user', display_name: '用户', kind: 'preset', is_preset: true }],
    total: 1,
  }),
}));

const cohort = (over: Record<string, unknown> = {}) => ({
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
  member_count: 1234,
  batch_id: 'b_1',
  last_computed_at: '2026-09-05T05:30:16.000Z',
  compute_error: null,
  subject_id: 'asub_userxxxx',
  locked: false,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-05T05:30:16.000Z',
  ...over,
});

async function renderPage() {
  render(
    <MemoryRouter>
      <UserCohortsPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(getCohorts).toHaveBeenCalled());
}

describe('UserCohortsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCohorts).mockResolvedValue({ items: [], total: 0 } as never);
  });

  it('创建类型卡带说明与典型场景，并说明结果分群的来源', async () => {
    const user = userEvent.setup();
    await renderPage();
    // 空态 CTA 的 aria-label 是「创建第一个分群」，不再匹配；此正则只命中顶部按钮
    await user.click(screen.getByRole('button', { name: /创建分群/ }));
    expect(screen.getByRole('button', { name: 'SQL 分群' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '条件分群' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ID 分群' })).toBeInTheDocument();
    expect(screen.getByText(/拼出一句话规则/)).toBeInTheDocument();
    expect(screen.getByText(/上传一列用户 ID 的 CSV/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /取\s*消/ })).toBeInTheDocument();
    expect(screen.getByText(/结果分群/)).toBeInTheDocument();
  });

  it('列表以显示名为第一列，并渲染出圈人规则摘要', async () => {
    vi.mocked(getCohorts).mockResolvedValue({ items: [cohort()], total: 1 } as never);
    await renderPage();
    expect(await screen.findByText('活跃用户')).toBeInTheDocument();
    expect(screen.getAllByText('圈人规则')[0]).toBeInTheDocument();
    // 事件显示名（启动）优先于事件 key，时间窗与次数比较都在句子里
    expect(screen.getByText('过去 7 天 做过 启动 的次数 大于 0')).toBeInTheDocument();
  });

  it('人数可点开成员抽屉并支持按 ID 检索', async () => {
    const user = userEvent.setup();
    vi.mocked(getCohorts).mockResolvedValue({ items: [cohort()], total: 1 } as never);
    await renderPage();
    await user.click(await screen.findByRole('button', { name: /查看「活跃用户」的成员/ }));
    await waitFor(() => expect(getCohortMembers).toHaveBeenCalledWith('cohort_abc123xx', { limit: 1000, keyword: undefined }));
    const input = await screen.findByPlaceholderText('按用户 ID 搜索');
    await user.type(input, 'u123{Enter}');
    await waitFor(() =>
      expect(getCohortMembers).toHaveBeenLastCalledWith('cohort_abc123xx', { limit: 1000, keyword: 'u123' }),
    );
  });

  it('按状态筛选后只剩匹配行，可清除筛选', async () => {
    const user = userEvent.setup();
    vi.mocked(getCohorts).mockResolvedValue({
      items: [cohort(), cohort({ cohort_id: 'cohort_fail0001', display_name: '失败分群', status: 'failed' })],
      total: 2,
    } as never);
    await renderPage();
    expect(await screen.findByText('活跃用户')).toBeInTheDocument();
    expect(screen.getByText('失败分群')).toBeInTheDocument();

    // 三个筛选下拉：类型 / 状态 / 主体，取第二个。
    // 下拉用 fireEvent.mouseDown + click：antd Select 认这条路径，比 userEvent 的指针模拟快得多
    // （页面级用例在 CI 满载时容易顶到超时，能省的渲染等待就省）
    const [kindSelect, statusSelect] = screen.getAllByRole('combobox');
    fireEvent.mouseDown(kindSelect);
    fireEvent.mouseDown(statusSelect);
    fireEvent.click(await screen.findByTitle('已就绪'));
    await waitFor(() => expect(screen.queryByText('失败分群')).not.toBeInTheDocument());
    expect(screen.getByText('活跃用户')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(await screen.findByText('失败分群')).toBeInTheDocument();
  });
});
