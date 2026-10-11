# 实现方案：分析工作台布局 + 留存分析 v1

> phase: clklog-analytics-workbench-v1
> 上游：`docs/product/prd-clklog-analytics-workbench-v1.md`
> 契约对齐：`docs/architecture/clklog-analytics-design.md` §8.4 / §9、`apps/analytics-server/src/types/dsl.types.ts` 的 `RetentionQuery`

---

## 1. 阶段目标与范围

实现 PRD 的窄配置工作台、步骤卡片、筛选弹出层，以及留存 SQL/API/前端/看板刷新。漏斗 SQL 增加步骤事件 `IN` 收窄，降低超时。

## 2. 验收标准

与 PRD §2 WB-1~WB-10、WB-13～WB-15 一一对应。单测至少覆盖：

- 留存 SQL：含 `project_name`、`stat_date` 上界外延、`LIMIT`、`is_first_day`（first_day）、事件名走参数、`'; DROP` 不进入 SQL 字面量。
- `DslValidatorService.validateRetentionQuery` 拒绝空事件、非法 n_list、非法口径。
- 前端 `buildRetentionQuery` 把表单映射为后端 `RetentionQuery`。
- 漏斗 `QueryStep`：默认不渲染别名输入；点击标题后出现；折叠钮隐藏步骤体。
- 分析事件选择器 `EventSelect`：按 `keyword` 请求列表，不把搜索限制在已加载的首页选项；hidden 事件不进选项。
- `FilterEditor`：0～1 条不渲染且/或；≥2 条在条目之间渲染同层逻辑；可添加条件组，深度 ≤ 3。

## 3. 非目标

与 PRD §3 相同。不抽取新的 `common/utils` 包；筛选弹出层辅助函数放在 `features/query`。

---

## 4. 前端结构

| 文件 | 职责 |
|------|------|
| `features/query/AnalysisWorkbench.tsx` + `.css` | 左 280px / 右 1fr；split/stack 由 `clklog-analytics-shell-responsive-v1` 档位驱动，不再用 800px 容器查询作为主决策 |
| `features/query/QueryStep.tsx` | 分区卡片；`index` 仅同级列表传入；漏斗步 `collapsible` + 点击标题才改名 |
| `features/query/select-popup.ts` | `getPopupContainer → document.body` |
| `EventAnalysisForm` / `FunnelEditor` / `RetentionEditor` | 改用 QueryStep；事件分析指标内选事件，无单独事件分区；事件下拉用 `EventSelect` |
| `components/EventSelect.tsx` | 远程搜索：`GET /meta/events?keyword=&pageSize=100&exclude_hidden=true`，`filterOption=false`，不在前端截断全量列表 |
| `FilterEditor` / `MetricEditor` / `GroupEditor` | 纵向排字段；Select 走 portal；筛选且/或在条件之间，条件组递归最多 3 层 |
| `stores/retention.store.ts` | 与 event/funnel store 同形 |
| `pages/Analysis/RetentionAnalysisPage.tsx` | 工作台 + 卡片还原 `?card=` |

左栏 `overflow-y: auto`。下拉必须 portal，因为 `overflow-y: auto` 会把 `overflow-x` 一起变成裁切。

## 5. 留存 DSL 与 SQL

后端权威类型已是：

```
RetentionQuery {
  project, start_event: {event, filters?}, retain_event: {event, filters?},
  cohort: 'first_day' | 'all',
  granularity: 'day' | 'week' | 'month',
  n_list: number[],
  time_range
}
```

前端表单映射到该结构；HTTP 仍走 `x-project-name`，service 内 `project = header || body`。

`n_list`：1~31 个互异正整数，每个 ∈ [1, 90]，默认 `[1,7,30]`。

粒度桶：

- day → `toDate(stat_date)`，偏移 `addDays`
- week → `toMonday(stat_date)`，偏移 `addWeeks`
- month → `toStartOfMonth(stat_date)`，偏移 `addMonths`

扫描窗口：`stat_date BETWEEN time_range.start AND time_range.end` 的上界再加 `max(n_list)` 个对应粒度单位，以便算第 N 期回访。队列日期仍限制在用户选择的 `time_range` 内。

`retention()`：第 1 条件 = 桶等于队列桶；随后每个 n 一条「桶 = 队列桶偏移 n 且命中回访事件（含虚拟事件展开与回访筛选）」。`r[1]` 为入组，`r[k+1]` 为对应 `n_list[k]`。

`cohort=first_day`：`minIf(桶, 初始事件条件 AND is_first_day = 1)`。  
`cohort=all`：`minIf(桶, 初始事件条件)`。

用户键：`if(user_key != '', user_key, distinct_id)`，与事件/漏斗一致。

外层 `GROUP BY cohort_date ORDER BY cohort_date LIMIT 366`。

虚拟事件：复用 `MetaVirtualEventService.findDefinition`，与漏斗相同 `event IN (...)` + 定义筛选。

## 6. API 与卡片

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/sa/api/query/retention` | body=`RetentionQuery`，`?refresh=true` 跳过缓存 |

响应：`{ columns, rows, elapsed_ms, sql, from_cache }`。列：`cohort_date`、`cohort_size`、`n_{n}`、`n_{n}_rate`。

`CardService.computeResult` 的 `retention` 分支改为 `RetentionQueryService.analyze(..., true)`。看板 `CardWidget` 允许刷新留存卡；`chart_type=line` 画各 N 留存率，`table`/`bar`/`number` 走现有渲染（line 时把 `n_*_rate` 当作指标列）。

## 7. 漏斗超时

`FunnelSqlGeneratorService` 在 `sa_events` 扫描 WHERE 增加步骤（含虚拟展开）事件的 `event IN {funnel_events: Array(String)}`。不改变 windowFunnel 语义；禁止再加 `AND step_0`（会丢掉第 2 步及之后的事件行，异事件漏斗转化恒为 0）。

## 8. 示例卡

不入库种子。部署后在当前项目：用可见事件填三页示例并保存到已有看板（或卡片库）。卡片 `dsl._form` 仍用于分析页还原。
