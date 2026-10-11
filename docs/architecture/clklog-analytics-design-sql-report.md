# 实现方案：自定义 SQL 分析（SqlReport）

> phase: clklog-analytics-sql-report
> 版本：v1.3（2026-09-21）｜ 上游：`docs/product/prd-clklog-analytics-sql-report-v1.md`、`docs/architecture/analytics-extension-plan.md`、`docs/architecture/clklog-analytics-design.md` §5/§6
> v1.3 变更：新增 §11.5 扫描过滤守卫、§9.1 长查询流式送达契约（含预算错误机器码）、§14 长查询送达与扫描守卫（phase `clklog-analytics-sql-longquery-delivery-v1`）。
> 本文档是自定义 SQL 分析的**查询模型、API、数据契约、安全边界**的唯一权威（SSOT）。布局/交互/错误提示见 PRD。
> AI 页面桥权威：`docs/architecture/clklog-ai-analytics-design.md` §14

---

## 1. 阶段目标与范围（门禁要素①）

交付带元数据辅助的自定义 SQL 分析器，两种互斥模式（Builder / SQL），执行走安全限额。本期不做专用只读账号隔离（留 TODO）。

## 2. 验收标准（门禁要素②）

- [ ] **SR-1**：`GET /sa/api/report/schema` 返回聚合元数据字典（事件/事件属性/用户属性/系统字段/物化状态）。
- [ ] **SR-2**：`POST /sa/api/report/sql/execute` 强制 `time_range`（默认近 7 天，最大跨度 90 天）+ 强制 `LIMIT`（默认 1000，上限 100000）+ 资源限额（`max_rows_to_read`/`max_bytes_to_read`/`max_memory_usage`/`max_result_bytes`/`max_threads`）+ 超时（2026-09-09 起随全局 `query.maxExecutionTime`=300s）。
- [ ] **SR-3**：AST 解析校验（非正则）：仅允许 SELECT；禁止 `INSERT/ALTER/DROP/ATTACH/DETACH/TRUNCATE/RENAME/SYSTEM/KILL/OPTIMIZE`；禁止表函数（`remote`/`url`/`s3`/`file`/`mysql` 等）、`system.*`、`information_schema`、其他库、`FORMAT`、`SETTINGS`、`INTO OUTFILE`。
- [ ] **SR-4**：`project_name` 从认证上下文取得，**不接受 SQL 自带的项目值**；对每个 `sa_events` / `sa_user_profiles` 数据源注入 `project_name` + `stat_date`（表名归一到 `clklog_sa.*`，ClickHouse `additional_table_filters`；不包 `SELECT *` 子查询）。
- [ ] **SR-5**：两种互斥模式：Builder（DSL 为 SSOT，服务端生成 SQL，编辑器只读）与 SQL（SQL 为 SSOT，字典只插片段，不隐形合并分组/筛选）。
- [ ] **SR-6**：用户属性 JOIN 使用 `sa_user_profiles`（含 `project_name` 列），按 `(project_name, distinct_id)` 关联，取 `argMax(properties, updated_at)` 最新画像，避免 ReplacingMergeTree 未合并导致事件放大。
- [ ] **SR-7**：保存报表含 `mode`、`sql_text`/`dsl`、`field_map`、`chart_config`、`schema_version`；SQL 卡片存完整执行规格快照。
- [ ] **SR-8**：属性值/事件名/别名统一转义，筛选值参数化；`sample_value` 默认脱敏。
- [ ] **SR-9**：SQL 编辑器保持受控 React 状态，并通过 AI Page Bridge 的 revision/diff/确认协议读写；AI 编辑确认与 SQL 执行确认分离。

## 3. 非目标（门禁要素③）

- 不做专用只读账号隔离（TODO，见 §12.4）。
- 本文档不重复定义 AI Runtime、面板或 Page Bridge；统一以 `clklog-ai-analytics-design.md` 为权威。
- 不触碰社区版 `clklog`；不做跨项目；不做多语句（仅单条 SELECT）；不做留存/调度。

---

## 4. 查询模型与两种互斥模式

### 4.1 Builder 模式（默认，面向非技术分析师）

- DSL（分组/筛选/指标配置）是 **SSOT**；服务端根据 DSL 生成 SQL；编辑器**只读展示**生成的 SQL。
- 执行链路：`DSL → 服务端生成 SQL → AST 校验 → 逻辑表改写 → 参数绑定 → 执行`。

