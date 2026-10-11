# 实现方案：事件分析图表字段绑定与显示优化（v1）

- phase: `clklog-analytics-event-chart-binding-v1`
- 帽子：架构（`docs/architecture/`）
- 对应 PRD：`docs/product/prd-clklog-analytics-event-chart-binding-v1.md`
- 上游 SSOT：`docs/architecture/clklog-analytics-design-charts-v1.md`（`ChartConfigV1` 契约）、`docs/architecture/clklog-analytics-design-i18n-v1.md`（结果列元信息）、`docs/architecture/clklog-analytics-design-result-settings-v1.md`（`dsl._view`）
- 状态：待评审

---

## 0. 执行入口

改动按 §15 的 7 个切片顺序落地，每个切片可独立合并、独立回滚。任一切片完成后运行 §16 的验证命令。

先读：

| 要说清什么 | 读哪篇 |
|---|---|
| `ChartConfigV1` 的字段与约束（本 phase 复用，不重定义） | `docs/architecture/clklog-analytics-design-charts-v1.md` §6.3、§10 |
| 事件结果列今天有哪些字段、怎么装配 | `docs/architecture/clklog-analytics-design-i18n-v1.md` §14.3-14.4 |
| 事件侧展示偏好今天存在哪 | `docs/architecture/clklog-analytics-design-result-settings-v1.md` |
| 单位白名单与格式化 | `docs/architecture/clklog-analytics-design-chart-units-v1.md` |
| 代码架构硬门禁（文件数/行数/包边界） | `AGENTS.md`「系统代码架构硬门禁」、`docs/architecture/code-hard-gates.md` |

---

## 1. 阶段目标与范围（程序门禁要素①）

### 1.1 目标

让事件分析的图表拥有与自定义 SQL 同级的**字段级显示控制**，并修掉三个具体的显示缺陷：

1. **多指标量级差异**：支持把指标分配到左/右两条 Y 轴，并在量级差异明显时主动建议拆分。
2. **多分组列被丢弃**：支持选择 X 轴与「拆分系列」，让第二个及以后的分组列能上图。
3. **长维度标签**：X 轴标签按分类数与长度自动旋转/截断，不被容器裁切，悬停可见全文。

同时把事件侧的展示配置从无 schema 的 `dsl._view` 收敛到**与 SQL 卡同一份** `dsl.chart_config: ChartConfigV1`。

### 1.2 代码范围

| 层 | 文件 |
|---|---|
| Server 列契约 | `apps/analytics-server/src/modules/query/event-query.service.ts` |
| Server 图表配置校验 | `apps/analytics-server/src/modules/report/chart-config.validator.ts` |
| Server 卡片持久化 | `apps/analytics-server/src/modules/report/card.service.ts` |
| Web 列类型 | `apps/analytics-web/src/types/dsl.types.ts` |
| Web 图表配置类型/校验 | `apps/analytics-web/src/features/visualization/chart.types.ts`、`chart.constants.ts`、`chart-config.ts` |
| Web 字段面板 | `apps/analytics-web/src/features/visualization/FieldBindingPanel.tsx`（泛化，不新增文件） |
| Web 渲染 | `apps/analytics-web/src/features/explore-charts/explore-chart-option.ts` |
| Web 结果区 | `apps/analytics-web/src/features/query/EventAnalysisResult.tsx`、`EventViewSettings.tsx` |
| Web 看板 | `apps/analytics-web/src/features/report/CardWidget.tsx` |
| Web 新增包 | `apps/analytics-web/src/features/event-chart/`（新建，见 §9） |
| i18n | `apps/analytics-web/src/i18n/locales/*/analysis.json`（13 语言） |

### 1.3 不变边界

1. **查询语义不变**：`EventAnalysisQuery`（`apps/analytics-server/src/types/dsl.types.ts:153-165`）一个字段都不动；本 phase 不产生任何新查询路径。
2. **SQL 侧行为不变**：`parseChartConfigV1` 在 `domain='sql'` 下与今天逐字节等价；SQL 卡不出现新字段。
3. **漏斗 / 留存不变**：`funnel-display.ts`、`retention-trend.ts` 不动。
4. **红线**：本 phase 不触碰 ClickHouse 表、容器、Puppet 模板与数据链路（`AGENTS.md` 绝对红线 1/2/6 不适用，PR 声明「不适用」即可）。

---

## 2. 验收标准（程序门禁要素②）

| # | 验收项 | 核对方式 |
|---|---|---|
| AC1 | `/sa/api/query/event` 响应每列带 `role`，取值对「时间分组 / 属性分组 / 指标」三类正确 | `event-query.service.spec.ts` 覆盖 §6.1 判定表全部分支 |
| AC2 | 结果区「展示」弹层新增「字段」区，含 X 轴 / 拆分系列 / 指标 / 列角色 / 每指标轴 / 每指标单位 | 浏览器实测截图（§16.2） |
| AC3 | 至少一个指标设为右轴时出现两条 Y 轴，各按所属指标单位格式化；全部左轴时不产生 `yAxis` 数组 | `explore-chart-option.spec.ts` + 浏览器实测 |
| AC4 | 指标最大值比值 ≥ 50 时出现拆分建议；点「应用」才写配置，不点则图表与配置均不变 | `axis-suggest.spec.ts` + 浏览器实测（对比点击前后 `dsl.chart_config`） |
| AC5 | 长维度标签不重叠、不出界，悬停显示完整原文 | 浏览器实测（`channel_name` 分组） |
| AC6 | 改绑定**不触发** `/sa/api/query/event` 请求 | 浏览器 Network 面板实测 |
| AC7 | 保存卡片 → 刷新 → 重开，绑定与轴归属复现；看板同卡片复现 | 浏览器实测 |
| AC8 | 无 `chart_config` 的旧卡：图形与改造前一致（系列集合、轴数量、边距不变） | 改造前后截图比对（AC10 in PRD）；**唯一允许的差异见 §18.2** |
| AC9 | 拆分系列按维度取值透视；同一 (X, 系列) 多行按求和合并并给出界面说明 | `event-binding.spec.ts` |
| AC10 | 服务端 `parseChartConfigV1(input, 'event')` 接受 `stack/cumulative/distribution` 且拒绝 `funnel`；`domain='sql'` 行为不变 | `chart-config.validator.spec.ts` |
| AC11 | `python3 scripts/i18n_check.py`、`python3 scripts/i18n_scan.py --check` 通过，13 语言新键齐全 | 命令输出 |
| AC12 | `python3 scripts/arch_ratchet.py` 通过：无新增超标目录、无新增超长文件、`process.env` 读取处数不增 | 命令输出 |
| AC13 | 浏览器切换语言后 `<html lang>`、页面标题与「字段」区文案正确、无源语言残留 | 浏览器实测（`?lang=en-US` 覆盖入口） |

---

## 3. 非目标（程序门禁要素③）

