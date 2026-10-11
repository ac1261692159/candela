# 实现方案：ClkLog 分析平台 — 数据治理（一致性对拍 + 敏感数据清洗）

> phase: clklog-analytics-data-governance
> 版本：v1.0（2026-08-26）｜ 上游：`docs/product/prd-clklog-analytics-v1-data-governance.md`
> 本文档是数据治理的对拍口径、清洗流程、表结构、SQL 契约、权限边界的唯一权威（SSOT）。

---

## 1. 阶段目标与范围（门禁要素①）

按 PRD 交付两条主线：
1. **数据一致性对拍**：只读比对 `clklog_sa.sa_events` 与社区版 `clklog.log_analysis`，粗/细两级，定时 + 手动，兜底 ingestor 丢数据风险。
2. **敏感数据清洗**：删除/掩码 `clklog_sa` 旁路库敏感数据，带备份/审计/演练门禁，**绝不触碰社区版 `clklog` 库**。

## 2. 验收标准（门禁要素②）

以 PRD §2 的 G-R1~G-R4、G-C1~G-C4、G-S1 为准；本设计补充可核对的实现断言：
- [ ] `scripts/reconcile.sh` 存在且可执行，`bash -n` 通过；对拍 SQL 全部只读（`SELECT`）。
- [ ] 对拍粗粒度默认阈值 0.1%；超阈值非零退出。
- [ ] 清洗 CLI 对 `clklog`（社区版）库名做硬拒绝校验，含 `log_analysis` 在内的社区版表不可写/删/DDL。
- [ ] 清洗前自动生成 `clklog_sa_bak` 快照 + `clklog_sa_meta.audit` 审计记录；生产执行前强制要求测试库 `clklog_sa_staging` 演练标记。

## 3. 非目标（门禁要素③）

- 不做 ID-Mapping 离线刷数（运行时归并口径不变）。
- 不做脏数据字段自动修复（本期仅删除/掩码）。
- 不做全量行级 CRC 对拍（计数对拍 + 抽样细对拍）。
- 不对社区版 `clklog` 库做任何写入/删除/DDL（红线）。

---

## 4. 数据一致性对拍（只读）

### 4.1 表结构（`clklog_sa.sa_events`，复用现有定义）

对拍只依赖现有 `sa_events` 列：`crc`、`event`、`distinct_id`、`stat_date`、`log_time`、`user_key`。不新增表。

### 4.2 对拍 SQL 契约

#### 4.2.1 粗粒度：总量对拍（R-1）

```sql
-- sa_events 侧（旁路库，读）
SELECT stat_date, count() AS sa_cnt, count(DISTINCT crc) AS sa_uniq
FROM clklog_sa.sa_events
WHERE stat_date BETWEEN {from} AND {to}
GROUP BY stat_date;

-- log_analysis 侧（社区版，只读，不写不改）
SELECT toDate(log_time) AS d, count() AS raw_cnt
FROM clklog.log_analysis
WHERE toDate(log_time) BETWEEN {from} AND {to}
  AND event != ''
GROUP BY d;
```

- 偏差阈值：`ABS(sa_cnt - raw_cnt) / raw_cnt > {threshold}`（默认 0.1%）→ 报警非零退出。

#### 4.2.2 粗粒度：按事件对拍（R-2）

```sql
SELECT event, count() AS sa_cnt
FROM clklog_sa.sa_events
WHERE stat_date BETWEEN {from} AND {to}
GROUP BY event;

SELECT event, count() AS raw_cnt
FROM clklog.log_analysis
WHERE toDate(log_time) BETWEEN {from} AND {to}
  AND event != ''
GROUP BY event;
```

- 事件维度并表求差，列出差异事件。

#### 4.2.3 CRC 唯一性（R-3）

```sql
SELECT count() AS total, count(DISTINCT crc) AS uniq
FROM clklog_sa.sa_events
WHERE stat_date BETWEEN {from} AND {to};
```

- `total != uniq` → 存在重复 CRC（ReplacingMergeTree 未 merge），报告标注。

#### 4.2.4 抽样细对拍（R-4）

