# 架构设计：ClkLog 分析平台 v1 — M3 事件分析增强 + 漏斗分析

> phase: clklog-analytics-v1
> 上游：`docs/product/prd-clklog-analytics-v1-m3.md`
> 下游：后端/前端实现代码

---

## 1. 总体设计

M3 包含两大能力：

1. **事件分析增强**：在 M2 单指标事件分析基础上，扩展为「多指标 × 全局筛选 × 多维分组 × 多图表」。
2. **漏斗分析**：新增基于 ClickHouse `windowFunnel` 的多步骤转化分析。

核心原则：

- 复用 M2 的 `AttributeResolverService`、虚拟事件/虚拟属性展开、项目过滤红线。
- 每个指标生成一个子查询，最终按分组维度 JOIN/UNION 成结果表。
- 漏斗使用 `windowFunnel` 单查询完成，避免多次扫描 `sa_events`。

---

## 2. DSL 类型扩展

### 2.1 事件分析

```ts
export interface Metric {
  id: string;
  name?: string;                 // 指标别名
  event: string;                 // 事件 key（支持虚拟事件）
  type: MetricType;
  prop?: string;                 // agg/per_user 时使用的属性
  func?: AggFunc;                // agg 类型
  filters?: FilterGroup;         // 指标级筛选
}

export interface EventAnalysisQuery {
  project: string;
  time_range: TimeRange;
  metrics: Metric[];             // 1~3 个
  filters?: FilterGroup;         // 全局筛选
  groups?: Group[];              // 0~2 个
  granularity?: TimeGranularity; // 按时间分组时生效
  limit?: number;                // TopN 默认 20
}
```

### 2.2 漏斗分析

```ts
export interface FunnelStep {
  event: string;
  name?: string;
  filters?: FilterGroup;
}

export interface FunnelQuery {
  project: string;
  time_range: TimeRange;
  steps: FunnelStep[];           // 2~8
  window_seconds: number;        // 默认 7 天 = 604800
  filters?: FilterGroup;         // 全局筛选
  group?: Group;                 // 可选单分组
  limit_window_in_range?: boolean;
  limit?: number;
}
```

---

## 3. 后端设计

### 3.1 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/sa/api/query/event` | 事件分析增强（覆盖 M2 接口，字段兼容） |
| POST | `/sa/api/query/funnel` | 漏斗分析 |

返回统一格式：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "columns": [...],
    "rows": [...],
    "elapsed_ms": 123,
    "sql": "..."
  }
}
```

### 3.2 事件分析 SQL 生成

策略：**每个指标独立子查询，按分组维度 JOIN**。

- 对每个 `metric`，生成与 M2 相同的 `SELECT metric_expr AS m_<id>, group_cols FROM sa_events WHERE ... GROUP BY group_cols`。
- 若存在多个指标，用 `FULL OUTER JOIN` 按所有分组列连接；ClickHouse 使用 `ALL FULL OUTER JOIN`。
- 若仅 1 个指标，直接返回子查询。
- 全局筛选注入到每个子查询的 `WHERE` 中。
- 时间粒度分组时，`group_cols` 包含 `toStartOfDay(event_time)` 等表达式。

示例（2 指标，按天分组）：

```sql
SELECT
  COALESCE(a.g_0, b.g_0) AS day,
  a.m_1 AS page_views,
  b.m_2 AS purchases
FROM (
  SELECT toStartOfDay(event_time) AS g_0, count() AS m_1
  FROM sa_events
  WHERE project_name = {project: String}
    AND event = 'PageView'
    AND stat_date BETWEEN ...
  GROUP BY g_0
) a
ALL FULL OUTER JOIN (
  SELECT toStartOfDay(event_time) AS g_0, count() AS m_2
  FROM sa_events
  WHERE project_name = {project: String}
    AND event = 'Purchase'
    AND stat_date BETWEEN ...
  GROUP BY g_0
) b ON a.g_0 = b.g_0
ORDER BY day
LIMIT {limit: UInt32}
```

### 3.3 漏斗分析 SQL 生成

使用 ClickHouse `windowFunnel`。

```sql
SELECT
  level,
  count() AS users,
  group_col
