# 实现方案：用户分群后续（标签 / SQL 分群 / 分析主体 / SQL 与看板）

> 上游：`docs/product/prd-clklog-analytics-user-segment-followups.md`
> 契约补充：`docs/architecture/clklog-analytics-design.md` §5 / §10
> 前置：`docs/architecture/clklog-analytics-design-user-segment-v1.md`（成员表、`scope=cohort`、`modules/cohort`）
> 相关：`clklog-analytics-design-sql-report.md`（AST / `additional_table_filters`）、看板 refresh

本文档四块各自带 `phase`。**A SQL 分群**（`clklog-analytics-sql-cohort-v1`）已实现于 `apps/analytics-server/src/modules/cohort/` 与分群编辑页。**B 自定义 SQL / 看板上的分群**（`clklog-analytics-cohort-sql-dashboard-v1`）已实现于 `modules/report`（schema / Builder / `sa_in_cohort` / 看板 `cohort_filter`）。**C 用户标签**（`clklog-analytics-user-tag-v1`）已实现于 `modules/tag`、分析 DSL `scope=tag`、SQL Builder `sa_tag_*`。**D 分析主体**（`clklog-analytics-analysis-subject-v1`）已实现于 `modules/subject`、查询 `subjectExpr`、分析表单与侧栏「用户」菜单。

红线：成员/标签值只落 `clklog_sa`；圈人与分析有 `project_name` + 时间或 LIMIT/超时；自定义 SQL 与 SQL 分群的用户 SELECT 走只读账号；禁止扩大 `utils/`；`modules/meta` 不承接本域，标签落 `modules/tag`，主体落 `modules/subject`。

---

## A. SQL 分群

> phase: clklog-analytics-sql-cohort-v1

### A.1 阶段目标与范围

与 PRD A 相同。扩展 `MetaUserCohort.kind` 增加 `sql`，成员仍写 `sa_cohort_members`，分析路径零改或只改校验（已按 `cohort_id + batch_id` 读成员）。

### A.2 验收标准

与 PRD SC-1～SC-5 对应。交付前 `python3 scripts/arch_ratchet.py` 通过。

### A.3 非目标

与 PRD A.3 相同。

### A.4 存储

`kind`：`condition | id_upload | result | sql`。`schedule`：`sql` 允许 `manual | daily`，同分群条件。

`definition_json`：

```json
{
  "sql_text": "SELECT if(user_key != '', user_key, distinct_id) AS uid\nFROM sa_events\nWHERE event = 'AppStart'\n  AND stat_date BETWEEN ${PartDate:start} AND ${PartDate:end}\nGROUP BY uid",
  "time_params": [
    { "name": "start", "mode": "last_n_days", "n": 7, "bound": "start" },
    { "name": "end", "mode": "last_n_days", "n": 7, "bound": "end" }
  ]
}
```

占位符 `${PartDate:<name>}` 仅替换 `time_params` 里声明过的 name，值为 `YYYY-MM-DD`。计算日 D：`last_n_days` 窗为 `[D-n, D-1]`（与条件分群一致，不含今日）；`bound=start|end` 取窗两端。另允许 `mode=static` + `date`。未声明的 `${…}` 保存失败。

试跑替换后执行，`LIMIT 1000`；物化 `LIMIT 1000000`。超时 30s。

### A.5 执行

1. 复用 SQL 报告 AST：仅 SELECT；禁止 INSERT/ALTER/DROP/ATTACH/DETACH/TRUNCATE/RENAME/SYSTEM/KILL/OPTIMIZE；禁止表函数、`system.*`、`information_schema`、其他库、`FORMAT`、`SETTINGS`、`INTO OUTFILE`。
2. 表名只允许 `sa_events` / `sa_user_profiles`（归一 `clklog_sa.*`）。**禁止** `sa_cohort_members`、`sa_tag_members`（分群套分群另做）。
3. `project_name` + `stat_date` 用 `additional_table_filters` 注入，不包 `SELECT *` 子查询。不接受 SQL 自带项目值。
4. 用户 SELECT 走 `sa_readonly`。服务把结果集写入 `sa_cohort_members`（写账号），新 `batch_id`，切 MySQL 后再删旧 batch。
5. 结果校验：恰好 1 列；列名不区分大小写为 `uid`，否则取第一列并在服务端当作 `uid`；值转 String；空串丢弃；超 LIMIT 截断并 `failed` 或 `ready` 带截断提示（实现选一种，列表可感知）。