- 两表无公共 `crc`，用伪键 `distinct_id + '#' + event + '#' + toString(log_time)` 抽样。
- 先取 `sa_events` 抽样 N 条，再按伪键回查 `log_analysis`，比对字段一致率。

```sql
-- sa_events 抽样
SELECT crc, distinct_id, event, toString(log_time) AS lt
FROM clklog_sa.sa_events
WHERE stat_date BETWEEN {from} AND {to}
ORDER BY rand() LIMIT {sample};

-- 回查 log_analysis（伪键）
SELECT distinct_id, event, toString(log_time) AS lt
FROM clklog.log_analysis
WHERE distinct_id IN (...);
```

### 4.3 工具形态

- **位置**：`scripts/reconcile.sh`（Bash + `curl` 访问 CK HTTP，与既有验证方式一致，见 AGENTS.md「ClickHouse 验证」）。
- **参数**：`--from`、`--to`（时间范围，默认昨日）、`--threshold`（默认 0.1）、`--sample`（抽样数，默认 1000）、`--type`（`count|event|crc|detail`，默认 `count`）。
- **凭据**：`CLICKHOUSE_PASSWORD` 等环境变量注入（不入库），复用 `.env`。
- **只读账号**：优先用 `sa_readonly` 只读账号执行；对 `clklog` 库仅 SELECT。
- **输出**：差异表 + 退出码；报告落 `logs/reconcile/reconcile-{ts}.txt`。
- **定时**：cron / supervisor 每小时 `count` 对拍、每日 `detail` 抽样。

### 4.4 对拍一致性边界

- `log_analysis` 无 `crc`，细对拍用伪键，存在极小误匹配概率；以抽样 + 统计口径兜底，不做全量行级。
- `log_analysis` 列名随社区版升级可能变化：对拍 SQL 先探测列存在性（`DESCRIBE` 或列白名单），缺失列时跳过该对拍项并告警，不因升级导致对拍失败。

---

## 5. 敏感数据清洗

### 5.1 边界（硬约束）

- **只允许操作 `clklog_sa*` 库**（`clklog_sa`、`clklog_sa_bak`、`clklog_sa_staging`）。
- **硬拒绝**任何指向 `clklog`（社区版）库的 `INSERT|ALTER|DROP|ATTACH|DETACH|TRUNCATE|RENAME|DELETE`。
- 社区版 `clklog.log_analysis` 及 19 张聚合表不可触碰（红线 1）。

### 5.2 表结构（`clklog_sa_meta` 新增审计表）

```sql
-- 清洗审计表（MySQL clklog_sa_meta）
CREATE TABLE clklog_sa_meta.audit_cleanup (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  operator    VARCHAR(128) NOT NULL,           -- 操作人/系统
  action      ENUM('delete','mask') NOT NULL,
  target_db   VARCHAR(64)  NOT NULL,           -- 目标库（须为 clklog_sa*）
  target_table VARCHAR(128) NOT NULL,
  rule_json   JSON,                            -- 清洗规则（条件/字段/掩码模板）
  backup_table VARCHAR(255) NOT NULL,          -- 对应 clklog_sa_bak 快照表
  affected_rows BIGINT UNSIGNED NOT NULL,
  staged      TINYINT NOT NULL DEFAULT 0,      -- 是否已测试库演练
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 5.3 备份快照表（`clklog_sa_bak`）

清洗前将受影响行插入对应快照表，保证可回滚：

```sql
-- 例：删除 sa_events 前备份
CREATE TABLE IF NOT EXISTS clklog_sa_bak.sa_events_bak_{yyyyMMdd_HHmmss}
  AS clklog_sa.sa_events;

INSERT INTO clklog_sa_bak.sa_events_bak_{ts}
SELECT * FROM clklog_sa.sa_events
WHERE <清洗条件>;
```

### 5.4 清洗流程门禁（强制）

```
① staged 标记（测试库 clklog_sa_staging 演练通过）
  → ② 生成备份快照 clklog_sa_bak.*
  → ③ 写 audit_cleanup 审计记录（staged=1）
  → ④ 生产执行 delete/mask
  → ⑤ 复用对拍工具确认清洗结果
