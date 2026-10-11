// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { LoginPage } from '../pages/LoginPage';
import { ForbiddenPage } from '../pages/ForbiddenPage';
import { UserCohortsPage } from '../pages/Analysis/UserCohortsPage';
import { getCohorts } from '../services/cohort.service';
import { changeLocale, i18n } from './index';

vi.mock('../services/cohort.service', () => ({
  getCohorts: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  deleteCohort: vi.fn(),
  getCohortMembers: vi.fn().mockResolvedValue({ items: [], total: 0, truncated: false }),
  refreshCohort: vi.fn(),
}));

vi.mock('../services/meta.service', () => ({
  getEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getUserProperties: vi.fn().mockResolvedValue({ items: [], total: 0 }),
}));

vi.mock('../services/subject.service', () => ({
  getSubjects: vi.fn().mockResolvedValue({
    items: [
      { subject_id: 'asub_userxxxx', name: 'user', display_name: 'User', kind: 'preset', is_preset: true },
    ],
    total: 1,
  }),
}));

vi.mock('../stores/project.store', () => ({
  useProjectStore: (select: (s: { currentProject: string }) => unknown) =>
    select({ currentProject: 'clklogapp' }),
}));

/**
 * 英文渲染验收（PRD I18N-5 / I18N-6 的组件级闭环）：
 * 切成 en-US 后，登录页与 403 页**不得出现任何中文字符**。
 * 这是「无中文残留」防回归的最低成本自动化，覆盖最常被非中文用户看到的两个页面。
 */
const CJK = /[\u4e00-\u9fff]/;

function textOf(container: HTMLElement): string {
  return container.textContent ?? '';
}

afterEach(async () => {
  await changeLocale('zh-CN');
});

describe('en-US rendering', () => {
  it('renders the login page fully in English', async () => {
    await changeLocale('en-US');
    const { container } = render(
      <ConfigProvider>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </ConfigProvider>,
    );

    const text = textOf(container);
    expect(text).toContain('Sign in');
    expect(text).toContain('Trusted user behavior analytics');
    expect(CJK.test(text)).toBe(false);
  });

  it('renders the forbidden page fully in English', async () => {
    await changeLocale('en-US');
    const { container } = render(
      <MemoryRouter>
        <ForbiddenPage />
      </MemoryRouter>,
    );

    const text = textOf(container);
    expect(text).toContain('Access denied');
    expect(CJK.test(text)).toBe(false);
  });

  it('keeps the Chinese rendering byte-identical to the pre-migration copy', async () => {
    await changeLocale('zh-CN');
    render(
      <MemoryRouter>
        <ForbiddenPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('没有权限')).toBeTruthy();
    expect(screen.getByText('你不是该项目成员，或当前角色不能打开这个页面。')).toBeTruthy();
    expect(screen.getByText('返回看板')).toBeTruthy();
  });

  it('re-renders language-dependent text without a full reload', async () => {
    await changeLocale('zh-CN');
    render(
      <MemoryRouter>
        <ForbiddenPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('返回看板')).toBeTruthy();

    await changeLocale('en-US');
    expect(i18n.language).toBe('en-US');
    expect(await screen.findByText('Back to dashboards')).toBeTruthy();
  });
});

/**
 * 用户分群页（phase: clklog-analytics-user-segment-ux-v1）：
 * 列表（含圈人规则摘要）与创建类型卡整页切到 en-US 后不得残留中文——
 * 摘要句式在英文里占位符顺序与中文不同，这里同时证明「语言不进载荷、渲染在浏览器端」。
 */
describe('en-US rendering · user cohorts', () => {
  it('renders the cohort list, rule summary and type cards fully in English', async () => {
    vi.mocked(getCohorts).mockResolvedValue({
      items: [
        {
          cohort_id: 'cohort_abc123xx',
          project_name: 'clklogapp',
          owner: 'alice',
          name: 'cohort_active',
          display_name: 'Active users',
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
          schedule: 'daily',
          status: 'ready',
          member_count: 1234,
          batch_id: 'b_1',
          last_computed_at: '2026-09-05T05:30:16.000Z',
          compute_error: null,
          subject_id: 'asub_userxxxx',
          locked: false,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-05T05:30:16.000Z',
        },
      ],
      total: 1,
    } as never);
    await changeLocale('en-US');
    const { container } = render(
      <ConfigProvider>
        <MemoryRouter>
          <UserCohortsPage />
        </MemoryRouter>
      </ConfigProvider>,
    );

    expect(await screen.findByText('User cohorts')).toBeTruthy();
    expect(screen.getAllByText('Rule')[0]).toBeTruthy();
    // 摘要句式按英文重排，证明渲染在浏览器端而不是服务端下发译好的文本
    expect(screen.getByText('Did AppStart greater than 0 times in the last 7 days')).toBeTruthy();
    expect(screen.getByText('All statuses')).toBeTruthy();
    expect(CJK.test(container.textContent ?? '')).toBe(false);

    // 创建类型卡：同一页面上再点开一次，省一次整页渲染（页面级用例在满载时开销大）
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Create cohort/ }));
    expect(await screen.findByText(/Compose a one-line rule/)).toBeTruthy();
    expect(screen.getByText(/Upload a CSV with one user ID column/)).toBeTruthy();
    expect(CJK.test(container.textContent ?? '')).toBe(false);
  });
});
