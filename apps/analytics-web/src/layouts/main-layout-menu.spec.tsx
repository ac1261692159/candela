// @vitest-environment jsdom
/**
 * 侧栏分组裁剪（phase: clklog-analytics-rbac-v3 §7）。
 *
 * 背景：v3.2 把整个 `meta.view` 授给分析师，侧栏因此出现「埋点管理」与
 * 「数据管理（接入指南/Debug/数据表）」。修正后分析师只持
 * `meta.picker.view`，应看到「数据管理 → 指标」一项，其余入口整体消失。
 */
import { describe, expect, it } from 'vitest';
import { buildMenuItems } from './MainLayout';
import type { TFunction } from '../i18n';

const t = ((key: string) => key) as unknown as TFunction;
const childKeys = (items: ReturnType<typeof buildMenuItems>, group: string) =>
  items.find((item) => item.key === group)?.children?.map((child) => child.key);

describe('侧栏数据管理分组裁剪（rbac-v3）', () => {
  it('分析师：无埋点管理分组，数据管理只剩指标', () => {
    const items = buildMenuItems(
      new Set([
        'dashboard.view',
        'model.query',
        'model.sql',
        'model.card_save',
        'cohort.view',
        'metric.view',
        'meta.picker.view',
      ]),
      t,
    );
    expect(items.map((item) => item.key)).not.toContain('meta');
    expect(childKeys(items, 'data')).toEqual(['/meta/metrics']);
  });

  it('owner：埋点管理与数据管理五项齐全', () => {
    const items = buildMenuItems(
      new Set(['dashboard.view', 'meta.view', 'metric.view', 'meta.picker.view']),
      t,
    );
    expect(items.map((item) => item.key)).toContain('meta');
    // 「数据质量」已迁到运维组（phase: clklog-data-quality-ops-ia-v1）
    expect(childKeys(items, 'data')).toEqual([
      '/meta/onboarding',
      '/meta/metrics',
      '/meta/debug',
      '/meta/datatables',
    ]);
  });

  it('既无 meta.view 也无 metric.view：数据管理分组不渲染', () => {
    const items = buildMenuItems(new Set(['dashboard.view', 'dashboard.view_all']), t);
    expect(items.map((item) => item.key)).not.toContain('data');
  });
});

describe('运维组包含数据质量（phase: clklog-data-quality-ops-ia-v1）', () => {
  it('超管（持 ops.runtime.access）：运维组含数据质量，数据管理组不含', () => {
    const items = buildMenuItems(
      new Set(['dashboard.view', 'meta.view', 'metric.view', 'ops.runtime.access']),
      t,
    );
    expect(childKeys(items, 'ops')).toEqual([
      '/ops/slow-queries',
      '/ops/server-status',
      '/ops/alerts',
      '/ops/data-management',
      '/ops/quality',
    ]);
    expect(childKeys(items, 'data') ?? []).not.toContain('/ops/quality');
    expect(childKeys(items, 'data') ?? []).not.toContain('/meta/quality');
  });

  it('无 ops 权限：运维组不渲染（数据质量随之不可见）', () => {
    const items = buildMenuItems(new Set(['dashboard.view', 'meta.view', 'metric.view']), t);
    expect(items.map((item) => item.key)).not.toContain('ops');
  });
});