1. **不收敛 option builder**。事件侧继续走 `features/explore-charts/explore-chart-option.ts`，不迁移到 `features/visualization/adapters/*`。理由见 §5.2。
2. **不新增图表类型**。事件侧仍是 8 种（`EventChartType`）；不引入 SQL 侧的 `bar` 横向 / `donut`。
3. **不做 dataZoom**。分类数过多时的缩放留到下一版。
4. **不做「按指标重取 TopN」**。结果集抽样仍由左侧查询配置决定；展示层的排序/截断只在已返回行内生效。
5. **不改漏斗 / 留存 / SQL 卡的任何展示行为**。
6. **不修 `features/visualization → features/explore-charts` 的既有依赖倒挂**（见 §13.3），本 phase 只保证不加剧。
7. **不给事件侧做自动图表推荐**（SQL 侧的 `chart-recommender` 不在本 phase 接入）。

---

## 4. 现状与差距

### 4.1 两条展示链路的对照

| | 事件分析 | 自定义 SQL |
|---|---|---|
| 配置对象 | 无（`dsl._view` 散文式 5 个字段） | `dsl.chart_config: ChartConfigV1` |
| 列角色 | 靠 `g_` / `m_` 前缀猜（`explore-chart-option.ts:81-87`） | 前端按 ClickHouse type + 别名正则 + SQL 解析推断 |
| X 轴 | 固定 = `groups[0]`（`:102`） | `bindings.x` 用户选 |
| 系列 | 指标列各一条（`:105-108`） | `bindings.series` 用户选（透视） |
| 第二分组列 `g_1` | **丢弃** | N/A |
| Y 轴 | 单条，全局一个单位 | 单条，`options.units` **每指标**一个单位 |
| 双轴 | 不支持 | 不支持 |
| 轴标签 | `hideOverlap` + 时间格式化（`:265-268`） | 旋转/截断只在柱状与漏斗里各自实现 |
| 持久化校验 | 无（`dsl` 是自由 JSON） | 前后端双份白名单（`chart-config.validator.ts`） |

差距可以归成三句：**列语义没有表达出来**（全靠前缀猜）、**绑定没有出口**（写死）、**契约不一致**（一套有一份没有）。

### 4.2 事件侧其实比 SQL 侧更有条件做好

SQL 侧的列角色是**推断**出来的——列名来自用户 SQL 别名，不可预测，所以需要 `column-profiler.ts` 拿 ClickHouse type、样本值、别名正则、甚至解析 SQL 的 SELECT 列表来猜，还带 `confidence`。

事件侧不需要猜：`EventAnalysisQuery.groups[i]` 与结果列 `g_i` 一一对应，`groups[i].scope === 'time'` 就说明这列是时间。**服务端知道答案，就应该由服务端下发**，而不是让前端用中文标题去启发式判断（今天 `DataTable` 判时间列就是读 `title` 里的「时间(day)」，i18n-v1 §14.3 已把这记为遗留问题）。

这是本方案与「照抄 SQL 侧」最关键的一处差别，也是把 `role` 放在服务端而不是前端的理由。

### 4.3 既有问题（本 phase 顺带修掉的）

`modelFromEventResult`（`explore-chart-option.ts:95-111`）在多分组时只取 `groups[0]`，`g_1…` 的值**已经在返回的行里**却完全不上图。这不是设计取舍，是遗漏。本 phase 通过「拆分系列」把这条数据接回来。

---

## 5. 总体架构与选型

### 5.1 三条路线

| 路线 | 做法 | 判断 |
|---|---|---|
| **A. 全量收敛** | 事件分析整体接入 `resolveVisualization` + adapters，删掉 `explore-charts` | ❌ 需新增 `stack/cumulative/distribution` 三个 adapter，迁移 `__stage` 行、`value_map` 列、`_rate` 列、`stat_calcs`、`y_unit` 语义，改看板分流。改动面接近重写，风险与本 phase 的用户价值不成比例 |
| **B. 事件侧自建 `EventChartConfigV1`** | 给事件侧单开一份配置对象 | ❌ 制造第二套持久化图表配置格式，与 `charts-v1` §10「唯一持久化图表配置，不存在第二套字段/option 权威」直接冲突 |
| **C. 统一契约 + 保留渲染器（**采用**）** | 事件侧复用 `ChartConfigV1` 与同一份前后端校验；新增一个纯函数翻译层把 `(列, 行, config)` 变成 `ExploreChartModel`；渲染仍走 `explore-charts` | ✅ 不产生第二套格式；痛点改动集中在可控范围；`__stage` / `value_map` / `_rate` 语义零风险 |

### 5.2 为什么保留两套渲染器

事件侧有 8 种图型，其中 `stack` / `cumulative` / `distribution` 三种在 SQL 侧不存在对应 adapter。收敛渲染器意味着先补齐 3 个 adapter 并验证 6 个既有 adapter 在事件数据形状下的等价性——这是一次独立重构，应当单独排期、单独验收，不能塞进一个以「修显示」为目标的 phase。

**代价必须明说**：本 phase 结束后，双轴能力只在事件侧生效；SQL 侧要双轴需 phase 2。两条 option builder 的并存期被本方案**延长**了，这是有意识的取舍。

### 5.3 目标架构

```
┌──────────────────────────── 事件分析结果区 ────────────────────────────┐
│                                                                        │
│  /sa/api/query/event 响应                                              │
│      columns[{ key, role, title, unit, ... }]   ← role 由服务端新增下发 │
│      rows[]                                                            │
│           │                                                            │
│           ▼                                                            │
│  ┌──────────────────────────┐      ┌──────────────────────────────┐    │
│  │ features/event-chart/    │      │ 字段面板（展示齿轮内）        │    │
│  │  event-chart-config.ts   │◀────▶│  features/visualization/     │    │
│  │   读/合成/写             │      │  FieldBindingPanel（泛化）    │    │
│  │   ChartConfigV1          │      │   columns: BindingColumn[]   │    │
│  │  event-binding.ts        │      └──────────────────────────────┘    │
│  │   透视 + 绑定 → model    │                                          │
│  │  axis-suggest.ts         │──── 建议（不自动写）                     │
│  └───────────┬──────────────┘                                          │
│              │ ExploreChartModel{ categories, series[{axis,unit}], … } │
│              ▼                                                         │
│  features/explore-charts/ExploreChart → buildExploreOption             │
│      双轴 / 标签策略 / 单位                                            │
└────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼ dsl.chart_config: ChartConfigV1
         卡片持久化（与 SQL 卡同字段、同校验器，domain='event'）
```

关键点：

- **`role` 上行**：服务端下发，前端不再猜。
- **`chart_config` 下行**：与 SQL 卡同名字段、同形状，服务端用同一份 `parseChartConfigV1` 但按 `domain` 收窄图型白名单。
- **翻译层是纯函数**：`(columns, rows, config) → ExploreChartModel`，无 React、无副作用，可直接单测。这层是本 phase 的复杂核心，必须落在新包里，不许塞进 `EventAnalysisResult.tsx`。

---

## 6. 契约

### 6.1 事件结果列角色（新增）

`apps/analytics-server/src/modules/query/event-query.service.ts:22-45`：

