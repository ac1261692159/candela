# 实现方案：自定义 SQL 折线图的双 Y 轴（v1）

- phase: `clklog-analytics-sql-dual-axis-v1`
- 帽子：架构（`docs/architecture/`）
- 对应 PRD：`docs/product/prd-clklog-analytics-sql-dual-axis-v1.md`
- 上游 SSOT：`docs/architecture/clklog-analytics-design-charts-v1.md`（`ChartConfigV1` 契约）、`docs/architecture/clklog-analytics-design-event-chart-binding-v1.md`（事件侧同类实现，可参照）
- 状态：待评审

---

## 0. 执行入口

先读：

| 要说清什么 | 读哪篇 |
|---|---|
| `ChartConfigV1` 的字段与约束（本期不新增字段） | `docs/architecture/clklog-analytics-design-charts-v1.md` §6.3 |
| 事件侧双轴怎么做的（本期在 SQL 侧复刻同一语义） | `docs/architecture/clklog-analytics-design-event-chart-binding-v1.md` §6.2、§8 |
| 单位与轴格式化工具 | `apps/analytics-web/src/features/visualization/metric-units.ts` |

---

## 1. 阶段目标与范围（程序门禁要素①）

### 1.1 目标

让自定义 SQL 的**折线图与趋势图**具备与事件侧相同的左右双 Y 轴能力，且两轴各按所属指标的单位格式化。

**契约层无需改动** —— `options.metric_axis` 已在前后端白名单内且不按域收窄；本期只补渲染与 UI。

### 1.2 代码范围

| 层 | 文件 |
|---|---|
| SQL 折线渲染 | `apps/analytics-web/src/features/visualization/adapters/line.adapter.ts` |
| SQL 趋势渲染 | `apps/analytics-web/src/features/visualization/adapters/trend.adapter.ts` |
| 轴基线与边距 | `apps/analytics-web/src/features/visualization/adapters/shared.ts`（`baseChartOption`，如需） |
| 字段面板 | `apps/analytics-web/src/features/visualization/FieldBindingPanel.tsx` |

不新增生产文件（`features/visualization/` 已有 27 个，越过 80% 线；本期只改既有文件）。

### 1.3 不变边界

1. **契约不变**：不新增 `ChartConfigV1` 字段，服务端 `chart-config.validator.ts` 一行不改。
2. **事件侧不变**：`explore-chart-option.ts` 与 `features/event-chart/` 不动。
3. **查询不变**：轴归属是纯展示层。
4. **单轴图形不变**：未配置 `metric_axis` 时输出与改造前一致的**单条** `yAxis` 对象。

---

## 2. 验收标准（程序门禁要素②）

| # | 验收项 | 核对方式 |
|---|---|---|
| AC1 | 全部指标在左轴（或未配置）时，`yAxis` 仍是**单对象**、`grid.right` 仍是 16 | `line.adapter.spec.ts` / `trend.adapter.spec.ts` 断言形状（锁住「既有图不变」） |
| AC2 | 任一指标为 `right` 时，`yAxis` 为长度 2 的数组，每条系列带正确 `yAxisIndex` | 同上 |
| AC3 | 双轴时 `grid.right` 放宽到 48（右轴刻度不被裁） | 同上 |
| AC4 | 左右轴分别用各自第一个指标的单位格式化刻度 | 同上：右轴设百分比后右轴 formatter 输出含 `%`、左轴不含 |
| AC5 | tooltip 仍按每条系列自己的单位（既有行为，不回归） | 既有用例保持通过 |
| AC6 | 字段设置里每个指标出现轴归属下拉，仅折线/趋势图可见 | `FieldBindingPanel.spec.tsx` |
| AC7 | 改轴归属走「应用配置」生效；改单位仍即时生效（既有行为） | `FieldBindingPanel.spec.tsx` |
| AC8 | `python3 scripts/arch_ratchet.py`、`i18n_check.py`、`i18n_scan.py --check` 通过；前端构建通过 | 命令输出 |

---

## 3. 非目标（程序门禁要素③）

1. **不做柱状 / 条形 / 饼图 / 数值卡的轴归属**（连控件都不显示，避免「能设但不生效」）。
2. **不做量级差异自动建议**：`axis-suggest.ts` 现在在 `features/event-chart/`，SQL 侧引用它会形成 `visualization → event-chart` 反向依赖；要做得先迁到中性位置并拆 `features/visualization/`（越 80% 线）。单独排期。
3. **不做第三、第四条轴**。
4. **不改事件侧渲染与配置**。
5. **不改服务端**。
6. **不新增 `ChartConfigV1` 字段**（契约早已支持）。

---

## 4. 现状与差距

### 4.1 契约层已就绪（本期无需改动）

| 项 | 证据 |
|---|---|
| 服务端白名单含 `metric_axis` | `chart-config.validator.ts:252`（options 允许键）与 `:332-346`（值只允许 left/right） |
| 前端解析含 `metric_axis` | `chart-config.ts:269` `parseMetricAxis`、`:317` 白名单、`:363` 解析 |
| 两者都**不按域收窄** | `parseChartConfigV1(input, columns, domain)` 的 `domain` 只影响 `chart_type`；options 两域共用 |

→ **SQL 卡今天就能存下 `metric_axis` 并通过校验**，只是渲染被忽略。

### 4.2 缺的两块

| 缺口 | 证据 |
|---|---|
| 渲染只建单轴 | `line.adapter.ts:70` `yAxis: yAxisWithUnit(unit, { scale: true, min, max })`；`trend.adapter.ts:119` `yAxis: yAxisWithUnit(unit, { scale: true })`。两处都读 `config.options.units`（`:61`），但只用于 tooltip（`axisTooltipFormatter` + `unitForSeriesName`）；轴单位取 `unit`＝首个指标 |
| UI 控件被域挡住 | `FieldBindingPanel.tsx:337` 的轴下拉在 `{isEvent ? (...) : null}` 里 |

