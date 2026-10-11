# 实现方案：ClkLog 分析平台 v1

> phase: clklog-analytics-v1
> 版本：v1.0（2026-07-28）｜ 上游：`docs/architecture/analytics-extension-plan.md`、`docs/product/prd-clklog-analytics-v1.md`
> 本文档是 DSL Schema、SQL 生成器、ingestor 解析规格、API 契约、表结构、ID 约定的唯一权威（SSOT）。

---

## 1. 阶段目标与范围（门禁要素①）

按 PRD §2 交付 P0~P3：数据补齐链路、分析引擎（事件/漏斗/留存）、埋点管理、自定义报表，含前端 SPA 与 Puppet 部署集成。

技术形态：

| 组件 | 形态 | 说明 |
|------|------|------|
| `apps/analytics-server` | 单体 Spring Boot（Java 17），按 `ingest/meta/query/report` 分包 | 一期不拆微服务 |
| `apps/analytics-web` | React + ECharts SPA | 挂 `管理后台入口/sa/` |
| `apps/ingestor` | 独立轻量 Java 进程（可与 server 同镜像不同 entrypoint） | Kafka 消费，长驻 |
| 存储 | ClickHouse `clklog_sa` 库 + MySQL `clklog_sa_meta` 库 + Redis 缓存 | 复用现有中间件 |

## 2. 验收标准（门禁要素②）

- [ ] PRD §5 全部用例通过（A1~A4、B1~B4、C1~C4、D1~D11、E1~E5、F1~F3）
- [ ] SQL 生成器单测：事件/漏斗/留存三类 DSL 各 ≥ 10 case，含注入攻击 case（`'; DROP--` 等）
- [ ] ingestor 幂等：同一 Kafka 消息重放不产生重复行（`crc` 去重，查询侧 `count() = count(DISTINCT crc)`）
- [ ] 性能压测：造数 DAU 5 万 × 30 天，达成 PRD §1 量化目标
- [ ] `puppet agent -t` 可一键部署/重建 `clklog-analytics` 容器，nginx `/sa/` 可达

## 3. 非目标（门禁要素③）

- 不实现 PRD §6 列出的全部 v2+ 功能
- 不引入 Flink/Spark 等重计算组件；不做离线 ID-Mapping 刷数
- 不改 `clklog.log_analysis` 等社区版任何表结构（红线）
- 不实现行列级数据权限（v1 仅看板所有者/只读链接）。后继：`phase: clklog-analytics-rbac-v2` 在 `clklog-analytics-design-rbac-v2.md` 定义项目空间数据权限。

---

## 4. 部署拓扑

```
管理后台入口
  /        → clklog-ui:8081（社区版，不动）
  /api/    → clklog-api:8083（不动）
  /manage/ → clklog-manage:8084（不动）
  /sa/     → clklog-analytics:8085（新增：web 静态资源 + /sa/api/* 后端）

新容器 clklog-analytics（内存 1024M，与现有 Java 容器一致）：
  ├── server 进程（8085）：meta/query/report 模块 + web 静态托管
  └── ingestor 进程：CKafka 消费（独立 consumer group: clklog-sa-ingestor）
```

Puppet 集成点：`puppet/clklog/templates/docker-compose.yml.epp` 增加服务、`puppet/clklog/templates/env.epp` 增加参数、`nginx.pp` 增加 location（`nginx_location_extensions` 数组相应扩容，见 HANDOVER 问题 8）。

## 5. 数据模型（终稿）

### 5.1 ClickHouse：`clklog_sa.sa_events`

