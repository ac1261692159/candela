import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthUser {
  id: string;
  username: string;
  display_name: string | null;
  /** 可空唯一邮箱（account-lifecycle-v1） */
  email?: string | null;
  platform_role: 'super_admin' | 'none';
  default_project?: string | null;
  /** 界面语言偏好（BCP-47）；null/缺省 = 未设置，按浏览器语言解析 */
  locale?: string | null;
  /** 实例级平台时区（IANA；登录/me 下发，phase: clklog-analytics-timezone-v1） */
  platform_timezone?: string | null;
  /** 用户显示时区偏好（IANA；null = 跟随项目/平台，timezone-v2） */
  timezone?: string | null;
  /** 管理员代设密码后强制首登改密（account-lifecycle-v1） */
  must_change_password?: boolean;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  setAuth: (token: string, user: AuthUser) => void;
  setUser: (user: AuthUser) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      setUser: (user) => set({ user }),
      clearAuth: () => set({ token: null, user: null }),
    }),
    {
      name: 'clklog-analytics-auth',
      version: 3,
      migrate: (persisted) => {
        const state = persisted as AuthState & { user?: AuthUser & { role?: string } };
        if (state.user && !state.user.platform_role) {
          state.user.platform_role = state.user.role === 'admin' ? 'super_admin' : 'none';
        }
        // v2 → v3（account-lifecycle-v1）：旧缓存补默认标记，me() 引导会刷新真值
        if (state.user && state.user.must_change_password === undefined) {
          state.user.must_change_password = false;
        }
        if (state.user && state.user.email === undefined) {
          state.user.email = null;
        }
        return state as AuthState;
      },
    },
  ),
);
