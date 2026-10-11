/**
 * 侧栏展开宽度：按当前语言的**菜单标签实测宽度**算出。
 *
 * 为什么不用「按语言写死一张宽度表」：标签会随文案修订、权限裁剪、菜单增删而变，
 * 写死的表必然漂移；实测对任何语言都成立，加语言时不需要改代码（i18n 规范 G 组）。
 *
 * 测量对象是菜单标签自身（`white-space: nowrap` 的元素，`scrollWidth` 即自然宽度），
 * 加上图标/内边距/箭头等固定开销后 clamp 到 [SIDER_EXPANDED_MIN, SIDER_EXPANDED_MAX]。
 * 结果按「语言 + 菜单集合」缓存，避免切语言后重新测量造成的宽度跳动。
 */
import { useLayoutEffect, useState, type RefObject } from 'react';
import { SIDER_EXPANDED_MIN, clampSiderExpanded } from './shell-layout';

/** 标签之外的固定开销：图标 16 + 图标间距 8 + 条目内边距 8×2 + 子菜单箭头 12 + 侧栏内边距 8 */
const LABEL_OVERHEAD = 60;

const measuredCache = new Map<string, number>();

export function useSiderWidth(
  container: RefObject<HTMLElement | null>,
  /** 缓存键：语言 + 菜单集合（权限变化会改变可见菜单） */
  measureKey: string,
): number {
  const [width, setWidth] = useState(() => measuredCache.get(measureKey) ?? SIDER_EXPANDED_MIN);

  useLayoutEffect(() => {
    const cached = measuredCache.get(measureKey);
    if (cached !== undefined) {
      setWidth(cached);
      return;
    }
    const node = container.current;
    if (!node) return;

    let widest = 0;
    for (const label of node.querySelectorAll<HTMLElement>('.shell-sider-menu-label')) {
      // 折叠态下标签被 antd 隐藏（宽度 0）：跳过，保留上一次/默认宽度，展开时会再测
      widest = Math.max(widest, label.scrollWidth);
    }
    if (widest <= 0) return;

    const measured = clampSiderExpanded(widest + LABEL_OVERHEAD);
    measuredCache.set(measureKey, measured);
    setWidth(measured);
  }, [container, measureKey]);

  return width;
}