```ts
export type EventColumnRole = 'time' | 'dimension' | 'metric';

export interface EventAnalysisColumn {
  key: string;
  /** 列角色：由服务端按查询定义确定，不由列名前缀或标题推断 */
  role: EventColumnRole;
  title: string;
  title_key?: string;
  title_params?: Record<string, unknown>;
  unit?: 'number' | 'duration_sec' | 'percent';
  value_map?: Record<string, string>;
  value_map_title?: string;
  value_map_stats?: { sampled: number; matched: number; truncated?: boolean };
}
```

判定规则（在 `formatResult()`，`event-query.service.ts:220-247` 内装配）：

| 列 key | 条件 | `role` |
|---|---|---|
| `m_*` | 恒成立（含公式指标；`hidden` 的指标照旧不产生列） | `metric` |
| `g_i` | `query.groups[i].scope === 'time'` 且 `granularity !== 'total'` | `time` |
| `g_i` | 其余：`scope === 'time'` 且 `granularity === 'total'`、`scope ∈ {event, user, cohort, tag}` | `dimension` |

`granularity === 'total'` 归 `dimension` 是刻意的：那个分组的取值恒为单个汇总值，不是时间轴。

`__stage` 是**行**标记（`row.__stage === true`），不是列，不受影响。

**前端类型**（`apps/analytics-web/src/types/dsl.types.ts:205-231` 的 `QueryColumn`）新增可选字段：

```ts
/** 列角色；事件结果必给，漏斗/留存未给。缺失时回退 g_/m_ 前缀判定 */
role?: 'time' | 'dimension' | 'metric';
```

可选而非必填：同一个 `QueryColumn` 也用于漏斗与留存结果。**读取顺序恒为「`role` 优先，缺失回退前缀」**，这样旧服务端缓存的结果不会炸。

### 6.2 `ChartConfigV1` 扩展（前后端同步）

`ChartOptions` 新增两个可选字段。**不新增根键**，`ROOT_KEYS` 与 `roles` / `bindings` 的形状完全不动。

```ts
export interface ChartOptions {
  // …既有字段不变…

  /**
   * 指标轴归属。未列出的指标走左轴。
   * 仅当至少一个指标为 'right' 时才渲染第二条轴。
   */
  metric_axis?: Record<string, 'left' | 'right'>;

  /**
   * X 轴标签策略。null 或缺失 = 由前端按分类数与标签长度自动决定（§7.4）。
   * 显式给出时以用户值为准。
   */
  x_label?: {
    rotate: number | null;      // 0..90
    max_width: number | null;   // 24..400，null = 不截断
  } | null;
}
```

约束（追加到 `charts-v1` §6.3 的约束列表）：

- `metric_axis` 的 key 必须是本次结果中真实存在的 `metric` 列；值只能是 `'left'` / `'right'`。
- `x_label.rotate` 取值 0..90；`x_label.max_width` 取值 24..400。
- 两个字段的序列化增量不得使 `chart_config` 超过既有的 32 KiB 上限。

### 6.3 图型白名单按域收窄

今天 `chart-config.validator.ts:5` 的 `CHART_TYPES` 是单集合，且**不含** `stack/cumulative/distribution`。直接复用会让事件侧保存被拒。做法是给校验器加域参数，而不是放宽集合：

```ts
const CHART_TYPES_SQL = new Set(['table', 'number', 'line', 'bar', 'pie', 'funnel', 'trend']);
const CHART_TYPES_EVENT = new Set([
  'table', 'number', 'line', 'bar', 'pie', 'trend',
  'stack', 'cumulative', 'distribution',
]);

export function parseChartConfigV1(
  input: unknown,
  domain: 'sql' | 'event' = 'sql',
): ChartConfigV1;
```

`domain` 缺省 `'sql'`，保证既有 SQL 调用点**零改动、零行为变更**（AC10）。`domain='event'` 时 `funnel` 被拒——事件侧没有漏斗图型（漏斗分析是独立页面）。

前端 `chart.constants.ts` 同步加 `EVENT_CHART_TYPES`，供面板在保存前自检。

### 6.4 新增兼容 issue code

追加到 `ChartIssueCode`（`chart.types.ts:140-164`）：

| code | 触发 | 严重级 |
|---|---|---|
| `AXIS_SPLIT_SUGGESTED` | 指标量级差异 ≥ 阈值且当前为单轴 | `info` |
| `SERIES_DIMENSION_UNUSED` | 结果里还有未绑定的 `time`/`dimension` 列 | `info` |
| `SERIES_CELL_COLLAPSED` | 拆分系列时同一 (X, 系列) 命中多行，已求和合并 | `warning` |
| `SERIES_LIMIT_EXCEEDED` | 透视产生的线数超过图型上限，已截断 | `warning` |
| `STALE_BINDING` | `chart_config` 引用了不存在的列 | `error` |

`STALE_BINDING` 与既有 `STALE_CONFIG` 的区别：后者是 schema/版本问题，前者是列引用失效。两个都出现时以 `STALE_CONFIG` 优先。

---

## 7. 算法

### 7.1 自动绑定（无 `chart_config` 时合成）

旧卡没有 `chart_config`。读取时**动态合成**一份 `mode: 'auto'` 的配置，**不写回**（避免「打开一次卡片就静默改写用户数据」）：

```
输入：columns（含 role，缺失回退 g_/m_ 前缀）、rows、_view（可选）

1. 可用列 = columns.filter(role !== 'ignored' && key !== 'cohort_date')
2. x = 第一个 role==='time' 的列
     ?? 第一个 role==='dimension' 的列
     ?? 可用列[0]        // 与改造前的 columns[0] 回退一致；见下方说明
3. metrics = 可用列.filter(role === 'metric')     // 保列序
4. series  = undefined                            // 关键：自动绑定不设拆分系列
5. units[m]：
     若 _view.y_unit 存在且 ≠ 'number' → _view.y_unit     // 用户显式设过「整张图的单位」，尊重它
     否则按列推导：'percent' → 'ratio_0_1'
                   'duration_sec' → 'duration_sec'
                   key 以 '_rate' 结尾 → 'ratio_0_1'
                   其余 → 'number'
6. metric_axis = {}                               // 全部左轴
7. top_n = undefined（不截断）
```

**第 4 步是刻意的**：不做「自动把 `g_1` 当拆分系列」。自动改变既有卡片的图形属于静默改写（PRD R10 / AC8）。发现路径改为给一条 `SERIES_DIMENSION_UNUSED` 提示，由用户主动选择。

**第 2 步的 `?? 可用列[0]` 也是刻意的**（2026-09-23 线上验收补回）：无分组的「数值」卡
（`chart_type='number'` + `groups=[]`）结果里只有指标列，`ExploreChart` 在 `categories` 为空时
渲染「当前时间范围内暂无数据」。改造前 `x = groups[0] ?? columns[0]` 正好兜住了这种卡片；
实现时漏掉这一层，线上 69 张卡片里有 2 张变成空态。回退到第一列即恢复改造前行为
（数值卡的图只画 series，X 轴取什么不影响显示）。

