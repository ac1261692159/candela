import { describe, expect, it } from 'vitest';
import {
  BAND_LG,
  BAND_MD,
  BAND_SM,
  BAND_XL,
  CHROME,
  HARNESS_DIALOG_MIN,
  HARNESS_DOCK_MAX,
  HARNESS_DOCK_MIN,
  SPLIT_MIN,
  SIDER_COLLAPSED,
  SIDER_EXPANDED,
  SIDER_EXPANDED_MIN,
  SIDER_EXPANDED_MAX,
  clampSiderExpanded,
  boundedDockedHarnessWidth,
  overlayHarnessWidth,
  resolveShellLayout,
} from './shell-layout';

const SNAPSHOTS = [
  { W: 1920, band: 'xl', sider: 'expanded', harness: 'docked', workbench: 'split' },
  { W: 1600, band: 'xl', sider: 'expanded', harness: 'docked', workbench: 'split' },
  { W: 1512, band: 'xl', sider: 'expanded', harness: 'docked', workbench: 'split' },
  { W: 1440, band: 'xl', sider: 'expanded', harness: 'docked', workbench: 'split' },
  { W: 1280, band: 'lg', sider: 'collapsed', harness: 'docked', workbench: 'split' },
  { W: 1100, band: 'md', sider: 'collapsed', harness: 'docked', workbench: 'stack' },
  { W: 1024, band: 'md', sider: 'collapsed', harness: 'docked', workbench: 'stack' },
  { W: 768, band: 'sm', sider: 'overlay', harness: 'collapsed', workbench: 'split' },
  { W: 375, band: 'xs', sider: 'overlay', harness: 'collapsed', workbench: 'stack' },
] as const;

describe('resolveShellLayout', () => {
  it('matches the architecture snapshot table', () => {
    for (const row of SNAPSHOTS) {
      const layout = resolveShellLayout(row.W);
      expect(
        {
          W: row.W,
          band: layout.band,
          sider: layout.sider,
          harness: layout.harness,
          workbench: layout.workbench,
        },
        `${row.W}px`,
      ).toEqual(row);
    }
  });

  it('never expands the menu while Harness is undocked', () => {
    for (let width = 360; width <= 1920; width += 16) {
      const layout = resolveShellLayout(width);
      if (layout.sider === 'expanded') {
        expect(layout.harness, `${width}px`).toBe('docked');
      }
    }
  });

  it('never expands the menu while the workbench is stacked', () => {
    for (let width = 360; width <= 1920; width += 16) {
      const layout = resolveShellLayout(width, { widthPref: 720 });
      if (layout.sider === 'expanded') {
        expect(layout.workbench, `${width}px`).toBe('split');
      }
    }
  });

  it('collapses the menu before undocking Harness', () => {
    const wide = resolveShellLayout(BAND_XL);
    const laptop = resolveShellLayout(BAND_LG);
    const phone = resolveShellLayout(BAND_SM);
    expect(wide.sider).toBe('expanded');
    expect(wide.harness).toBe('docked');
    expect(laptop.sider).toBe('collapsed');
    expect(laptop.harness).toBe('docked');
    expect(phone.sider).toBe('overlay');
    expect(phone.harness).toBe('collapsed');
  });

  it('does not dock when occupyDock is false, and gives the workbench the leftover', () => {
    const occupied = resolveShellLayout(1100, { occupyDock: true });
    const free = resolveShellLayout(1100, { occupyDock: false });
    expect(occupied.harness).toBe('docked');
    expect(occupied.workbench).toBe('stack');
    expect(free.harness).toBe('collapsed');
    expect(free.harnessInFlow).toBe(0);
    expect(free.workbench).toBe('split');
    expect(free.canDock).toBe(true);
  });

  it('keeps band thresholds stable', () => {
    expect(resolveShellLayout(BAND_XL).band).toBe('xl');
    expect(resolveShellLayout(BAND_XL - 1).band).toBe('lg');
    expect(resolveShellLayout(BAND_LG).band).toBe('lg');
    expect(resolveShellLayout(BAND_LG - 1).band).toBe('md');
    expect(resolveShellLayout(BAND_MD).band).toBe('md');
    expect(resolveShellLayout(BAND_MD - 1).band).toBe('sm');
    expect(resolveShellLayout(BAND_SM).band).toBe('sm');
    expect(resolveShellLayout(BAND_SM - 1).band).toBe('xs');
  });

  it('defaults a 14-inch Mac viewport to a 400px dock, not 640px', () => {
    const layout = resolveShellLayout(1512);
    expect(layout.harnessInFlow).toBe(400);
    expect(layout.sider).toBe('expanded');
  });

  it('uses compact sider widths in flow', () => {
    expect(resolveShellLayout(BAND_XL).siderInFlow).toBe(SIDER_EXPANDED);
    expect(resolveShellLayout(BAND_LG).siderInFlow).toBe(SIDER_COLLAPSED);
    expect(resolveShellLayout(BAND_SM).siderInFlow).toBe(0);
  });
});

