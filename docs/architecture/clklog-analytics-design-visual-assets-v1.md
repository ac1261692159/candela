# 视觉资产实现方案（BrandLogo / EmptyState / Favicon）

> phase: clklog-analytics-visual-assets-v1
> 版本：v1.0（2026-09-11）
> 上游：`docs/product/design-visual-assets-clklog-analytics-v1.md`（产品帽，P0 批次）
> 本文档回答：P0 视觉资产如何稳定实现与验证。

---

## 0. 门禁要素

- **phase**：`clklog-analytics-visual-assets-v1`
- **阶段目标与范围**：为分析平台前端补齐视觉资产——P0 批次（A1 主 Logo、A2 Favicon、B1 登录页品牌区、E1 看板空状态、E2 分析无数据空状态）已完成并验收；本阶段扩展完成 **P1 批次**（D 实体类型 icon 体系、E3 SQL 空状态、E4 元事件空状态、E5 分群/标签空状态），沉淀 `BrandLogo` / `EmptyState` / `EntityIcon` 三个可复用组件。
- **验收标准**：见 §8。
- **非目标（本 phase 不做）**：
  - 不做 P2 批次（B2 登录背景、C1/C2 头像与项目切换 icon、F1/F2 错误页、F3 骨架屏），列入后续 phase。
  - **C3/G1（AI 助手标识）经代码核查，现状已用 `RobotOutlined` 线性图标满足"克制、不玩具化"要求，本次不新增资产。**
  - 不引入任何位图资源（favicon 除外）；不引入新 npm 依赖。
  - 不改动布局结构、路由与既有组件交互逻辑，仅替换/增强视觉呈现。
  - 不改变 antd 主题 token 与全局组件外观，视觉资产自带色板常量。
  - 不生成"插画式"装饰图；空状态与 Logo 均为线性几何 SVG，遵守 PRODUCT.md Anti-references。

---

## 1. 现状与接入点（代码事实）

| 接入点 | 现状 | 改造 |
|---|---|---|
| `src/layouts/MainLayout.tsx` §`ShellChrome` | 品牌区展开 `<span>ClkLog 分析</span>`；折叠 `<button>C + DownOutlined</button>` | 展开用 `<BrandLogo variant="full" />`；折叠用 `<BrandLogo variant="mark" />`（按钮保留展开语义） |
| `src/pages/LoginPage.tsx` | `Card title={<Typography.Title level={4}>ClkLog 分析平台</Typography.Title>}`，灰底 `#f5f5f5` | title 替换为品牌组合标 + 一句产品语 |
| `index.html` | 无 favicon，`<title>ClkLog 分析平台</title>` | 加 `<link rel="icon">` 指向 `/sa/favicon.svg` |
| `src/features/explore-charts/ExploreChart.tsx` §31 | `<Empty description="暂无数据" />`（分析无数据，E2） | 替换为 `<EmptyState variant="analysis" />` |
| 看板列表空状态（E1） | `src/pages/Report/DashboardListPage.tsx` 两处 `Table.locale.emptyText` 为纯文本 | 替换为 `<EmptyState variant="dashboard" />`；列表视图带新建 CTA，文件夹内为空用覆盖文案 |
| `vite.config.ts` | `base: '/sa/'`；`public/` 目录存在（空） | favicon 源文件放 `public/favicon.svg`，引用路径带 `/sa/` 前缀 |

## 2. 目录与文件

```
apps/analytics-web/
├── public/favicon.svg                    # A2（蓝底白标，32×32 viewBox）
├── index.html                            # + <link rel="icon">
└── src/
    ├── styles/tokens.ts                  # A3 色板常量（P0 先落最小集）
    ├── components/
    │   ├── BrandLogo.tsx                 # A1 图形标/组合标
    │   ├── BrandLogo.spec.tsx
    │   ├── EmptyState.tsx                # E1/E2 空状态（内联 SVG 插画）
    │   └── EmptyState.spec.tsx
    └── features/
        ├── explore-charts/ExploreChart.tsx   # E2 接入
        └── pages/Report/...                  # E1 接入（按实际定位）
```

不新增图片文件：Logo 与插画全部内联 SVG React 组件（跟随色板 token，无硬编码色值）。

## 3. 色板常量（`src/styles/tokens.ts`）

