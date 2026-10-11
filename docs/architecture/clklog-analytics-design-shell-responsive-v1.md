# 实现方案：分析平台壳层多分辨率适配 v1

> phase: clklog-analytics-shell-responsive-v1
> 上游：`docs/product/prd-clklog-analytics-shell-responsive-v1.md`
> 本文件是档位阈值、槽位宽度、解析函数契约的 SSOT。

---

## 1. 阶段目标与范围

用**一个纯函数**根据 visual viewport 宽度算出壳层结构，`MainLayout` / `AiAssistantPanel` / `AnalysisWorkbench` 只消费结果，禁止再各写一套 960 / 800 / 42vw 判断。

## 2. 验收标准

与 PRD SH-1～SH-13 对应。自动化至少：

- `resolveShellLayout` 对架构 §4 表中每个档位代表宽度（1920、1440、1280、1024、768、375）的快照测试。
- 折叠顺序断言：不存在 `sider === 'expanded' && harness !== 'docked'`；不存在 `sider === 'expanded' && workbench === 'stack'`。
- `boundedDockedHarnessWidth`：输入低于停靠下限时返回下限（调用方应改为 undock，而不是用返回值画出更窄的栏）；输入超过「留下工作台下限后的剩余」时被截断。

## 3. 非目标

与 PRD §3 相同。解析器放 `apps/analytics-web/src/layouts/shell-layout.ts`（及同目录 spec），不新建 `common` / `utils` 包。

---

## 4. 常量（SSOT）

```
SIDER_EXPANDED      = 160   // 最长标签 + 图标/缩进 + 少量余量；禁止再回到 Ant Design 默认 208
SIDER_COLLAPSED     = 48    // 图标栏：16px 图标 + 两侧约 16px 空气；折叠 brand 为单字母 C
CHROME              = 16    // 内容区左侧内边距；Harness 贴边后不再预留 24+24 外边距（phase: clklog-analytics-ux-polish-v1）

WORKBENCH_RAIL      = 280
WORKBENCH_RESULT_MIN= 360   // 左右分栏时结果列下限（不再用 400 与停靠下限抢宽度）
SPLIT_MIN           = 640   // RAIL + RESULT_MIN
STACK_MIN           = 360   // 上下堆叠时工作台可用宽度下限

HARNESS_DOCK_MIN     = 400   // 对话可用；官方设置弹层不承诺在停靠态完整
HARNESS_DOCK_DEFAULT = 400
HARNESS_DOCK_MAX     = 560
HARNESS_DOCK_MAX_RATIO = 0.32
HARNESS_OVERLAY_MIN  = 640   // 覆盖层至少这么宽；视口更窄则 100vw
```

档位阈值（viewport CSS px，`window.visualViewport?.width ?? window.innerWidth`）：

```
XL = 1440   // 含 14 寸 Mac 默认缩放 1512：expanded + dock 400 + split
LG = 1280
MD = 1024
SM = 768
XS = 0      // < SM
```

命名：`xl: W ≥ 1440`，`lg: 1280 ≤ W < 1440`，`md: 1024 ≤ W < 1280`，`sm: 768 ≤ W < 1024`，`xs: W < 768`。

## 5. 解析算法

```
type SiderMode = 'expanded' | 'collapsed' | 'overlay'
type HarnessMode = 'docked' | 'collapsed' | 'overlay'
type WorkbenchMode = 'split' | 'stack'

function resolveShellLayout(W: number, opts?: { harnessUserOpen?: boolean }): {
  band: 'xl' | 'lg' | 'md' | 'sm' | 'xs'
  sider: SiderMode
  harness: HarnessMode
  workbench: WorkbenchMode
  siderInFlow: 160 | 48 | 0
  harnessInFlow: number  // 0 或 [HARNESS_DOCK_MIN, HARNESS_DOCK_MAX]
}
```

默认结构（`harnessUserOpen` 不影响 in-flow 停靠是否成立，只影响 collapsed 时是否显示覆盖层）：

1. `sider`：`W ≥ XL → expanded`；`W ≥ MD → collapsed`；否则 `overlay`。`siderInFlow` 对应 160 / 48 / 0。折叠态 brand 文案为 `C`（不是 `CLK`）。
2. 尝试停靠：`remainWithDock = W - siderInFlow - HARNESS_DOCK_MIN - CHROME`。
   - 若 `remainWithDock ≥ STACK_MIN`：`harness = 'docked'`，`harnessInFlow = clamp(userPref, DOCK_MIN, min(DOCK_MAX, 0.32*W, W - siderInFlow - workbenchFloor - CHROME))`（`workbenchFloor` 在 `sider === expanded` 时为 `SPLIT_MIN`，否则 `STACK_MIN`），`workbench = remainAfterActualDock ≥ SPLIT_MIN ? 'split' : 'stack'`。
   - 否则：`harness = 'collapsed'`，`harnessInFlow = 0`，`remain = W - siderInFlow - CHROME`，`workbench = remain ≥ SPLIT_MIN ? 'split' : 'stack'`。