**第 5 步的分支是刻意的**：`_view.y_unit` 缺省恒为 `'number'`，它只有非缺省时才携带用户意图。
缺省时按列推导，时长 / 比率指标能各自正确格式化；显式设过时整张图沿用用户的选择（旧卡表现不变）。

### 7.2 系列透视

翻译层的核心。输入去掉了 `__stage` 行的结果，输出 `ExploreChartModel`。

```
输入：rows（已去 __stage）、columns、config.bindings、config.options

分支 A — 无 bindings.series：
  categories = rows.map(r => text(r[bindings.x]))
  series     = bindings.metrics.map(k => ({
                 name:  localizedTitle(k),
                 values: rows.map(r => asNumber(r[k])),
                 unit:  options.units[k] ?? 'number',
                 axis:  options.metric_axis?.[k] ?? 'left',
               }))

分支 B — 有 bindings.series：
  categories   = rows 按 bindings.x 取值，首次出现顺序去重
  seriesValues = rows 按 bindings.series 取值，首次出现顺序去重
  cell[(sv, cat)] += value            // 同一 (x, series) 多行 → 求和
                                      // 命中多行时置 collapsed = true
  series = 对每个 metric k × 每个 seriesValue sv：
             name   = metrics.length > 1 ? `${sv} · ${localizedTitle(k)}` : sv
             values = categories.map(c => cell[(sv, c)] ?? null)
             其余字段同分支 A

截断：线数上限 MAX_LINE_SERIES = 5 / MAX_BAR_SERIES = 4（对齐 SQL 侧 `chart.constants.ts:11` `LINE_MAX_SERIES`、`:15` `BAR_MAX_METRICS`）
      超出按「跨 category 求和」降序取前 N，其余不画，出 SERIES_LIMIT_EXCEEDED
      —— 不合成「其他」系列（对折线求和语义上不成立）
```

两点必须写进实现注释：

1. **`(x, series)` 组合通常唯一**——它对应 `g_0` / `g_1` 两个分组键的组合。出现多行说明结果里还有 `g_2` 等未绑定的分组列，此时求和是唯一不丢数的降级，但要出 `SERIES_CELL_COLLAPSED` 让用户知道该收敛分组。
2. **求和只对 additive 指标正确**。`per_capita_*` 这类人均值求和没有业务含义——这正是要出 warning 而不是静默处理的原因。

X 轴排序：

| X 列角色 | 行为 |
|---|---|
| `time` | 走既有 `sortModelByTime`（升序）+ `formatTimeAxisLabel` 标签格式化 |
| `dimension` | 保持服务端返回顺序（TopN 已按指标降序），标签走原文，不格式化 |

### 7.3 双轴建议

纯函数，落在新包（`features/event-chart/axis-suggest.ts`）。**只产出建议，不写配置**。

```
AXIS_SPLIT_RATIO = 50     // 常量，落 chart.constants.ts

suggestAxisSplit(series) -> Record<string, 'left'|'right'> | null
  1. scales = series.map(s => max(|s.values 的有限值|)).filter(v => v > 0)
  2. scales.length < 2 → null
  3. sorted = scales 升序
  4. gaps[i] = sorted[i+1] / sorted[i]
  5. i* = argmax(gaps)；gaps[i*] < AXIS_SPLIT_RATIO → null
  6. 返回：scales[0..i*] 对应的系列 → 'right'，其余 → 'left'
```

用「相邻比值最大处」而非「中位数分界」，是为了在指标数多于 3 时找**真正的断层**，而不是机械对半分。

对 PRD 截图的数据验证：三个指标最大值为 `[98, 190.214, 18641]`，相邻比值 `[1.94, 98.0]`，最大比值 98.0 ≥ 50 → 切在 `190.214 | 18641` 之间 → 消耗用户数、消耗均值_人均 走右轴，消耗总量 走左轴。符合预期。

三个量级相近的指标（比值 ≈ 1）不触发；单指标不触发。

### 7.4 X 轴标签策略

```
resolveXLabel(categories, override?) -> { rotate, max_width }
  传入 override（config.options.x_label）且有非 null 值时直接采用
  否则：
    n = categories.length
    L = max(各分类字符串长度)
    n <= 6  && L <= 10 → { rotate: 0,  max_width: null }
    n <= 10            → { rotate: 0,  max_width: 96 }
    n <= 20            → { rotate: 30, max_width: 96 }
    否则                → { rotate: 45, max_width: 88 }
```

ECharts 侧：

- `xAxis.axisLabel`：`{ rotate, width: max_width, overflow: 'truncate', hideOverlap: true, formatter }`
- `formatter` 分流：`role === 'time'` 的 X 轴走既有 `formatTimeAxisLabel`（时间标签本身短，不截断）；维度轴走原文（`mappedText` 的结果）。
- `grid.containLabel: true` 已存在（`explore-chart-option.ts:260`），保留——这是「不被裁切」的一半保证。
- 完整值的可读性由 `tooltip.trigger: 'axis'` 的表头提供（ECharts 在 axis 触发下用完整 `axisValue` 作表头，不受 `axisLabel` 截断影响）。**实现时须实测确认**，若默认行为不符则用 `tooltip.formatter` 补。

---

## 8. 渲染改造（`explore-charts`）

### 8.1 模型扩展

`explore-chart-option.ts:21-30`：

```ts
export interface ExploreSeries {
  name: string;
  values: Array<number | null>;
  /** 走哪条 Y 轴；缺省 left。仅当至少一条为 right 时启用双轴 */
  axis?: 'left' | 'right';
  /** 该系列的单位；缺省取 model 全局 */
  unit?: MetricUnit;
}

export interface ExploreChartModel {
  categories: string[];
  series: ExploreSeries[];
  percent?: boolean;
  /** X 轴标签策略；缺省自动（§7.4） */
  xLabel?: { rotate: number | null; max_width: number | null } | null;
  /** X 轴是否为时间列；决定标签格式化与排序语义 */
  timeAxis?: boolean;
}
```

把轴与单位挂在 **series 上**而不是加参数，是为了让 `buildExploreOption` 保持「只认 model」的签名的同时拿到所需信息——四个调用方（`ExploreChart`、看板、留存、漏斗）都不需要改签名。

### 8.2 `buildExploreOption` 改动

`explore-chart-option.ts:193-284`：

1. **双轴**
   - `hasRight = working.series.some(s => s.axis === 'right')`
   - `hasRight` 时 `yAxis = [yAxisWithUnit(leftUnit), yAxisWithUnit(rightUnit)]`，每条 series 加 `yAxisIndex`
   - `leftUnit` = 第一条左轴系列的 `unit ?? 全局 unit`；`rightUnit` 同理由右轴系列取
   - `grid.right` 从 `16` 提到 `48`（给右轴刻度标签留位）；单轴时保持 `16`（AC8 逐像素一致的前提）
   - `yAxis` 单轴时仍是**对象**而非单元素数组——ECharts 两者都接受，但保持对象能让旧截图逐像素一致

2. **标签**
   - `resolveXLabel(working.categories, model.xLabel)` 决定 `rotate` / `width` / `overflow`
   - `formatter` 按 `model.timeAxis` 分流

