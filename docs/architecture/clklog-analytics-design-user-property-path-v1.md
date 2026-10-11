# 实现方案：用户属性查询路径修复

> phase: `clklog-user-property-path-v1`
> 性质：**生产缺陷修复**（不是新功能）。
> 上游 PRD：`docs/product/prd-clklog-user-property-path-v1.md`
> 证据：`CODE_HANDOVER.md` 2026-09-14 节；生产只读探针（ClickHouse 23.2.1.2537）
> 取代：`docs/architecture/clklog-analytics-design-user-property-join-v1.md`（其归因已被实测否证，见该文 §7）
> 状态：**已实现并上线**（2026-09-15 回写：`migrate-clickhouse.ts` 的 `ensureUserProfileSchema`、`sa-user-profile-writer.service.ts`、`attribute-resolver.service.ts` 三处即为本方案落地）。

---

## 0. 结论摘要

两条**互相独立**的根因，造成"用户属性"整条路径在生产不可用：

| # | 根因 | 证据 |
|---|---|---|
| R1 | **表结构漂移**：生产 `sa_user_profiles` 只有 `distinct_id,user_key,properties,updated_at`，**没有 `project_name`**，且排序键与脚本不一致 | `system.columns` 实测；`init-clickhouse.ts:45-54` 的目标结构带 `project_name` + `ORDER BY (project_name, distinct_id)` |
| R2 | **相关子查询不被支持**：23.2.1 无法解析子查询里对外层列的引用 | `Code 47 UNKNOWN_IDENTIFIER Missing columns: 'sa_events.distinct_id'`（最小反例与列齐备重测均失败） |

对应三段修复：**迁移表结构 → 写入补 `project_name` → 查询侧改 JOIN 注入**。

---

## 1. 阶段目标与范围（门禁要素①）

让「用户属性」在事件 / 漏斗 / 留存三类分析里可用且项目隔离正确，并让自定义 SQL / AI 查询能正常读 `sa_user_profiles`。

范围：表结构幂等迁移（含回滚保留）、写入路径补列、查询侧 JOIN 注入（共享机制）、旧补偿逻辑清理、验收与发布。

## 2. 验收标准（门禁要素②）

- [ ] **V1 可用性**：事件 / 漏斗 / 留存各构造一个带 `scope=user` 筛选的查询，成功返回；结果与"手写 JOIN `sa_user_profiles`"的结果一致。
- [ ] **V2 项目隔离**：在测试项目造同 `distinct_id` 的用户属性 → 与 `clklogapp` 互不串值（迁移回填 + JOIN 条件双保险）。
- [ ] **V3 自定义 SQL / AI**：`SELECT count() FROM sa_user_profiles` 经守卫的 `additional_table_filters` 注入后**可执行**（不再缺列）。
- [ ] **V4 迁移幂等**：连续跑两次迁移入口，第二次为 no-op，退出码 0。
- [ ] **V5 可回滚**：旧表在保留期内 RENAME 回去即可回滚；回滚步骤写入发布单。
- [ ] **V6 无相关引用**：单测断言生成的 SQL 中，子查询内**不再出现** `sa_events.`（`attribute-resolver`、`subject-expr` 两处）。
- [ ] **V7 分析主体**：`scope=user` 的属性型分析主体同一批验收（`subjectExpr` 走同一条 JOIN 路径）。
- [ ] **V8 回归**：既有 spec 全绿 + `python3 scripts/arch_ratchet.py` 通过；Harness `scope=user` 的 fail-closed 保持不动（对拍通过后另行评估解除）。

## 3. 非目标（门禁要素③）

- 不做 ID-Mapping / `track_signup` 归并；不实现 `user_set_once` / `user_append` / `user_increment` 的读改写语义（现状仍是覆盖写 + 警告）。
- 不动社区版表与官方容器；不改 `sa_events` 结构。
- 不改分析平台其它 SQL 生成路径（自定义 SQL 守卫白名单不变）。
- 不解除 Harness `scope=user` 的 fail-closed。

---

## 4. 表结构对齐迁移（R1）

### 4.1 为什么必须重建而不是 ALTER

目标结构的主键是 `ORDER BY (project_name, distinct_id)`，而排序键**无法 ALTER**；`ADD COLUMN` 只能得到"不在主键里的 `project_name`"，跨项目同 `distinct_id` 仍会互相覆盖。因此按"建新表 → 回填 → RENAME 原子切换 → 保留旧表"。

### 4.2 步骤（幂等，先测试库演练）