```sql
CREATE TABLE clklog_sa.sa_events
(
    `project_name`   LowCardinality(String),
    `event`          LowCardinality(String),
    `log_time`       DateTime64(3),
    `stat_date`      Date,
    `distinct_id`    String,
    `user_key`       String DEFAULT '',
    `device_id`      String DEFAULT '',
    `url_path`       String DEFAULT '',
    `utm_source`     LowCardinality(String) DEFAULT '',
    `utm_medium`     LowCardinality(String) DEFAULT '',
    `utm_campaign`   LowCardinality(String) DEFAULT '',
    `country`        LowCardinality(String) DEFAULT '',
    `province`       LowCardinality(String) DEFAULT '',
    `city`           LowCardinality(String) DEFAULT '',
    `os`             LowCardinality(String) DEFAULT '',
    `browser`        LowCardinality(String) DEFAULT '',
    `model`          String DEFAULT '',
    `app_version`    LowCardinality(String) DEFAULT '',
    `lib`            LowCardinality(String) DEFAULT '',
    `is_first_day`   UInt8 DEFAULT 0,
    `event_session_id` String DEFAULT '',
    `properties`     String CODEC(ZSTD(3)),          -- 自定义属性全量 JSON
    `crc`            String,                          -- 上报原文校验码（幂等键）
    `ingest_time`    DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingest_time)
PARTITION BY toYYYYMM(stat_date)
ORDER BY (event, stat_date, distinct_id, crc)
TTL stat_date + INTERVAL 18 MONTH;
```

- `ORDER BY` 前缀 (event, stat_date) 保证分析查询裁剪；`crc` 入键使重放行在 merge 时被替换去重；精确计数场景查询侧用 `count(DISTINCT crc)` 兜底。
- 属性访问解析顺序（SQL 生成器强制）：存在物化列 `p_{prop}` → 用列；否则按 meta 登记类型生成 `JSONExtract{String|Float|Bool}(properties, '{prop}')`。
- 物化列 DDL（M8 触发，由 meta 模块执行）：`ALTER TABLE sa_events ADD COLUMN p_amount Float64 MATERIALIZED JSONExtractFloat(properties,'amount')`。

### 5.2 ClickHouse：`clklog_sa.sa_user_profiles`

```sql
CREATE TABLE clklog_sa.sa_user_profiles
(
    `distinct_id`  String,
    `user_key`     String DEFAULT '',
    `properties`   String CODEC(ZSTD(3)),
    `updated_at`   DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY distinct_id;
```

分析侧用户属性 = 对子查询 `SELECT distinct_id, properties FROM sa_user_profiles FINAL` 做 `IN`/`JOIN`，或物化为 ClickHouse 字典（`dictGet`）；一期用 JOIN，性能不足再切字典。

### 5.3 分析主体（一期口径）

所有「用户数」指标统一：`analysis_id = if(user_key != '', user_key, distinct_id)`，SQL 生成器内联，不暴露给调用方。

### 5.4 MySQL：`clklog_sa_meta`（核心表）

| 表 | 关键列 | 说明 |
|----|--------|------|
| `meta_event` | event_key(PK), display_name, description, owner, status(pending/visible/hidden), is_preset, first_seen_at | 元事件 |
| `meta_event_property` | id, event_key, prop_key, display_name, data_type, is_materialized, sample_value, status | 事件属性 |
| `meta_user_property` | id, prop_key, display_name, data_type, is_materialized, status | 用户属性 |
| `meta_virtual_event` | ve_id(PK, `ve_`+nanoid10), display_name, definition_json(事件+筛选组合), status | 虚拟事件 |
| `meta_property_dict` | id, prop_key, dict_json(key→显示名) | 维度字典 |
| `meta_funnel_template` | id, name, definition_json, owner | 漏斗模板 |
| `rpt_dashboard` | db_id(PK, `db_`+nanoid10), name, layout_json, owner, share_token | 看板 |
| `rpt_card` | card_id(PK, `card_`+nanoid10), db_id, type(event/funnel/retention/sql), dsl_json, chart_type, refresh_policy | 卡片 |
| `rpt_sql` | id, name, sql_text, field_map_json, owner | 自定义 SQL |
| `meta_saved_metric` | metric_id(`metric_`+nanoid10), name, kind, definition_json | 保存指标 |
| `meta_user_cohort` | cohort_id(`cohort_`+nanoid10), name, kind(condition/id_upload/result/sql), definition_json, batch_id, subject_id | 用户分群元数据；成员在 CK `sa_cohort_members`。`kind=sql` 见 `clklog-analytics-sql-cohort-v1`；`subject_id` 见 followups，主体仍固定用户 |
| `meta_user_tag` | tag_id(`tag_`+nanoid10), name, kind(condition), definition_json, batch_id, subject_id | 用户标签元数据；取值在 CK `sa_tag_members`（`clklog-analytics-user-tag-v1` 已实现）；`subject_id` 见 followups D |
| `meta_analysis_subject` | subject_id(`asub_`+nanoid10), name, kind(preset/property), source_json | 分析主体（`clklog-analytics-analysis-subject-v1` 已实现）；预置「用户」 |