3. **tooltip 单位**
   - 现签名是单 `unit` 闭包（`:256-258`）。改为按系列名查 `series.unit`，查不到回退全局 `unit`
   - 单轴且所有系列同单位时行为与今天一致

**不改的**：`pie` / `distribution` / `cumulative` / `stack` 的既有分支、`markPoint` / `markLine`、`EXPLORE_COLORS`、`connectNulls` 规则。

### 8.3 单位与轴的缺省推导

新函数（放新包 `event-chart-config.ts`）：

```
defaultUnitForColumn(col) :
  col.unit === 'percent'       → 'ratio_0_1'
  col.unit === 'duration_sec'  → 'duration_sec'
  col.key.endsWith('_rate')    → 'ratio_0_1'
  model.percent                → 'ratio_0_1'
  否则                          → 'number'
```

`_view.y_unit` 的迁移路径：只在**没有 `chart_config.options.units`** 时作为全部指标的缺省值注入（§7.1 第 5 步）。用户一旦改过任一指标的单位，整个 `units` 表随 `chart_config` 落库，`_view.y_unit` 不再参与。

---

## 9. UI 与组件边界

### 9.1 新增包 `features/event-chart/`

`apps/analytics-web/src/features/query/` 已有 **29 个生产文件**（上限 30），`features/visualization/` 有 **27 个**（80% 线是 24，两者都已在线上）。**本 phase 不得向这两个目录新增文件**（硬门禁 A.1）。

新增语义窄包 `apps/analytics-web/src/features/event-chart/`：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `index.ts` | 桶导出 | — |
| `event-chart-config.ts` | 读 / 合成 / 写 `ChartConfigV1`；`defaultUnitForColumn`；列 → `BindingColumn` 映射 | `visualization/chart.types`、`visualization/chart-config` |
| `event-binding.ts` | `(columns, rows, config) → ExploreChartModel`；透视、截断、issue 产出 | `explore-charts`（只依赖类型与 `sortModelByTime`）、`event-chart-config` |
| `axis-suggest.ts` | `suggestAxisSplit` 纯函数 | `chart.constants`、`chart.types` |

依赖方向：`event-chart → {visualization, explore-charts}`，**方向不可逆**。

`axis-suggest.ts` 放这里而非 `visualization/`：SQL 侧双轴是 phase 2，届时**先拆 `features/visualization/`**（其生产文件数已越 80% 线），再把本文件迁移过去。现在放进 `visualization/` 会让那个目录直接跑到 28 个文件，把结构债继续养大。

### 9.2 `FieldBindingPanel` 泛化（改文件，不加文件）

`apps/analytics-web/src/features/visualization/FieldBindingPanel.tsx`（499 行）今天吃 `profiles: ColumnProfile[]`。`ColumnProfile` 带 `confidence` / `reasons` / `clickhouseType`——事件侧这些**都不存在也不该伪造**（伪造 confidence 是脏数据）。

改为吃一层中性抽象：

```ts
export interface BindingColumn {
  key: string;
  label: string;
  role: ColumnRole;          // 'time' | 'dimension' | 'metric' | 'ignored'
  /** 附加展示信息；SQL 侧 = clickhouseType，事件侧留空 */
  typeLabel?: string;
}
```

调用侧适配：

- SQL 侧调用点把 `profiles` 映射成 `BindingColumn[]`（`typeLabel = clickhouseType`），行为不变。
- 事件侧直接由 `EventAnalysisColumn[]` 映射（`typeLabel` 留空）。

再给面板加一个 `scope: 'sql' | 'event'`（或等价的布尔能力位），控制区块显隐：

| 区块 | SQL | 事件 |
|---|---|---|
| 列角色 | ✅ | ✅ |
| 时间轴 / X 轴 | ✅（文案「时间轴」） | ✅（文案「X 轴」，候选含维度） |
| 系列 / 拆分系列 | ✅ | ✅ |
| 指标 | ✅ | ✅ |
| 单位（每指标） | ✅ | ✅ |
| 轴归属（左/右） | 隐藏（phase 2） | ✅ |
| 排序指标 / TopN | ✅ | 隐藏（§3 非目标 4） |
| 分组行 / 漏斗 / 预测点数 / 阈值线 | ✅ | 隐藏 |

**不加新文件、不改 `features/visualization/` 的文件数**，符合硬门禁 A.4「新公共能力落语义窄包」——面板本体留在原处做泛化，事件专属逻辑（配置合成与透视）才进新包。

### 9.3 状态所有权

| 状态 | 所有者 | 说明 |
|---|---|---|
| `chart_config` | `EventAnalysisResult.tsx`（`useState`，与今天 `view/chartType/...` 同级） | 单一写入方 |
| `_view`（展示方式 / 图表类型 / 统计值 / 时长） | 同上，**保留不动** | 这四项不是列绑定，不进 `chart_config` |
| 建议条显隐 | 同上，派生自 `chart_config` + 结果 + 是否已忽略该建议 | 不进持久化 |

`_view` 与 `chart_config` 的分工必须写清：**`_view` 管「怎么展示」，`chart_config` 管「展示什么」**。不做 `_view` → `chart_config` 的整体搬迁，避免把无关字段拖进契约。

---

## 10. 持久化与 API 兼容

### 10.1 存储位置

事件卡 `dsl_json` 追加一个可选键（SQL 卡同名字段）：

```json
{
  "event": "$pageview",
  "metrics": [ … ],
  "groups": [ … ],
  "time_range": { … },
  "_view": { "event_layout": "both", "event_chart": "line", "y_unit": "number" },
  "_form": { … },
  "chart_config": {
    "schema_version": 1,
    "recommendation_version": 1,
    "mode": "manual",
    "preferred_view": "chart",
    "chart_type": "line",
    "roles": { "g_0": "dimension", "m_0": "metric", "m_1": "metric", "m_2": "metric" },
    "bindings": { "x": "g_0", "metrics": ["m_0", "m_1", "m_2"], "ignored": [] },
    "options": {
      "orientation": "vertical",
      "donut": false,
      "include_other": false,
      "units": { "m_0": "number", "m_1": "number", "m_2": "number" },
      "aggregation": {},
      "metric_axis": { "m_1": "right", "m_2": "right" }
    }
  }
}
```

注意 `bindings` 的 key 是**列 key**（`g_0` / `m_0`），不是列标题——与 SQL 侧一致，且列标题会随语言变化（i18n-v1 §14.3），不能作为稳定标识。

### 10.2 服务端校验

`apps/analytics-server/src/modules/report/card.service.ts:132`（create）与 `:149`（update）是 `dsl` 的落库点。在这两处之前插入：

```
若 dto.type === 'event' 且 dsl 是对象且 dsl.chart_config 存在：
    dsl.chart_config = parseChartConfigV1(dsl.chart_config, 'event')
```

要点：

- **只在存在时校验**。没有 `chart_config` 的旧卡照旧保存（`dsl` 仍是自由 JSON）。
- 校验失败**抛 400 拒绝保存**，不静默丢弃——静默丢弃会让用户以为配置存上了。
- `Card.chart_type` 白名单（`dto/card.dto.ts:37-51`）已含 `stack` / `cumulative` / `distribution`，**不用改**。

