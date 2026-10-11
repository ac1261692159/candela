import { describe, expect, it } from 'vitest';
import { MAX_FUNNEL_STEPS } from '../../types/dsl.types';
import {
  insertFunnelStepAfter,
  insertFunnelStepBefore,
  moveFunnelStep,
} from './funnel-editor-steps';

const two = [
  { event: 'a', alias: '启动' },
  { event: 'b', alias: '登录' },
];

describe('funnel-editor-steps', () => {
  it('inserts a blank step before the current index', () => {
    const next = insertFunnelStepBefore(two, 1);
    expect(next.map((s) => s.event)).toEqual(['a', '', 'b']);
    expect(next[1].alias).toBe('第 2 步');
    expect(next[2].alias).toBe('登录');
  });

  it('adds a blank step after the current index', () => {
    const next = insertFunnelStepAfter(two, 0);
    expect(next.map((s) => s.event)).toEqual(['a', '', 'b']);
    expect(next[1].alias).toBe('第 2 步');
  });

  it('moves a step up and down without renaming', () => {
    expect(moveFunnelStep(two, 1, -1).map((s) => s.alias)).toEqual(['登录', '启动']);
    expect(moveFunnelStep(two, 0, 1).map((s) => s.alias)).toEqual(['登录', '启动']);
    expect(moveFunnelStep(two, 0, -1)).toBe(two);
    expect(moveFunnelStep(two, 1, 1)).toBe(two);
  });

  it('does not insert past the step cap', () => {
    const full = Array.from({ length: MAX_FUNNEL_STEPS }, (_, i) => ({
      event: `e${i}`,
      alias: `第 ${i + 1} 步`,
    }));
    expect(insertFunnelStepBefore(full, 0)).toBe(full);
    expect(insertFunnelStepAfter(full, 0)).toBe(full);
  });
});
