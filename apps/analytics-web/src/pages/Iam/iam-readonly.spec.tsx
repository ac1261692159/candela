// @vitest-environment jsdom
/**
 * 项目权限只读态（phase: clklog-analytics-rbac-v4）。
 *
 * 全员可见后，无写码的角色（分析师 / 普通成员 / 外部人员）进入成员、成员组、
 * 数据权限三页时应看到纯只读界面：没有写按钮、没有邀请与审计治理面；
 * 数据权限的「查看」明细对所有人可用。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IamMembersPage } from './MembersPage';
import { IamGroupsPage } from './GroupsPage';
import { IamDataPoliciesPage } from './DataPoliciesPage';
import { useIamStore } from '../../stores/iam.store';

vi.mock('../../services/iam.service', () => ({
  listMembers: vi.fn(async () => [
    {
      id: 'm1',
      user_id: 'u1',
      role_key: 'analyst',
      data_policy: null,
      user: { id: 'u1', username: 'analyst', display_name: '分析师甲' },
    },
  ]),
  listInvitations: vi.fn(async () => [
    { id: 'i1', email: 'invitee@example.com', role_key: 'analyst', invited_by: 'owner', expires_at: '2026-09-25T00:00:00Z' },
  ]),
  listGroups: vi.fn(async () => [
    { id: 'g1', name: '增长组', role_key: 'analyst', data_policy: null, _count: { users: 1 }, users: [{ user_id: 'u1' }] },
  ]),
  listDataPolicies: vi.fn(async () => [
    {
      id: 'p1',
      name: '只看 App',
      definition_json: JSON.stringify({
        events: { mode: 'allow', keys: ['AppLaunch'] },
        event_properties: { mode: 'all', keys: [] },
        user_properties: { mode: 'all', keys: [] },
        row_filter: { rel: 'and', children: [{ prop: 'channel', op: '=', value: 'app' }] },
      }),
      _count: { members: 1, groups: 0 },
    },
  ]),
  listUserDirectory: vi.fn(async () => []),
  addMember: vi.fn(),
  patchMember: vi.fn(),
  removeMember: vi.fn(),
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  createGroup: vi.fn(),
  addGroupUser: vi.fn(),
  removeGroupUser: vi.fn(),
  createDataPolicy: vi.fn(),
  deleteDataPolicy: vi.fn(),
}));

vi.mock('../../services/auth.service', () => ({
  listAuditLogs: vi.fn(async () => []),
}));

const READONLY = ['iam.member.view'];
const MANAGER = ['iam.member.view', 'iam.member.edit', 'iam.data_policy.manage'];

function setPermissions(codes: string[]) {
  useIamStore.setState({ permissions: new Set(codes), me: null, hydrated: true, loading: false });
}

describe('项目权限只读态（rbac-v4）', () => {
  beforeEach(() => {
    setPermissions(READONLY);
  });

  it('分析师看成员页：无添加按钮、无邀请与审计治理面，但能看到成员', async () => {
    render(<IamMembersPage />);
    expect(screen.queryByText('添加成员')).toBeNull();
    await waitFor(() => expect(screen.getByText('分析师甲')).toBeTruthy());
    expect(screen.queryByText('待接受邀请')).toBeNull();
    expect(screen.queryByText('项目操作审计')).toBeNull();
    expect(screen.queryByRole('button', { name: /移\s*除/ })).toBeNull();
  });

  it('管理员看成员页：添加、邀请区与审计区齐全', async () => {
    setPermissions(MANAGER);
    render(<IamMembersPage />);
    expect(await screen.findByText('添加成员')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('待接受邀请')).toBeTruthy());
    expect(screen.getByText('项目操作审计')).toBeTruthy();
    expect(screen.getByText('invitee@example.com')).toBeTruthy();
  });

  it('分析师看成员组页：无新建组，组员只读展示', async () => {
    render(<IamGroupsPage />);
    await waitFor(() => expect(screen.getByText('增长组')).toBeTruthy());
    expect(screen.queryByText('新建组')).toBeNull();

    // 只读：组员以标签展示，没有可编辑的多选控件，也没有确定按钮
    await userEvent.click(screen.getByRole('button', { name: /成\s*员/ }));
    await waitFor(() => expect(screen.getAllByText('分析师甲').length).toBeGreaterThan(0));
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('分析师看数据权限页：无新建/删除，可查看明细（事件白名单 + 行过滤）', async () => {
    render(<IamDataPoliciesPage />);
    await waitFor(() => expect(screen.getByText('只看 App')).toBeTruthy());
    expect(screen.queryByText('新建策略')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /查\s*看/ }));
    await waitFor(() => expect(screen.getByText('策略明细')).toBeTruthy());
    expect(screen.getByText('AppLaunch')).toBeTruthy();
    expect(screen.getByText('channel = app')).toBeTruthy();
    expect(screen.getAllByText('不限制')).toHaveLength(2);
  });

  it('管理员看数据权限页：新建与删除可用', async () => {
    setPermissions(MANAGER);
    render(<IamDataPoliciesPage />);
    expect(await screen.findByText('新建策略')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('只看 App')).toBeTruthy());
    expect(screen.getByRole('button', { name: /删\s*除/ })).toBeTruthy();
  });
});