### 10.3 兼容矩阵

| 输入 | 行为 |
|---|---|
| 事件卡无 `chart_config`（今天全部卡片） | 按 §7.1 合成 `mode='auto'` 配置，**不写回**；图表与改造前一致（AC8） |
| 有 `chart_config` 且列引用有效 | 按配置复现 |
| `chart_config` 引用不存在的列 | `STALE_BINDING` → 回退自动绑定 + 提示，**保留原 config 不覆盖** |
| `schema_version > 1` | `UNSUPPORTED_CONFIG_VERSION` → 回退自动绑定 |
| `chart_config` JSON 损坏 | 读取时置 null + 日志，不抛 500 |
| 服务端未升级（响应无 `role`） | 前端回退 `g_` / `m_` 前缀判定 |
| 前端未升级（不认 `chart_config`） | 忽略该键，按 `_view` 渲染（现状） |

**回滚基础**：不做数据库 migration，`chart_config` 是 `dsl_json` 内的可选键。回滚旧版本应用时它被忽略，卡片仍可按 `_view` 渲染。

---

## 11. 看板接入

`apps/analytics-web/src/features/report/CardWidget.tsx:399` 与 `:440-443` 今天用 `modelFromEventResult(columns, rows)` 给事件卡出图。改为：

```
config = 从 card.dsl.chart_config 读（无则合成 auto）
model  = buildEventChartModel(columns, rows, config)
<ExploreChart kind={card.chart_type} model={model} … />
```

看板不提供字段面板（只读），但**轴归属、单位、拆分系列、标签策略必须复现**（AC7）。`DashboardCard.display_json` 的 `{"view": …}` 契约不变。

---

## 12. i18n

新增文案落在 `analysis` 命名空间（事件分析文案所在域），**13 种语言全部补齐**（`zh-CN`、`zh-TW`、`en-US`、`ja-JP`、`ko-KR`、`de-DE`、`fr-FR`、`es-ES`、`pt-BR`、`ru-RU`、`th-TH`、`vi-VN`、`id-ID`）。键一律全限定形式（硬门禁 21）。

### 12.0 实现记录：共享文案复用 `sql:` 前缀，只新增真正不同的键

两个域共用一个面板与一张 issue 文案表，同一概念的文案（列角色、系列、指标、单位、应用配置）
在 13 语言里已有译文。再建一份 `analysis:` 副本只会得到两处需要同步维护的同义键，
因此**只新增「语义确实不同」的键**：

| key | zh-CN 源文案 | 为什么不能复用 |
|---|---|---|
| `analysis:field.xAxis` | X 轴 | 事件侧 X 轴可以是维度，叫「时间轴」会误导 |
| `analysis:field.axis` | 轴 | 轴归属是事件侧新控件 |
| `analysis:field.axisLeft` | 左轴 | 同上 |
| `analysis:field.axisRight` | 右轴 | 同上 |
| `analysis:field.hintLive` | 轴与单位改完立刻生效；其它项点「应用配置」。 | 事件侧多了「轴」这一类即时生效项 |
| `analysis:issue.applySuggestion` | 应用 | 建议条上的按钮，事件侧专有 |

复用（未新增）：`sql:field.*`（`title`/`sectionLabel`/`series`/`metrics`/`unit`/`roleSection`/`role.*`/`hintDrawer`/`hintLive`/`apply`/`error*`）、
`sql:chart.listSeparator`、其余 `sql:issue.*`。

### 12.1 新增的 5 个 issue 文案（落在 `sql:issue.*`）

`chart-issues.ts` 的 `issueMessages` 是一张覆盖全部 `ChartIssueCode` 的表，新码必须在这张表里有条目，
否则 `Record<ChartIssueCode, …>` 直接类型报错。它们与既有 20 多条 issue 文案同表同命名空间：

| key | zh-CN 源文案 |
|---|---|
| `sql:issue.axisSplitSuggested` | 指标量级差异 {{ratio}}×，建议把 {{metrics}} 拆到右轴 |
| `sql:issue.seriesDimensionUnused` | 还有 {{count}} 个分组列未使用，可设为拆分系列 |
| `sql:issue.seriesCellCollapsed` | 存在未绑定的分组列，同一 X 值的多行已按求和合并 |
| `sql:issue.seriesLimitExceeded` | 系列数超过 {{max}}，已按总量取前 {{max}} 条 |
| `sql:issue.staleBinding` / `staleBindingColumns` | 保存的字段绑定引用了已不存在的列（{{columns}}），已回退自动绑定 |

`seriesDimensionUnused` 带真实数量，按硬门禁 23 补了 CLDR 复数形态：`_one`/`_other` 给
en/de/fr/es/pt，`_one`/`_few`/`_many`/`_other` 给 ru，中/日/韩/越/泰/印尼只用基础键。

### 12.2 服务端新增 3 个错误码与基线记录

`report.chart.axisInvalid`、`report.chart.axisValueInvalid`、`report.chart.xLabelInvalid`
（中文兜底 `message` 分别是「metric_axis 无效」「非法轴归属: {{key}}」「x_label 无效」）。

这三个中文 `message` 使 `scripts/i18n_scan.py` 的 `apps/analytics-server/src/modules/report` 计数
137 → 140。**它们是 `badRequest({ code, messageKey, params, message })` 契约的必要组成**
（`message` 保留中文原文作老客户端兜底，硬门禁 21），不是漏译；已按脚本的逃生口
`--force --update` 记录，原因须写进提交说明。同一轮基线里 `apps/analytics-server/src/config`
28 → 26 是基线陈旧漂移的顺带修正（本 phase 未改该目录）。

其他约定：

- `{{metrics}}` 占位符插入的是**已本地化的指标名**（前端渲染边界翻译），不是服务端下发的 key。
- `analysis:view.unit`（Y 轴单位）语义在实现中明确为「整张图的缺省」：改一次写全部已绑定指标的单位；
  想只改一个走「字段 → 指标单位」。文案无需改动。

**RTL 语言**（阿语 / 希伯来语）尚未上线，本 phase 不引入（i18n 硬门禁 28 的前置改造未做）。

---

## 13. 结构门禁与文件预算

### 13.1 文件数

| 目录 | 当前生产文件 | 本 phase 增量 | 交付后 |
|---|---|---|---|
| `features/query/` | 29 | **0** | 29 |
| `features/visualization/` | 27 | **0** | 27 |
| `features/explore-charts/` | 6 | **0** | 6 |
| `features/event-chart/` | — | **+4**（新建） | 4 |

`features/query/` 离上限只差 1 个文件。本 phase 对该目录**只做文件内修改**，任何新增逻辑一律进 `features/event-chart/`。实现时必须跑 `python3 scripts/arch_ratchet.py`（AC12）。

### 13.2 单文件行数

待改文件当前行数：`explore-chart-option.ts` 284、`EventAnalysisResult.tsx` 245、`FieldBindingPanel.tsx` 499、`event-query.service.ts` 388。上限 1200，空间充足。`FieldBindingPanel.tsx` 泛化后预计增至 ~600 行，仍在安全区。

