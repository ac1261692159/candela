# 实现方案：用户分群 v1

> phase: clklog-analytics-user-segment-v1
> 上游：`docs/product/prd-clklog-analytics-user-segment-v1.md`
> 契约补充：`docs/architecture/clklog-analytics-design.md` §5 / §10

---

## 1. 阶段目标与范围

与 PRD 相同。分群**预计算**成员到 `clklog_sa.sa_cohort_members`；分析查询只读该表，不按规则即席圈人。主体固定 `if(user_key != '', user_key, distinct_id)`（下称 `uid`）。不改社区版表。

## 2. 验收标准

与 PRD US-1～US-8 对应。交付前 `python3 scripts/arch_ratchet.py` 通过。单测至少：条件定义校验、圈人 SQL 含 `project_name` 与时间/LIMIT、分析筛选/分组 SQL 引用 `sa_cohort_members` 且不含条件规则里的事件谓词。

## 3. 非目标

与 PRD §3 相同。不扩大 `utils/`。`modules/meta` 已近目录上限，本域落新建 `modules/cohort`，分析求值仍在 `modules/query`。

标签 / SQL 分群 / 分析主体 / SQL 与看板：`clklog-analytics-design-user-segment-followups.md`，不在本期实现。

## 4. 存储

### 4.1 MySQL `clklog_sa_meta.MetaUserCohort`

| 列 | 说明 |
|----|------|
| `cohort_id` | `cohort_` + nanoid(10) |
| `project_name`、`owner` | 项目与创建人 |
| `name` | `^[a-z][a-z0-9_]{0,79}$`，项目内唯一 |
| `display_name`、`remark` | 显示名必填；备注 ≤200 |
| `kind` | `condition` \| `id_upload` \| `result` |
| `definition_json` | 见 §5 |
| `schedule` | `manual` \| `daily`；`id_upload`/`result` 强制 `manual` |
| `status` | `pending` \| `ready` \| `failed` |
| `member_count`、`batch_id`、`last_computed_at`、`compute_error` | 最近一次计算 |

项目内条数上限 200。分析选择器只列出 `status=ready`。

### 4.2 ClickHouse `clklog_sa.sa_cohort_members`

```sql
CREATE TABLE clklog_sa.sa_cohort_members
(
    `project_name` LowCardinality(String),
    `cohort_id`    String,
    `batch_id`     String,
    `uid`          String,
    `computed_at`  DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY project_name
ORDER BY (cohort_id, batch_id, uid)
TTL computed_at + INTERVAL 180 DAY DELETE
```

刷新：新 `batch_id` 写入全量成员，MySQL 切 `batch_id` 后再删旧 batch（`ALTER DELETE` 或之后 TTL）。查询始终 `cohort_id + batch_id`，避免读到半截。单次写入 `LIMIT` 100 万，超时 30s。

建表走分析域 DDL 演练流程，不碰 `clklog.log_analysis`。

## 5. `definition_json`

条件（`kind=condition`），`conditions` 全部 **且**：

```json
{
  "conditions": [
    {
      "type": "did_event",
      "polarity": "did",
      "event": "AppStart",
      "metric": "times",
      "op": "gt",
      "value": 0,
      "time": { "mode": "last_n_days", "n": 7 }
    },
    {
      "type": "sequence",
      "polarity": "did",
      "events": ["A", "B"],
      "time": { "mode": "last_n_days", "n": 7 }
    },
    {
      "type": "user_prop",
      "prop": "vip_level",
      "op": "gte",
      "value": 3
    }
  ]
}
```

`time.mode`：`last_n_days`（相对计算日，不含「今日」未完整日，窗为 `[计算日-n, 计算日-1]`）或 `static`（`start`/`end`）。`event` 允许 `*` 与 `ve_*`。`op` 对次数：`gt|gte|lt|lte|eq`。`user_prop.op` 与现网 `FilterOp` 相同。`sequence.events.length >= 2`。本期无事件属性子筛、无序列关联属性。

ID：`{ "match": "uid" }`，成员只在 CH。结果：`{ "source": "event"|"funnel"|"retention", "dsl": {}, "cell": {} }`，成员只在 CH，不再计算。

## 6. 圈人 SQL（计算时）

公共：`project_name` + `stat_date` 窗 + `uid` 表达式。虚拟事件走现有 `findDefinition`。

