// @vitest-environment jsdom
/**
 * 资产侧授权弹层的双栏选择器（rbac-v6 增补）。
 *
 * 从「多选下拉」改为「左右双栏（未添加 / 已添加）+ 头部标签页 + 固定高度内部滚动」：
 * 候选多（成员上百）时也要能一眼核对已授权对象，且弹层高度不随内容变化。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetGrantModal } from './AssetGrantModal';
import { useIamStore } from '../../stores/iam.store';

const getCohorts = vi.fn(async () => ({ items: [] }));
vi.mock('../../services/cohort.service', () => ({
  getCohorts: (...args: unknown[]) => getCohorts(...(args as [])),
}));

vi.mock('../../services/iam.service', () => ({
  listMembers: vi.fn(async () => [
    { id: 'm1', user_id: 'u-analyst', role_key: 'analyst', user: { id: 'u-analyst', username: 'a1', display_name: '分析师甲' } },
    { id: 'm2', user_id: 'u-member', role_key: 'member', user: { id: 'u-member', username: 'm1', display_name: '成员乙' } },
  ]),
  listGroups: vi.fn(async () => [
    { id: 'g1', name: '分析师组', role_key: 'analyst' },
    { id: 'g2', name: '普通成员组', role_key: 'member' },
  ]),
}));

const renderModal = (loadGrants: () => Promise<{ subject_type: string; subject_id: string; perm: string }[]>) =>
  render(
    <AssetGrantModal
      open
      title="授权 · 看板A"
      allowView
      loadGrants={loadGrants}
      saveGrants={async () => {}}
      onClose={() => {}}
    />,
  );

describe('授权弹层双栏选择器（rbac-v6 增补）', () => {
  beforeEach(() => {
    getCohorts.mockClear();
    useIamStore.setState({ permissions: new Set(['dashboard.view', 'asset.grant']), me: null, hydrated: true, loading: false });
  });

  it('编辑栏只列分析师；查看栏列全部成员组与成员；两栏按标签页切换类别', async () => {
    renderModal(async () => []);
    const editLeft = await screen.findByTestId('grant-transfer-edit-left');
    const viewLeft = screen.getByTestId('grant-transfer-view-left');

    // 编辑栏 · 成员组标签页：只有分析师组
    await waitFor(() => expect(within(editLeft).getByText('组 · 分析师组')).toBeTruthy());
    expect(within(editLeft).queryByText('组 · 普通成员组')).toBeNull();

    // 编辑栏 · 成员标签页：只有分析师个人
    await userEvent.click(within(editLeft).getByRole('tab', { name: '成员' }));
    expect(within(editLeft).getByText('分析师 · 分析师甲')).toBeTruthy();
    expect(within(editLeft).queryByText('成员 · 成员乙')).toBeNull();

    // 查看栏 · 成员组标签页：两个组都在
    expect(within(viewLeft).getByText('组 · 普通成员组')).toBeTruthy();
    await userEvent.click(within(viewLeft).getByRole('tab', { name: '成员' }));
    expect(within(viewLeft).getByText('成员 · 成员乙')).toBeTruthy();
    expect(within(viewLeft).getByText('成员 · 分析师甲')).toBeTruthy();
  });

  it('点左栏加入右栏、点右栏移回左栏；已授权对象初始就在右栏', async () => {
    renderModal(async () => [{ subject_type: 'group', subject_id: 'g2', perm: 'view' }]);
    const viewLeft = await screen.findByTestId('grant-transfer-view-left');
    const viewRight = screen.getByTestId('grant-transfer-view-right');

    // 已授权的组初始在右栏，不在左栏
    await waitFor(() => expect(within(viewRight).getByText('组 · 普通成员组')).toBeTruthy());
    expect(within(viewLeft).queryByText('组 · 普通成员组')).toBeNull();

    // 左 → 右
    await userEvent.click(within(viewLeft).getByText('组 · 分析师组'));
    await waitFor(() => expect(within(viewRight).getByText('组 · 分析师组')).toBeTruthy());
    expect(within(viewLeft).queryByText('组 · 分析师组')).toBeNull();

    // 右 → 左
    await userEvent.click(within(viewRight).getByText('组 · 普通成员组'));
    await waitFor(() => expect(within(viewLeft).getByText('组 · 普通成员组')).toBeTruthy());
    expect(within(viewRight).queryByText('组 · 普通成员组')).toBeNull();
  });

  it('两栏都支持按名字筛选', async () => {
    renderModal(async () => []);
    const viewLeft = await screen.findByTestId('grant-transfer-view-left');
    await waitFor(() => expect(within(viewLeft).getByText('组 · 分析师组')).toBeTruthy());

    await userEvent.type(within(viewLeft).getByPlaceholderText('搜索'), '普通');
    expect(within(viewLeft).queryByText('组 · 分析师组')).toBeNull();
    expect(within(viewLeft).getByText('组 · 普通成员组')).toBeTruthy();
  });
});