另外 `baseChartOption`（`adapters/shared.ts:34`）的 `grid.right` 是 16，双轴要放宽。

### 4.3 与事件侧的差异（复刻时要保持一致的语义）

| 语义 | 事件侧实现 | 本期 SQL 侧 |
|---|---|---|
| 何时产生第二条轴 | 任一系列 `axis === 'right'` | 任一指标 `metric_axis[k] === 'right'` |
| 轴单位 | 该轴第一条系列的单位 | 该轴第一个指标的单位 |
| 全左轴时 | 输出单对象（不产生数组） | 同 |
| 右边距 | 双轴 48 / 单轴 16 | 同 |

---

## 5. 实现

### 5.1 `line.adapter.ts`

在构造 option 前算三件事：

```ts
const metricAxis = config.options.metric_axis ?? {};
const axisOf = (key: string) => metricAxis[key] ?? 'left';
const hasRight = metricKeys.some((key) => axisOf(key) === 'right');
// 每条轴的单位：取该轴第一个指标
const unitOn = (side: 'left' | 'right') => {
  const key = metricKeys.find((k) => axisOf(k) === side);
  return key ? unitForSeriesName(key, units, unit) : unit;
};
```

然后：

- `yAxis`：`hasRight ? [yAxisWithUnit(unitOn('left'), { scale: true, min, max }), yAxisWithUnit(unitOn('right'), { scale: true })] : yAxisWithUnit(unitOn('left'), { scale: true, min, max })`
  - `min`/`max` **只给左轴**：它们是从全部数值算出来的，套到右轴会把右轴压扁——这正是双轴要解决的问题，不能反向引入。
- `series`：`hasRight` 时每条加 `yAxisIndex: axisOf(metric) === 'right' ? 1 : 0`
- `grid.right`：`hasRight ? 48 : 16`（其余 grid 字段沿用 `baseChartOption`）

### 5.2 `trend.adapter.ts`

同样的三件事。趋势图比折线多「预测段」与「阈值线」：

- 预测段的系列名带后缀、`unitForSeriesName` 会剥后缀查单位（`metric-units.ts:142`），所以**按指标 key 查单位时要用原始 key**，不要用带后缀的系列名；
- `yAxisIndex` 要同时给真实段与预测段，否则预测线会跳回左轴。

### 5.3 `FieldBindingPanel.tsx`

轴下拉的显示条件从「仅事件」放宽为「事件 or SQL 的折线族」：

```ts
const showsAxis = isEvent
  ? EVENT_Y_AXIS_TYPES.includes(chartType)
  : chartType === 'line' || chartType === 'trend';
```

（事件侧的 `EVENT_Y_AXIS_TYPES` 保持不变。）

控件本身、`setAxis`、即时生效逻辑都已存在（`:226`、`:337-344`），**只是把门开对**——不新增控件、不新增文案（`analysis:field.axis*` 三个键已有 13 语言译文）。

---

## 6. 测试设计

| 文件 | 覆盖 |
|---|---|
| `adapters/line.adapter.spec.ts`（扩充） | AC1 单轴时 `yAxis` 是对象且 `grid.right=16`；AC2 双轴时数组 + `yAxisIndex` 正确；AC3 `grid.right=48`；AC4 左右轴 formatter 各按自己单位；min/max 只作用于左轴 |
| `adapters/trend.adapter.spec.ts`（扩充） | 同上，另加：预测段也带正确 `yAxisIndex`；阈值线不受影响 |
| `FieldBindingPanel.spec.tsx`（扩充） | AC6 折线/趋势出现轴下拉、柱状/饼图不出现；AC7 改轴归属走「应用配置」、改单位仍即时 |

浏览器实测（release）：造一个「收入金额 + 付费人数」量级差两个数量级的 SQL，把付费人数设到右轴，确认出现第二条轴且右轴刻度完整。

---

## 7. 实施拆分与依赖顺序

| # | 切片 | 产物 | 可独立合并 |
|---|---|---|---|
| 1 | 折线 adapter 双轴 | `line.adapter.ts` + spec | ✅ |
| 2 | 趋势 adapter 双轴 | `trend.adapter.ts` + spec | ✅ |
| 3 | 字段面板放开轴控件 | `FieldBindingPanel.tsx` + spec + i18n 复用确认 | ✅ |
| 4 | 浏览器实测与验收记录 | `docs/project/acceptance-clklog-analytics-sql-dual-axis-v1.md` | ✅ |

切片 1/2 是纯渲染、无 UI 入口，先合并不影响任何既有行为（没人能设 `metric_axis` 之前，`hasRight` 恒假）。切片 3 打开入口后功能才可用。

---

## 8. 验证命令与交付证据

```bash
python3 scripts/arch_ratchet.py
python3 scripts/i18n_check.py
python3 scripts/i18n_scan.py --check
cd apps/analytics-web && npx vitest run src/features/visualization && npm run build
```

---

## 9. 回滚与失败策略

| 失败点 | 表现 | 处置 |
|---|---|---|
| adapter 改动出错 | 单轴图变形 | 回滚对应 adapter；切片 1/2 无 UI 入口，用户感知不到 |
| 面板改动出错 | SQL 用户看到无效控件 | 回滚切片 3，控件退回隐藏 |
| 整体回滚 | 不动数据库 | 本 phase **无 schema 变更、无迁移**；回滚只回代码 |

**不允许的处置**：为省事把轴归属塞进 `bindings` 或新建字段（契约已支持，另起字段就是第二套真相）。
