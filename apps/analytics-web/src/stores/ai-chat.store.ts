import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { HARNESS_DOCK_DEFAULT, HARNESS_DOCK_MAX, HARNESS_DOCK_MIN } from '../layouts/shell-layout';

interface AiPanelLayout {
  expanded: boolean;
  width: number;
}

interface AiPanelState {
  activeUserId: string | null;
  expanded: boolean;
  width: number;
  layouts: Record<string, AiPanelLayout>;
  activateUser: (userId: string) => void;
  setExpanded: (expanded: boolean) => void;
  setWidth: (width: number) => void;
  resetForProject: () => void;
}

const DEFAULT_LAYOUT: AiPanelLayout = { expanded: true, width: HARNESS_DOCK_DEFAULT };

/**
 * 宽度偏好迁移：上限之外的脏数据（历史上没有夹紧时存下的超大值）拉回默认；
 * 上限之内一律保留——上限已放宽到 720，640~720 是用户合法拖出来的宽度，
 * 不能再被这条迁移清掉（phase: clklog-analytics-ai-panel-surface-v1）。
 */
export function migrateDockWidth(width: number): number {
  if (width > HARNESS_DOCK_MAX) return HARNESS_DOCK_DEFAULT;
  return Math.max(HARNESS_DOCK_MIN, Math.round(width));
}

export const useAiChatStore = create<AiPanelState>()(
  persist(
    (set, get) => ({
      activeUserId: null,
      ...DEFAULT_LAYOUT,
      layouts: {},

      activateUser: (userId) => {
        const layout = get().layouts[userId] ?? DEFAULT_LAYOUT;
        set({
          activeUserId: userId,
          expanded: layout.expanded,
          width: migrateDockWidth(layout.width),
        });
      },

      setExpanded: (expanded) => {
        const userId = get().activeUserId;
        set((state) => ({
          expanded,
          layouts: userId
            ? { ...state.layouts, [userId]: { expanded, width: state.width } }
            : state.layouts,
        }));
      },

      setWidth: (width) => {
        const normalized = Math.round(width);
        const userId = get().activeUserId;
        set((state) => ({
          width: normalized,
          layouts: userId
            ? {
                ...state.layouts,
                [userId]: { expanded: state.expanded, width: normalized },
              }
            : state.layouts,
        }));
      },

      // Runtime 会话按浏览器标签页与项目隔离；切项目时 iframe 会重新领取票据。
      resetForProject: () => undefined,
    }),
    {
      name: 'clklog-ai-panel-layout-v1',
      partialize: (state) => ({ layouts: state.layouts }),
    },
  ),
);
