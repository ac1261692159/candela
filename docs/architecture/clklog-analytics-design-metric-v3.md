# 设计：指标 v3（留存队列范围 / 指标卡 / 数值变换四则运算 / 时间面板）

- `phase: clklog-analytics-metric-v3`
- 关联 PRD：`docs/product/prd-clklog-analytics-metric-v3.md`
- 落点：`types/dsl.types.ts`、`query/event-sql-generator.service.ts`、`query/dsl-validator.service.ts`、`query/metric-value-pick.ts`、`query/metric-window.ts`、`alerting/alert-metric-eval.service.ts`、`report/*`、`features/metrics/*`、`features/time-range/*`

## 1. 数值变换：`MetricTransform` v2

```ts
export interface MetricTransform {
  /** 四则运算：mul=乘 div=除 add=加 sub=减；缺省（且无 factor）不运算 */
  op?: 'mul' | 'div' | 'add' | 'sub';
  /** 运算数（|value| ≤ 1e6；div 时不得为 0） */
  value?: number;
  /** 旧字段：等价于 op='mul' + value=factor，读时归一化、写回时升级为 op/value */
  factor?: number;
  /** 保留小数位（0..6），在四则运算之后执行 */
  decimals?: number;
}
```

**归一化唯一入口**（新增 `query/metric-transform.ts`，纯函数）：
```ts
resolveTransform(t?: MetricTransform | null): { op: 'mul'|'div'|'add'|'sub'; value: number; decimals?: number } | null
applyTransformValue(value: number, t?: MetricTransform | null): number   // JS 侧（指标求值）
buildTransformSql(expr: string, t?: MetricTransform | null): string      // 数据库侧（聚合后）
validateTransform(raw: unknown): string | null                            // 保存/查询前校验
```
- `resolveTransform`：`factor` 存在且无 `op` → `{op:'mul', value:factor}`；`op` 存在 → 用 `op/value`；两者都没有 → `null`。
- `buildTransformSql`：`mul → (expr) * N`、`div → (expr) / N`、`add → (expr) + N`、`sub → (expr) - N`，其后 `round(x, decimals)`。
- `validateTransform`：`op` 枚举、`value` 有限且 |value| ≤ 1e6、`div` 的 value ≠ 0、`decimals` 0..6 整数；`factor` 与 `op/value` 同时出现时以 `op/value` 为准（不报错，保证旧数据可读）。
- 调用点替换：`event-sql-generator.applyMetricTransform` → `buildTransformSql`；`metric-value-pick.applyTransform` → `applyTransformValue`；`dsl-validator` 与 `meta-saved-metric.service.normalizeTransform` → `validateTransform`。
- 前端 `MetricDefinitionForm` / `EventMetricCard` 次要设置：`[运算 Select][数值 InputNumber][保留小数位]`，提交 `{op, value, decimals}`；`metric-definition.describeMetric` 输出 `×N / ÷N / +N / −N`。

## 2. 留存指标的队列范围

现状：`alert-metric-eval.retentionRange(n)` = `max(30, n+30)` 天（上限 180）。
改为：`resolveRetentionWindow(definition, n)`：

```
definition.metric.time_range.relative 存在 → materializeTimeRange(...)（相对范围）
                                            校验：天数 ≥ n+1 且 ≤ 180，否则 400
否则 → retentionRange(n)（现行推导，行为不变）
```

- 复用 `metric-window.metricTimeRange()` 做解析与相对范围校验（同一套时区与日历逻辑）；
- 事件指标已有「查询时间（窗口）」语义，留存指标的同一字段解释为**队列范围**（口径文案分别为「查询时间」「队列范围」，避免歧义）；
- 保存校验在 `meta-saved-metric.service.normalizeDefinition('retention')` 里追加：`time_range` 合法（相对）、跨度 ≥ n+1、≤ 180；
- `normalizeDefinition('retention')` 白名单补 `time_range`（与事件侧同一字段），并写 `version: 2`。

## 3. 指标卡（`card.type = 'metric'`）

| 层 | 变更 |
|---|---|
| Prisma | 无需改表：`Card.type` 是字符串，`dsl_json` 存 `{ metric_id }` |
| DTO | `CreateCardDto.type` 白名单加 `metric`；新增校验：`metric` 类型必须给 `dsl_json.metric_id` |
| `CardService.computeResult` | 新增分支：`metric` → `MetricEvalService.evaluateEvent({ project, definition, withSeries: true })`，返回**分析同构结果**：`{ columns:[{key:'g_0',title:'日期'},{key:'m_0',title:<指标显示名>,unit}], rows:[{__stage:true,g_0:'阶段汇总',m_0:value}, ...每日行] }` |
| 缓存 | 走既有 `writeCache`；失败落 `error` 并保留上次结果（现有行为） |
| 看板分群筛选 | `mergeDashboardCohortFilter` 对 `metric` 类型返回原文并在结果上带 `cohort_applied:false`；卡片 UI 显示「指标卡不支持看板分群筛选」（AC-12） |
| 前端渲染 | `CardWidget` 把 `metric` 与 `event` 同路径渲染（`modelFromEventResult`），视图沿用卡片自身的 `chart_type`（line/bar/table/number）；类型标签「指标」，颜色与指标实体一致 |
| 创建入口 | 指标详情抽屉 → `创建看板卡片`（`POST /sa/api/report/cards {type:'metric', dsl_json:{metric_id}, name: 指标显示名}`）→ 提示「已创建，可到看板工作室放置」 |