FROM (
  SELECT
    distinct_id,
    group_col,
    windowFunnel({window_seconds: UInt32})(
      event_time,
      event = 'Step1' AND cond1,
      event = 'Step2' AND cond2,
      ...
    ) AS level
  FROM sa_events
  WHERE project_name = {project: String}
    AND stat_date BETWEEN {start: String} AND {end: String}
    AND (global_filter)
  GROUP BY distinct_id, group_col
)
GROUP BY level, group_col
ORDER BY level, group_col
```

- 全局筛选注入外层 `WHERE`。
- 每步条件注入 `windowFunnel` 的参数列表。
- 虚拟事件在第 1~N 步展开为 `event IN (...)` + 该虚拟事件的全局筛选。
- 分组时，`group_col` 取第 1 步事件的分组属性（用户属性走子查询，事件属性直接取）。
- 结果服务层把 `level` 行转列，计算每步人数、转化率、流失人数。

### 3.4 缓存

沿用 M2 的 Redis 缓存：key = `sha256(规范化 DSL)`，TTL 5min。多指标 DSL 的 key 排序递归进行。

### 3.5 模块改造

| 文件 | 改动 |
|------|------|
| `event-sql-generator.service.ts` | 支持 `metrics` 数组、多指标 JOIN、指标级 filters |
| `event-query.service.ts` | 兼容新 DSL，结果列拼接 |
| `funnel-sql-generator.service.ts` | 新增 windowFunnel SQL 生成 |
| `funnel-query.service.ts` | 新增校验、缓存、查询、结果整形 |
| `funnel-query.controller.ts` | 新增 `POST /query/funnel` |
| `dsl-validator.service.ts` | 新增 `validateFunnelQuery`、扩展 `validateEventQuery` |
| `attribute-resolver.service.ts` | 无需改动，复用 |

---

## 4. 前端设计

### 4.1 组件规划

| 组件 | 说明 |
|------|------|
| `EventAnalysisPage` | 页面容器，左侧配置面板 + 右侧结果 |
| `EventAnalysisForm` | 多指标编辑器、全局筛选、分组、时间范围 |
| `MetricEditor` | 扩展为指标卡片：事件、类型、属性、筛选、别名 |
| `EventAnalysisResult` | 图表/表格切换、多指标结果展示 |
| `FunnelAnalysisPage` | 页面容器 |
| `FunnelEditor` | 步骤列表、全局筛选、窗口期、分组 |
| `FunnelStepEditor` | 单步：事件、别名、筛选 |
| `FunnelResult` | 漏斗图、转化/流失切换、明细表格 |
| `ChartRenderer` | 扩展饼图支持 |

### 4.2 状态管理

沿用 `analysis.store.ts`，新增：

- `eventQuery`：多指标、全局筛选、分组。
- `funnelQuery`：步骤、窗口期、分组。

### 4.3 路由

已存在 `/analysis/event` 与 `/analysis/funnel`，无需新增。

---

## 5. 数据模型

无新增 MySQL 表。漏斗模板（F8）本次不做，因此无需 `MetaFunnelTemplate`。

ClickHouse 查询继续使用 `clklog_sa.sa_events`，所有查询带 `project_name` 过滤。

---

## 6. 关键算法

### 6.1 多指标 JOIN 对齐

- 每个子查询的 `GROUP BY` 列顺序、别名必须一致。
- 无分组时直接 UNION ALL 并加 `metric_id` 列，前端 pivot。
- 有分组时使用 `ALL FULL OUTER JOIN`，用 `COALESCE` 回填 NULL 为 0。

### 6.2 漏斗结果整形

ClickHouse 返回每用户最大转化深度 `level`。服务层按分组聚合：

```
step_i_users = count(level >= i)
step_i_conversion = step_i_users / step_{i-1}_users
step_i_churn = step_{i-1}_users - step_i_users
```

返回表格行：总体 / 各分组；列：步骤 1..N 人数、转化率、流失人数。

---

## 7. 性能与红线

- 事件分析最多 3 指标、2 分组、TopN 20。
- 漏斗最多 8 步、1 分组。
- 所有查询强制 `project_name` 过滤 + `stat_date` 范围 + `LIMIT`。
- 虚拟事件/属性在 SQL 生成阶段展开，不修改社区版表。

---

## 8. 实施顺序

1. 后端：扩展 `EventAnalysisQuery` DSL 与 `event-sql-generator` 多指标。
2. 后端：实现漏斗 SQL 生成器、服务、控制器。
3. 前端：扩展 `MetricEditor`、`EventAnalysisForm`、`EventAnalysisResult`。
4. 前端：实现 `FunnelEditor`、`FunnelResult`、`FunnelAnalysisPage`。
5. 集成测试：多指标 JOIN、漏斗窗口期、转化率计算。