```sql
-- 幂等判定：SELECT count() FROM system.columns WHERE database='clklog_sa' AND table='sa_user_profiles' AND name='project_name'
CREATE TABLE IF NOT EXISTS clklog_sa.sa_user_profiles_v2
(
    project_name LowCardinality(String) DEFAULT 'clklogapp',
    distinct_id  String,
    user_key     String DEFAULT '',
    properties   String CODEC(ZSTD(3)),
    updated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (project_name, distinct_id);

-- 回填：旧表无 project_name → 取默认项目；同 distinct_id 多条取 updated_at 最新
INSERT INTO clklog_sa.sa_user_profiles_v2 (project_name, distinct_id, user_key, properties, updated_at)
SELECT 'clklogapp' AS project_name, distinct_id, user_key, properties, updated_at
FROM (
    SELECT * FROM clklog_sa.sa_user_profiles
    ORDER BY updated_at DESC
    LIMIT 1 BY distinct_id
);

RENAME TABLE clklog_sa.sa_user_profiles TO clklog_sa.sa_user_profiles_old_20260914,
             clklog_sa.sa_user_profiles_v2 TO clklog_sa.sa_user_profiles;
```

- **写入窗口**：迁移前 `supervisorctl stop clklog_analytics_ingestor`，切换后启动（5.8 万行，秒级）；窗口内事件仍进 CKafka，重启后由消费者补上，不丢数据（Kafka 保留期内）。
- **保留与回滚**：旧表保留 7 天（`sa_user_profiles_old_<日期>`），回滚即反向 `RENAME`；7 天后人工确认后 DROP。
- **审计**：迁移前后行数、耗时、执行人记入发布记录；不静默改写数据（红线⑥）。
- **入口**：并入 v1 数据表方案已规划的 `migrate-clickhouse` 幂等入口（`ensureUserProfileSchema()`），由 `scripts/server-upgrade.sh` 调用，失败即中止升级。

### 4.3 默认项目值

回填与 `DEFAULT` 都用 `clklogapp`（现网唯一项目，`docker-compose`/init 脚本同值）。多项目接入后由写入侧显式带值（§5），不再依赖 DEFAULT。

## 5. 写入路径补列（R1 的一半）

`modules/ingestor/sa-user-profile-writer.service.ts:37-42` 当前 record 不含 `project_name`，因此在旧表上"恰好能写"。修复：

- `buildRecord` 增加 `project_name: message.project_name ?? 'clklogapp'`（`ParsedSensorsMessage` 需补该字段，解析处从消息体取，缺省同 DDL DEFAULT）。
- 迁移与新写入同批发布；先迁移后发码，或用 DEFAULT 兜住顺序差异（DDL 默认值即兜底）。
- 顺带把 `user_set_once/user_append/user_increment` 的"覆盖写 + 警告"在注释与文档里标注为已知限制（非目标，见 §3）。

## 6. 查询侧 JOIN 注入（R2，与数据表 v2 共用机制）

### 6.1 为什么不能继续用子查询

23.2.1 不支持相关子查询（§0 R2）。用户属性能用的三种写法里：字典需内嵌凭证（见 `clklog-analytics-design-datatable-v2.md` §4.5，已否）；相关子查询不可用；**只剩 JOIN**。

### 6.2 JoinRegistry 契约（新增，请求级）

```ts
interface JoinSpec {
  alias: string;        // up_1 / dt_1 …
  table: string;        // clklog_sa.sa_user_profiles | clklog_sa.sa_datatable_rows
  on: string;           // sa_events.distinct_id = up_1.distinct_id
  subquery: string;     // (SELECT … WHERE project_name = {project} …) 带参数化
}
// register(spec): string  // 返回 alias，按 (table + 过滤条件) 去重
// renderJoins(): string   // 供生成器拼进 FROM 之后
```

- 表达式侧只引用 `alias.column`，**不再出现对外层表的引用**；
- 参数化沿用现有 `{project: String}` 风格（`clickhouse.service` 的 params 机制）；
- 同一查询多次引用同一属性 → 命中同一 alias（去重）。

### 6.3 改动点

| 文件 | 改动 |
|---|---|
| `modules/shared/attribute-resolver.service.ts:84-88` | `resolveUserProperty` 改为 `registry.register(userProfilesJoin(project))` + 返回 `JSONExtract{Suffix}(up_1.properties, '<prop>')` |
| `modules/subject/subject-expr.ts:30-39` | `subjectExpr` 的 user 分支同上（`nullIf(JSONExtract…(up_1.properties,'…'), '')`） |
| `modules/shared/*`（`stripSaEventsCorrelation`） | 该补偿函数失去意义 → 删除并清理引用与单测 |
| 三个生成器 + `listUsers` | FROM 后拼 `registry.renderJoins()`（事件 / 漏斗 / 留存 / 主体 / 用户列表） |
| `modules/cohort/cohort-condition-sql.service.ts` | profile 侧 SQL 本来就是**非相关**查询（`FROM sa_user_profiles`），不注入 JOIN；确认迁移后 `WHERE project_name = {project}` 可用 |
| `modules/report/sql-ast-guard.service.ts:136-137` | `additional_table_filters` 已有 `sa_user_profiles → project_name = '<project>'`；迁移后自然生效，无需改动（补一条测试） |
| `modules/ai-query/ai-sql-guard.service.ts` | 同上，补测试 |

### 6.4 JOIN 形态（性能与语义）

```sql
LEFT JOIN (
    SELECT distinct_id AS uid, properties
    FROM clklog_sa.sa_user_profiles FINAL
    WHERE project_name = {project: String}
) AS up_1 ON sa_events.distinct_id = up_1.uid
```

