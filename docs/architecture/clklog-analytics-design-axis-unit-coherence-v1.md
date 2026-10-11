# 架构：轴内单位一致（双轴之后重新定义「混合单位」）

> phase: clklog-analytics-axis-unit-coherence-v1
> 帽子：架构（`docs/architecture/`）
> 产品：[PRD](../product/prd-clklog-analytics-axis-unit-coherence-v1.md)
> 上游契约：`clklog-analytics-design-charts-v1.md`（`ChartConfigV1`）、`clklog-analytics-design-sql-dual-axis-v1.md`（`options.metric_axis`）、`clklog-ai-analytics-design-sql-chart-axis-v1.md`（Harness 侧 ability 自述）

---

## 1. 阶段目标、范围与验收

一条判定的语义修正 + 一处渲染兜底 + 一个面板动作 + Harness 契约同步。不新增图表类型、不改 `MetricUnit` 枚举、不改单位格式化规则。验收对齐 PRD SC-1～SC-7。

## 2. 判定：从「整图」改成「按轴」

现状：

```ts
function sameUnits(metrics: ColumnProfile[], options?: ChartOptions): boolean {
  if (metrics.length <= 1) return true;
  const units = new Set(metrics.map((item) => metricUnit(item, options)));
  return units.size === 1;                       // 整图一个集合
}
```

调用点三处：`evaluateLine:218`、`evaluateBar:266`、`evaluateTrend:437`。

改法——在 `metric-units.ts` 增加按轴分组的判定，`line` / `trend` 改用它，`bar` 保持 `sameUnits`（柱状/条形没有双轴，全部指标共用一个刻度，整图判定本来就对）：

```ts
/** 指标 → 轴归属；未点名一律左轴。与 adapter 的 axisOf 同规则，只有一处实现。 */
export function axisOfMetric(column: string, options?: ChartOptions): ChartAxis;

/** 每根轴上的单位集合（去重、保序）；用于判定与面板提示。 */
export function axisUnitGroups(columns: string[], options?: ChartOptions): { axis: ChartAxis; units: MetricUnit[]; columns: string[] }[];

/** 哪几根轴混了单位（同轴单位数 > 1）。 */
export function mixedUnitAxes(columns: string[], options?: ChartOptions): ChartAxis[];
```

`axisOf` 这份规则目前在 `line.adapter.ts` / `trend.adapter.ts` 各写了一份闭包，本期收敛到 `axisOfMetric`，避免判定与渲染两处漂移。

**Issue 形状**：`MIXED_UNITS` 从「无参数」变成带 `params: { axis, columns }`，文案改为能指出位置：

```
同一根轴（左轴）上的指标单位不一致：消耗均值_人均、消耗总量
```

新增 i18n 键：`sql:issue.mixedUnits`（占位符 `{{axis}}` `{{columns}}`）、`sql:issue.axisLeft`、`sql:issue.axisRight`。一次报一根轴（两根都混就报两条），避免把两个问题压成一句。

## 3. 渲染：混单位轴的刻度退化为纯数字

两根 adapter 的轴组装当前是：

```ts
yAxisWithUnit(unitOfKey(leftKeys[0]), ...)      // 第一个指标的单位决定了整根轴
```

同轴混单位时这就是「把 A 的量纲套到 B 上」。改法：

- 该轴单位唯一 → 用该单位，**表达式与改动前逐字节一致**（既有图不变，SC-3）；
- 该轴单位不唯一 → 刻度用 `'number'`（纯数字 + 语言默认量级换算如 万/亿/k/M，不带货币符号、百分号、时长、字节），各系列的单位由悬停提示按系列给出（`axisTooltipFormatter` 早已按系列取单位）。

`formatChartNumber(value, 'number')` 不引入新的格式化分支，只是「不做单位装饰」那一档，因此不触碰单位格式化契约。

## 4. 面板：一键「按单位拆轴」

`FieldBindingPanel` 的指标区在 `showsAxisControl`（line/trend 且双轴可用）时，若当前混单位则显示一个按钮：

```
按单位拆轴：把不同单位的指标分到左右两轴
```

实现是 `metric-units.ts` 里的纯函数：

```ts
/** 按单位分组落到左右两轴；返回新的 metric_axis 映射。 */
export function splitMetricsByUnit(
  entries: { key: string; unit: MetricUnit }[],
  currentAxis?: (key: string) => ChartAxis,
): Record<string, ChartAxis>;
```

规则与边界：

- 只有一组单位 → 返回空映射（不产生变化，按钮此时也不显示）；
- **两组 → 比较两种朝向，选需要搬动的指标更少的那一种**。这一条是评审时补的：只按「大组留左轴」会把「人均(数值,左)、用户数(数值,右)、总量(百分比,左)」拆成右轴＝数值＋百分比，仍然混，等于没修；按少搬动优先则只搬人均一个指标，两根轴各自干净。
- 两组大小相同时，按「指标列表里先出现的单位」留左轴（可预期，不随机）。
- 三组及以上 → 指标最多的一组留左轴、其余进右轴；右轴仍混单位时**如实保留提示**（双轴只有两根，不虚构第三根）。

面板提交走的仍是既有 `onChange`（`options.metric_axis` 全量覆盖，与 §「options 按整键替换」一致）。SQL 与事件两侧共用同一组件，因此两侧同时可用。

## 5. Harness 契约同步（本次必须一起做）

模型要能**自己**把混单位状态改合法，缺两样东西：

| 缺口 | 补法 |
|---|---|
| 不知道合法单位值 | 服务端 `chart-proposal.ts` 把 `UNITS` 集合导出为有序数组，两域 capability 各加 `units: ['number','percent_0_100','ratio_0_1','currency','currency_cny','currency_usd','duration_sec','duration_ms','bytes','bytes_iec']`（现在只有 `options_keys` 里一个 `units` 名字，模型猜错值直接 400 `report.chart.unitInvalid`） |
| 不知道「同一根轴必须同单位」 | 两域 `notes` 加一条规则，并给出动作：同轴单位不同 → 用 `options.metric_axis` 拆开 |

分发物同步：插件（`clklog_propose_sql_chart` / `clklog_propose_event_chart` 描述各加一句）、Workspace（`ai_workspace/default/AGENTS.md` 与 `tools/analysis-playbook.md`）。Workspace 是分发物，改完要 `ai-workspace-sync.sh push default`；插件改完要 `install-harness-runtime.sh` + 重启 broker。

`ratio_0_1` 与 `percent_0_100` 的差别（前者渲染时 ×100）也写进 notes——选错会得到「0–1 的值显示成 0.5%」这种结果。

## 6. 影响面与不做的事

- 判定语义变化只影响 `line` / `trend` 的 issue 列表：**跨轴不同单位**从「报错」变「不报」，因此自动模式下这类配置从「可能不出图」变成「正常出图」。这是本次最有价值的一处修正。
- `bar` / `pie` / `number` / `funnel` 的判定与渲染不动。
- 不改 `fixableInPanel` 语义：`MIXED_UNITS` 仍属「可在面板修」，只是现在修的方式多了一个按钮。
- 不做自动改单位、不做三分轴、不动量级断崖建议（`axis-suggest`），理由见 PRD 非目标。
