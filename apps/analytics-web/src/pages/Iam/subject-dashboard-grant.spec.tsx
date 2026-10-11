// @vitest-environment jsdom
/**
 * 成员组视角的看板授权（phase: clklog-analytics-rbac-v6）。
 *
 * 入口只在 `asset.grant` 持有者（owner / 分析管理员）出现；弹层按文件夹与看板列出、
 * 可筛选可勾选；被授「可编辑」的资产只读（edit 蕴含可见，不在此处取消）。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listGroups = vi.fn();
const getSubjectDashboardGrants = vi.fn();
const putSubjectDashboardGrants = vi.fn();
const getDashboards = vi.fn();

vi.mock('../../services/iam.service', () => ({
  listGroups: (...a: unknown[]) => listGroups(...(a as [])),
  listMembers: vi.fn(async () => []),
  addGroupUser: vi.fn(),
  removeGroupUser: vi.fn(),
  createGroup: vi.fn(),
  getFolders: vi.fn(async () => ({
    uncategorized: { name: '未分组', dashboard_count: 1 },
    folders: [{ folder_id: 'f1', name: '核心数据', parent_id: null, locked: false, sort_order: 0, dashboard_count: 2 }],
  })),
  getSubjectDashboardGrants: (...a: unknown[]) => getSubjectDashboardGrants(...(a as [])),
  putSubjectDashboardGrants: (...a: unknown[]) => putSubjectDashboardGrants(...(a as [])),
}));

vi.mock('../../services/report.service', () => ({
  getDashboards: (...a: unknown[]) => getDashboards(...(a as [])),
}));

import { IamGroupsPage } from './GroupsPage';
import { useIamStore } from '../../stores/iam.store';

const setPermissions = (codes: string[]) =>
  useIamStore.setState({ permissions: new Set(codes), me: null, hydrated: true, loading: false });

describe('成员组 · 看板授权（rbac-v6）', () => {
  beforeEach(() => {
    listGroups.mockReset();
    getSubjectDashboardGrants.mockReset();
    putSubjectDashboardGrants.mockReset();
    getDashboards.mockReset();
    listGroups.mockResolvedValue([{ id: 'g1', name: '普通成员组', role_key: 'member', data_policy: null, _count: { users: 1 }, users: [] }]);
    getSubjectDashboardGrants.mockResolvedValue([
      { asset_type: 'dashboard', asset_id: 'd-edit', perm: 'edit' },
      { asset_type: 'folder', asset_id: 'f1', perm: 'view' },
    ]);
    getDashboards.mockResolvedValue([
      { db_id: 'd-edit', name: '被授编辑的看板', folder_id: null },
      { db_id: 'd-free', name: '未授权看板', folder_id: 'f1' },
    ]);
    putSubjectDashboardGrants.mockResolvedValue({ ok: true });
  });

  it('持 asset.grant 时可用：列出现有授权（含可编辑只读），勾选新看板后保存', async () => {
    setPermissions(['iam.member.view', 'iam.member.edit', 'asset.grant']);
    render(<IamGroupsPage />);

    await waitFor(() => expect(screen.getByText('普通成员组')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /看板授权/ }));

    // 「核心数据」既是文件夹行，也是未授权看板的所属文件夹标签，故用 getAllByText
    await waitFor(() => expect(screen.getAllByText('核心数据').length).toBeGreaterThan(0));
    expect(screen.getByText('被授编辑的看板')).toBeTruthy();
    expect(screen.getByText('可编辑')).toBeTruthy();

    // 勾选未授权的看板 → 保存（含原有的文件夹授权与被授编辑的资产）
    await userEvent.click(screen.getByText('未授权看板'));
    await userEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(putSubjectDashboardGrants).toHaveBeenCalled());
    const body = putSubjectDashboardGrants.mock.calls[0][0] as { subject_type: string; asset_ids: string[] };
    expect(body.subject_type).toBe('group');
    expect(new Set(body.asset_ids)).toEqual(new Set(['f1', 'd-edit', 'd-free']));
  });

  it('无 asset.grant 时不出现入口', async () => {
    setPermissions(['iam.member.view']);
    render(<IamGroupsPage />);
    await waitFor(() => expect(screen.getByText('普通成员组')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /看板授权/ })).toBeNull();
  });
});
