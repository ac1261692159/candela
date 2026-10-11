/**
 * 查询时间面板不被视口裁切（phase: clklog-analytics-metric-v3，PRD §3.1 / AC-1 / AC-2）。
 *
 * 用户反馈：面板固定 848px，锚点靠近视口右侧时整块超出浏览器右边界，日历被裁切。
 * jsdom 量不出真实布局，因此这里锁**布局契约**：宽度自适应视口、窄容器单列、弹层限宽并自动避让。
 * 真实观感在浏览器里验收（见 HANDOVER §22 的线上验收记录）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const css = readFileSync(join(__dirname, 'time-range-panel.css'), 'utf8');
const control = readFileSync(join(__dirname, 'TimeRangeControl.tsx'), 'utf8');

describe('查询时间面板的布局契约', () => {
  it('宽度随视口收缩，不再固定 848px（AC-2）', () => {
    expect(css).toContain('width: min(848px, calc(100vw - 40px))');
    expect(css).toContain('max-width: calc(100vw - 40px)');
    expect(css).not.toMatch(/\.time-range-panel\s*\{[^}]*min-width: 848px/);
  });

  it('窄容器下日历自动降为单列、预设列整行铺开', () => {
    expect(css).toContain('repeat(auto-fit, minmax(260px, 1fr))');
    expect(css).toMatch(/@media \(max-width: 680px\)/);
  });

  it('弹层限宽、提前给定宽度并允许自动避让（贴右边时整体左移，不越界）', () => {
    expect(control).toContain('autoAdjustOverflow');
    expect(control).toContain("width: 'min(848px, calc(100vw - 40px))'");
    expect(control).toContain("maxWidth: 'calc(100vw - 24px)'");
    expect(control).toContain('getPopupContainer={() => document.body}');
  });

  it('中窄视口（≤900px）改单列日历并收窄面板，应用按钮不会被挤出视口', () => {
    expect(css).toMatch(/@media \(max-width: 900px\)/);
    expect(css).toContain('width: min(560px, calc(100vw - 24px))');
  });
});
