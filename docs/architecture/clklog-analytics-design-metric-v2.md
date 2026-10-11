# 设计：指标 v2 契约与实现（口径保真 / 查询时间 / 取值选择）

- `phase: clklog-analytics-metric-v2`
- 关联 PRD：`docs/product/prd-clklog-analytics-metric-v2.md`
- 关联实现：`meta-saved-metric.service.ts`、`metric-definition-merge.ts`、`types/dsl.types.ts`、`metric-normalize.ts`、`event-query.service.ts`、`alert-metric-eval.service.ts`、`features/metrics/*`

## 1. 现状与差距（代码级）

| 位置 | 现状 | 差距 |
|---|---|---|
| `MetaSavedMetric.definition_json` | 文本列，事件指标形如 `{metric:{kind,event,analysis,prop,percentile,filters,alias,type,func}}` | 无 `transform`、无 `stage_reduce`、无 `time_range`、无 `subject_id`、无版本号 |
| `MetaSavedMetricService.normalizeDefinition`（event 分支） | **按白名单重建**：只保留上述 8 个键 | 卡片上的数值变换/阶段总和**静默丢失**（PRD §1 保真缺陷） |
| `metric-definition-merge.ts` | 事件分支 `{...stored, metric: {...storedMetric, ...pickDefined(incoming)}}` | 能承载新键，但需补「显式清空」与 v2 校验 |
| 分析 DSL `MetricItem` / `EventAnalysisQuery` | 已有 `analysis/percentile/stage_reduce/transform/event/prop/filters/type/func`、`time_range`、`subject_id`、`approx` | 字段齐全，指标只需**映射**而非重造 |
| 求值归并 `metric-normalize.ts` | `mixStageMetricValue(reduce, daily, overall)`；`defaultStageReduce(analysis)`；不可加方法（`uniq_total`/`weighted`）必须用整段结果 | 现有能力直接复用即可，无需新 SQL |
| 告警求值 `alert-metric-eval.service.ts` | `compute()` 用**规则的 `window_days`** → `windowRange(days)` 拼 `time_range` | 时间范围应来自**指标定义**，规则仅在覆盖时生效 |
| 指标编辑器 `MetricDetailDrawer` | 只编辑 显示名/格式/备注 + 事件/计算方法/属性 | 需与 `EventMetricCard` 同深度 |

结论：**引擎与分析 DSL 已经具备全部能力，缺的是指标层的字段契约、求值接线与界面**。

## 2. 数据契约：`definition_json` v2

事件指标定义（版本化，缺 `definition.version` 视为 v1 legacy）：