前端：创建类型卡第三张；编辑器复用 SQL 报告组件的只读守卫提示；字典只给事件表/用户表字段，不给分群成员表。`POST /sa/api/meta/cohorts` body `kind=sql`；`POST /:id/preview-sql` 试跑。

日更：现有 `CohortComputeJob` 对 `kind=sql` 走本执行器，不要第二套 cron。

---

## B. 自定义 SQL / 看板上的分群

> phase: clklog-analytics-cohort-sql-dashboard-v1

### B.1 阶段目标与范围

与 PRD B 相同。依赖分群 v1 成员表；不依赖 SQL 分群类型（有 `ready` 分群即可）。

### B.2 验收标准

与 PRD CD-1～CD-5 对应。交付前棘轮通过。

### B.3 非目标

与 PRD B.3 相同。

### B.4 SQL Builder / 手写

`GET /sa/api/report/schema` 增加：

```json
"cohorts": [{ "cohort_id": "cohort_…", "name": "high_vip", "display_name": "高活", "batch_id": "…", "member_count": 1200 }]
```

只列当前项目 `status=ready`。

Builder 的 Filter/Group 增加 `scope: 'cohort'`，表达式与分析 DSL 相同：

```sql
if(user_key != '', user_key, distinct_id) IN (
  SELECT uid FROM clklog_sa.sa_cohort_members
  WHERE project_name = {project} AND cohort_id = {id} AND batch_id = {batch}
)
```

`batch_id` 查询前从 MySQL 注入。禁止展开 `definition_json`。独立用户指标若仍用 `uniqExact(distinct_id)`，与分群成员键不一致时，Builder 在存在 `scope=cohort` 时改为同一 `uid` 表达式（本 phase 修正，避免筛选按 uid、人数按 distinct_id）。

手写模式：字典点击插入注释 + 谓词片段，例如：

```sql
-- cohort: 高活 (cohort_xxx)
if(user_key != '', user_key, distinct_id) IN (
  SELECT uid FROM clklog_sa.sa_cohort_members
  WHERE project_name = {注入} AND cohort_id = {id} AND batch_id = {注入}
)
```

占位由执行层参数化，不把 batch 写死在用户文本里（刷新后仍对准现网 batch）。实现：片段用函数 `sa_in_cohort({cohort_id})` 由改写器展开（仅白名单函数名，AST 允许），避免用户手写过期 `batch_id`。若不愿加函数，则执行前由服务扫描注释锚点替换——优先函数改写，规则写进 SQL 报告守卫白名单，禁止任意函数。

### B.5 看板

`Dashboard` 增加可选：

```json
"cohort_filter": { "cohort_id": "cohort_…", "op": "in" | "not_in" }
```

空 = 无看板级分群筛。最多一个。

`CardService.refresh`：

| 卡片 | 行为 |
|------|------|
| event / funnel / retention | 把看板 `cohort_filter` AND 进 DSL `filters`（已有同 `cohort_id` 则以卡片为准，不重复 AND） |
| sql + Builder | 同上，合并进报表 DSL |
| sql + 手写 | **不改** `sql_text`；对 `clklog_sa.sa_events` 的 `additional_table_filters` 追加 `uid表达式 op (SELECT uid FROM sa_cohort_members …)`；若 SQL 只用了 `sa_user_profiles`，对画像表按画像侧 uid 等价表达式追加 |
| text | 忽略 |

`sa_readonly` 需 `SELECT` `sa_cohort_members`（Puppet `users.epp` / GRANT，只读、仅该表）。注入仍禁止包 `SELECT *`。

