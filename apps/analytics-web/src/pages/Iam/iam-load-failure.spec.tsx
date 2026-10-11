// @vitest-environment jsdom
/**
 * IAM 页取数失败态（2026-09-18 验收实测）。
 *
 * 角色管理页此前是裸 `.then(setCatalog)`：请求失败时 catalog 保持 null，页面渲染成
 * 「左列空 + 右表暂无数据」，看起来像没有权限。现在给出「加载失败 + 重试」。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getIamCatalog = vi.fn();
vi.mock('../../services/iam.service', () => ({
  getIamCatalog: (...args: unknown[]) => getIamCatalog(...(args as [])),
  putAdminRole: vi.fn(),
}));

import { IamRolesPage } from './RolesPage';
import { useIamStore } from '../../stores/iam.store';

const CATALOG = {
  permissions: [
    { code: 'dashboard.view', feature: '看板使用', feature_key: 'iam:permission.feature.dashboard', op: '查看', op_key: 'iam:permission.op.view', detail: '查看可访问看板及设置', detail_key: 'iam:permission.detail.dashboardView' },
  ],
  roles: [
    { key: 'project_owner', label: '项目 owner', label_key: 'iam:role.projectOwner', preset: true, codes: ['dashboard.view'] },
    { key: 'analyst', label: '分析师', label_key: 'iam:role.analyst', preset: true, codes: [] },
  ],
};

describe('角色管理页取数失败态', () => {
  beforeEach(() => {
    getIamCatalog.mockReset();
    useIamStore.setState({ permissions: new Set(['iam.member.view']), me: null, hydrated: true, loading: false });
  });

  it('失败时提示「加载失败」并可重试成功', async () => {
    getIamCatalog.mockRejectedValueOnce(new Error('502'));
    render(<IamRolesPage />);

    expect(await screen.findByText('加载失败，请重试')).toBeTruthy();
    expect(screen.queryByText('项目 owner')).toBeNull();

    getIamCatalog.mockResolvedValueOnce(CATALOG);
    await userEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    await waitFor(() => expect(screen.getByText('项目 owner')).toBeTruthy());
    expect(screen.queryByText('加载失败，请重试')).toBeNull();
  });
});