### 13.3 既有结构问题（本 phase 不修，只登记）

`features/visualization/adapters/shared.ts:3` 反向 import `features/explore-charts` 的 `EXPLORE_COLORS`——依赖方向倒挂，与硬门禁 A.10 的精神相悖。这是既有债，**本 phase 不修**，但也不加剧（新包 `event-chart` 的依赖方向是单向的 `event-chart → explore-charts`，与倒挂无关）。建议本 phase 结束后在 `CODE_HANDOVER.md` 登记一条。

---

## 14. 测试设计

### 14.1 Web 纯函数测试（vitest）

| 文件 | 覆盖 |
|---|---|
| `features/event-chart/event-chart-config.spec.ts` | 自动绑定合成（有时间列 / 无时间列 / 无分组 / 多分组）；`_view.y_unit` 兼容注入；`defaultUnitForColumn` 全分支；`STALE_BINDING` 回退；`roles` 里 `ignored` 列被排除 |
| `features/event-chart/event-binding.spec.ts` | 无 series 直取；有 series 透视（矩阵正确性）；同一 (x, series) 多行求和 + `SERIES_CELL_COLLAPSED`；线数超限截断 + `SERIES_LIMIT_EXCEEDED`；时间轴升序 vs 维度轴保序；`__stage` 行被剔除 |
| `features/event-chart/axis-suggest.spec.ts` | PRD 实际数据 `[98, 190.214, 18641]` → `m_1/m_2` 走右轴；量级相近（比值 1~2）→ null；单指标 → null；含 0 / 负值 / 全 0 → null；多于 3 指标时切在最大断层 |
| `features/explore-charts/explore-chart-option.spec.ts`（扩充） | 有 right 系列 → `yAxis` 为长度 2 的数组且 `grid.right=48`；全 left → `yAxis` 仍是对象且 `grid.right=16`（AC8 保证）；`yAxisIndex` 正确；`resolveXLabel` 四档；时间/维度 formatter 分流；tooltip 按系列查单位 |

### 14.2 Server 测试

| 文件 | 覆盖 |
|---|---|
| `apps/analytics-server/src/modules/query/event-query.service.spec.ts`（扩充） | §6.1 判定表全分支：时间分组 → `time`；`granularity='total'` → `dimension`；event/user/cohort/tag 分组 → `dimension`；指标（含公式、含 `hidden` 以外全部）→ `metric` |
| `apps/analytics-server/src/modules/report/chart-config.validator.spec.ts`（扩充） | `domain='event'` 接受 `stack/cumulative/distribution`、拒绝 `funnel`；`domain='sql'`（含缺省）拒绝 `stack` 且与今天逐项一致；`metric_axis` 非法值 / 非法 key 被拒；`x_label` 越界被拒；32 KiB 上限仍生效 |

### 14.3 浏览器实测（交付证据）

1. **双轴**：构造渠道 + 3 指标的查询 → 打开「展示 → 字段」→ 把两个小指标设为右轴 → 截图（左右两条刻度轴，小指标曲线可见）。
2. **建议条**：同上查询、未设右轴时出现建议条 → 点「应用」→ 截图；再验一次「不点则 `dsl.chart_config` 不变」。
3. **长标签**：X 轴为 `channel_name`，确认标签不重叠、不出界，悬停显示完整 URL。
4. **拆分系列**：加第二个分组列 → 选为拆分系列 → 截图多条线；确认合并说明出现。
5. **无重查**：整个操作流程中 Network 面板无 `/sa/api/query/event` 请求。
6. **持久化**：保存卡片 → 刷新 → 重开 → 看板打开 → 绑定复现。
7. **旧卡回归**：改造前保存的多指标事件卡，改造前后同尺寸截图比对。
8. **i18n**：切到 `en-US`，确认 `<html lang>`、页面标题与「字段」区文案正确、无中文残留。

---

## 15. 实施拆分与依赖顺序

| # | 切片 | 产物 | 依赖 | 可独立合并 |
|---|---|---|---|---|
| 1 | 服务端列角色 | `event-query.service.ts` 的 `role` + 单测；前端 `QueryColumn.role?` | — | ✅ |
| 2 | 契约扩展 | `chart.types.ts` / `chart.constants.ts` / `chart-config.ts`（前端）与 `chart-config.validator.ts`（服务端 `domain` 参数 + 两个新 options 字段）+ 单测 | — | ✅ |
| 3 | 渲染扩展 | `explore-chart-option.ts` 双轴 + 标签策略 + 每系列单位；`ExploreChart` 无需改签名 | — | ✅ |
| 4 | 翻译层 | 新增 `features/event-chart/`（3 文件 + index）；单测 | 1, 2 | ✅ |
| 5 | UI | `FieldBindingPanel` 泛化 + `EventViewSettings` 接入 + `EventAnalysisResult` 接线 | 2, 4 | ✅ |
| 6 | 持久化 + 看板 | `card.service.ts` 校验 + `CardWidget` 读配置 | 2, 4 | ✅ |
| 7 | i18n + 实测 | 13 语言文案 + §14.3 全部实测证据 | 1-6 | ✅ |

切片 1 / 2 / 3 之间无依赖，可并行。切片 4 是复杂度核心，留足 review 时间：透视与截断的边界（空 series 值、null 值、单行、全 null）必须逐个测到。

---

## 16. 验证命令与交付证据

### 16.1 本地

```bash
# 结构棘轮（AC12）
python3 scripts/arch_ratchet.py

# i18n（AC11）
python3 scripts/i18n_check.py
python3 scripts/i18n_scan.py --check

# Web 单测
cd apps/analytics-web && npm test

# Server 单测
cd apps/analytics-server && npm test

# 前端构建（类型检查）
cd apps/analytics-web && npm run build
```

### 16.2 部署后（release 环境）

按 `AGENTS.md`「实现专用规则」的 release 快速发版流程执行（隧道检查 → push → 等 CI → 服务器 rsync）。部署后：

1. 构造一条「按 `channel_name` 分组 + 3 个指标」的事件分析查询并保存卡片。
2. 执行 §14.3 的 8 项浏览器实测，逐项留截图。
3. 核对 `.version` 与 `supervisorctl status clklog_analytics_server`。

### 16.3 PR 声明

```text
门禁未自动检：
- 红线 1/2/6：本 phase 不触碰容器、Puppet 模板与 ClickHouse 表，不适用
- 硬门禁 A.2/A.3/A.11/A.13：已人工核对（入口装配未改；无集中分派；领域包未读 process.env；单一写入方为 EventAnalysisResult）
自动检：python3 scripts/arch_ratchet.py、python3 scripts/i18n_check.py、python3 scripts/i18n_scan.py --check
```

---

## 17. 回滚与失败策略