看板编辑面：筛选条一个分群选择器 + 属于/不属于；与时间范围并列，不新做变量系统。

---

## C. 用户标签

> phase: clklog-analytics-user-tag-v1

### C.1 阶段目标与范围

与 PRD C 相同。预计算「uid → 一个离散值」。主体固定现网用户口径，直到 D 落地。

### C.2 验收标准

与 PRD UT-1～UT-5 对应。交付前棘轮通过。

### C.3 非目标

与 PRD C.3 相同。

### C.4 存储

MySQL `MetaUserTag`：

| 列 | 说明 |
|----|------|
| `tag_id` | `tag_` + nanoid(10) |
| `project_name`、`owner` | |
| `name` | 同分群名规则，项目内唯一 |
| `display_name`、`remark` | |
| `kind` | 本期仅 `condition` |
| `definition_json` | 见下 |
| `schedule` | `manual` \| `daily` |
| `status` / `member_count` / `batch_id` / `last_computed_at` / `compute_error` | 同分群 |

项目内标签上限 100。选择器只列 `ready`。

ClickHouse：

```sql
CREATE TABLE clklog_sa.sa_tag_members
(
    `project_name` LowCardinality(String),
    `tag_id`       String,
    `batch_id`     String,
    `uid`          String,
    `tag_value`    String,
    `computed_at`  DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY project_name
ORDER BY (tag_id, batch_id, uid)
TTL computed_at + INTERVAL 180 DAY DELETE
```

同一 `(tag_id, batch_id, uid)` 一行；规则互斥靠顺序匹配，不写多值。刷新策略同分群（新 batch → 切 MySQL → 删旧 batch）。单次 LIMIT 100 万，超时 30s。

`definition_json`：

```json
{
  "rules": [
    {
      "value": "高活",
      "conditions": [ { "type": "did_event", "polarity": "did", "event": "*", "metric": "times", "op": "gte", "value": 10, "time": { "mode": "last_n_days", "n": 7 } } ]
    },
    {
      "value": "低活",
      "conditions": [ { "type": "did_event", "polarity": "did", "event": "*", "metric": "times", "op": "gt", "value": 0, "time": { "mode": "last_n_days", "n": 7 } } ]
    }
  ],
  "default_value": "其他"
}
```

`conditions` 校验与分群条件句共用（抽到 `modules/cohort` 的定义校验 **export**，标签模块引用，禁止复制一份谓词实现）。`rules[].value` 非空、标签内唯一、长度 ≤40。`default_value` 可省略。计算：按规则顺序对 uid 求集合；已命中的 uid 不再进入后续规则；剩余 uid 若有 `default_value` 则写入该值。默认值的「剩余」宇宙 = 窗内任意事件出现过的 uid（与「没做过」同一宇宙），避免给从未出现的 ID 打标。

### C.5 分析 DSL

`FilterScope` / `GroupScope` 增加 `'tag'`。

- 筛选：`{ scope: 'tag', prop: '<tag_id>', op: 'eq'|'in'|'not_in', value: string | string[] }`
- 分组：`{ scope: 'tag', prop: '<tag_id>' }` → `ifNull((SELECT tag_value FROM sa_tag_members WHERE … AND uid = 外层.uid), '未打标')`  
  实现用 LEFT JOIN 子查询或 `dictGet` 等价 JOIN，禁止相关子查询扫全表；标准写法：

```sql
LEFT JOIN (
  SELECT uid, tag_value
  FROM clklog_sa.sa_tag_members
  WHERE project_name = {p} AND tag_id = {id} AND batch_id = {b}
) AS t ON t.uid = {uid_expr}
```

分组列 `if(t.tag_value = '', '未打标', t.tag_value)`（未命中为 NULL → 未打标）。

分析 SQL **禁止**展开标签 `definition_json`。

