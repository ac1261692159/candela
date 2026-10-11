# 近似计算方案（clklog-analytics-approx-compute-v1）

> phase: clklog-analytics-approx-compute-v1
> 状态：实现 · 日期：2026-09-10
> 上游：`docs/product/prd-clklog-analytics-approx-compute-v1.md`、HANDOVER §11.2

---

## 1. 阶段目标与范围

事件分析去重类指标可选用 `uniqCombined(12)`。漏斗 / 留存本期不做。查询仍有界：`project_name` + 时间窗 + LIMIT/超时 + 现有 `max_memory_usage`。

## 2. 技术选型

| 手段 | 适用 | V1 |
|---|---|---|
| **A. uniq 概率函数** | 事件分析 UV / 去重 | **做** |
| B. 预聚合表 | 固定口径日汇总 | 数据管理路线，不做 |
| C. 分区裁剪 | 已有按月分区 | 已有 |
| D. SAMPLE BY | 需重建 sa_events | 不做 |

漏斗 / 留存现 SQL 是 `GROUP BY uid` 再 `count()`，不是 `uniqExact`。换函数几乎无收益，V2 才考虑改形状。

## 3. 契约

### 3.1 DSL

```ts
// EventAnalysisQuery 可选
{ approx?: boolean }  // 缺省 / false = 精确；true = 近似
```

漏斗 / 留存 DSL **不加** `approx`。校验：有该字段且非 boolean → 400。

### 3.2 SQL

精度 12，ClickHouse 写法：

- 主体去重：`uniqExactIf(expr, pred)` → `uniqCombinedIf(12)(expr, pred)`
- 属性去重：`uniqExact(expr)` → `uniqCombined(12)(expr)`

覆盖指标：`trig_user_num`、`per_capita_times` / `per_capita_num` 的分母、`distinct`、`array_distinct`、`array_item_distinct`。`uniq_total` 走同一 SQL 生成器，自动跟随。

不覆盖：`count` / `sum` / `avg` / 分位 / 方差 / 布尔计数。

缓存：`EventQueryService` 以规范化后的 DSL（含 `approx: true|false`）为 key，且 SQL 文本不同，不会串味。

### 3.3 资源

不放宽 `max_threads`（分析查询已是 4）、不放宽 `max_memory_usage`。对拍不受本开关影响。

## 4. UI

事件分析：计算按钮左侧可勾选「近似计算」。漏斗 / 留存 checkbox 保持 disabled。

结果区 Tag「近似」。卡片保存 `dsl.approx`；看板事件卡刷新走同一 `analyze()`。

## 5. 结构

| 文件 | 职责 |
|------|------|
| `subject-expr.ts` | `uniqSubject` / `uniqExpr`（approx 切换） |
| `event-sql-generator.service.ts` | 按 `query.approx` 生成函数 |
| `dsl-validator.service.ts` | `approx` 类型 |
| `EventAnalysisForm` / `dsl-builder` | checkbox 与 DSL |
| `EventAnalysisResult` | 「近似」标记 |

## 6. 验收 / 非目标

与 PRD AC-1～AC-8、§3 相同。交付前 `python3 scripts/arch_ratchet.py` 通过。

## 7. 后续

| 期 | 内容 |
|---|---|
| V2 | 预聚合表（固定口径 DAU/总量） |
| V3 | 漏斗/留存若要近似，须改 SQL 形状，不是换 uniq 函数；SAMPLE 随大版本迁移 |