```jsonc
{
  "version": 2,
  "metric": {
    "kind": "event",
    "event": "base_performance_httprequest_report",
    "analysis": "sum",
    "prop": "$request_time_ms",
    "percentile": null,
    "filters": { "logic": "and", "items": [
      { "scope": "event", "prop": "status", "op": "in", "value": ["200", "304"] },
      { "scope": "user", "prop": "city", "op": "=", "value": "上海" }
    ] },
    "transform": { "factor": 0.001, "decimals": 2 },
    "value_pick": "avg",
    "time_range": { "start": "", "end": "", "relative": { "kind": "past_n", "n": 7 } },
    "subject_id": null,
    "alias": "近 7 天平均响应时间",
    "type": null,
    "func": null
  },
  "time_source": "metric"
}
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `version` | int | 缺省 = 1 | 2 表示本契约；服务端写入时总是落 2 |
| `metric.value_pick` | 见 §3.2 | `null` = 自动 | **UI 名「取值选择」**；与卡片 `stage_reduce` 同值域（+`first_day`/`last_day`） |
| `metric.time_range` | `TimeRange`（**只允许 `relative`**） | 缺省 = 规则窗口（legacy） | UI 名「查询时间」；上限 90 天（`calendarDaysInclusive` 校验） |
| `metric.transform` | `{factor?, decimals?}` | 缺省 | 与卡片一致：先乘系数，再保留小数位 |
| `metric.subject_id` | string \| null | null（用户主体） | 保真保存分析主体 |
| `time_source` | `'metric' \| 'rule'` | 新指标 `metric`，迁移前 `rule` | 兼容开关，见 §5 |

**为什么不新造字段名 `stage_reduce` → `value_pick`**：值域相同、语义相同，但 `first_day`/`last_day` 是新的（卡片 UI 不暴露）。存 `value_pick` 是为了让「指标口径」自成一档，应用回分析页时做一对一映射（`first_day`/`last_day` → `stage_reduce` 缺省 + 提示「该取值仅在指标求值时生效」，见 PRD §4.3）。

**规范化（`normalizeDefinition` event 分支）改为**：
1. 白名单补 `transform`、`value_pick`、`time_range`、`subject_id`，并写 `version: 2`；
2. 保留既有键（`analysis/percentile/prop/filters/alias/type/func`）；
3. 校验：`event` 必填（现状）；`value_pick` 必须在值域内；`time_range.relative.kind` 必须在 `TIME_RANGE_RELATIVE_KINDS` 内且解析后跨度 ≤ 90 天；`transform.factor` 有限数、`decimals` 为 0–6 整数；`filters` 交给 `DslValidatorService` 的过滤器规则复用校验。
4. **显式清空**语义：`null` = 删除该键；缺省 = 保留（`mergeMetricDefinition` 已有此语义，补新键即可）。

## 3. 求值口径

### 3.1 时间范围解析（唯一入口）

```
resolveMetricWindow(definition, ruleWindowDays?) →
  time_source == 'metric' 且 definition.metric.time_range.relative ?
      materializeTimeRange(range, shanghaiTodayYmd())            // 复用 query/time-range.ts
    : windowRange(ruleWindowDays)                                // legacy：规则窗口（现状）
```

- 复用 `apps/analytics-server/src/modules/query/time-range.ts`，**不新写时间解析**；
- 上海时区与既有 `shanghaiTodayYmd()` 同源，避免 8 小时错位（HANDOVER §12 踩过）；
- 跨度上限 90 天：解析后 `calendarDaysInclusive(start, end) ≤ 90`，否则 400。

### 3.2 取值归并

求值链路（事件指标）：

```
EventQueryService.analyze({ event, metrics:[metric], filters, time_range, groups:[] })
  → rows: 单行聚合（当前 group by 日粒度的 daily 序列 + overall 整段值）
  → mixStageMetricValue(pick, daily, overall)      // 复用 metric-normalize.ts
  → transform（先乘 factor，再按 decimals 取整）
  → 指标值