### 4.2 SQL 模式（面向懂 SQL 的分析师）

- SQL 文本是 **SSOT**；数据字典仅「插入片段」到编辑器，**不参与执行时合并**（无隐形改写，用户看到的 SQL == 执行语义，除强制安全注入外）。
- 执行链路：`SQL → AST 校验 → 逻辑表改写（注入 project + time）→ 参数绑定 → 执行`。

### 4.3 逻辑表改写（统一强制边界）

两种模式最终都经过「逻辑表改写」：把裸名 `sa_events` / `sa_user_profiles` 归一为 `clklog_sa.*`，并通过 ClickHouse `additional_table_filters` 注入 `project_name` + `stat_date`。**不**再包一层 `SELECT *` 子查询：`sa_events` 的 ORDER BY 是 `(event, stat_date, …)`，包 `SELECT *` 会让 event 谓词无法下推，7 天扫描会打满字节上限。

```sql
-- 用户写的
SELECT count() FROM clklog_sa.sa_events WHERE event = 'PageView'
-- 执行时 SQL 表名保持 clklog_sa.sa_events；settings:
-- additional_table_filters = {'clklog_sa.sa_events':'project_name = \'…\' AND stat_date BETWEEN \'…\' AND \'…\''}
```

---

## 5. 数据字典

同 PRD §6。支撑接口 `GET /sa/api/report/schema` 返回：

```json
{
  "events": [{ "event_key": "PageView", "display_name": "浏览页面", "yesterday_count": 1234 }],
  "event_properties": [{ "prop_key": "$os", "data_type": "string", "sample_value": "iOS", "event_count": 5, "materialized": "p__os" }],
  "user_properties": [{ "prop_key": "level", "data_type": "number", "sample_value": "3", "materialized": null }],
  "system_columns": [{ "name": "event", "type": "String", "desc": "事件名" }],
  "cohorts": [{ "cohort_id": "cohort_…", "name": "high_vip", "display_name": "高活", "batch_id": "…", "member_count": 1200 }]
}
```

> `sample_value` 默认脱敏：手机号/邮箱/身份证等敏感字段掩码后返回。

---

## 6. 属性引用规范

> ⚠️ 生产 ClickHouse 版本为 **23.2.1**，无 `...OrNull` 系列函数（24.x 才有）。统一用 23.2 支持的函数。

| 类型 | JSON 表达式（自动生成） | 物化列（已物化优先） |
|------|------------------------|---------------------|
| string | `JSONExtractString(properties, 'prop_key')` | `p_prop_key` |
| number | `JSONExtractFloat(properties, 'prop_key')` | `p_prop_key` |
| boolean | `JSONExtractBool(properties, 'prop_key')` | `p_prop_key` |
| datetime | `parseDateTime64BestEffort(JSONExtractString(properties, 'prop_key'))` | `p_prop_key` |
| list/object | `JSONExtractRaw(properties, 'prop_key')` | `p_prop_key` |

**正确性约定**：
- `JSONExtractString` 对缺失键返回空字符串（非 NULL），`is null` 语义不成立；判属性是否存在用 `JSONHas(properties, 'prop_key')`，判空用 `empty()`。
- 属性 key/事件名/别名/筛选值统一转义；筛选值**参数化绑定**，不拼文本。
- SQL 别名统一英文（`event_count`/`uniq_users`/`sum_xxx`），避免中文别名编码问题。

---

## 7. 分组与筛选（Builder 模式，服务端生成 SQL）

### 7.1 分组维度

| 类型 | 表达式 |
|------|--------|
| 时间 | `toStartOfDay/Hour/Week/Month(log_time)` |
| 事件属性 | `JSONExtractStringOrNull(properties, 'prop_key')` |
| 用户属性 | `JSONExtractStringOrNull(p.properties, 'prop_key')`（经 JOIN，见 §8） |
| 系统字段 | `event`、`stat_date` |

### 7.2 指标

| 指标 | 表达式 |
|------|--------|
| 事件量 | `count()` |
| 独立用户 | `uniqExact(distinct_id)` |
| 数值聚合 | `sum/avg/min/max(JSONExtractFloatOrNull(properties, 'prop'))` |

