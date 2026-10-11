# 实现方案：趋势图（含预测与阈值推演）

- `phase: clklog-analytics-trend-chart-v1`
- 日期：2026-09-07
- 帽子：架构 / 愿景（`docs/architecture/`）
- 状态：**已实现**（2026-09-15 回写：`trend-forecast.ts` + 三页接入 + 运维面板磁盘预估）。
- 上游需求：运维面板「服务器状态」需要**磁盘使用量预估**（`clklog-analytics-ops-console-v1`），预估依赖趋势图；本 phase 是它的前置。

---

## 1. 背景与需求

用户原话：

> 服务器状态菜单尤其要对磁盘进行使用量的预估，需要依赖趋势图，如果当前系统没有趋势图，请先增加趋势图，看看留存分析，漏斗分析，自定义SQL 有无趋势图的图像列表可选？如果没有，增加该图（这个需求优先做，做完了在做运维面板）

两个问题需要回答：**① 现在有没有趋势图？② 三个目标页面的图形列表里有没有？** 调研结论均为**没有**（见 §2）。

因此新增 `trend` 图表类型，作为独立 phase 先行落地。

---

## 2. 调研结论

### 2.1 图表体系现状：统一 ECharts，但存在两套体系

| 体系 | 入口 | 类型集合 | 使用者 |
|---|---|---|---|
| 旧兼容壳 | `components/ChartRenderer.tsx:6` | `'line' \| 'bar' \| 'number'` | 事件分析、看板 event/retention 卡 |
| **新 v1 体系** | `features/visualization/chart-pipeline.ts:32-39` | `ChartTypeV1`（6 种） | 自定义 SQL 页、看板 SQL 卡、ChartWorkbench |

渲染库统一为 `echarts-for-react`（`ChartRenderer.tsx:1`、`ChartWorkbench.tsx:2`）。新增图表类型应落在**新 v1 体系**。

### 2.2 现有类型只有 6 种，**没有趋势图**

`features/visualization/chart.types.ts:7`：

```ts
export type ChartTypeV1 = 'table' | 'number' | 'line' | 'bar' | 'pie' | 'funnel';
```

`features/visualization/chart.constants.ts:52-59`：

```ts
export const CHART_TYPE_LABELS: Record<string, string> = {
  table: '明细表', number: '指标卡', line: '折线图',
  bar: '柱状图', pie: '饼图', funnel: '漏斗图',
};
```

分发逻辑 `chart-pipeline.ts:32-39` 逐个 if 命中 adapter，`table` 在 `:83` 提前返回表格视图。

### 2.3 ⚠️ 现有「折线图」不能当趋势图用

`features/visualization/adapters/line.adapter.ts`：

- X 轴是**类目轴**（`:68` `xAxis: { type: 'category', data: categories, boundaryGap: false }`），时间点不等距时会被**均匀铺开**，时间语义失真；
- 只有实际数据点，**没有任何拟合线、预测段、阈值线**；
- `connectNulls: false`（`:54`），缺失时间点断开。

磁盘预估恰恰需要：等距时间轴 + 拟合趋势 + 外推预测 + 阈值交汇点。因此**必须新增类型**，不能靠配置折线图实现。

> **2026-09-09 变更（用户决策）**：预测段从「仅主系列」扩展为**每个系列各自外推**（各系列一条 `（预测）` 虚线，从各自最后实测点接续；拟合线同规则）。系列数 > 8（分组维度取值爆炸）时仅保留主系列外推，防图面不可读。阈值线仍作用于坐标系（第一个系列承载 markLine），「预计达到阈值」按主系列回归计算。

### 2.4 三个目标页面的图形列表（均无趋势图）

`features/query/SaveAsCardModal.tsx:17-36`：

```ts
const chartOptionsFor = (type: CardType): { value: ChartType; label: string }[] => {
  if (type === 'funnel') {
    return [{ value: 'bar', label: '柱状图' }, { value: 'table', label: '表格' }];
  }
  if (type === 'retention') {
    return [{ value: 'line', label: '留存曲线' }, { value: 'table', label: '表格' }];
  }
  return [
    { value: 'line', label: '折线图' }, { value: 'bar', label: '柱状图' },
    { value: 'number', label: '数值' }, { value: 'table', label: '表格' },
  ];
};
```

| 页面 | 现有可选图形 | 有趋势图？ |
|---|---|---|
| 漏斗分析 | 柱状图、表格 | ❌ |
| 留存分析 | 留存曲线（即 line）、表格 | ❌ |
| 自定义 SQL | 折线图、柱状图、数值、表格 | ❌ |

另有 `ChartToolbar.tsx:20-38` 从 `inference.compatible` 生成下拉（自动模式），选项源自 `chart-recommender.ts` 的候选集。