describe('boundedDockedHarnessWidth', () => {
  it('raises values below the dock floor up to the floor', () => {
    expect(boundedDockedHarnessWidth(320, 1920, SIDER_EXPANDED, 640)).toBe(HARNESS_DOCK_MIN);
    expect(boundedDockedHarnessWidth(200, 1440, SIDER_COLLAPSED, 360)).toBe(HARNESS_DOCK_MIN);
  });

  it('宽视口下保留用户拖出的宽度（含官方弹窗下限 760）', () => {
    // 1920 视口、菜单展开、工作台地板 640：roomMax = 1104，用户拖到弹窗下限不会被压回
    // （32% 时代这里只能到 512，弹窗必然排不开）。
    expect(boundedDockedHarnessWidth(HARNESS_DIALOG_MIN, 1920, SIDER_EXPANDED, SPLIT_MIN))
      .toBe(HARNESS_DIALOG_MIN);
    expect(boundedDockedHarnessWidth(400, 1920, SIDER_EXPANDED, SPLIT_MIN)).toBe(400);
  });

  it('caps a wide preference so an expanded menu still leaves a split workbench', () => {
    const width = boundedDockedHarnessWidth(900, 1536, SIDER_EXPANDED, 640);
    expect(1536 - SIDER_EXPANDED - width - CHROME).toBeGreaterThanOrEqual(640);
  });

  it('宽视口下停靠能到弹窗下限，同时不夺走工作台地板', () => {
    // 1600 视口 + 菜单展开：roomMax = 1600-160-SPLIT_MIN(640)-16 = 784 ≥ 760
    const width = boundedDockedHarnessWidth(HARNESS_DOCK_MAX, 1600, SIDER_EXPANDED, SPLIT_MIN);
    expect(width).toBeGreaterThanOrEqual(HARNESS_DIALOG_MIN);
    expect(1600 - SIDER_EXPANDED - width - CHROME).toBeGreaterThanOrEqual(SPLIT_MIN);
    // 窄一点儿的视口达不到弹窗下限——那时由面板扩宽兜底，而不是硬挤工作台
    const narrow = boundedDockedHarnessWidth(HARNESS_DOCK_MAX, 1440, SIDER_EXPANDED, SPLIT_MIN);
    expect(narrow).toBeLessThan(HARNESS_DIALOG_MIN);
    expect(1440 - SIDER_EXPANDED - narrow - CHROME).toBeGreaterThanOrEqual(SPLIT_MIN);
  });

  it('覆盖层在任何视口下都不低于弹窗下限（覆盖层是本期的兜底手段）', () => {
    for (const viewport of [1920, 1600, 1440, 1280, 1024]) {
      expect(overlayHarnessWidth(viewport)).toBeGreaterThanOrEqual(HARNESS_DIALOG_MIN);
    }
    // 视口本身不够时覆盖层也只能 100% 视口——那是「窗口太窄」提示负责的场景
    expect(overlayHarnessWidth(640)).toBe(640);
  });
});

describe('overlayHarnessWidth', () => {
  it('uses the full viewport when narrower than the overlay floor', () => {
    expect(overlayHarnessWidth(375)).toBe(375);
  });

  it('keeps overlay at least the overlay floor on tablet widths', () => {
    expect(overlayHarnessWidth(768)).toBeGreaterThanOrEqual(640);
  });

  it('clamps the measured sider width into the allowed range', () => {
    expect(clampSiderExpanded(120)).toBe(SIDER_EXPANDED_MIN);
    expect(clampSiderExpanded(200)).toBe(200);
    expect(clampSiderExpanded(999)).toBe(SIDER_EXPANDED_MAX);
    expect(clampSiderExpanded(Number.NaN)).toBe(SIDER_EXPANDED_MIN);
  });

  it('uses the language-measured width for the expanded sider in flow', () => {
    // 长语言（俄/德/越/泰）实测更宽；未传时保持中文基线的既有布局
    expect(resolveShellLayout(BAND_XL, { siderExpanded: 240 }).siderInFlow).toBe(240);
    expect(resolveShellLayout(BAND_XL).siderInFlow).toBe(SIDER_EXPANDED_MIN);
    // 折叠态与覆盖层不受影响
    expect(resolveShellLayout(BAND_MD, { siderExpanded: 240 }).siderInFlow).toBe(SIDER_COLLAPSED);
  });
});
