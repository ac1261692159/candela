# 实现方案：事件分析序号 / 金额聚合 / 看板与壳层 UX

> phase: clklog-analytics-ux-polish-v1
> 帽子：架构（`docs/architecture/`）
> 上游：`docs/product/prd-clklog-analytics-ux-polish-v1.md`

---

## 1. 阶段目标与范围

对应 PRD 五项。DSL 路径、ClickHouse 表、社区版链路不变。数值聚合仍走现有 `JSONExtractFloat` / `toFloat64OrZero` 路径；看板新增一列开关。

## 2. 验收标准

- [ ] **ARCH-UX-1**：`EventMetricEditor` 事件卡与公式卡都用列表下标 `index+1` 作为序号；单测锁定「两事件 + 公式 + 事件 → 1,2,3,4」。
- [ ] **ARCH-UX-2**：`methodAllowedForDataType` 对 `sum/avg/max/min/per_capita_num/percentile/variance/stddev` 允许 `number` 与 `string`。SQL 对 string 声明属性解析为 Float 并 `toFloat64OrZero(toString(...))`。前端 `methodsForDataType('string')` 含上述数值方法。布尔/列表/datetime 规则不变。
- [ ] **ARCH-UX-3**：`Dashboard.show_card_type` Boolean 默认 `false`；`PUT` 看板可改；`DashboardGrid` 只按该字段决定是否渲染类型 Tag。`.grafana-panel-header` 背景 `#fff`，无 `border-bottom`。
- [ ] **ARCH-UX-4**：`ResultResizePane` 一个按钮：未顶满为「展开结果」，已顶满为「收起结果」。
- [ ] **ARCH-UX-5**：`MainLayout` 内容行 `overflow: hidden`。`.shell-page` 可滚但 `scrollbar-width: none` / `::-webkit-scrollbar { display: none }`，页面不出现最外层滚动条。停靠 Harness `margin: 0`、直角贴右。`CHROME` 为 16。SQL 页高度 `100%`。
- [ ] **ARCH-UX-6**：`python3 scripts/arch_ratchet.py` 通过；不向 `shared/` / `utils` 加生产文件。

## 3. 非目标

与 PRD §3 相同。不改 Prisma `Card` 列。禁止伪模块包。

## 4. 契约

### 4.1 数值方法 × 属性类型

| analysis | 原允许 | 现允许 |
|----------|--------|--------|
| sum / avg / max / min / per_capita_num / percentile / variance / stddev | number | number, string |
| distinct / is_empty / is_not_empty | 任意 | 不变 |
| true_num / false_num | boolean | 不变 |
| array_* | list | 不变 |

string 做数值聚合时：`resolve(..., 'number')` 得到 `JSONExtractFloat`（或物化列），再包 `toFloat64OrZero(toString(attr))`。非数字 → 0。过滤/分组仍按声明类型（string 仍 `JSONExtractString`）。

### 4.2 看板

`Dashboard.show_card_type`：`BOOLEAN NOT NULL DEFAULT false`。

`CreateDashboardDto` / `UpdateDashboardDto` 可选 `show_card_type?: boolean`。详情与分享接口带回该字段。

### 4.3 壳层常量修订

相对 `clklog-analytics-design-shell-responsive-v1.md`：`CHROME = 16`（Harness 贴边后不再预留 24+24 外边距）。档位阈值与停靠上下限不变。

### 4.4 文件

| 路径 | 职责 |
|------|------|
| `event-metric-editor/EventMetricEditor.tsx` | 序号 |
| `query/metric-normalize.ts`、`event-sql-generator.service.ts` | 类型放行与 SQL |
| `event-metric-editor/analysis-methods.ts` | 前端方法列表 |
| `prisma/schema.prisma` + migrate | `show_card_type` |
| `DashboardGrid.tsx` / `DashboardSettingsDrawer.tsx` | 白底与开关 |
| `ResultResizePane.tsx` | 单按钮 |
| `MainLayout.tsx` / `AiAssistantPanel.tsx` / `shell-layout.ts` | 贴边与外层滚动 |

