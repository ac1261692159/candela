/**
 * 展开宽度（下限）：容纳中文最长标签（数据质量 / API Key 管理 / 事件属性）+ 图标与 8px 余量。
 *
 * **多语言注意**：拉丁/西里尔/泰文标签普遍比中文长 30–100%，固定 160px 会把
 * 「Пользователи / Хронология пользователя / Управление данными」这类标签切掉。
 * 实际渲染宽度由 `useSiderWidth()` **按当前语言实测菜单标签**后给出（clamp 到
 * [SIDER_EXPANDED_MIN, SIDER_EXPANDED_MAX]）；这两个常量只定义区间与默认值，
 * 供纯函数解析器与快照测试使用。
 */
export const SIDER_EXPANDED_MIN = 160;
/** 展开宽度（上限）：再宽就明显挤占内容区（展开态只在 xl 档出现，见 siderModeForBand）。 */
export const SIDER_EXPANDED_MAX = 260;
/** 默认展开宽度 = 下限（中文基线，保持既有布局快照不变）。 */
export const SIDER_EXPANDED = SIDER_EXPANDED_MIN;

/** 把实测/估算的展开宽度夹到允许区间（非有限值回退下限）。 */
export function clampSiderExpanded(width: number): number {
  if (!Number.isFinite(width)) return SIDER_EXPANDED_MIN;
  return Math.max(SIDER_EXPANDED_MIN, Math.min(SIDER_EXPANDED_MAX, Math.round(width)));
}
/** 折叠：16px 图标 + 两侧约 16px 空气；antd `padding-inline: calc(50% - 8px)` 在 48 宽下刚好居中。 */
export const SIDER_COLLAPSED = 48;
export const CHROME = 16;

/** 侧栏在文档流中占的像素宽（展开态随语言实测变化，故为 number） */
export type SiderInFlow = number;

export const WORKBENCH_RAIL = 280;
export const WORKBENCH_RESULT_MIN = 360;
export const SPLIT_MIN = WORKBENCH_RAIL + WORKBENCH_RESULT_MIN;
export const STACK_MIN = 360;

/** 停靠下限：对话面可用（内容是聊天，400 下排版正常）。禁止再降到 320。 */
export const HARNESS_DOCK_MIN = 400;
export const HARNESS_DOCK_DEFAULT = 400;
/**
 * 停靠上限。放宽到 800 是为了让宽视口**在停靠态也能容纳官方设置弹窗**（需 ≥760，
 * 实测表见 `prd-clklog-analytics-ai-panel-surface-v1.md` §3）；窄一点儿的视口达不到时
 * 由弹窗下限触发扩宽。工作台仍由 `roomMax` 保住地板宽度。
 */
export const HARNESS_DOCK_MAX = 800;
export const HARNESS_DOCK_MAX_RATIO = 0.5;
/**
 * 第三方弹窗面下限：官方设置弹窗要 ≥760 才让**全部**说明文字各占一行
 * （更窄时较长的说明会折成两行、再窄会逐字断行成竖排）。
 * 判据取「最长的那条说明」，不能只看第一条——640 只够最短的那条，这是实测修正过的值。
 * 当前面比它窄且官方弹层打开时，面板必须离开文档流走覆盖层，而不是继续挤。
 */
export const HARNESS_DIALOG_MIN = 760;
export const HARNESS_OVERLAY_MIN = 640;

export const BAND_XL = 1440;
export const BAND_LG = 1280;
export const BAND_MD = 1024;
export const BAND_SM = 768;

export type ShellBand = 'xl' | 'lg' | 'md' | 'sm' | 'xs';
export type SiderMode = 'expanded' | 'collapsed' | 'overlay';
export type HarnessMode = 'docked' | 'collapsed' | 'overlay';
export type WorkbenchMode = 'split' | 'stack';

export interface ShellLayout {
  band: ShellBand;
  sider: SiderMode;
  harness: HarnessMode;
  workbench: WorkbenchMode;
  siderInFlow: SiderInFlow;
  harnessInFlow: number;
  canDock: boolean;
}