```

- 若 `staged=0`（未演练），生产清洗命令**拒绝执行**。
- 每次清洗写一条 `audit_cleanup`，含规则、备份表名、影响行数，全程可追溯。

### 5.5 删除 / 掩码 DML 契约

#### 5.5.1 按用户删除（`sa_events`）

```sql
-- 备份已由流程②完成
DELETE FROM clklog_sa.sa_events
WHERE distinct_id = {uid} OR user_key = {uid};
```

> ⚠️ ClickHouse 的 `DELETE` 是异步 mutation（`SYSTEM`），本设计用 `ALTER TABLE ... DELETE WHERE`（`mutations`），需 `lightweight` 或等待 mutation 完成；生产用独立写账号，且必须带 `project_name`/时间边界防全表误删（红线 4）。

#### 5.5.2 字段掩码（`properties` JSON）

```sql
-- 将 properties 中 phone 掩码为 138****0000
ALTER TABLE clklog_sa.sa_events
UPDATE properties = replaceRegexpAll(
  properties,
  '"phone":"[0-9]{11}"',
  concat('"phone":"', substring(match(properties,'"phone":"([0-9]{7})'),1,3), '****', substring(extract(properties,'"phone":"[0-9]{11}'), ...))
)
WHERE project_name = {project} AND stat_date BETWEEN ... AND ...;
```

> 掩码函数需在测试库演练确定精确正则；掩码**幂等**：对已掩码值再次执行不改变结果（模板基于脱敏后判定）。

### 5.6 权限与凭据

- 清洗写账号：独立账号 `sa_cleanup`，仅授权 `clklog_sa*` 库（不含社区版 `clklog`），凭据经 Puppet 模板参数化（红线 3）。
- 只读对拍账号：`sa_readonly`（`readonly=1`），仅 SELECT。

---

## 6. 工具清单与 API 契约

### 6.1 工具清单

| 工具 | 位置 | 形态 | 说明 | 状态 |
|------|------|------|------|------|
| `reconcile.sh` | `scripts/` | Bash CLI | 只读对拍（定时告警用） | ✅ 已实现 |
| Web 数据质量页 | `apps/analytics-web` + `apps/analytics-server` | 前后端 | 对拍结果可视化（人工查看） | ✅ 已实现 |
| `cleanup.sh` | `scripts/` | Bash CLI | 清洗入口（五步门禁） | ✅ 已实现（2026-09-15，验收见 `docs/project/acceptance-clklog-analytics-v1-data-governance.md`） |
| 建库与清洗账号 | `apps/analytics-server/src/scripts/migrate-clickhouse.ts` | 幂等 DDL/SQL | `clklog_sa_staging`、`clklog_sa_bak`、`sa_cleanup` | ✅ 已实现（随发版执行；未用 Puppet 模板，见 §5.7） |

> 对拍能力双通道：`reconcile.sh` 负责**定时告警**（cron + 退出码），Web 数据质量页负责**人工查看**，二者共享同一对拍 SQL 契约。

### 6.2 后端 API 契约（对拍，只读）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/sa/api/meta/quality/reconcile?from=&to=&threshold=` | 数据一致性对拍报告（总量/CRC/事件 + 近期元数据变化） |
| GET | `/sa/api/meta/quality/report` | 数据质量概览（当前返回对拍 summary，字段级质量问题预留） |
| GET | `/sa/api/meta/quality/discovery-logs?limit=50` | 元数据自动发现变化记录（新增事件/属性/类型变更） |

对拍响应结构：
```json
{
  "range": { "from": "...", "to": "..." },
  "threshold": 0.1,
  "summary": { "has_alert": false, "total_days": 7, "alert_days": 0, "dup_crc_rows": 0, "crc_pass": true, "recent_changes": 3 },
  "daily": { "items": [{ "date": "...", "sa_cnt": 100, "sa_uniq": 100, "raw_cnt": 100, "deviation_pct": 0, "status": "ok" }], "has_alert": false },
  "crc": { "total": 100, "uniq": 100, "dup_rows": 0, "pass": true },
  "events": { "sa_events": [{ "event": "...", "cnt": 3 }], "log_analysis": [...] },
  "discovery_logs": [{ "id": "...", "event": "Buy", "prop": "amount", "change_type": "property_created", "change_label": "新增属性", "from_value": null, "to_value": "number", "created_at": "..." }]
}
```