| 失败点 | 表现 | 处置 |
|---|---|---|
| 切片 1（`role`）出错 | 前端已能回退前缀判定 | 单独回滚切片 1，图表不受影响 |
| 切片 3（双轴/标签）出错 | 单轴时 `yAxis` 仍是对象、`grid.right` 仍是 16 | 回滚切片 3，退回改造前渲染 |
| 切片 4（透视）出错 | 影响面最大 | 关闭「拆分系列」入口（面板隐藏该控件），绑定其余部分仍可用 |
| 切片 5/6（持久化）出错 | 已保存的 `chart_config` 读不出来 | 读取路径置 null 退回自动绑定；`_view` 一直保留，最坏情况等同改造前 |
| 整体回滚 | 不动数据库 | 旧版本应用忽略 `dsl_json.chart_config`，按 `_view` 渲染 |

**不允许的处置**：为了让校验通过而放宽 `parseChartConfigV1` 的白名单、把 `chart_config` 挪出 `dsl_json`、或改 `Card` 表结构。任何一项都会破坏「与 SQL 卡共用同一份契约」这一本 phase 的核心约束。

---

## 18. 实现记录（2026-09-22）

### 18.1 与本方案的偏离

| 处 | 方案原文 | 实现 | 原因 |
|---|---|---|---|
| §9.2 | `BindingColumn` 只有 `key/label/role/typeLabel` | 增加 `numeric?: boolean` | 面板的「指标」候选是 `role === 'metric' \|\| numeric`：SQL 侧的数值列即使角色未定也应可选，这个信号来自 `ColumnProfile.baseType`，塞进展示字符串 `typeLabel` 里会被 UI 反向解析 |
| §9.2 | 面板 props `profiles: ColumnProfile[]` → `columns: BindingColumn[]` | 同左，另加 `scope?: 'sql' \| 'event'` | 用 `scope` 控制区块显隐与 2 处文案，比传入整套 `labels` 覆盖更少接口 |
| §12 | 事件侧新增 `analysis:field.*` / `analysis:issue.*` / `analysis:role.*` | 只新增 6 个键，其余复用 `sql:field.*` / `sql:issue.*` | 见 §12.0：同一概念的键已存在 13 语言译文，另起一套只会得到需要同步维护的同义键 |
| §12.2 | 「不新增服务端错误码」 | 新增 3 个（`axisInvalid`/`axisValueInvalid`/`xLabelInvalid`） | 原判断过于乐观：复用 `roleInvalid`/`unitsInvalid` 会给出语义错误的提示。代价是 i18n 基线 +3，按 `--force --update` 记录 |
| §14.1 | 服务端测试落 `src/modules/**/*.spec.ts` | 落 `test/query/event-column-role.spec.ts` 与 `test/report/chart-config.validator.spec.ts`（扩充既有文件） | 该模块的既有测试就在 `test/` 下，且 `test/report/chart-config.validator.spec.ts` 早已存在——放 `src/` 会造出重复覆盖 |
| §16.3 | PR 声明只列硬门禁自检 | 增加 i18n 基线 `--force` 的原因说明 | 见 §12.2 |

### 18.2 AC8 允许的唯一差异

`_view.y_unit` 缺省为 `'number'`（不携带用户意图）。旧卡里若**第一个指标是比率列或时长列**，
按列推导后轴与 tooltip 的格式会从「纯数值」变成「百分比 / 秒」——这是本 phase 要修的问题之一，
不是回归。除此之外，无 `chart_config` 的旧卡在图型、系列集合、轴数量、边距上与改造前一致。

### 18.3 浏览器实测发现并修复的缺陷

**卡片重开时绑定丢失**：`EventAnalysisPage` 加载卡片时把 `_view` / `_form` 分发到页面 state，
但**没有把 `card.dsl.chart_config` 传下去**；而 `EventAnalysisResult` 从 store 的 `dsl` 读配置——
store 里是 `buildEventQuery(snapshot, project)` 重建出的查询，天然不含 `chart_config`。
结果：保存卡片成功、库里配置也在，重开却退回自动绑定（双轴消失）。

修法：页面新增 `cardChartConfig` state，在卡片加载时从 `card.dsl.chart_config` 取值，
经 `initialChartConfig` prop 传给结果组件；结果组件不再从 store 读该键。
**看板侧不受影响**——`CardWidget` 直接读 `card.dsl`，本来就是对的。

这条说明「从 store 的 dsl 读卡片配置」是个陷阱：store 的 `dsl` 是**查询**，卡片配置在**卡片 dsl** 上，
两者只在「保存」方向重合。

### 18.4 验收执行结果

| AC | 结果 | 证据 |
|---|---|---|
| AC1 列 role | ✅ | `test/query/event-column-role.spec.ts` 10 项；线服务器实测：卡片刷新响应里列带 `"role":"time"` |
| AC2 字段区 | ✅ | 浏览器实测：X 轴 / 系列 / 指标 / 每指标单位 / 每指标轴 / 列角色 / 恢复自动 / 应用配置 |
| AC3 双轴 | ✅ | 实测截图：左轴 0–20、右轴 0–2，两条曲线各自可读 |
| AC4 建议条 | ✅（单测） | `axis-suggest.spec.ts` 7 项，含实例数据 `[98, 190.214, 18641]` → 98/190.214 走右轴 |
| AC5 长标签 | ✅（单测 + 实测） | `resolveXLabel` 四档单测；实测维度轴标签不重叠不出界 |
| AC6 不重查 | ✅ | 实测：改指标绑定并「应用配置」后，页面内 `fetch` 钩子记录的 `/sa/api/query/` 请求数为 **0** |
| AC7 持久化 | ✅ | 实测：保存卡片 → 读回 `dsl.chart_config` 含 `metric_axis: {m_1:'right'}` → 重载重开 → 双轴复现（修掉 §18.3 后）；**看板卡片同样复现双轴（截图）** |
| AC8 旧卡一致 | ✅ | 自动绑定不设拆分系列、单轴时 `yAxis` 仍是对象且 `grid.right` 仍为 16（单测锁定） |
| AC9 透视 | ✅ | `event-binding.spec.ts` 11 项：矩阵、求和合并、超限截断、时间/维度排序 |
| AC10 域白名单 | ✅ | `test/report/chart-config.validator.spec.ts` 扩充 8 项，含两域逐项等价对比 |
| AC11 i18n | ✅ | `i18n_check.py` 13×16 命名空间 3746 条键；基线 1390（+3 见 §12.2） |
| AC12 棘轮 | ✅ | `arch_ratchet.py` passed；新增 `features/event-chart/` 4 个生产文件，`features/query/` 与 `features/visualization/` 零新增文件 |
| AC13 多语言 UI | ✅ | 实测 `?lang=en-US`：`<html lang>="en-US"`、标题 `ClkLog Analytics`、「字段」区全英文（Fields / X axis / Series / Metrics / Left axis / Column roles / Use auto / Apply settings），**中文残留 0 处** |

### 18.5 未完成项

- 依赖倒挂（§13.3）已按「阶段性架构审计」登记为 `CODE_HANDOVER.md` **ECB-01**（P2，仅登记不修）。
- 另登记 **ECB-03**：拆分系列 + 双轴 + 截断三者的组合只有单测覆盖，未做浏览器实测。
- 本 phase 的验收数据（测试卡片与看板）已在实测后删除，未留在环境里。
