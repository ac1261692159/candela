# 架构设计：指标查看与编辑

- `phase: clklog-analytics-metric-detail-v1`
- 帽子：架构
- 配套 PRD：`docs/product/prd-clklog-analytics-metric-detail-v1.md`

---

## 1. 现状（为什么是纯前端补齐）

| 层 | 现状 |
|---|---|
| 后端 | **已具备**：`GET /sa/api/meta/metrics/:metricId`（`metric.view`）、`PUT /sa/api/meta/metrics/:metricId`（`metric.edit_own`）；`MetaSavedMetricService.update` 会重跑 `normalizeDefinition` 做规范化与校验，返回更新后的完整对象 |
| 前端 | `services/meta.service.ts` 只接了 list / create / delete；`SavedMetricsPage` 只有表格 + 删除按钮 |
| 结论 | 缺的是前端接线与交互，**不改后端契约**（避免为 UI 补齐而扩 API 面） |

## 2. 组件与文件

```
apps/analytics-web/src/features/metrics/
├── metric-definition.ts          # 纯函数：口径摘要 / 编辑载荷构造 / 方法是否需要属性
├── metric-definition.spec.ts     # 纯函数单测
├── MetricDetailDrawer.tsx        # 查看 / 编辑一体抽屉（含编辑态切换）
├── MetricDetailDrawer.spec.tsx   # 交互单测（查看→编辑→保存载荷）
├── CreateMetricModal.tsx         # 既有：从分析结果创建指标（不改）
apps/analytics-web/src/pages/Meta/SavedMetricsPage.tsx   # 列表接入查看/编辑
apps/analytics-web/src/services/meta.service.ts          # 新增 getSavedMetric / updateSavedMetric
```

## 3. 纯函数契约（`metric-definition.ts`）

```ts
export interface DefinitionRow { label: string; value: string }

/** 定义 → 可读行（查看抽屉与列表摘要共用同一份口径文案） */
export function describeMetric(kind: 'event' | 'retention', definition: Record<string, unknown>): DefinitionRow[]

/** 计算方法是否需要属性（total_times / trig_user_num / per_capita_times 不需要） */
export function analysisNeedsProp(method: string): boolean

/** 事件指标编辑后的 definition（保留未暴露字段：filters / alias / percentile / stage_reduce…） */
export function buildEventDefinition(
  original: Record<string, unknown>,
  patch: { event: string; analysis: string; prop?: string },
): Record<string, unknown>

/** 留存指标编辑后的 definition（保留 start_event.filters / retain_event.filters） */
export function buildRetentionDefinition(
  original: Record<string, unknown>,
  patch: { startEvent: string; retainEvent: string; n: number; measure: 'rate' | 'count'; cohort: string; granularity: string },
): Record<string, unknown>
```

要点：

- **保留未暴露字段**：编辑只覆盖表单字段，`filters`、`alias`、`percentile`、`stage_reduce` 等原样带回（PRD M-6）。实现为「原对象浅拷贝 + 覆盖表单字段」，属性被清空时删除 `prop` 键而非写空串。
- **口径文案与后端一致**：事件/留存的中文标签复用 `features/query/event-metric-editor/analysis-methods.ts#analysisLabel`，不另起一套文案。
- 与告警侧 `alert-metric-eval.service#definitionSummary`（后端摘要素文案）**刻意保持不同粒度**：后端摘要给选择列表用（一行），前端摘要给详情用（多行分字段）。

## 3.1 后端契约补强：定义合并（as-built，验收实测发现）

后端 `normalizeDefinition` 是**按白名单重建**对象，调用方漏传的字段会直接消失。
生产验收实测：`PUT /sa/api/meta/metrics/:id` 只传 `{analysis, event, prop}` 时，
已存的 `filters` / `alias` 被**静默清空**——这些字段在界面上看不到，属于数据破坏级行为。

修复：`MetaSavedMetricService.update` 在规范化之前先合并已存定义
（`src/modules/meta/metric-definition-merge.ts`）：

- `undefined` = 本次未提供 → **保留已存值**（防止误删）；
- `null` = 显式清空 → 覆盖（保留「能删掉筛选」的能力）；
- 留存指标两侧事件分别合并，`startEvent`/`retainEvent` 驼峰写法兼容。

> 前端「保留未暴露字段」的逻辑仍在（双层保险）：前端回传完整定义，后端也不允许部分定义意外丢字段。

## 4. 交互

| 状态 | 行为 |
|---|---|
| 查看 | `Descriptions` 展示元信息 + `Table`/`Descriptions` 展示口径行；底部按钮「编辑」「关闭」；顶部 `Tag` 显示类型（事件/留存）与格式 |
| 编辑 | 同一抽屉切换为 `Form`：显示名列 + 指标名（`Input disabled` + 说明）、类型（只读）、格式、备注；事件指标 → 事件下拉（`GET /meta/events`）+ 计算方法下拉（`ANALYSIS_LABELS`）+ 属性输入（方法需要时必填）；留存指标 → 初始/回访事件下拉 + 周期 n + 口径 + 队列 + 粒度 |
| 保存 | `PUT /sa/api/meta/metrics/:id` → 成功后关闭并刷新列表；失败把后端 message 就地显示（`Alert`） |
| 取消 | 回到查看态（不关闭抽屉），避免用户丢失上下文 |

- 事件下拉取 `GET /meta/events`（失败时降级为「保留当前值」的可输入 Select，不阻塞编辑）。
- 提示文案：① 时间范围不写入指标；② 口径变更会影响引用该指标的分析与告警判定；③ 筛选条件本期不在此编辑。

## 5. 测试

| 文件 | 覆盖 |
|---|---|
| `metric-definition.spec.ts` | 摘要（事件/留存、缺字段回落）、`analysisNeedsProp`、事件载荷保留 `filters/alias`、清空属性删键、留存载荷保留两侧 `filters`、周期/口径透传 |
| `MetricDetailDrawer.spec.tsx` | 查看态渲染关键词、切编辑态、保存调用 `updateSavedMetric` 且载荷含保留字段、失败显示错误 |
| 既有 | `SavedMetricsPage` 无独立 spec；列表改动由构建 + 抽屉 spec 覆盖（如需再补） |

CI：`scripts/build.sh` 前端切片加入 `src/features/metrics`。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 编辑定义改变口径 → 引用它的分析卡片/告警结果变化 | 抽屉内明示影响面；不提供静默批量改 |
| 事件下拉依赖元事件表，事件被删后原值不在列表里 | Select 允许保留原值（`options` 合并当前值），避免一保存就把事件改掉 |
| 指标名/类型被误改 → 打断引用 | 后端 DTO 本就不接受 `name`/`kind`，前端只读展示并说明原因 |
| 与告警绑定的指标被删 | 告警侧健康度已能报「指标已删除」（alerting-v4），删除确认文案保留原样 |