> `discovery_logs` 的 `change_type` 取值：事件/属性维度为 `event_created` / `property_created` / `property_type_changed`；用户属性维度为 `user_property_created` / `user_property_type_changed` / `user_property_hidden` / `user_property_active`（用户属性用占位事件键 `__user_profile__`）。

### 6.3 实现要点

- `QualityService` 注入 `ClickHouseService`：`sa_events` 侧走 `query`（强制 `project_name` 过滤，红线）；`log_analysis` 侧走新增的 `queryReconcile`（只读跨库，需显式 `readonly: true`，无 `project_name` 列）。
- 默认对拍范围近 7 天；阈值默认 0.1（10%），双向偏差取绝对值判定。
- 前端 `QualityPage` + `QualityReport` 组件挂载在已有「数据质量」菜单（`/meta/quality`）。
- **元数据变化记录**：ingestor 自动发现时写入 `clklog_sa_meta.metadiscoverylog`（MySQL），记录新增事件/属性/属性类型变更；`QualityService.getDiscoveryLog` 查询展示，便于运营感知字段增长与类型变更。

---

## 7. 安全与限额

- 对拍只读：SQL 全部 `SELECT`，无写权限；对社区版仅读取 `log_analysis` 列。
- 清洗硬拒绝社区版库名：白名单 `^clklog_sa(_.*)?$`，其余一律拒绝。
- 清洗删除必须带 `project_name` 过滤 + 时间边界 + 影响行数预估确认（红线 4）。
- 所有清洗 DDL/DML 先在 `clklog_sa_staging` 演练，生成影响行数与预期一致才允许生产。

---

## 8. 发布与运维

- `reconcile.sh` 部署到服务器 `scripts/`，凭据走 `.env`。
- 定时任务：supervisor / cron 配置（每小时粗对拍、每日细对拍）。
- 清洗仅人工触发（合规操作需审批，不宜自动化）。
- 回滚：任何清洗删除可通过 `clklog_sa_bak` 快照表 `INSERT SELECT` 恢复；审计记录保证可追溯。

### 5.7 实现实况（2026-09-15 as-built）

| 设计写法 | 实现做法 | 原因 |
|---|---|---|
| 「① 测试库演练：重建受影响表结构，再跑清洗 SQL」 | 拆成**两段**：① 生产只读预演（影响行数 + 样本）；② 测试库演练——把**匹配行**（≤ `--rehearsal-max`，默认 1000）复制成同构表后跑同一条 DML，删除验「剩余 0」、掩码验「残留归零 + 幂等复跑不变」 | 只重建空表跑 DML 得到的是「影响了 0 行」，验证不了任何东西；复制真实匹配行才能证明 DML 语义与掩码正则正确 |
| 清洗账号写在 `users.d` XML | 由 `migrate-clickhouse.ts` **SQL 建权** | 实测 CH 会把 XML `<grants>` 的 `SELECT, ALTER DELETE, ALTER UPDATE` 扩展成含 `INSERT/DROP/CREATE DATABASE` 的宽权限；SQL 方式权限精确且随发版幂等自愈（🔎 `SHOW GRANTS` 逐条核对） |
| 掩码表达式示例（含嵌套 substring/match） | 内置三种模式的**字面量正则 + 反引替换**（phone/email/idcard），键名先过标识符校验 | ClickHouse 23.2 的 `replaceRegexpAll` 不支持对捕获组做函数运算；字面量方案同时保证**幂等**（掩码后不再匹配）与零注入面 |
| 未提及 | **掩码覆盖度门禁**：掩码前统计「带该键但格式不匹配」的行，默认阻断，需 `--allow-uncovered` 才放行 | 这类行会**保持明文**；不提示会让运维误以为「掩码完成」 |
| 未提及 | 所有 CH 查询带 `max_execution_time`（`--query-timeout`，默认 120s）+ curl `--max-time`；掩码默认窗口 = 当天 | `properties` 无索引：3 天窗口实测 CH 估值 327s、曾让 CLI 挂死 781s（红线 4：查询必须有界） |