```ts
export const BRAND_PRIMARY = '#1677FF';      // 主色/强调色
export const BRAND_TEXT = '#1F2329';          // 主文字
export const BRAND_TEXT_SECONDARY = '#646A73';// 次级文字
export const BRAND_BORDER = '#E5E6EB';        // 边框/坐标轴
export const BRAND_ILLUS_LIGHT = '#C9CDD4';   // 插画虚线轮廓
export const BRAND_ILLUS_GRID = '#F2F3F5';    // 插画网格
```

## 4. 组件契约

### 4.1 `BrandLogo`

```ts
export type BrandLogoVariant = 'mark' | 'full';
export interface BrandLogoProps {
  variant?: BrandLogoVariant;   // 'mark' 仅图形标；'full' 图形标 + "ClkLog" 字标
  size?: number;                // 图形标边长 px，默认 24；'full' 时文字随 size 缩放
  color?: string;               // 图形标颜色，默认 BRAND_PRIMARY
  className?: string;
  'aria-label'?: string;        // 折叠态按钮语义由调用方给出
}
```

- `mark`：渲染 24×24 viewBox 的图形标 SVG（字母 C 弧线 + 三根上升柱状）。
- `full`：`display:inline-flex; align-items:center; gap:8px` 的图形标 + `ClkLog` 文本（`font-weight:600`，继承品牌色文本），`size` 同时控制图形标边长与字号（`size*0.75`）。
- 图形标路径（viewBox 0 0 24 24，`stroke="currentColor"` 实现换色）：

```
C 弧线:  M 18.2 5.8  A 7.8 7.8 0 1 0 18.2 18.2   （stroke-width 2, linecap round, fill none）
柱 1:    rect x=7.2  y=13.2  w=2.6 h=4.0  rx=1     fill
柱 2:    rect x=10.7 y=10.4  w=2.6 h=6.8  rx=1     fill
柱 3:    rect x=14.2 y=7.6   w=2.6 h=9.6  rx=1     fill
```

### 4.2 `EmptyState`

```ts
export type EmptyStateVariant = 'dashboard' | 'analysis' | 'sql' | 'meta' | 'cohort' | 'tag';
export interface EmptyStateProps {
  variant: EmptyStateVariant;   // 决定插画与默认文案
  title?: string | null;        // 覆盖默认主文案；null 隐藏主文案行（仅插画 + 说明）
  description?: string;         // 覆盖默认说明
  action?: ReactNode;           // CTA 插槽（按钮/链接）
  className?: string;
}
```

- 内部封装 antd `Empty`：`image` 为内联 SVG 插画（240×160 viewBox），`description` 为 `title + description`，`children` 渲染 `action`。
- 插画（`empty-chart`，全 variant 共用，文案区分）矢量结构：

```
网格:     10 条竖线（x=48…192，步长 16）+ 5 条横线（y=44…108，步长 16）（BRAND_ILLUS_GRID，1px）
坐标系:   x 轴 M40 116 L200 116；y 轴 M40 116 L40 32（BRAND_BORDER，1.5px）
虚线柱:   4 根 rect（x=52/88/124/160，y=88/70/52/34，h=28/46/64/82，w=20，rx=3，
          stroke BRAND_ILLUS_LIGHT 1.5px，dasharray 4 3，fill none）
虚线折线: M52 88 L88 70 L124 52 L160 34（BRAND_PRIMARY 2px，dasharray 5 3）
强调点:   circle cx=160 cy=34 r=4（BRAND_PRIMARY）
```

- 默认文案与 CTA：
  - `dashboard`：title "还没有看板"，description "创建第一个看板，沉淀你的分析结论"，action 由调用方传。
  - `analysis`：title "当前时间范围内暂无数据"，description "调整时间范围或检查埋点上报后重试"。
  - `sql`：title "查询无结果"，description "检查筛选条件或时间范围后重试"。
  - `meta`：title "尚未发现上报事件"，description "接入 SDK 并上报后，事件将自动发现"。
  - `cohort`：title "还没有用户分群"，description "创建第一个分群，开始圈选目标用户"。
  - `tag`：title "还没有用户标签"，description "规则标签创建后自动计算并沉淀成员"。