## 6. ingestor 解析规格

### 6.1 输入

- CKafka topic `clklog`（6 分区），consumer group `clklog-sa-ingestor`，手动提交位点（写入 CK 成功后提交，at-least-once + crc 幂等）。
- ⚠️ P0 首个任务：消费 1 条确认 Kafka 内消息确切格式（预期为 receiver 解码后的神策 JSON：单条或数组），解析器按实际格式实现并留样例到 `apps/ingestor/samples/`。

### 6.2 神策 type 路由

| type | 去向 | 处理 |
|------|------|------|
| `track` | `sa_events` | event/distinct_id/time/properties 全保留；`user_key` 取 login_id 上下文；常用维度（utm/os/browser/省市等）从 properties 物化到列 |
| `track_signup` | `sa_events` + 画像 | 记事件本身；`user_key`/`track_signup_original_id` 写入 `sa_user_profiles` 建立登录关联 |
| `user_set` | `sa_user_profiles` | properties 全量覆盖写（ReplacingMergeTree 按 updated_at 取新） |
| `user_set_once` | `sa_user_profiles` | 仅写缺失 key（ingestor 读取-合并-写回） |
| `user_append`/`user_increment`/`user_delete`/`user_unset` | `sa_user_profiles` | 读-改-写合并；delete/unset 删 key |

### 6.3 容错与吞吐

- 未知字段/属性不报错，原样进 `properties` JSON；解析失败行写本地 DLQ 文件（不阻塞主流）。
- 批量写 CK：攒批 500 条或 2s；失败重试 3 次指数退避，仍失败入 DLQ。
- 历史回灌：用独立 consumer group 从头消费一次（topic 保留期内），`crc` 幂等保证不产生重复。

### 6.4 元数据自动发现（MetaDiscoveryService）

- **发现范围**：仅 `track` 类型事件；同一 `event` 以 Redis 去重键 `discovery:event:{project}:{event}` 限 5 分钟窗口只做一次全量扫描（性能优化，类型变更检测随之有 ≤5 分钟延迟）。
- **事件**：不存在则创建（`status: pending`），并写 `metadiscoverylog`（`event_created`）；**不覆盖人工维护字段**（display_name/remark/status）。
- **属性**：
  - 不存在 → 创建（`pending`）+ `property_created` 日志。
  - 已存在但 `data_type` 与上报不一致 → **更新类型** + `property_type_changed` 日志（记 from→to），避免属性类型漂移被静默忽略。
  - 已存在且类型一致 → 跳过。
- **变化可见**：`metadiscoverylog` 审计表记录新增事件/属性/类型变更，数据质量页展示，便于运营感知字段增长与类型变更。

### 6.5 用户属性自动发现（UserPropertyDiscovery）

**背景**：`meta_user_property` 元数据表此前从未被填充（`upsertUserProperty` 无调用点），「用户属性管理」页为空；`sa_user_profiles` 画像数据有写入但元数据不登记。

