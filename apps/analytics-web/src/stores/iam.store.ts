import { create } from 'zustand';
import type { IamMe } from '../services/iam.service';
import { getIamMe, listAccessibleProjects } from '../services/iam.service';
import { useProjectStore } from './project.store';

interface IamState {
  me: IamMe | null;
  permissions: Set<string>;
  loading: boolean;
  hydrated: boolean;
  /**
   * 上次求值失败（非 401 的瞬时故障：发版重启 / 网络抖动）。
   * 只有 401 会走 api 层的清登录态 + 跳登录，所以这里不会掩盖掉登录。
   */
  lastLoadFailed: boolean;
  loadMe: () => Promise<void>;
  has: (code: string) => boolean;
  reset: () => void;
}

export const useIamStore = create<IamState>((set, get) => ({
  me: null,
  permissions: new Set(),
  loading: false,
  hydrated: false,
  lastLoadFailed: false,
  loadMe: async () => {
    set({ loading: true });
    try {
      const me = await getIamMe();
      try {
        const projects = await listAccessibleProjects();
        if (projects.length) useProjectStore.getState().setProjects(projects);
      } catch {
        // 选择器保留本地列表
      }
      set({
        me,
        permissions: new Set(me?.permissions ?? []),
        loading: false,
        hydrated: true,
        lastLoadFailed: false,
      });
    } catch {
      // 瞬时失败保留上次已知权限：清空会让侧栏按码裁剪的分组整块消失，
      // 用户看到的是「没权限」而不是「没拉到」（2026-09-18 验收实测）。
      // 服务端才是权限唯一裁决点，前端保留旧值只影响菜单显示。重试由外壳层退避调度。
      set({ loading: false, hydrated: true, lastLoadFailed: true });
    }
  },
  has: (code) => get().permissions.has(code),
  reset: () =>
    set({ me: null, permissions: new Set(), hydrated: false, loading: false, lastLoadFailed: false }),
}));