- **三分析页未查询引导态（本次新增接入）**：事件/漏斗/留存三个分析页在「未点击查询」时结果区为空白，按 `EmptyState variant="analysis" title={null} description="在左侧配置…后点击"查询"查看结果"` 接入（`EventAnalysisResult` / `FunnelResult` / `RetentionResult` 的 `!result` 分支），实现"中间插画、下面配字"。
- **查询失败态（三处统一）**：`!result && error` 时先显示红色错误文本（`Typography.Text type="danger"`），再回落引导态；error 分别取自 `useAnalysisStore` / `useFunnelStore` / `useRetentionStore`，避免用户把「查询失败」误读成「还没查询」。

### 4.3 Favicon（A2）

`public/favicon.svg`（32×32 viewBox，蓝底白标）：

```
rect 0 0 32 32 rx=7  fill BRAND_PRIMARY
C 弧线:  M 21.5 9.8  A 8.4 8.4 0 1 0 21.5 22.2  stroke #fff 2.4 round
柱 1:    rect x=10.4 y=17.2 w=3 h=4.4 rx=1 fill #fff
柱 2:    rect x=14.6 y=14.4 w=3 h=7.2 rx=1 fill #fff
柱 3:    rect x=18.8 y=11.6 w=3 h=10  rx=1 fill #fff
```

`index.html`：`<link rel="icon" type="image/svg+xml" href="/sa/favicon.svg" />`（vite `base=/sa/` 不变，public 复制到 dist 根，路径带前缀）。

### 4.4 `EntityIcon`（P1，D 实体类型 icon 体系）

```ts
export type EntityIconType =
  | 'event' | 'virtual-event' | 'event-property' | 'user-property'
  | 'metric' | 'dashboard' | 'card' | 'cohort' | 'tag' | 'subject' | 'api-key';
export interface EntityIconProps {
  type: EntityIconType;
  size?: number;            // 默认 14（表格行内尺寸）
  style?: CSSProperties;    // 颜色等透传，默认继承 currentColor
}
```

单一分发组件，内部映射 `@ant-design/icons`（不新增依赖，不散落 import）：

| type | icon |
|---|---|
| `event` | `ThunderboltOutlined` |
| `virtual-event` | `FundOutlined`（事件子类区分） |
| `event-property` | `TagsOutlined` |
| `user-property` | `IdcardOutlined` |
| `metric` | `CalculatorOutlined` |
| `dashboard` | `DashboardOutlined` |
| `card` | `AppstoreOutlined` |
| `cohort` | `FilterOutlined` |
| `tag` | `TagOutlined` |
| `subject` | `ClusterOutlined` |
| `api-key` | `KeyOutlined` |

接入点（行内名称前加 icon，语义区分实体类型）：

| 文件 | 接入 |
|---|---|
| `src/features/meta/EventList.tsx` | 事件名 `event`；`event_type=virtual` 用 `virtual-event` |
| `src/features/report/DataDictionaryPanel.tsx` | 事件节点 `event`、属性节点 `event-property`/`user-property`（字段数据类型 icon 保留） |
| `src/pages/Analysis/UserCohortsPage.tsx` | 分群名 `cohort` |
| `src/pages/Analysis/UserTagsPage.tsx` | 标签名 `tag` |
| `src/pages/Analysis/AnalysisSubjectsPage.tsx` | 主体名 `subject` |
| `src/pages/Meta/SavedMetricsPage.tsx` | 指标名 `metric` |
| `src/pages/Settings/ApiKeysPage.tsx` | API Key 名 `api-key` |

## 5. 接入点改造清单