### 2.5 类型定义分散在 4 处 + 1 处白名单（新增类型必须同步改）

| # | 位置 | 内容 |
|---|---|---|
| 1 | `features/visualization/chart.types.ts:7` | `ChartTypeV1` |
| 2 | `features/visualization/chart.types.ts:232` | `CardChartType` |
| 3 | `types/report.types.ts:7` | `ChartType` |
| 4 | `features/visualization/chart-config.ts:32` | `CHART_TYPES` 数组（**保存时白名单校验，漏改会导致新类型被拒**） |
| 5 | `features/visualization/chart.constants.ts:52` | `CHART_TYPE_LABELS` 展示名 |

### 2.6 推荐器与兼容性评估

`chart-recommender.ts:22`：`const CANDIDATE_ORDER: ChartTypeV1[] = ['funnel','number','line','bar','pie','table'];`
`:67-74` 逐个 `evaluateXxx` 生成 `candidates`，评估函数来自 `chart-compatibility.ts`（`evaluateLine` / `evaluateBar` / `evaluatePie` / `evaluateNumber` / `evaluateFunnel` / `evaluateCompatibility`）。

### 2.7 配置契约

`chart.types.ts:94-113`：

```ts
export interface ChartOptions {
  orientation: 'vertical' | 'horizontal';
  donut: boolean;
  sort?: ChartSortOption;
  top_n?: number;
  include_other: boolean;
  units: Record<string, MetricUnit>;
  aggregation: Record<string, AggregationSemantics>;
}

export interface ChartBindings {
  x?: string; category?: string; series?: string;
  metrics: string[]; ignored: string[];
  row_selector?: RowSelector; funnel?: FunnelBinding;
}
```

新增趋势配置需给 `ChartOptions` 加**可选**字段（已有可选字段先例：`sort?`、`top_n?`，且 `ChartConfigV1.schema_version: 1` 存在，可选字段不影响旧配置反序列化）。

---

## 3. 设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| D1 | 新增独立 `trend` 类型，**不增强 line** | 预测语义（外推、阈值交汇）是独立能力；塞进 line 会让普通折线图承担预测副作用，且破坏「折线图 = 事实呈现」的语义 |
| D2 | X 轴用 `type: 'time'` | 磁盘/容量预估要求时间点等距，类目轴会失真（§2.3） |
| D3 | 拟合算法用**一元线性回归（最小二乘）** | 磁盘增长近似线性；算法确定、可单测、无外部依赖。不引入季节性/指数平滑等复杂模型 |
| D4 | **不参与自动推荐**，仅手动可选 | 自动推断出「预测线」会让用户误以为预测值是事实；趋势图应由使用者显式选择 |
| D5 | 阈值线与耗尽时间推演做成**配置驱动**（`options.trend`） | 同一套能力复用：磁盘看「何时满」，留存看「何时跌破 x%」 |

---

## 4. 详细设计

### 4.1 改动清单（按 §2.5 全部同步）

| 文件 | 改动 |
|---|---|
| `features/visualization/chart.types.ts:7` | `ChartTypeV1` 加 `'trend'` |
| `features/visualization/chart.types.ts:232` | `CardChartType` 加 `'trend'` |
| `types/report.types.ts:7` | `ChartType` 加 `'trend'` |
| `features/visualization/chart-config.ts:32` | `CHART_TYPES` 白名单加 `'trend'` |
| `features/visualization/chart.constants.ts:52` | `CHART_TYPE_LABELS` 加 `trend: '趋势图'` |
| `features/visualization/chart.types.ts:94` | `ChartOptions` 加可选 `trend?: TrendOptions` |
| `features/visualization/chart-pipeline.ts:32-39` | 分发加 `if (config.chart_type === 'trend') return trendAdapter(...)` |
| **新增** `features/visualization/adapters/trend.adapter.ts` | 趋势图 adapter |
| **新增** `features/visualization/adapters/trend-forecast.ts` | 纯函数：回归拟合 + 外推 + 阈值交汇（便于单测） |
| `features/visualization/chart-compatibility.ts` | 新增 `evaluateTrend()` |
| `features/visualization/chart-recommender.ts` | **不改** `CANDIDATE_ORDER`（D4：不参与自动推荐）；但 candidates 需能给出「趋势图是否可用」的结论供手动切换时判定 |
| `features/query/SaveAsCardModal.tsx:17-36` | 三类分析均加入趋势图选项（见 §4.5） |

### 4.1.1 ⚠️ 实现时补记：另有 3 处「隐性白名单」必须同步