---

## 8. 用户属性 JOIN 与表迁移

### 8.1 现状问题（评审确认）

`sa_user_profiles` 无 `project_name` 列、排序键为 `distinct_id`，无法隔离不同项目同 `distinct_id`，也无法按项目 JOIN。

### 8.2 迁移（红线 6：DDL 变更，先测试库演练）

```sql
-- 加 project_name 列（默认 'clklogapp'，回填既有数据）
ALTER TABLE clklog_sa.sa_user_profiles ADD COLUMN IF NOT EXISTS project_name LowCardinality(String) DEFAULT 'clklogapp';
-- 重建排序键（新建表 + 迁移数据 + 原子换名，避免直接改排序键）
```

排序键调整为 `(project_name, distinct_id)`；`ORDER BY (project_name, distinct_id)` + `ReplacingMergeTree(updated_at)`。

### 8.3 用户属性 JOIN 标准 SQL

```sql
SELECT JSONExtractStringOrNull(p.properties, 'level') AS level, count() AS cnt
FROM clklog_sa.sa_events e
LEFT JOIN (
  SELECT distinct_id, argMax(properties, updated_at) AS properties
  FROM clklog_sa.sa_user_profiles
  WHERE project_name = {project: String}
  GROUP BY distinct_id
) p ON e.distinct_id = p.distinct_id
WHERE e.project_name = {project: String}
  AND e.stat_date BETWEEN {from: Date} AND {to: Date}
GROUP BY level
```

- 用 `argMax(properties, updated_at)` 取最新画像，避免 ReplacingMergeTree 未合并重复放大事件。
- 用户属性语义为**「查询时最新画像」**（非事件发生时快照），需在文档与 PRD 明确。
- 物化列 `p_xxx` 当前不支持用户属性（见 §8.4 修正）。

### 8.4 用户属性物化修正

现有 `MetaPropertyService.materializeProperty` 对用户属性**错误地物化到 `sa_events.properties`**（用户属性在 `sa_user_profiles`，不在 `sa_events`）。修正为：用户属性物化 = 在 `sa_user_profiles` 落列（`ALTER TABLE clklog_sa.sa_user_profiles ADD COLUMN p_xxx`），而非 `sa_events`。

---

## 9. API 契约

### 9.1 执行

```json
POST /sa/api/report/sql/execute
{
  "mode": "sql" | "builder",
  "sql": "SELECT ...",          // SQL 模式
  "dsl": { ... },               // Builder 模式
  "time_range": { "start": "2026-08-01", "end": "2026-08-27" },  // 必填
  "limit": 1000
}
→ {
  "query_id": "...",
  "columns": [{ "name": "day", "type": "Date" }],
  "rows": [...],
  "row_count": 100,
  "truncated": false,
  "elapsed_ms": 12,
  "read_rows": 12345,
  "read_bytes": 987654
}
```

**长查询送达契约（2026-09-21，见 §14）**

适用于长接口集合：`POST /report/sql/execute`、`POST /report/cards/:cardId/execute`（目录执行）、`POST /report/dashboards/:dbId/cards/:cardId/refresh`、`GET /meta/quality/reconcile`、`POST /query/{event|funnel|retention}`（nginx 侧同一正则集合放行）。

- 查询期间服务端每 15 秒往响应写入一个空白字节保活（心跳），因此**超过约 15 秒的查询响应体是「空白字节 + JSON 信封」**：前置空白对 `JSON.parse` 合法，消费方按一段文本解析即可（前端 axios 无需改动）。
- 心跳一旦写出，HTTP 状态码与响应头即定型。此后失败**不再返回 4xx/5xx**，改为 201（POST）/200（GET）+ 信封 `code != 0`；前端按既有的 `code !== 0` 分支渲染。**这是这些接口唯一的契约特例，消费方不得以状态码判断失败。**
- 预算类失败（ClickHouse 158/160 超时、241/307/321 超量）由服务端换成人话 + 机器码：`report.sql.queryTimeout`（带 `params.seconds`）与 `report.sql.queryTooLarge`，原文只留服务端日志。AI 侧据此区分「查询超预算」与「服务不可达」。
- 客户端断开（含切页、超时放弃）会立即取消 ClickHouse 查询（SQL 执行路径已接线；卡片刷新/查询/对拍当前只保活、不取消）。