| 文件 | 改动 |
|---|---|
| `index.html` | `<head>` 加 favicon link |
| `MainLayout.tsx` | 品牌区展开/折叠两态替换为 `BrandLogo`；折叠态保持 button 语义（aria-label="展开菜单"） |
| `LoginPage.tsx` | `Card` title 改为 `<BrandLogo variant="full" size={28} />` + 副语"可信的用户行为分析"（`Typography.Text` type secondary）；背景保持 `#f5f5f5` 不引渐变 |
| `ExploreChart.tsx` | "暂无数据" Empty → `<EmptyState variant="analysis" />` |
| `FunnelExploreChart.tsx` / `CardWidget.tsx` | 同类「暂无数据」→ `<EmptyState variant="analysis" />`，与 `ExploreChart` 同款（避免同类场景两种空态） |
| `DashboardListPage.tsx` | 列表视图空态 → `<EmptyState variant="dashboard" action={新建看板按钮} />`；文件夹内为空用覆盖文案 |
| `QueryResultPanel.tsx`（P1/E3） | 两处 Empty → `<EmptyState variant="sql" />`；「缓存为空」与「条件无数据」用 `title`/`description` 覆盖区分；"执行 SQL 后查看表格和图表"初始引导处覆盖文案为"执行 SQL 后展示查询结果" |
| `EventList.tsx`（P1/E4/D） | 事件名加 `EntityIcon`（virtual 区分）；Table 空态 → `<EmptyState variant="meta" />` |
| `UserCohortsPage.tsx`（P1/E5/D） | 分群名加 `EntityIcon type="cohort"`；空态 → `<EmptyState variant="cohort" action={新建分群按钮} />` |
| `UserTagsPage.tsx`（P1/E5/D） | 标签名加 `EntityIcon type="tag"`；空态 → `<EmptyState variant="tag" />` |
| `AnalysisSubjectsPage.tsx`（P1/D） | 主体名加 `EntityIcon type="subject"` |
| `SavedMetricsPage.tsx`（P1/D） | 指标名加 `EntityIcon type="metric"` |
| `ApiKeysPage.tsx`（P1/D） | API Key 名加 `EntityIcon type="api-key"` |
| `DataDictionaryPanel.tsx`（P1/D） | 事件/属性节点加 `EntityIcon`（字段类型 icon 保留） |

## 6. 测试方案

文件头 `// @vitest-environment jsdom`，用 `@testing-library/react` + `userEvent`：

- `BrandLogo.spec.tsx`
  - `mark` 渲染 SVG（`role="img"` 或容器查询），`full` 含 "ClkLog" 文本；
  - `size`/`color` prop 正确应用（查询 style/attribute）；
  - `aria-label` 透传。
- `EmptyState.spec.tsx`
  - `dashboard`/`analysis` 默认文案渲染；
  - `title`/`description` 覆盖生效；
  - `action` 渲染且点击回调触发（`user.click` + `vi.fn`）。
- `EntityIcon.spec.tsx`
  - 11 种实体类型都能渲染出图标；
  - `size` / `style` 覆盖生效；
  - `virtual-event` 与 `event` 图标不同（虚拟事件可区分）。

## 7. 验证

1. `npm run build`（`tsc -b && vite build`）通过——生产构建含 favicon 复制与 `/sa/` 路径。
2. `npm test -- --run`（或仓库现有测试命令）新增 2 个 spec 通过，既有测试不回归。
3. 棘轮：`python3 scripts/arch_ratchet.py` 通过（前端 `src/` 行数/文件数受控，无新增 env 读取）。
4. 人工检查：本地 `npm run dev` 下品牌区、登录页、空状态渲染符合"数据感"基线。

## 8. 验收标准

- [ ] 品牌区展开显示组合标、折叠显示图形标，折叠态仍可点击展开（语义与交互不变）。
- [ ] 登录页出现品牌组合标 + 产品语，无渐变/无高饱和。
- [ ] 浏览器标签页出现 favicon（`/sa/favicon.svg` 可访问）。
- [ ] 事件分析无数据与看板空状态为定制插画 + 行动引导，非 antd 默认图。
- [ ] **P1**：`EntityIcon` 在事件/字典/分群/标签/主体/指标/API Key 列表可读，单一分发无散落 import。
- [ ] **P1**：SQL 无结果、元事件、分群、标签空状态为定制插画 + 引导文案。
- [ ] 新增 spec 通过；`npm run build` 与棘轮检查通过。
- [ ] 无新增位图文件（favicon 除外）、无新增依赖、无 `process.env` 读取。

## 9. 风险与边界

- **favicon 兼容性**：SVG favicon 在 Chrome/Firefox/Edge 支持良好；Safari 旧版本可能不显示，B 端内部工具可接受，不做 PNG 兜底（避免位图资源）。
- **品牌区替换不改变布局**：保持 `shell-sider__brand` 现有 height 48px 与折叠逻辑，仅替换内容节点。
- **空状态 CTA 跳转**：看板创建入口以现有路由为准，E1 接入时若创建入口不明确，先给"返回看板列表"类安全 CTA，不新增路由。