```

| `value_pick` | 归并实现 | 备注 |
|---|---|---|
| `null`（自动） | `defaultStageReduce(analysis)` | 现状行为，兼容 |
| `sum` / `avg` / `max` / `min` | `stageReduceNumbers(daily, pick)` | 直接用现有函数 |
| `uniq_total` / `weighted` | `overall`（整段值） | 不可加方法**必须**走这里 |
| `first_day` / `last_day` | `daily[0]` / 最后一个非空值 | **新增**：取不到值（窗口内无数据）→ 返回 `null`，与现有「求值为空跳过本轮」一致 |
| `transform` | 最后一步，且**只作用于指标值，不作用于日序列展示** | 与卡片一致（卡片在展示层做） |

**校验与提示**：`methodAllowedForDataType(analysis, dataType)` 与 `defaultStageReduce` 已是既有实现；新取值集合需通过 `isAdditiveMethod(analysis)` 判断——不可加方法选 `sum`/`avg`/`max`/`min`/`first_day`/`last_day` 时**允许保存但给界面警告**（值仍按用户所选计算，避免「被系统悄悄改口径」）。这条与 PRD AC-6 对应。

## 4. API 变更

| 方法 | 路径 | 变更 |
|---|---|---|
| POST | `/sa/api/meta/metrics` | 请求体不变；`definition_json` 支持 v2（缺省字段按 §2 补齐默认）；新增 400 场景：查询时间跨度 > 90 天、`value_pick` 非法、`filters` 非法 |
| PUT | `/sa/api/meta/metrics/:id` | 不变；merge 语义扩展到新键 |
| POST | `/sa/api/meta/metrics/preview` | **新增**：`{ kind:'event', definition_json, time_range? }` → `{ value, value_fmt, series:[{date,value}], reduce, reduce_reason, window:{start,end,label}, elapsed_ms }`；按**项目过滤 + 只读账号 + LIMIT/超时**执行（红线 4），不落库、不缓存 |
| GET | `/sa/api/meta/metrics` | 响应补 `definition_summary`（含「查询时间 · 取值」） |
| POST | `/sa/api/ops/alerts/rules` / `PUT` | 请求新增可选 `time_source`（默认 `metric`，legacy 规则保持 `rule`）；probe 响应补 `window_source` |

审计：`POST/PUT metrics` 写 `ops_action_log`（`action=alert_metric_update`，detail 记录改动字段名与新旧值，敏感值不落明文——筛选条件值按现有审计脱敏规则处理）。

## 5. 告警联动与兼容

| 场景 | 行为 |
|---|---|
| 迁移前的规则/指标（`time_source` 缺省） | 视为 `rule`：窗口仍取 `rule.window_days`，行为与线上现状**完全一致**（AC-10） |
| 新建指标 | `time_source: 'metric'`；规则窗口字段仍会写入（兼容旧读路径），但求值不读它 |
| 编辑指标后 | `time_source` 切为 `metric`；同时 `AlertMetricEvalService` 的指标缓存（TTL）需失效（现在已有 `loadMetric(fresh)`） |
| 规则窗口 vs 指标查询时间同时存在 | 求值时**以 `time_source` 为准**，不做「取交集」这类隐式合并（避免无法解释的窗口） |
| 模板变量 | `{{.window}}` 取指标查询时间的文案（`windowLabel` 已有，补 relative 版本） |

**迁移脚本**（幂等，随发版执行）：对 `metasavedmetric` 全表扫描 `definition_json`：补 `version: 2`、补 `time_source: 'rule'`（不改其它字段）；`value_pick` 保持缺省（= 自动），因此**迁移后所有既有指标值不变**。

## 5.1 实现记录与偏差（2026-09-16 落地，版本 17259）

| 项 | 设计原文 | 实际实现 | 原因 |
|---|---|---|---|
| 试算接口位置 | `POST /sa/api/meta/metrics/preview`（meta 模块） | **路径不变**，控制器落在 `query/metric-eval.controller.ts` | `QueryModule` 已 `imports MetaModule`（指标元数据要读），反向在 Nest 里会成环；路径与权限（`metric.view`）保持承诺不变 |
| 存量数据迁移 | 「迁移脚本（幂等，随发版执行）补 version 与 time_source」 | **未做数据回填**：读取侧把缺省 `version` 当 v1、缺省 `time_source` 当 `rule`，下一次保存自然写成 v2 | 回填会改全表 `definition_json` 却不改变任何行为；读取侧兜底更安全（避免「发版即批量写数据」）。**发版后核实：7 条存量规则 `time_source=rule`，其指标无 `time_range`/`value_pick`，求值仍是原来那条无分组聚合 SQL** |
| 规则侧开关 | 设计里 `time_source` 挂在定义上 | 定义上传 `time_source`（写入用），**另加 `alertrule.time_source` 列**（迁移 `20260916210000`，默认 `rule`） | 「一条指标被两条规则分别用不同窗口」需要规则级覆盖；DB 默认 `rule` 保证存量规则行为不变 |
| 归并边界 | 「first_day/last_day 取 daily[0] / 最后一个非空值」 | `sum`/`avg`：缺日按 0（`avg` 除以**窗口天数**）；`max`/`min`/`first_day`/`last_day`：只取**有数据的日子**（窗口内全无数据 → `null`，检测器跳过本轮而非当 0） | 避免「今天还没数据就先报 0」，与既有「求值为空跳过本轮」的约定一致 |
| 文案一致性 | 未写 | 后端 `relativeRangeLabel` 与前端 `metricWindowLabel` **同一批字面量**（`近 7 天（含今天）` / `过去 7 天（不含今天）`），两侧各有用例锁住 | 三处（告警预览、指标列表、通知模板）各写一套会导致「近 7 天」与「最近7天」同时出现 |
| 数值变换生效位置 | 「最后一步，只作用于指标值」 | 实现同设计；**注意**：此前数值变换在保存时被丢弃，因此「带变换的指标」是本次才可能出现，只影响新保存的指标 | — |

## 6. 前端实现

| 复用 | 位置 | 说明 |
|---|---|---|
| 条件组编辑器 | `components/FilterEditor.tsx` | 指标编辑器的「条件组」直接复用，不复制 |
| 方法/属性联动 | `features/query/event-metric-editor/analysis-methods.ts` | `ANALYSIS_LABELS`/`methodsForDataType`/`STAGE_REDUCE_OPTIONS`/`PERCENTILE_PRESETS` + **新增** `VALUE_PICK_OPTIONS`（含说明文案）与 `pickLabel()` |
| 分析主体 | `features/subject/SubjectSelect.tsx` | 复用 |
| 时间范围 | `features/time-range/*` | 复用相对范围选择器（指标只允许相对） |
| 编辑表单 | `features/metrics/MetricDefinitionForm.tsx`（新） | 抽屉内嵌，受控组件；`metric-definition.ts` 的 `buildEventDefinition` 扩展为覆盖全部 v2 字段（含「显式清空」） |
| 描述文案 | `features/metrics/metric-definition.ts` | `describeMetric` 补「查询时间」「取值」两行；`shortSummary` 用 `查询时间 · 取值` |

**抗回归**：`buildEventDefinition` 必须做到「界面没动的字段逐字节保留」——用 PRD AC-8 的快照用例锁住（保存未修改的指标 → `definition_json` 不变）。

## 7. 红线与有界性

- 试算/求值全部走**只读 ClickHouse 账号**，强制 `project_name` 过滤 + 时间上限 90 天 + `LIMIT`/超时（红线 4）；
- 指标口径变更写审计，不静默改变告警语义（红线 6 的「不静默改写」精神）；
- 不新增环境变量读取（棘轮 envReaders 只减不增）；
- 不触碰社区版表与数据链路（红线 1）。

## 8. 测试策略

| 层 | 用例 |
|---|---|
| 单测（后端） | `metric-normalize` 扩展：`first_day`/`last_day`/不可加方法；`normalizeDefinition` v2 白名单与默认补齐；`resolveMetricWindow`（metric/rule 两种来源、90 天上限、时区）；迁移脚本幂等 |
| 单测（前端） | `metric-definition.spec.ts` 扩展：九字段 round-trip；`buildEventDefinition` 不改动字段的快照；`VALUE_PICK_OPTIONS` 文案与默认推导 |
| 交叉验证 | 同一 fixture：**试算接口值 == 告警 probe 值 == 分析页应用后查询值**（PRD AC-7 的自动化版本） |
| 契约 | `definition_json` v2 的 JSON Schema 校验（复用 `dsl-validator` 的过滤器规则），v1 读路径兼容 |
| 线上验收 | 用线上指标 `http_report_count` 做三件事：试算值 == 告警 probe 值；改查询时间为「近 7 天日均」后，告警窗口文案与值同步变化；既有规则未编辑时值不变 |

## 9. 实施顺序

1. **P0-a 契约修复（可独立发版）**：`normalizeDefinition`/`merge` 补 `transform`、`stage_reduce`，round-trip 与快照用例；此时卡片→指标→卡片已保真。
2. **P0-b 编辑器**：`MetricDefinitionForm` 接入抽屉（九个区），条件组可编辑；列表补摘要与「新建指标」。
3. **P1-a 求值链路**：`value_pick`/`time_range` 字段 + `resolveMetricWindow` + 归并扩展（`first_day`/`last_day`）+ 审计。
4. **P1-b 试算与告警联动**：`POST metrics/preview`、告警抽屉的「跟随指标」、迁移脚本与回归用例。
5. **P2**：留存查询时间、卡片以指标为数据源（另开 phase）。

每步都可单独发版且不破坏现有行为；`time_source` 与 `version` 两个兼容闸门保证「迁移前后值一致」。