| 条件 | 口径 |
|------|------|
| 做过事件 | 窗内该事件（或任意/虚拟展开）按 `uid` `count()`，`HAVING` 比较 |
| 没做过 | 窗内**任意事件**出现过的 `uid`，减去做过集合（次数为 0） |
| 依次做过 | 同漏斗 `windowFunnel`，`level >= 步数`；同时刻不算依次 |
| 没依次 | 窗内有任意事件的 `uid`，且 `level < 步数` |
| 用户属性 | `sa_user_profiles` 按项目 + `uid` 关联，运算符与分析用户筛选相同 |
| 多条件 | 各条件 `uid` 集合求交 |

ID 上传：CSV UTF-8 一列 ID，与 `uid` 等值匹配；在 `sa_events` 或 `sa_user_profiles` 出现过才入群，否则丢弃。模板一行表头 `uid`。

结果分群：用同一套 DSL **另写 list-users SQL**（不是把聚合结果表当成员）。单元格：

- 事件：该查询筛选 + 时间 + 该格子分组值，列出 `uniq uid`（人数类指标）。
- 漏斗：`windowFunnel` `level >= 点击步`。
- 留存：所选队列日进入队列的 `uid`；若点的是 N 日留存人数/率，再限制回访条件。

list-users：`LIMIT 1000` 预览；物化 `LIMIT 1000000`。自定义 SQL 分析无此入口。

## 7. 分析 DSL

`FilterScope` / `GroupScope` 增加 `'cohort'`。

- 筛选：`{ scope: 'cohort', prop: '<cohort_id>', op: 'in'|'not_in' }`（属于 / 不属于）。`value` 不用。
- 分组：`{ scope: 'cohort', prop: '<cohort_id>' }` → `if(uid IN members, '属于', '不属于')`。

三个 SQL 生成器对 `cohort` 只生成：

```sql
uid IN (
  SELECT uid FROM clklog_sa.sa_cohort_members
  WHERE project_name = {project} AND cohort_id = {id} AND batch_id = {batch}
)
```

`batch_id` 查询前从 MySQL 现网值注入参数。禁止把 `definition_json` 展开进分析 SQL。`status≠ready` 或分群已删：校验失败或当空集并返回提示（与 PRD 一致：查询中失效当分空集）。

事件 / 漏斗：现有全局筛选与分组项加 `scope=cohort`。留存：增加全局 `filters`（可含 cohort）及可选一个 `groups` 分群项；圈人条件加在内层 `uid` 上，不改日/周/月队列算法。

选择器：`GET /meta/cohorts?status=ready` 填「用户分群」分类；**不**做「用户标签」。

## 8. API

前缀 `/sa/api/meta/cohorts`（鉴权与项目头与现网一致）。

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/` | 列表，keyword 打 name/display_name |
| POST | `/` | 创建条件或 ID（multipart CSV）；创建后入队计算 |
| POST | `/from-result` | 结果分群 |
| GET | `/:id` | 详情（含定义，不含全量成员） |
| PUT | `/:id` | 改条件/显示名/定时；条件变更后重算 |
| DELETE | `/:id` | 删；`dsl_json` 含该 `cohort_id` 的卡片先 409 提示，query `force=1` 才删 |
| POST | `/:id/compute` | 手动刷新（条件）；ID/结果 405 |
| GET | `/:id/members?limit=` | 成员预览，默认 1000、上限 1000 |
| GET | `/template.csv` | ID 模板 |
| POST | `/preview-result` | 结果格成员预览，默认/上限 1000 |

计算异步：创建立即 `pending`，worker 跑完 `ready`/`failed`。日更：`CohortComputeJob` 每天 02:00 处理 `schedule=daily`（元事件统计仍 01:00）。

## 9. 结构

| 位置 | 职责 |
|------|------|
| `modules/cohort/*` | CRUD、定义校验、入队、日更、成员预览 |
| `modules/query/*-sql-generator` | `scope=cohort` 成员 IN；list-users SQL |
| `modules/query/*-query.service` | 结果分群物化调用 list-users |
| `features/cohort/` | 列表、创建类型、条件句编辑器、ID 上传 |
| `pages/.../UserCohortsPage` | 分析 → 用户分群 |
| `FilterEditor` / `GroupEditor` | `scope=cohort`；无标签分类 |
| `EventAnalysisResult` 等 | 人数格「保存为分群」 |

条件句编辑器独立组件，不塞进 `FilterEditor`。`MainLayout` 分析子菜单加 `/analysis/cohorts`。

ID 写入 `clklog-analytics-design.md` §10：用户分群 `cohort_` + nanoid(10)。