## 5. 迁移

Prisma migrate：`ALTER TABLE dashboard ADD COLUMN show_card_type BOOLEAN NOT NULL DEFAULT false`。发版走 `prisma migrate deploy`。

---

## 6. 增补（2026-09-11）：列表编辑态、卡片缓存可见性与菜单悬停

### 6.1 阶段目标与范围

同批交付三件事：看板卡片外观（灰底、去边框）、看板列表与分析卡片列表的「默认只读 + 编辑态」、分析卡片列表的缓存可见性、侧栏菜单悬停展开。

范围：`apps/analytics-web/src/pages/Report/`、`apps/analytics-web/src/features/report/`、`apps/analytics-web/src/layouts/`，以及 `apps/analytics-server/src/modules/report/` 的列表读取路径。不改 TTL 语义、不改 worker 刷新策略、不做数据库结构变更。

### 6.2 验收标准

- [ ] **ARCH-UXP-1**：两个列表默认不渲染「操作」列；看板列表的「转移路径」列同样默认不渲染。点「编辑」进入编辑态后出现列，点「完成」弹确认框。
- [ ] **ARCH-UXP-2**：确认框点「保存」写库并退出编辑态；点「取消」丢弃草稿并退出编辑态（不写库）。看板列表的转移路径改动在保存前只存在于前端草稿，取消后列表回到原值。
- [ ] **ARCH-UXP-3**：两个列表的名称常态黑色、鼠标悬停变蓝（`pages/Report/asset-list.css` 的 `.asset-name`）。
- [ ] **ARCH-UXP-4**：`GET /sa/api/report/cards` 每项附带 `cache_summary`；分析卡片列表展示「查询缓存」（有效 / 已过期 / 查询失败 / 无缓存）与「上次查询」（相对时长），不再单列创建时间与更新时间，二者改为悬停「类型」标签的 Tooltip。
- [ ] **ARCH-UXP-5**：列表接口不返回 `result_json`，只取缓存行的 `error` / `refreshed_at`。
- [ ] **ARCH-UXP-6**：侧栏菜单板块默认折叠，悬停可同时展开多个板块，鼠标移出菜单时只折叠非选中板块。
- [ ] **ARCH-UXP-7**：`python3 scripts/arch_ratchet.py` 通过；前后端 `tsc --noEmit` 通过。

### 6.3 契约

`GET /sa/api/report/cards` 响应项新增 `cache_summary`（**总是返回对象**，无缓存行时字段取下表默认值）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `has_cache` | boolean | `cardcache` 中是否存在该卡的行 |
| `stale` | boolean | 按引用看板中最小的 `cache_ttl_sec` 判定（无引用看板时用 `DEFAULT_CACHE_TTL_SEC`），与后台温热同一规则 `cacheIsStale` |
| `refreshed_at` | string \| null | ISO 时间；无缓存行时为 `null` |
| `error` | string \| null | 最近一次刷新失败原因 |

详情接口 `GET /sa/api/report/cards/:cardId` 的 `cache`（含 `result`）契约不变——列表刻意不搬运 `result_json`（LongText）。

### 6.4 文件

| 路径 | 职责 |
|------|------|
| `pages/Report/DashboardListPage.tsx` | 编辑态、转移路径草稿（保存才写库） |
| `pages/Report/AnalysisCardsPage.tsx` | 编辑态、缓存列、相对时间格式化 |
| `pages/Report/asset-list.css` | 名称悬停样式（两页共用） |
| `layouts/MainLayout.tsx`、`layouts/shell-sider.css` | 菜单悬停展开、Outlet memo 化 |
| `features/report/DashboardGrid.tsx`、`CardWidget.tsx` | 灰底、去边框、标题与按钮悬停 |
| `card-cache.policy.ts` | `summarizeCache` 纯函数 |
| `card.repository.ts`、`card.service.ts` | 列表透出 `cache_summary` |

### 6.5 非目标

不引入编辑态通用框架；不做卡片缓存手动失效按钮；不改变 TTL 语义与 worker 刷新策略；不在列表预览缓存结果体。