上表是「能渲染」的最小集。实现时又撞到 3 处**不在表内**的校验，缺任一都会导致「趋势图能显示，但保存 / 回显失败」——这类问题只在保存路径暴露，不易察觉：

| 位置 | 现象 | 处理 |
|---|---|---|
| `chart-config.ts` `parseOptions()` 的 options 白名单（原 211-214 行硬编码数组） | `options.trend` 被判 `unknown option` 直接抛错 → 整个 config 解析失败、静默回退表格 | 白名单加 `'trend'`，并新增 `parseTrend()` 做范围校验（`forecast_points` 整数 0~90、`threshold` 数值或 null） |
| `chart-compatibility.ts` `defaultOptions()`（对象白名单重建） | 即便解析成功，`trend` 也会在重建时被丢弃，回显时外推点数回到默认值 | 返回值补 `trend: partial?.trend` |
| `chart-compatibility.ts` `evaluateCompatibility()` 的 if 链 | `trend` 未匹配任何分支，落到末尾 `evaluateFunnel()` → 判不兼容 → 视图回退表格、无 adapter | if 链加 `trend` 分支 |

**教训**：本项目图表配置有「类型定义 → 类型白名单 → 解析 → 默认值重建 → 兼容评估 → adapter 分发」六道关卡。新增图表类型要沿这条链路逐关检查，只改类型定义会漏。

### 4.2 纯函数层：`trend-forecast.ts`

```ts
export interface TrendPoint { t: number; v: number }        // t = 时间戳(ms)，v = 指标值

export interface TrendFit {
  slope: number;        // 单位：值 / 毫秒
  intercept: number;
  r2: number;           // 拟合优度，用于提示可信度
  points: TrendPoint[]; // 参与拟合的原始点
}

export interface ForecastResult {
  fit: TrendFit;
  predicted: TrendPoint[];                 // 外推点（含时间戳）
  thresholdCrossAt: number | null;         // 与阈值线交汇的时间戳；不相交为 null
  daysToThreshold: number | null;          // 便捷字段：距交汇还有多少天
}
```

函数：

- `fitLinear(points: TrendPoint[]): TrendFit` —— 最小二乘；**点数 < 3 时返回 `r2 = 0` 且不外推**（样本不足以谈趋势）。
- `forecast(points, options): ForecastResult` —— 拟合 + 按 `forecast_points` 外推 + 解 `a + b*t = threshold`。
- 退化处理：斜率为 0（无增长）→ `thresholdCrossAt = null`，UI 提示「当前无明显增长趋势」。

### 4.3 Adapter：`trend.adapter.ts`

输入与 line 一致（`config.bindings.x` 为时间列，`metrics` 为指标，`series` 可选），输出 ECharts option：

| ECharts 元素 | 内容 |
|---|---|
| `xAxis` | `{ type: 'time' }`（等距，D2） |
| `yAxis` | `{ type: 'value', scale: true }` |
| series 1 | 实际值：`type: 'line'`，实线，带 symbol |
| series 2 | 预测段：`type: 'line'`，**虚线**（`lineStyle.type: 'dashed'`），从最后一个实际点接续，避免断线 |
| series 3 | 拟合直线（可选，`show_trend_line`）：贯穿全程的细虚线 |
| `markLine` | 阈值线（`threshold` 配置），与预测线交汇处标注「预计 YYYY-MM-DD 达到阈值」 |
| tooltip | `trigger: 'axis'`，预测点标注「预测」以免与实测混淆 |

**必须明确的视觉约定**：预测值一律虚线 + tooltip 标注「预测」，防止把推算值误读为实测值。

### 4.4 配置项扩展

```ts
export interface TrendOptions {
  forecast_points: number;      // 外推点数（按数据粒度，如 30 = 30 天）
  threshold?: number | null;    // 阈值线；用于推演耗尽/达标时间
  show_trend_line: boolean;     // 是否显示拟合直线
  show_threshold: boolean;      // 是否显示阈值线
}
```

默认值：`forecast_points = 7`、`threshold = null`、`show_trend_line = false`、`show_threshold = true`（有 threshold 时）。

### 4.5 三个页面接入

修改 `SaveAsCardModal.tsx` 的 `chartOptionsFor`：

| 类型 | 接入后的可选项 |
|---|---|
| funnel | 柱状图、表格、**趋势图**（需漏斗结果含时间维度，否则由 `evaluateTrend` 判不可用并禁用） |
| retention | 留存曲线、表格、**趋势图** |
| 其他（event/sql） | 折线图、柱状图、数值、表格、**趋势图** |

> 漏斗分析本身是「步骤转化率」，通常无时间维度。是否对漏斗开放趋势图，**建议由产品帽在 PRD 中裁定**；技术上通过 `evaluateTrend` 自动判不可用即可（后端无需特殊处理）。