**来源**：从 `user_set` / `user_set_once` / `track_signup` 的 `properties` 提取用户属性字段登记（`track` 的 `properties` 是事件属性，**不混**）。

**去重窗口**：按 `project_name + prop_key` 粒度，Redis 键 `discovery:userprop:{project}:{prop}`，300s。用户属性不绑定事件，故以「项目+属性」为去重单位。

**登记逻辑**（复用事件属性模式）：
- 属性不存在 → `create`（`status: pending`）+ 审计 `user_property_created`；
- 属性存在但 `data_type` 与上报不一致 → `update` 类型 + 审计 `user_property_type_changed`（from→to）；
- 属性存在且类型一致 → 跳过。

**user_unset / user_delete**：收到时把对应属性 `status` 置为 `hidden`（不清除，避免误删；可后续手动恢复或隐藏）。

**审计**：复用 `metadiscoverylog` 表，`change_type` 扩展 `user_property_created` / `user_property_type_changed` / `user_property_hidden`，数据质量页可展示。

**物化**：新登记属性默认 `is_materialized=false`；运营在用户属性管理页手动「物化」→ 复用现有接口，把 `sa_user_profiles.properties` 中该字段落成 ClickHouse 列（DDL 走测试库演练，红线）。

## 7. 分析 DSL Schema（权威定义）

### 7.1 EventAnalysisQuery

```json
{
  "project": "clklogapp",
  "event": "Purchase | ve_xxxxxxxxxx",
  "metrics": [{"id": "m1", "type": "count|uniq_user|agg|per_user",
               "func": "sum|avg|max|min|uniq|p50|p90|p99", "prop": "amount", "base": "count"}],
  "filters": {"logic": "and|or", "items": [
    {"scope": "event|user", "prop": "channel", "op": "=|!=|in|contains|regex|gt|gte|lt|lte|is_set|not_set", "value": "..."}
  ]},
  "groups": [{"scope": "event|user", "prop": "os"}, {"scope": "time", "granularity": "hour|day|week|month"}],
  "group_limit": 20,
  "time_range": {"start": "2026-07-01", "end": "2026-07-28", "relative": {"kind": "past_n", "n": 7}, "compare": "none|last_period|last_year|custom", "timezone": "Asia/Shanghai"},
  "limit": 1000
}
```

> `time_range.timezone`（可选，IANA 名，phase: clklog-analytics-timezone-v1）：缺省 = 平台时区；
> 「今天」、`start/end` 起止、粒度桶都按它解析；随卡片 DSL 持久化。实现契约见
> `clklog-analytics-design-timezone-v1.md`。

### 7.2 FunnelQuery

```json
{
  "project": "clklogapp",
  "window_seconds": 604800,
  "steps": [{"event": "ViewProduct", "alias": "浏览", "filters": {"logic": "and", "items": []}}],
  "filters": {"logic": "and", "items": []},
  "groups": [{"scope": "event|user", "prop": "os"}],
  "granularity": "total|day|week|month",
  "limit_window_in_range": false,
  "time_range": {"start": "...", "end": "..."}
}
```

### 7.3 RetentionQuery

```json
{
  "project": "clklogapp",
  "start_event": {"event": "AppLaunch", "filters": {"logic": "and", "items": []}},
  "retain_event": {"event": "AppLaunch", "filters": {"logic": "and", "items": []}},
  "cohort": "first_day|all",
  "granularity": "day|week|month",
  "n_list": [1, 2, 3, 7, 14, 30],
  "time_range": {"start": "...", "end": "..."}
}
```

## 8. SQL 生成器设计

### 8.1 通用规则

