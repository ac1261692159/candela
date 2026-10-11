# 架构：AI 面板的两种面（对话面 vs 第三方弹窗面）

> phase: clklog-analytics-ai-panel-surface-v1
> 帽子：架构（`docs/architecture/`）
> 产品：[PRD](../product/prd-clklog-analytics-ai-panel-surface-v1.md)
> 相关：`docs/architecture/templates/AGENTS_front.md` §1/§2/§3、`docs/architecture/clklog-analytics-design-shell-layout.md`（壳层解析器）

---

## 1. 阶段目标、范围与验收

数字与判据仍然只住在 `apps/analytics-web/src/layouts/shell-layout.ts`（红线 §1）；本期新增一个上限常量、一个开关、一条消息类型，不改官方套件。验收对齐 PRD SC-1～SC-8。

## 2. 面模型

| 面 | 触发 | 宽度 | 用途 |
|---|---|---|---|
| 停靠 docked | 视口够宽且用户想打开 | `boundedDockedHarnessWidth`（400–800，且不侵犯工作台地板） | 边聊边看结果 |
| 覆盖 overlay | 不能停靠、用户手动扩宽、**官方弹窗打开且当前面 < 640** | `overlayHarnessWidth`（视口 <640 时 100%，否则 92%） | 需要宽度的临时场景 |
| 收起 collapsed | 用户收起 | — | — |

**判据常量**：

```ts
/** 对话面可用下限（内容为聊天，排版在 400 下正常）。禁止再降到 320。 */
export const HARNESS_DOCK_MIN = 400;
/** 第三方弹窗面下限：官方设置弹窗需 ≥760 才能让**全部**说明各占一行（PRD §3 严格口径表）。 */
export const HARNESS_DIALOG_MIN = 760;
export const HARNESS_DOCK_MAX = 800;          // 原 560：让宽视口在停靠态也能容纳弹窗
export const HARNESS_DOCK_MAX_RATIO = 0.5;    // 原 0.32
```

停靠上限放宽**不会**挤压工作台：`boundedDockedHarnessWidth` 里 `roomMax = viewport - sider - workbenchFloor - CHROME` 仍在，返回值始终 ≤ roomMax。

## 3. 状态机（谁在什么时候切换）

```
docked ──用户点「扩宽」──────────────→ overlay            （手动，最高优先）
docked ──收到 dialog{open:true} 且 宽度<760 ─→ overlay     （自动，记 promotedByDialog=true）
overlay(promotedByDialog) ──收到 dialog{open:false}──→ docked（还原原宽度）
overlay(手动) ──用户点「收回」──────→ docked
```

规则：

1. **手动优先**：任何手动切换都把 `promotedByDialog` 清掉，自动逻辑不再回拉；
2. **不打扰**：面板宽度已 ≥ `HARNESS_DIALOG_MIN`（用户拖宽或本来就在覆盖层）时，`dialog{open:true}` 不做任何事；1600 视口下停靠最多到 784（roomMax 夹紧），因此宽视口可以完全不切换；
3. **还原保真**：自动还原只复位「面」，宽度用的是 store 里原样的 `width`，因此停靠宽度与滚动位置不变，iframe 不重挂载 → **会话不重建**（PRD SC-2）；
4. 面板处于收起态时忽略 dialog 消息（没人在看）。

## 4. 消息契约（`clklog:harness-dialog`）

官方弹窗在 sandbox iframe 内，父页面读不到其 DOM。我们的代理**已经**往 Harness 文档 `<head>` 注入 browserShim（`harness-web-proxy.service.ts#browserShim`，且已有 `clklog:harness-ready` / `clklog:harness-unauthorized` 两条上行消息），本期沿用它加一条：

```js
// 由 shim 在 Harness 文档内运行：官方弹层开合 → 通知宿主
{ type: 'clklog:harness-dialog', runtime_id: R, open: true | false }
```

- 采集方式：`MutationObserver` 观察 `documentElement`（`childList + subtree`，外加 `role` / `aria-modal` 属性变化），判据 `document.querySelector('[role="dialog"],[aria-modal="true"]')`；
- **不观察 `class`**：class 变化太频繁，会变成噪声源；
- 去重：状态不变不发消息；
- 宿主侧校验：`event.source === iframe.contentWindow`（既有检查）＋ `runtime_id` 形如 `air_…`（与 ready 一致），过期运行时的消息直接丢。

## 5. 宿主侧接线

| 位置 | 改动 |
|---|---|
| `useHarnessConnection(frame, source, tabId, options?)` | 新增可选 `onDialogChange`；用 ref 持有回调，**不参与 effect 依赖**（避免因回调变化重启连接与重连计时器） |
| `AiAssistantPanel` | 用 `onDialogChange` 实现 §3 状态机；头部常驻「扩宽/收回」；覆盖层且 `promotedByDialog` 时显示一行说明 |
| `AiChatPanel` 宽度偏好迁移 | `migrateDockWidth` 的阈值从硬编码 640 改为 `HARNESS_DOCK_MAX`：旧迁移本意是清历史脏数据，但在新上限下 640–720 是合法宽度，不能再被拉回默认 |

## 6. 与红线的对齐

| 红线条款 | 本期如何满足 |
|---|---|
| §1「装不下就换结构，不继续挤」 | 弹窗面不够宽 → 换面（覆盖层），不压窄容器 |
| §2「低于下限 → 离开文档流，会话尽量不销毁」 | `HARNESS_DIALOG_MIN` 是「弹窗面下限」，低于即走覆盖层；iframe 不重挂载 |
| §2「夹紧函数低于下限仍返回下限，调用方必须 undock」 | 停靠宽度仍由 `boundedDockedHarnessWidth` 夹紧；弹窗由本期的面板级逻辑 undock，不改夹紧函数语义 |
| §2「persist 偏好写入前必须夹紧」 | `migrateDockWidth` 随上限同步，写入前仍经夹紧 |
| §2「覆盖层 position:fixed，不占文档流」 | 复用既有覆盖层实现，未改 |
| §3「中文被压成竖字」 | 本期正是消除这条的具体形态（且给出可量的验收：说明文字行数 = 1） |

## 7. 度量与验证方法

沿用本期摸底用的那套尺子，作为回归手段可复现：

1. 顶层打开助手页（测试手法，非产品功能），`setViewportSize` 扫描 900/800/760/720/680/640/600/560；
2. 量**每一条** `[class*="_desc"]` 的宽度与行数（行高 18px，取最大行数）、`[role="dialog"]` 宽度；
3. **判据**：宽度 ≥ 760 时**全部**说明文字必须各占 1 行（取最长的那条——曾经只看第一条得出 640，上线后被发现不够）。

产品内的验收（不依赖上面那套）：在真实面板里打开官方设置，从父页面量 iframe 宽度（应 ≥640）并截图；关闭后量宽度应回到原值，且不出现重连提示。

## 8. 风险

- **官方弹层的判据可能变化**：dsh 若改用非 `role="dialog"` 的自绘浮层，观察器会漏报。兜底是手动开关（SC-3），不依赖自动通道也能用；后续可在 shim 里扩判据。
- **自动扩宽可能让用户「懵一下」**：用一行说明解释原因（PRD 流程 §2），并且关闭即还原。
- **停靠上限放宽**：会把工作台压到地板宽度（`SPLIT_MIN`/`STACK_MIN`），这是用户主动拖拽的结果，默认宽度不变（400）。
