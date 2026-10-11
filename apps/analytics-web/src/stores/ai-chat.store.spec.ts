// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { migrateDockWidth } from './ai-chat.store';
import { HARNESS_DOCK_DEFAULT, HARNESS_DOCK_MAX, HARNESS_DOCK_MIN } from '../layouts/shell-layout';

/**
 * phase: clklog-analytics-ai-panel-surface-v1 —— 上限放宽到 720 之后，
 * 旧的迁移阈值（≥640 就清成默认）会把用户合法拖出的宽度清掉，这里钉住新语义。
 */
describe('AI 面板宽度偏好迁移', () => {
  it('上限之内原样保留', () => {
    expect(migrateDockWidth(400)).toBe(400);
    expect(migrateDockWidth(520)).toBe(520);
    expect(migrateDockWidth(HARNESS_DOCK_MAX)).toBe(HARNESS_DOCK_MAX);
  });

  it('低于下限抬到下限，高于上限拉回默认', () => {
    expect(migrateDockWidth(120)).toBe(HARNESS_DOCK_MIN);
    expect(migrateDockWidth(HARNESS_DOCK_MAX + 1)).toBe(HARNESS_DOCK_DEFAULT);
    expect(migrateDockWidth(4000)).toBe(HARNESS_DOCK_DEFAULT);
  });
});