1. **强制注入**：`project_name = {project}`、`stat_date BETWEEN start AND end`（漏斗/留存自动外延窗口期/N 天）、`LIMIT`、JDBC 会话级 `max_execution_time=30`、`max_rows_to_read`。
2. **参数化**：所有用户输入走参数绑定；prop key 走标识符白名单校验（`^\$?[a-zA-Z_][a-zA-Z0-9_$.-]{0,63}$`，2026-09-10 起允许可选 `$` 前缀以兼容神策/ThinkingData 系 SDK 系统属性如 `$is_first_day`），杜绝注入。
3. **属性解析**：按 §5.1 解析顺序；类型由 meta 登记的 `data_type` 决定 `JSONExtract*` 函数。
4. **虚拟事件展开**：`event IN (...) AND (definition_json 中的筛选)`，生成器递归展开，禁止嵌套虚拟事件。
5. **用户属性**：生成对 `sa_user_profiles` 的 `IN (SELECT distinct_id ... WHERE ...)` 子查询。
6. **缓存**：Redis `key = sha256(规范化DSL)`，TTL 5 分钟；请求带 `refresh=true` 跳过。

### 8.2 事件分析 → SQL

按 `docs/architecture/analytics-extension-plan.md` §4.2 模板生成；`per_user` = `count()/uniqExact(analysis_id)` 外层派生。

### 8.3 漏斗 → SQL

核心：`windowFunnel(window_seconds)(toUnixTimestamp(log_time), cond_step1, ..., cond_stepN)`，每步条件 = `event = {step.event} AND {步骤筛选}`；`granularity != total` 时外层按时间桶各算一次。人数按 `analysis_id` 分组。语义对拍基准 = PRD §5.4 D1~D11。

### 8.4 留存 → SQL

按 `docs/architecture/analytics-extension-plan.md` §4.4 模板：cohort 子查询（`first_day` 口径加 `is_first_day=1`；`all` 口径取 `minIf(stat_date, event=start_event)`）+ `retention()` 数组，外层 `sum(r[k])` 出 N 日留存。周/月粒度先把 `stat_date` 映射到 `toMonday`/`toStartOfMonth` 再算间隔。

## 9. API 契约（`/sa/api/`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/query/event` | 事件分析，body=EventAnalysisQuery |
| POST | `/query/funnel` | 漏斗分析，body=FunnelQuery |
| POST | `/query/retention` | 留存分析，body=RetentionQuery |
| GET | `/meta/events?status=&keyword=` | 元事件列表 |
| PUT | `/meta/events/{event_key}` | 更新显示名/状态/负责人 |
| GET | `/meta/events/{event_key}/properties` | 事件属性列表（含采样值） |
| PUT | `/meta/properties/{id}` | 更新属性显示名/类型 |
| POST | `/meta/properties/{id}/materialize` | 物化列（异步执行 ALTER） |
| GET/POST/PUT/DELETE | `/meta/virtual-events` | 虚拟事件 CRUD |
| GET | `/meta/debug/recent?distinct_id=&event=&limit=100` | Debug 实时查询 |
| GET | `/meta/quality/report` | 入库校验报告 |
| GET/POST/PUT/DELETE | `/report/dashboards`、`/report/dashboards/{id}/cards` | 看板与卡片 CRUD（✅ 已实现） |
| POST | `/report/dashboards/{id}/cards/{cardId}/refresh` | 卡片实时重算（event/funnel/retention/sql；text 不刷新） |
| GET | `/report/dashboards/share/{token}` | 看板只读分享详情 |
| POST | `/report/sql` | 自定义 SQL 执行（只读账号 + 关键字黑名单 + `max_execution_time=30` + `max_result_rows=100000`） |

统一返回 `{code, message, data}`；查询类接口 `data` 内含 `columns[]`、`rows[]`、`elapsed_ms`、`sql`（调试用，仅管理员返回）。

#### 看板卡片实现要点（P3，2026-08-27）

