// @vitest-environment jsdom
/**
 * 路由静态守卫（phase: clklog-data-quality-ops-ia-v1）。
 *
 * 背景：BrowserRouter 的 basename 是 `/sa`，`Navigate to` 必须是**路由内路径**
 * （仓库里其他跳转都是 `/report/dashboards` 这种写法）。写成完整 URL `/sa/ops/quality`
 * 会被解析成 `/sa/sa/ops/quality`，静默落到兜底跳转 —— 2026-10-09 线上实测踩到。
 */
import { describe, expect, it } from 'vitest';
import { isValidElement } from 'react';
import { routes } from './routes';

interface FlatRoute {
  path: string;
  element: unknown;
}

function flatten(list: unknown[]): FlatRoute[] {
  const out: FlatRoute[] = [];
  for (const r of list as Array<{ path?: string; element?: unknown; children?: unknown[] }>) {
    if (r?.path) out.push({ path: r.path, element: r.element });
    if (r?.children) out.push(...flatten(r.children));
  }
  return out;
}

const all = flatten(routes as unknown[]);
const find = (path: string) => all.filter((r) => r.path === path);

describe('数据质量路由（IA 迁移）', () => {
  it('新入口在 ops/quality，权限与「数据运维」同为 ops.runtime.access', () => {
    const hits = find('ops/quality');
    expect(hits).toHaveLength(1);
    const el = hits[0].element as { props?: { code?: string } };
    expect(isValidElement(el)).toBe(true);
    expect(el?.props?.code).toBe('ops.runtime.access');
  });

  it('旧入口 meta/quality 是用路由内路径的跳转（不是完整 URL）', () => {
    const hits = find('meta/quality');
    expect(hits).toHaveLength(1);
    const el = hits[0].element as { props?: { to?: string; replace?: boolean } };
    expect(el.props?.to).toBe('/ops/quality');
    expect(el.props?.to?.startsWith('/sa/')).toBe(false);
    expect(el.props?.replace).toBe(true);
  });
});