### 9.2 保存与历史

```json
POST /sa/api/report/sql/save
{
  "name": "...",
  "mode": "sql" | "builder",
  "sql_text": "...",            // SQL 模式
  "dsl": { ... },               // Builder 模式
  "field_map": [{ "key": "day", "label": "日期", "type": "date" }],
  "chart_config": { "chart_type": "line" },
  "schema_version": 1
}
```

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/sa/api/report/schema` | 聚合元数据字典 |
| POST | `/sa/api/report/sql/execute` | 执行（安全限额） |
| POST | `/sa/api/report/sql/save` | 保存报表 |
| GET | `/sa/api/report/sql` | 已保存列表 |
| GET | `/sa/api/report/sql/:id` | 报表详情 |
| DELETE | `/sa/api/report/sql/:id` | 删除 |

SQL 卡片（P3）保存**完整执行规格快照**（含 mode/sql/dsl/time_range/field_map/chart_config），避免原报表删除/修改导致看板语义漂移。

---

## 10. 数据模型（Prisma）

```prisma
model SqlReport {
  id             String   @id @default(uuid())
  project_name   String
  name           String
  mode           String   // 'sql' | 'builder'
  sql_text       String?  // SQL 模式
  dsl_json       String?  // Builder 模式
  field_map      String?  // JSON
  chart_config   String?  // JSON
  schema_version Int      @default(1)
  created_at     DateTime @default(now())
  updated_at     DateTime @updatedAt

  @@index([project_name, created_at])
}
```

> 需新增 migration（`prisma migrate dev --name add_sql_report`）。

---

## 11. 安全边界（红线 4，严格）

### 11.1 AST 校验（非正则）

- 用 ClickHouse SQL AST 解析（`EXPLAIN AST` / 前端解析器），校验为**单条 SELECT**。
- 禁止 DDL/DML/管理命令、表函数、`system.*`、`information_schema`、其他库、`FORMAT`、`SETTINGS`、`INTO OUTFILE`。

### 11.2 项目与时间强制

- `project_name` 从认证上下文取得（**本期沿用现有 ProjectInterceptor，标注为 TODO：需替换为授权后的项目身份**）。
- 不接受 SQL 自带的项目值；对每个 `sa_events`/`sa_user_profiles` 数据源注入 `project_name` + `stat_date` 条件（`additional_table_filters`，§4.3）。
- `time_range` 必填，默认近 7 天，最大跨度 90 天。

### 11.3 资源限额（ClickHouse 官方组合保护）

| 设置 | 值 |
|------|-----|
| `max_execution_time` | 300s（2026-09-09 起，全局 `query.maxExecutionTime`；此前 30s） |
| `max_rows_to_read` | 600_000_000 |
| `max_bytes_to_read` | 50_000_000_000 |
| `max_memory_usage` | 2_000_000_000 |
| `max_result_rows` | 100_000 |
| `max_result_bytes` | 100_000_000 |
| `max_threads` | 4 |
| `timeout_before_checking_execution_speed` | 100 |
| LIMIT | 默认 1000，强制上限 100000 |

> `max_bytes_to_read` 50GB（2026-09-03）：高频事件 7 天读取 `properties` 约 45GB。2GB 内存仍为硬上限；墙钟上限 2026-09-09 起为 300s（`query.maxExecutionTime`），其余有界限额不变。ClickHouse 23.2 无 `max_estimated_execution_time`；`timeout_before_checking_execution_speed=100` 避免 10s 时按剩余行数悲观预估误杀。去掉 `SELECT *` 包层后 event 谓词可走 `ORDER BY (event, stat_date)`。
>
> 注意：预估检查在 **100 秒**才触发，而公网链路对「响应期无字节流动」的连接约 **60 秒**即切断（见 §14），所以超预算查询会先表现为客户端「服务不可用」。2026-09-21 起靠 §9.1 心跳保活把这段等待变可见、§11.5 把这类查询挡在入口。

### 11.4 专用只读账号（✅ 已落地，2026-08-28）

- **只读账号隔离**：新增 ClickHouse `sa_readonly` 账号（`readonly=1`、`access_management=0`、`allow_databases=clklog_sa`），分析服务只读查询（`query`/`querySql`/`queryReconcile`）走该账号，与写账号 `default` 隔离。
  - Puppet：`init.pp` 新增 `$ck_ro_user_pwd` 参数 + `templates/clickhouse/users.epp` 渲染 `sa_readonly`；users.xml 变化触发 `clklog_clickhouse_restart` 重启容器。
  - 服务配置：`config_server.yaml` readonly 段 `username: sa_readonly` + `password: ${READONLY_CH_PASSWORD}`；supervisor 注入 `READONLY_CH_PASSWORD`。
- **仍 TODO**：项目身份从「用户可控 header/query/body」（`ProjectInterceptor`）改为「认证后的项目上下文」。当前系统无认证体系，需引入登录/API Key 校验后落地（独立安全专项）。

### 11.5 扫描过滤守卫（2026-09-21）

`sa_events` 的 `ORDER BY` 首列是 `event`，无 `event`/`WHERE` 过滤时无法裁剪 granule，等于全窗口扫描；`properties` 是 ZSTD(3) 大列，逐行 JSON 解析的代价远超查询预算。

- **拒绝**：整条语句读 `sa_events` 且**没有 WHERE**，同时（a）出现 `JSONExtract*`，或（b）按 `properties` 分组。
  - 错误码 `report.sql.scanRequiresFilter`（400，文案键 `report:error.sql.scanRequiresFilter`，13 语言齐备），提示补 WHERE 或改用系统字段。
  - 实测（2026-09-21 AI 会话）`SELECT JSONExtractString(properties,'os'), count() FROM sa_events GROUP BY 1`：预估 1818~2334 秒、亿级行，必然失败——与其等满预估检查（100 秒）再看底层报错，不如入口拒绝。
- **不拦**：`GROUP BY` 系统字段（`event` / `os` / `app_version` / `country` / `url_path` …）与纯计数查询——它们廉价且合法，`SELECT event, count() FROM sa_events GROUP BY event` 照常放行。
- 判定在 token 层（复用 §11.1 的词法分析），注释与字符串字面量在 tokenize 阶段已丢弃，写进注释无法绕过。

---

## 12. 实现清单

| 层 | 文件 | 内容 |
|----|------|------|
| 后端 | `report/sql-report.service.ts` | execute（AST 校验 + 逻辑表改写 + 参数化 + 资源限额）+ save/list/get/delete |
| 后端 | `long-response/query-keepalive.ts` | 长响应保活：心跳、断开取消信号、`respondWithKeepalive` 统一入口（§14） |
| 后端 | `query-budget/query-budget-error.ts` | ClickHouse 预算类错误（158/160/241/307/321）→ 可读文案 + 机器码（§14） |
| 后端 | `report/schema.service.ts` | 聚合元数据字典 `/report/schema` |
| 后端 | `report/sql-report.controller.ts` | 端点 |
| 后端 | `report/dto/sql-report.dto.ts` | ExecuteSqlDto / SaveSqlReportDto |
| 后端 | `query/sql-ast-guard.service.ts` | AST 校验（非正则） |
| 后端 | `query/sql-logical-table.service.ts` | 逻辑表改写（注入 project + time） |
| 后端 | `init-clickhouse.ts` + migration | `sa_user_profiles` 加 `project_name` + 排序键迁移 |
| 前端 | `pages/Report/SqlReportPage.tsx` | 页面骨架（三栏 + 底部结果）+ 向全局 AI Page Bridge 发布 SQL 状态 |
| 前端 | `features/report/SqlReportEditor.tsx` | 受控代码编辑器 + 元数据补全 + revision/action adapter |
| 前端 | `features/report/DataDictionaryPanel.tsx` | 数据字典 |
| 前端 | `features/report/GroupByPanel.tsx` / `FilterPanel.tsx` | 分组/筛选（Builder） |
| 前端 | `features/report/QueryResultPanel.tsx` | 结果 |
| 前端 | 全局 AI 面板 | 由 `clklog-ai-analytics-v1` 在分析路由公共布局实现，本页不再维护局部 AI 占位 |
| 依赖 | `package.json` | `monaco-editor`、`@monaco-editor/react`、SQL AST 解析库 |

---

## 13. 实施顺序

1. 后端 `/report/schema`（聚合字典）+ `/sql/execute`（安全执行：AST + 改写 + 限额）。
2. `sa_user_profiles` 迁移 + 用户属性物化修正。
3. 前端页面骨架（三栏 + 底部结果），AI 区域由分析路由公共布局提供。
4. 数据字典 + Monaco 编辑器 + 元数据补全。
5. Builder 分组/筛选面板。
6. 结果表格/图表 + 保存报表/卡片。
7. 单测 + 文档 + 部署验证。

---

## 14. 长查询送达与扫描守卫

> phase: clklog-analytics-sql-longquery-delivery-v1（2026-09-21）
> 上游：本文档 §9.1 / §11.3 / §11.5；契约以 §9.1、§11.5 为准。

### 14.1 阶段目标与范围（门禁要素①）

让「墙钟 300 秒」的查询预算真正可用：查询期间保持连接有字节流动，超时裁决权归后端；并把注定超预算的查询挡在入口。

### 14.2 验收标准（门禁要素②）

- [ ] **LQ-1**：长接口集合（SQL 执行 / 目录执行 / 卡片刷新 / 数据质量对拍 / 事件·漏斗·留存查询）在查询期间每 15 秒写一个空白字节；nginx 对同一正则集合关 `gzip` 与代理缓冲（Puppet `nginx-clklog-manager.conf`），实测集合内请求心跳按期到达、集合外仍为原缓冲行为。
- [ ] **LQ-2**：超过约 15 秒的响应体为「空白字节 + JSON 信封」，`JSON.parse` 成功；失败以 HTTP 201 + `code != 0` 返回（§9.1 契约特例）。
- [ ] **LQ-3**：客户端断开触发 `abort_signal`，ClickHouse 查询被取消（日志 `自定义 SQL 已取消（客户端断开）`）。
- [ ] **LQ-4**：无 WHERE 且解析/分组 `properties` 的 `sa_events` 查询被 400 拒绝（`report.sql.scanRequiresFilter`）；`GROUP BY` 系统字段与纯计数照常放行。
- [ ] **LQ-6**：预算类失败（158/160/241/307/321）返回可读文案 + 机器码（`report.sql.queryTimeout` / `report.sql.queryTooLarge`），ClickHouse 原文不入响应。
- [ ] **LQ-7**：AI 回执携带机器码：浏览器执行失败时回执带 `errorCode`（服务端错误码或前端兜底 `web.sql.executeFailed`）；两个 Page Bridge 409（`sql_execution_requires_current_editor_sql`、`sql_revision_conflict`）在 `message` 里给出下一步动作。
- [ ] **LQ-5**：单测覆盖心跳节奏、流式信封可解析、断开取消、守卫正反例；`scripts/i18n_check.py` / `scripts/i18n_scan.py --check` / `scripts/arch_ratchet.py` 通过。

### 14.3 非目标（门禁要素③）

- 不改前端 axios 超时与错误映射（前置空白对 `JSON.parse` 合法，前端零改动）。
- 不为其它长接口（卡片 refresh、数据质量对拍）铺心跳；需要时按 §9.1 同样的 location 模式另加。
- 不调整 ClickHouse 资源限额与 `timeout_before_checking_execution_speed`（下调会误杀 60~110 秒的合法查询，实测存在）。
- 不改写链路层（公网七层监听器无空闲超时可配项，仅走工单或后续四层迁移）。

### 14.4 背景（2026-09-21 排查结论）

- 公网链路（Tencent CLB 七层 → nginx）对「响应等待期无字节流动」的连接约 60 秒切断：4 天访问日志中 >55 秒的请求 234 条，非流式响应真正送达客户端的最大值 **59.0 秒**，所有 ≥90 秒的非流式响应 `body_bytes_sent` 均为 0；持续发字节的 SSE 存活 3660 秒。nginx 侧 `proxy_read_timeout 3600`、等满 100.66 秒才记上游状态码，故切断点在负载均衡一跳。
- 前端 `executeSql` 超时 310 秒、ClickHouse 墙钟 300 秒，超时判定本就在后端；问题不在「谁判超时」，而在「连接空闲被链路掐断」。
- 表现为：AI 会话四次重试均拿到前端兜底文案「分析服务暂时无法连接」，把「查询太贵」误判为「服务不可用」并停止重试（单轮工具耗时 449 秒中 241 秒是这种空转）。