export interface ResolveShellLayoutOptions {
  widthPref?: number;
  /** 当前语言的侧栏展开宽度（由 `useSiderWidth()` 实测）；缺省为中文基线 160 */
  siderExpanded?: number;
  /** 用户是否占用停靠位；不能停靠时忽略，由 UI 改走覆盖层。默认 true。 */
  occupyDock?: boolean;
}

export function shellBand(viewportWidth: number): ShellBand {
  if (viewportWidth >= BAND_XL) return 'xl';
  if (viewportWidth >= BAND_LG) return 'lg';
  if (viewportWidth >= BAND_MD) return 'md';
  if (viewportWidth >= BAND_SM) return 'sm';
  return 'xs';
}

export function siderModeForBand(band: ShellBand): SiderMode {
  if (band === 'xl') return 'expanded';
  if (band === 'lg' || band === 'md') return 'collapsed';
  return 'overlay';
}

export function siderInFlowWidth(
  sider: SiderMode,
  expandedWidth: number = SIDER_EXPANDED_MIN,
): SiderInFlow {
  if (sider === 'expanded') return clampSiderExpanded(expandedWidth);
  if (sider === 'collapsed') return SIDER_COLLAPSED;
  return 0;
}

/**
 * 停靠宽度夹紧。低于下限仍返回下限，调用方应改为 undock。
 * 展开菜单时工作台地板用 SPLIT_MIN，避免「菜单展开 + 工作台堆叠」。
 */
export function boundedDockedHarnessWidth(
  value: number,
  viewportWidth: number,
  siderInFlow: number,
  workbenchFloor: number = STACK_MIN,
): number {
  const roomMax = viewportWidth - siderInFlow - workbenchFloor - CHROME;
  const maxByRatio = Math.floor(viewportWidth * HARNESS_DOCK_MAX_RATIO);
  const max = Math.max(
    HARNESS_DOCK_MIN,
    Math.min(HARNESS_DOCK_MAX, maxByRatio, roomMax),
  );
  return Math.max(HARNESS_DOCK_MIN, Math.min(max, Math.round(value)));
}

export function overlayHarnessWidth(viewportWidth: number): number {
  if (viewportWidth < HARNESS_OVERLAY_MIN) return Math.round(viewportWidth);
  return Math.max(HARNESS_OVERLAY_MIN, Math.min(viewportWidth, Math.floor(viewportWidth * 0.92)));
}

export function resolveShellLayout(
  viewportWidth: number,
  opts: ResolveShellLayoutOptions = {},
): ShellLayout {
  const occupyDock = opts.occupyDock ?? true;
  const widthPref = opts.widthPref ?? HARNESS_DOCK_DEFAULT;
  const band = shellBand(viewportWidth);
  const sider = siderModeForBand(band);
  const siderInFlow = siderInFlowWidth(sider, opts.siderExpanded);
  const remainWithDock = viewportWidth - siderInFlow - HARNESS_DOCK_MIN - CHROME;
  const canDock = remainWithDock >= STACK_MIN;
  const docking = canDock && occupyDock;
  const workbenchFloor = sider === 'expanded' ? SPLIT_MIN : STACK_MIN;

  if (docking) {
    const harnessInFlow = boundedDockedHarnessWidth(
      widthPref,
      viewportWidth,
      siderInFlow,
      workbenchFloor,
    );
    const remain = viewportWidth - siderInFlow - harnessInFlow - CHROME;
    return {
      band,
      sider,
      harness: 'docked',
      workbench: remain >= SPLIT_MIN ? 'split' : 'stack',
      siderInFlow,
      harnessInFlow,
      canDock,
    };
  }

  const remain = viewportWidth - siderInFlow - CHROME;
  return {
    band,
    sider,
    harness: 'collapsed',
    workbench: remain >= SPLIT_MIN ? 'split' : 'stack',
    siderInFlow,
    harnessInFlow: 0,
    canDock,
  };
}