**为什么返回分析同构结构**：卡片渲染、CSV 导出、图表配置、`__stage` 约定都已存在（`explore-chart-option.ts` 会过滤 `__stage`），新类型只要产出同样的形状即可复用全部渲染与设置能力，不新增一条渲染链路。

## 4. 查询时间面板（纯前端）

`time-range-panel.css`：
```css
.time-range-panel { width: min(848px, calc(100vw - 40px)); max-width: calc(100vw - 40px); display: flex; flex-wrap: wrap; }
.time-range-panel__presets { flex: 0 1 248px; }
.time-range-panel__main { flex: 1 1 420px; min-width: 0; }
.time-range-panel__calendars { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
@media (max-width: 680px) { .time-range-panel__presets { flex: 1 1 100%; grid-template-columns: repeat(3, max-content); } }
```
`TimeRangeControl`：`Popover placement="bottomLeft" arrow={false} overlayStyle={{ maxWidth: 'calc(100vw - 24px)' }}`，并把 `getPopupContainer` 固定为 `document.body`（抽屉内不被裁切）。

## 5. 指标列表 / 详情操作整理（纯前端）

- `SavedMetricsPage`：删除「操作」列与行内删除逻辑（`Modal.confirm` 迁入抽屉）。
- `MetricDetailDrawer`：头部 `编辑` 与 `删除` 并排；查看态与编辑态都显示删除；删除前确认（编辑态额外提示未保存修改会丢失），成功后 `onDeleted?.()` 通知父级刷新列表并关闭。

## 5.1 实现记录（2026-09-16 落地，版本 17270）

| 项 | 设计原文 | 实际实现 | 说明 |
|---|---|---|---|
| 面板弹层定位 | `placement="bottomLeft"` | **`placement="bottom"`**（居中展开） | 贴右边界时 bottomLeft 需位移的距离更大，实测 1280px 下会把面板推到左边界外 21px；居中展开两侧各有余量，位移更小 |
| 弹层宽度 | 未写 | `overlayStyle.width = min(848px, calc(100vw - 40px))`，与面板 CSS 同值 | antd 先量尺寸再定位，而面板内日历渲染会改尺寸 → 曾出现「右溢 24px、应用按钮被挤出视口」的测量竞态 |
| 窄视口 | 「<680px 日历单列」 | **≤900px 即单列 + 面板收窄到 `min(560px, 100vw-24px)`**；≤680px 预设列整行 | 两列日历并排在小屏放不下，900px 是实测能稳住的界线 |
| 留存队列范围上限 | ≤180 天 | 实现 `validateMetricTimeRange(raw, { maxDays })`，留存传 180（通用指标仍是 90） | 否则通用 90 天上限先命中，PRD 写的 180 天不可达（线上实测 120 天被 400 拦下） |
| 数值变换应用层 | 「JS 侧最后一步」 | **只在 SQL 侧应用一次**（`buildTransformSql`），JS 不再重复计算 | 指标求值复用事件分析查询链路，SQL 已算过；v2 曾在 JS 再算一次（有变换的指标会被算两遍：÷1000 变 ÷1000000），v3 修掉并删掉 JS 应用函数 |
| 验收抓到的三处实现缺陷 | — | ① `mergeMetricDefinition` 留存分支漏合并 `time_range` → 队列范围校验形同虚设；② 缓存 worker 候选类型白名单缺 `metric` → 指标卡永不刷新；③ 留存放宽到 180 天后，内部取天数仍走通用 90 天上限 → 120 天窗口被判「队列范围不合法」 | 均已修并补测试（见 CODE_HANDOVER MV-03/MV-04/MV-06）；三处都是**线上实测**才暴露的，见 HANDOVER §22.3 的验收方法 |

## 6. 测试策略

| 层 | 用例 |
|---|---|
| 后端单测 | `metric-transform.spec.ts`：四则运算的 SQL 片段与 JS 值、`factor` 兼容、div 0 拒绝、decimals 边界；`metric-v2.spec.ts` 扩展：留存 `time_range` 校验（< n+1、> 180）；`card.service` 单测：`type=metric` 的结果形状（含 `__stage` 行）与失败路径 |
| 前端单测 | `metric-definition.spec.ts`：transform 文案与回显（旧 factor → 乘以）；`MetricDefinitionForm.spec.tsx`：选「除以」提交 `{op:'div'}`；`SavedMetricsPage`/`MetricDetailDrawer` 断言无操作列、抽屉内有删除；`time-range-panel.spec` 补宽度/列数断言 |
| 线上验收 | ① 指标抽屉打开时间面板，量测面板右边距 ≥ 0（不越界）；② 「÷1000 保留 2 位」指标试算值 = 原值/1000；③ 建一张指标卡并放置到看板，数值与试算一致；④ 留存指标设队列 90 天后求值窗口变化；⑤ 删除按钮在抽屉内，二次确认生效 |

## 7. 实施顺序

1. 数值变换四则运算（后端归一化 + 校验 + SQL/JS + 前端两处 UI + 文案）——独立可发版；
2. 时间面板与列表/抽屉操作整理（纯前端）；
3. 留存指标队列范围（保存校验 + 求值 + 编辑器 + 文案）；
4. 指标卡（DTO/服务/渲染/入口 + 测试）。
