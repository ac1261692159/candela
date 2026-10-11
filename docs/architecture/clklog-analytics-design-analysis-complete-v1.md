# 实现方案：分析补齐（任意事件 / 创建指标 / 虚拟事件属性）

> phase: clklog-analytics-analysis-complete-v1
> 上游：`docs/product/prd-clklog-analytics-analysis-complete-v1.md`

---

## 1. 阶段目标与范围

与 PRD 三块相同。查询仍有界：`project_name` + 时间 + LIMIT/超时。任意事件只少事件谓词。

## 2. 验收标准

与 PRD AC-1～AC-7 对应。交付前 `python3 scripts/arch_ratchet.py` 通过。

## 3. 非目标

与 PRD §3 相同。不扩大 `utils/`。指标 CRUD 落 `modules/meta`，求值落 `modules/query`。

## 4. 任意事件

`ANY_EVENT = '*'`。`EventSelect` 在漏斗步、留存初始/回访加 `showAnyEvent`。

- 漏斗步 / 留存谓词：`*` 时不写 `event =` / `event IN` 该步；仅筛选。
- 漏斗 `event IN {funnel_events}`、留存 `event IN {retention_events}`：任一侧为 `*` 则整段省略（否则任意事件扫不到）。
- 校验：`event` 非空即可，允许 `*`。

## 5. 创建指标

表 `MetaSavedMetric`（`clklog_sa_meta`）：

- `metric_id`：`metric_` + nanoid(10)
- `project_name`、`owner`
- `name`：`^[a-z][a-z0-9_]{0,79}$`，项目内唯一
- `display_name`、`remark`（≤200）
- `kind`：`event` | `retention`
- `definition_json`、`format`：`number` | `percent`

事件定义：一条 `MetricItem`（非公式）。留存定义：`start_event` / `retain_event` / `cohort` / `granularity` / `n` / `measure`（`rate`|`count`）。**不含时间窗**。

API：`/sa/api/meta/metrics` CRUD。套用只读定义，在前端填回表单。

## 6. 虚拟事件 / 属性

`EventSelect` 并行拉 `/meta/events` 与 `/meta/virtual-events`。可见虚拟事件始终可被搜到；keyword 匹配显示名、`ve_id`、来源事件 key。选项 `{display}（虚拟）`。

`GET .../events/:eventKey/properties`：若 `eventKey` 是虚拟事件，改为来源事件属性并集（按 `prop_key` 去重）。

`GET /meta/virtual-properties?event_key=`：虚拟事件时并来源事件绑定 + `event_key` 为空的全局虚拟属性。

## 7. 结构

| 位置 | 职责 |
|------|------|
| `EventSelect` | 任意事件 + 合并虚拟事件 |
| `funnel-sql-generator` / `retention-sql-generator` | 省略事件谓词 / IN |
| `modules/meta/meta-saved-metric.*` | 指标库 |
| `features/metrics/` | 创建弹层、套用、指标页 |
| `meta-property` / `meta-virtual-property` | 虚拟事件属性并集 |