- `FINAL` + 项目过滤：5.8 万行规模，成本可忽略；若后续增长到千万级，再改 `argMax(properties, updated_at)` 聚合（写入设计文档，不在本次）。
- `LEFT JOIN` 保证未命中用户不丢行（语义与原子查询一致：未命中 → 空值）。
- 与数据表维度（v2 路径 C）共用同一 registry：**同一份"服务端 JOIN 注入"实现服务两个需求**，这是把 v2 从"字典"改成"JOIN"的直接理由。

## 7. 发布与回滚

1. 本地：单测 + 生成 SQL 快照；`arch_ratchet` 通过。
2. 发版：走既有 release 流程（隧道检查 → push → 等 CI → `server-upgrade.sh`）；升级脚本内先跑 `migrate-clickhouse`（幂等迁移），失败中止。
3. 灰度：迁移后先跑三类分析的用户属性查询对拍（与手写 JOIN 比对），再解除观察。
4. 回滚：代码 revert + 旧表 `RENAME` 回切（保留期内）。**迁移本身不删数据**。
5. 证据：`system.columns` 前后对比、迁移行数、对拍结果；不抄任何密钥。

## 8. 红线与门禁对照

| 红线 | 本方案 |
|---|---|
| ① 不侵入社区版 | 只动 `clklog_sa` 自建表 |
| ② 不破坏链路 | 迁移窗口暂停 ingestor（秒级），Kafka 保留兜底；不上报链路 |
| ③ 密钥 | 无新增；JOIN 不含凭证（这也是否掉字典方案的原因之一） |
| ④ 只读有界 | 不放开白名单；JOIN 带项目过滤 |
| ⑥ DDL 先演练、有审计 | 先测试库演练；重建 + RENAME + 旧表保留；行数与耗时留档 |
| ⑦ 配置真相在 Puppet | 无新增配置键 |

## 9. 测试清单

- `attribute-resolver.service.spec.ts`：断言**不再**出现 `sa_events.`，出现 `LEFT JOIN … sa_user_profiles` 与 `up_1.properties`。
- `subject-expr.spec.ts`：user 分支同上。
- 生成器 SQL 快照：事件 / 漏斗 / 留存 / `listUsers` 各一例，断言 JOIN 只挂一次（多次引用去重）。
- `sql-ast-guard` / `ai-sql-guard`：`sa_user_profiles` 查询注入 project 过滤后可执行。
- 端到端（合成 CK）：带用户属性筛选的事件/漏斗/留存查询与手写 JOIN 结果一致。
- 迁移：`ensureUserProfileSchema()` 幂等（第二次 no-op）、缺列时执行、`RENAME` 正确。

## 10. 文件清单

后端：`modules/shared/attribute-resolver.service.ts`、`modules/shared/join-registry.service.ts`（新）、`modules/subject/subject-expr.ts`、三个生成器 + `event-query.service.ts::listUsers`、`modules/ingestor/sa-user-profile-writer.service.ts` + `ingestor.types.ts`、`src/scripts/migrate-clickhouse.ts`（新，含 `ensureUserProfileSchema()`）、`scripts/server-upgrade.sh`。
删除：`stripSaEventsCorrelation` 及其单测。

## 11. 风险

| 风险 | 对策 |
|---|---|
| 迁移窗口内写入丢失 | 暂停 ingestor + Kafka 保留补消费；迁移前记录行数，迁移后核对 |
| JOIN 影响既有查询性能 | `FINAL` 子查询在项目过滤后仅 5.8 万行；对拍时记录耗时基线 |
| 旧表长期滞留占空间 | 保留 7 天 + 到期提醒；写入发布单 |
| 项目回填值错误（多项目未来接入） | 迁移只对"无 `project_name` 的历史行"生效，写入侧此后显式带值 |

## 12. 更新记录

| 日期 | 变更 |
|------|------|
| 2026-09-14 | 首稿。基于 CODE_HANDOVER 2026-09-14 两条实证根因（表缺列 + 相关子查询不可用）给出迁移、写入补列、JOIN 注入三段修复；明确与数据表 v2 共用 JOIN 机制。 |
| 2026-09-14 | **已实现并发布（生产 release）**。提交 `ef01434` → CI 包 `17080`（原 `17073`）。发布证据：① `sa_user_profiles` 迁移 `58217 → 50632` 去重行、旧表保留为 `sa_user_profiles_old_20260914`，`system.columns` 确认 `project_name` 存在；② 三个 supervisor 进程 RUNNING；③ 生产真实形态 SQL（左表不带别名 + `LEFT JOIN … ON sa_events.distinct_id = up_1.uid`）HTTP 200 执行；④ 画像写入健康（15 分钟内 104 行）。本地前置：`tsc` 0 错误、`jest` 319/319、`arch_ratchet` 通过。首次执行因升级脚本漏继承 `MYSQL_PASSWORD` 而**按设计中止**（未重启 server），修正为继承运行中进程全部环境后重跑成功；scripts/server-upgrade.sh 被 gitignore，改动仅存在于本机/部署机。 |