- 卡片存储分析 DSL 快照（`dsl_json`）；`refresh` 时按 `card.type` 调对应 QueryService / SqlReport（`refresh=true` 绕过缓存）实时重算。布局与留存 SQL 细节见 `clklog-analytics-design-workbench-v1.md`。
- `QueryModule` 已 `exports` 三个 QueryService 供 `ReportModule` 注入（此前无 exports，注入会失败）。
- ID 约定：看板 `db_` + nanoid(10)、卡片 `card_` + nanoid(10)、分享 token `sh_` + nanoid(10)。
- 卡片图表类型：`line`/`bar`/`table`/`number`/`pie`；前端 `CardWidget` + `ChartRenderer` 渲染，`DashboardGrid` CSS Grid 布局（12 列，按卡片 width 跨列）。
- **看板分群筛选**（`clklog-analytics-cohort-sql-dashboard-v1`）：`Dashboard.cohort_filter_json` 存 `{ cohort_id, op: in|not_in }`（0～1 个）。详情/更新 API 字段 `cohort_filter`。`refresh` 时事件/漏斗/留存/Builder SQL AND 进 DSL；手写 SQL 走 `additional_table_filters`，不改用户 SQL。未就绪则该次刷新 400。细节见 followups §B。
- **一键存卡片**：事件/漏斗/留存/SQL 无 `?card=` 时「保存为卡片」走新建；有卡时「覆盖保存」写回原卡、「另存为卡片」新建。分析三类经 `AnalysisCardSave` + `SaveAsCardModal`；SQL 走 `updateSqlReport` / `saveSqlReport`。细节见 `clklog-analytics-design-card-save-v1.md`。

## 10. ID 约定（权威）

| 实体 | 规则 |
|------|------|
| 事件 key | SDK 上报原值，不再另起；显示名另存 |
| 属性 key | properties 内原值；物化列名 = `p_` + snake_case(prop_key)，冲突时追加 `_2` |
| 虚拟事件 | `ve_` + nanoid(10) |
| 保存指标 | `metric_` + nanoid(10) |
| 用户分群 | `cohort_` + nanoid(10) |
| 用户标签 | `tag_` + nanoid(10) |
| 分析主体 | `asub_` + nanoid(10) |
| 看板 / 卡片 | `db_` / `card_` + nanoid(10) |
| 数据表 / 字段 / 绑定 / 导入批次 | `dt_` / `dtc_` / `dtb_` / `dti_` + nanoid(10)（v1）；维度表属性 `dtp_` + key `{绑定属性}@{字段名}`（**v2 已立项、未实现**，`docs/architecture/clklog-analytics-design-datatable-v2.md`） |
| ClickHouse | 库 `clklog_sa`；表 `sa_` 前缀；物化列 `p_` 前缀 |
| MySQL | 库 `clklog_sa_meta`；表 `meta_`/`rpt_` 前缀 |
| Kafka consumer group | `clklog-sa-ingestor`（回灌用 `clklog-sa-ingestor-replay-{yyyymmdd}`） |

## 11. 安全与限额

- 认证：一期复用社区版登录（nginx 层校验 `/manage/` session 转发），`/sa/api/` 未认证返回 401。
- 自定义 SQL：独立 CK 只读账号 `sa_readonly`（`readonly=1`）；黑名单 `INSERT|ALTER|DROP|ATTACH|DETACH|TRUNCATE|RENAME|SYSTEM|KILL`；强制 `max_execution_time=30`、`max_result_rows=100000`。
- 查询引擎：DSL 全参数化；prop key 白名单；单项目并发查询上限 10，排队超时 5s。

## 12. 测试与发布

- 单测：SQL 生成器（含注入 case）、DSL 校验、ingestor 解析（样例文件驱动）。
- 对拍：PRD §5 全部用例脚本化（`apps/analytics-server/src/test/acceptance/`），造数脚本生成已知答案的 30 天数据集。
- 发布：Puppet 管理容器；上线顺序 = 建库建表 → ingestor（观察 24h 数据一致性 A1/A2）→ server+web → 开放使用。
- 回滚：`docker compose` 摘除 `clklog-analytics` 服务 + 移除 nginx location；数据保留。
