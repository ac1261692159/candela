// @vitest-environment jsdom
/**
 * 权限求值的失败语义（2026-09-18 验收实测）。
 *
 * 发版重启窗口内 `/iam/me` 会瞬时失败：此前 store 直接清空权限集，侧栏按码裁剪的分组
 * 整块消失，用户看到的是「没权限」。现在失败只标记、不清空，由外壳层退避重试。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getIamMe = vi.fn();
const listAccessibleProjects = vi.fn(async () => []);

vi.mock('../services/iam.service', () => ({
  getIamMe: (...args: unknown[]) => getIamMe(...(args as [])),
  listAccessibleProjects: (...args: unknown[]) => listAccessibleProjects(...(args as [])),
}));

import { useIamStore } from './iam.store';

const ME = {
  platform_role: 'none' as const,
  member: true,
  role_key: 'analyst' as const,
  role_label: '分析师',
  role_label_key: 'iam:role.analyst',
  permissions: ['dashboard.view', 'iam.member.view'],
  data_scope: {},
};

describe('iam.store loadMe 失败语义', () => {
  beforeEach(() => {
    getIamMe.mockReset();
    useIamStore.getState().reset();
  });

  it('首次失败：没有旧值可留，标记失败且权限为空', async () => {
    getIamMe.mockRejectedValueOnce(new Error('502'));
    await useIamStore.getState().loadMe();
    const state = useIamStore.getState();
    expect(state.permissions.size).toBe(0);
    expect(state.lastLoadFailed).toBe(true);
    expect(state.hydrated).toBe(true);
  });

  it('后续失败保留上次已知权限与角色（菜单不闪没）', async () => {
    getIamMe.mockResolvedValueOnce(ME);
    await useIamStore.getState().loadMe();
    expect(useIamStore.getState().permissions.has('iam.member.view')).toBe(true);

    getIamMe.mockRejectedValueOnce(new Error('503'));
    await useIamStore.getState().loadMe();
    const state = useIamStore.getState();
    expect(state.permissions.has('iam.member.view')).toBe(true);
    expect(state.me?.role_key).toBe('analyst');
    expect(state.lastLoadFailed).toBe(true);
  });

  it('重试成功后清除失败标记并刷新权限', async () => {
    getIamMe.mockResolvedValueOnce(ME);
    await useIamStore.getState().loadMe();
    getIamMe.mockRejectedValueOnce(new Error('503'));
    await useIamStore.getState().loadMe();
    expect(useIamStore.getState().lastLoadFailed).toBe(true);

    getIamMe.mockResolvedValueOnce({ ...ME, permissions: ['dashboard.view'] });
    await useIamStore.getState().loadMe();
    const state = useIamStore.getState();
    expect(state.lastLoadFailed).toBe(false);
    expect(state.permissions.has('iam.member.view')).toBe(false);
  });

  it('登出（reset）清空权限与失败标记', async () => {
    getIamMe.mockResolvedValueOnce(ME);
    await useIamStore.getState().loadMe();
    useIamStore.getState().reset();
    const state = useIamStore.getState();
    expect(state.permissions.size).toBe(0);
    expect(state.me).toBeNull();
    expect(state.lastLoadFailed).toBe(false);
  });
});