### 4.6 磁盘预估场景的落地方式（本 phase 的下游消费者）

运维面板「服务器状态」的磁盘趋势：

1. 后端 ops 服务定期采样磁盘用量落表（采样频率与保留策略在 ops-console 文档中定义）；
2. 前端用**本 phase 的 trend 图表**渲染：X = 采样时间，Y = 已用字节；
3. `threshold` 取磁盘总量（或 90% 告警线）；
4. 页面直接展示「按近期增速，预计 YYYY-MM-DD 磁盘用尽，剩余 N 天」。

即：本 phase 只提供**通用趋势图能力**，磁盘采样与展示是它的第一个消费者。

---

## 5. 阶段目标与范围

### 目标

| 编号 | 目标 |
|---|---|
| G1 | 新增 `trend` 图表类型，具备等距时间轴、回归拟合、外推预测、阈值推演 |
| G2 | 留存 / 漏斗 / 自定义 SQL 三个页面的图形列表中可选趋势图 |
| G3 | 预测值与实测值在视觉上可区分，不误导 |
| G4 | 为运维面板磁盘预估提供可复用能力 |

### 范围

1. §4.1 全部改动（类型注册 5 处 + adapter + 纯函数 + 兼容评估）。
2. 单测：`trend-forecast.ts`（拟合正确性、<3 点不外推、斜率为 0、阈值交汇）、`trend.adapter.ts`（虚线、时间轴、阈值标注）、`chart-config` 白名单接受 `trend`。

### 非目标

1. **不做复杂时序模型**（季节性、ARIMA、指数平滑）——线性回归足够支撑磁盘/容量类预估。
2. 不参与自动推荐（D4）。
3. 不改旧兼容壳 `ChartRenderer.tsx`（存量路径，避免扩大影响面；如需，另立任务）。
4. 不做趋势告警（属于 ops-console phase 的告警菜单）。
5. 不支持多指标同时预测（首期单指标；多指标时沿用 `series` 分面，但预测仅对主指标）。

---

## 6. 验收标准

| 编号 | 标准 |
|---|---|
| AC1 | 自定义 SQL / 留存 / 漏斗的图形选择列表中出现「趋势图」，选中后正常渲染 |
| AC2 | 趋势图 X 轴为等距时间轴（两个不等距时间点在轴上的间距与其时间差成正比） |
| AC3 | 实际值实线、预测值虚线且 tooltip 标注「预测」 |
| AC4 | 配置阈值后显示阈值线，并在交汇点标注预计达到日期；无阈值时不显示 |
| AC5 | 数据点 < 3 时不外推，并给出「数据点不足，无法预测」提示 |
| AC6 | 拟合优度极低（如 r² < 0.1）时提示趋势不可靠，但不阻止渲染 |
| AC7 | 保存卡片时能持久化 `chart_type: 'trend'` 与 `options.trend`，重新打开可复现（白名单已放行） |

> **2026-09-09 缺陷登记（用户实测发现）**：AC7 的服务端部分实际未落地——`chart-config.validator.ts` 的 `CHART_TYPES` 与 `options` 白名单从未放行 `trend`（§4.1 清单列了该项但实现只改了前端），趋势图卡片自功能上线起保存必 400「chart_config 枚举无效」。已补：`CHART_TYPES` 加 `trend`；`options` 白名单加 `trend` 并校验形状（`forecast_points` 0..90 整数、`threshold` 数值或 null、两个布尔开关、未知键拒绝）。新增服务端用例覆盖 AC7 与非法键拒绝。
| AC8 | 单测覆盖 `trend-forecast.ts` 与 `trend.adapter.ts`；`python3 scripts/arch_ratchet.py` 通过 |
| AC9 | 旧卡片配置（无 `options.trend`）反序列化不受影响 |

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 类型定义分散 4 处 + 白名单，漏改导致保存被拒（AC7） | 改动清单化（§4.1），AC7 用「保存后重开可复现」端到端验证 |
| 预测值被误读为实测 | 强制虚线 + tooltip 标注 + AC3 验收 |
| 外推过远产生荒谬结论 | `forecast_points` 有默认值与上限（建议 ≤ 90），超出提示 |
| 旧兼容壳不同步导致看板 event 卡无趋势图 | 明确非目标，视觉一致由后续任务处理 |

---

## 8. 关联

- 下游消费者：`docs/architecture/clklog-analytics-design-ops-console-v1.md`（运维面板，磁盘预估）。
- 既有图表设计：`docs/architecture/clklog-analytics-design-charts-v1.md`。
- 实现前需产品帽产出 PRD（含漏斗是否开放趋势图的裁定）。