3. 用户在 `harness === 'collapsed'` 时点开 AI：`harness` 对外展示为 `'overlay'`（fixed），宽度 `max(HARNESS_OVERLAY_MIN, min(W, 0.92*W))`，若 `W < HARNESS_OVERLAY_MIN` 则 `100vw`；**不**写回 `harnessInFlow`。
4. 用户在 xl/lg/md 用侧栏底栏按钮手动折叠/展开：只改 `userSider`，不改档位算法的 `siderInFlow` 计算源；折叠态菜单 `inlineCollapsed` + `triggerSubMenuAction=hover`，弹出层挂 `document.body`。Menu token `collapsedWidth` 必须等于 `SIDER_COLLAPSED`（48），否则选中底按 80px 绘制会被栏宽裁切、悬停层也对不齐。弹出层相对图标栏外侧留 8px 透明垫，不盖住选中方块。仅 `sider === 'overlay'`（sm/xs）时顶栏汉堡打开抽屉，不改变 `siderInFlow`。

折叠顺序由算法保证：先减小 `siderInFlow`（xl→lg 在 MD 以上已是 collapsed），再在 `remainWithDock < STACK_MIN` 时丢掉 dock。

### 5.1 代表宽度快照（实现与 QA 共用）

| W | band | sider | harness 默认 | workbench |
|---|------|-------|--------------|-----------|
| 1920 | xl | expanded | docked | split |
| 1600 | xl | expanded | docked | split |
| 1512 | xl | expanded | docked | split（14 寸 Mac 默认缩放；AI 默认 400） |
| 1440 | xl | expanded | docked | split |
| 1280 | lg | collapsed | docked | split（1280-48-400-16=816≥640） |
| 1100 | md | collapsed | docked | stack（1100-48-400-16=636<640） |
| 1024 | md | collapsed | docked | stack |
| 768 | sm | overlay | collapsed | split |
| 375 | xs | overlay | collapsed | stack |

14 寸笔记本（约 1512 CSS px）走 xl：菜单带文字、AI 默认 400px（可拖到 400～约 32vw）、SQL/分析主区吃剩余宽度。侧栏底栏始终有折叠钮（只要菜单在文档流内）。顶栏汉堡只在菜单完全进抽屉（sm/xs）时出现，避免和左侧图标栏叠两套按钮。折叠后靠悬停弹出子项，不靠第二颗汉堡。

## 6. 前端落点

| 文件 | 职责 |
|------|------|
| `layouts/shell-layout.ts` | 常量 + `resolveShellLayout` + `boundedDockedHarnessWidth` |
| `layouts/shell-layout.spec.ts` | §5.1 快照 + 折叠顺序 |
| `layouts/MainLayout.tsx` | 订阅 viewport，应用 sider 模式；底栏折叠钮 + 折叠悬停子菜单；仅 overlay 用抽屉；设置下挂项目选择与退出登录；非 overlay 不渲染顶栏 |
| `layouts/shell-menu.ts` | 设置里非路由项（项目选择、退出登录）的 key，避免 `navigate(key)` |
| `features/ai/AiAssistantPanel.tsx` | 只在 `harness==='docked'` 时占文档流；`overlay` 用 fixed；删除 `isAiFullscreen(W<960)` 与 `minWidth:320` / `maxWidth:42vw` |
| `features/ai/ai-panel-layout.ts` | 删除或改为 re-export 架构常量，避免第二份数字 |
| `features/query/analysis-workbench.css` | `split` / `stack` 由父级 data 属性或 class 驱动；**删除** `@container (max-width: 800px)` 作为主决策（可留作 stack 档的内部滚动） |
| 壳层 CSS | 菜单、顶栏、分段、步骤标题：`white-space: nowrap`；芯片组 `flex-wrap`；禁止 chrome 上 `word-break: break-all` |

`useViewportWidth` 读 visualViewport，debounce ≤ 100ms。

### 6.1 文字下限（我们的 DOM）

- 可点击芯片 / 分段项：`white-space: nowrap`，宽度由内容决定（`min-width: max-content` 或等价）。
- 单行标题：`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。
- 侧栏菜单项单行不换行（禁止竖字）；展开宽 160 须放下「事件属性面板」「API Key 管理」；超长才 ellipsis。
- 配置轨 `min-width: 280px` 仅在 `split` 时生效；`stack` 时 `width: 100%`，`max-height: min(42vh, 420px)`，保证结果仍可见，查询按钮可滚到。

### 6.2 与 AI 宽度偏好

persist 键可沿用 `clklog-ai-panel-layout-v1`，但写入前必须经 `boundedDockedHarnessWidth`。档位不允许 dock 时忽略该偏好的「展开停靠」，只保留「用户是否想开 AI」（覆盖层）。

## 7. 官方 Harness

iframe `width: 100%; height: 100%`。宿主承诺：docked 时宿主 ≥ `HARNESS_DOCK_MIN`（400）。不在 iframe 内改设置弹层。官方设置若在 400 宽仍竖字，用户可拖宽或收起后走覆盖层；停靠下限不得再降到 320。

## 8. 红线与门禁

- 不改社区版表、不改 Harness Web。
- 触达布局但棘轮不覆盖 CSS：PR 声明「门禁未自动检：壳层档位需按 SH-11 截图」。
- 本阶段不新增 `process.env` 读取。