API 前缀 `/sa/api/meta/tags`（CRUD / compute / members），鉴权与项目头同分群。前端 `features/tag/`、`pages/.../UserTagsPage`，分析子菜单「用户标签」。`FilterEditor` 增加分类，不把标签条件句塞进分群编辑器。

计算 worker：可与分群共用队列，按 job type 分支；不要把标签 CRUD 写进 `modules/cohort` 膨胀目录。

---

## D. 分析主体管理

> phase: clklog-analytics-analysis-subject-v1

### D.1 阶段目标与范围

与 PRD D 相同。把写死的 uid 表达式换成按 `subject_id` 解析。分群/标签成员列名仍叫 `uid`，语义变为「当前主体实例 ID」。

### D.2 验收标准

与 PRD AS-1～AS-5 对应。交付前棘轮通过。

### D.3 非目标

与 PRD D.3 相同。

### D.4 存储

MySQL `MetaAnalysisSubject`：

| 列 | 说明 |
|----|------|
| `subject_id` | `asub_` + nanoid(10) |
| `project_name` | |
| `name` | 标识，项目内唯一 |
| `display_name` | |
| `kind` | `preset` \| `property` |
| `source_json` | preset 空；property：`{ "scope": "event"|"user", "prop": "account_id" }` |
| `sort_order` | 列表顺序 |
| `is_preset` | 预置「用户」一行，迁移写入，不可删 |

每个项目种子一条预置：`name=user`，`display_name=用户`，表达式固定：

```sql
if(user_key != '', user_key, distinct_id)
```

事件属性主体：`nullIf(JSONExtractString(properties, {prop}), '')`（已物化则用 `p_` 列）。空值从人数与圈人中排除。

用户属性主体：从 `sa_user_profiles` 最新画像取该 prop，JOIN 键仍是预置用户 uid（先定位人，再取属性值当主体 ID）。属性空则排除。

`MetaUserCohort` / `MetaUserTag` 增加非空 `subject_id`（默认预置用户）。`sa_cohort_members` / `sa_tag_members` 不必加列：成员已是该主体空间的 ID。分析选用分群/标签时校验 `asset.subject_id === query.subject_id`。

### D.5 查询 DSL

事件/漏斗/留存/Builder SQL 增加可选 `subject_id`。缺省 = 预置用户。SQL 生成器集中函数 `subjectExpr(subject)`，禁止各文件复制 `if(user_key…)`。

留存/漏斗 `uniq`、事件人数指标、分群圈人、标签宇宙，全部用 `subjectExpr`。事件属性主体下：

- 禁用条件「没做过 / 没依次」（校验 400，文案说明无法定义未出现过的属性值宇宙）。
- ID 上传按该属性值匹配，不在事件/画像中出现过的行丢弃。

结果分群 list-users 按卡片 `subject_id` 列出主体 ID。

API：`/sa/api/meta/subjects` CRUD + 排序。删除：引用计数（分群、标签、`dsl_json.subject_id` 卡片）>0 则 409，`force` 不做（避免看板静默变口径）；需先改资产。

前端：侧栏「用户」下「分析主体」页；事件/漏斗/留存/分群/标签表单顶部主体下拉。选择器拉分群/标签带 `?subject_id=`。

### D.6 迁移

存量分群/标签/卡片：`subject_id` 填预置用户。生成器缺省行为与现网一致，可先上管理页再上查询切换。

---

## 结构一览

| phase | 新包 / 扩展 | 不放哪里 |
|-------|-------------|----------|
| A | `modules/cohort` 增加 sql 执行器；复用 `report` AST | 不把 SQL 守卫抄进 cohort |
| B | `report/schema`、Builder 面板、`CardService.refresh`、CH GRANT | 不扩大 `modules/meta` |
| C | `modules/tag` + `features/tag`；校验 import cohort 定义 | 不新建 `utils/` |
| D | `modules/subject`；query 生成器改 `subjectExpr` | 不改社区版表 |

ID 写入 `clklog-analytics-design.md` §10：标签 `tag_`、分析主体 `asub_`。`kind=sql` 写入 §5 `meta_user_cohort` 说明。
