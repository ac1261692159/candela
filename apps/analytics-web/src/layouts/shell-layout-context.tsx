import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAiChatStore } from '../stores/ai-chat.store';
import {
  SIDER_EXPANDED_MIN,
  clampSiderExpanded,
  overlayHarnessWidth,
  resolveShellLayout,
  type ShellLayout,
} from './shell-layout';

function readViewportWidth(): number {
  return window.visualViewport?.width ?? window.innerWidth;
}

function useVisualViewportWidth(): number {
  const [viewportWidth, setViewportWidth] = useState(readViewportWidth);
  useEffect(() => {
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setViewportWidth(readViewportWidth()), 50);
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, []);
  return viewportWidth;
}

export interface ShellLayoutContextValue {
  viewportWidth: number;
  layout: ShellLayout;
  overlayOpen: boolean;
  overlayWidth: number;
  setOverlayOpen: (open: boolean) => void;
  /** 当前语言的侧栏展开宽度（菜单实测得出，clamp 后） */
  siderExpanded: number;
  setSiderExpanded: (width: number) => void;
}

const ShellLayoutContext = createContext<ShellLayoutContextValue | null>(null);

export function ShellLayoutProvider({ children }: { children: ReactNode }) {
  const viewportWidth = useVisualViewportWidth();
  const expanded = useAiChatStore((state) => state.expanded);
  const widthPref = useAiChatStore((state) => state.width);
  const [overlayOpen, setOverlayOpen] = useState(false);
  // 侧栏展开宽度随语言变化：由壳层实测菜单标签后回填（初始为中文基线）
  const [siderExpanded, setSiderExpandedState] = useState(SIDER_EXPANDED_MIN);
  const setSiderExpanded = useCallback((width: number) => {
    setSiderExpandedState((prev) => (Math.abs(prev - clampSiderExpanded(width)) > 1 ? clampSiderExpanded(width) : prev));
  }, []);
  const layout = useMemo(
    () => resolveShellLayout(viewportWidth, { widthPref, occupyDock: expanded, siderExpanded }),
    [viewportWidth, widthPref, expanded, siderExpanded],
  );

  // 视口变宽到可以停靠时，把「因不能停靠而处在覆盖层」的状态收回停靠。
  // 只依赖 canDock 的跳变，因此可停靠态下手动扩宽 / 因官方弹窗临时扩宽不会被这行清掉。
  useEffect(() => {
    if (layout.canDock) setOverlayOpen(false);
  }, [layout.canDock]);

  const value = useMemo<ShellLayoutContextValue>(
    () => ({
      viewportWidth,
      layout,
      siderExpanded,
      setSiderExpanded,
      // 覆盖层不再要求「不能停靠」：官方弹窗需要更宽的面时，可停靠态也要能临时离开文档流
      // （phase: clklog-analytics-ai-panel-surface-v1）。
      overlayOpen,
      overlayWidth: overlayHarnessWidth(viewportWidth),
      setOverlayOpen,
    }),
    [viewportWidth, layout, overlayOpen, siderExpanded, setSiderExpanded],
  );

  return <ShellLayoutContext.Provider value={value}>{children}</ShellLayoutContext.Provider>;
}

const FALLBACK: ShellLayoutContextValue = {
  viewportWidth: 1920,
  siderExpanded: SIDER_EXPANDED_MIN,
  setSiderExpanded: () => undefined,
  layout: resolveShellLayout(1920),
  overlayOpen: false,
  overlayWidth: overlayHarnessWidth(1920),
  setOverlayOpen: () => undefined,
};

export function useShellLayout(): ShellLayoutContextValue {
  return useContext(ShellLayoutContext) ?? FALLBACK;
}
