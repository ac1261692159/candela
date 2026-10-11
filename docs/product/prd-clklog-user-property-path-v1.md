# PRD：用户属性查询路径修复（生产缺陷）

> phase: `clklog-user-property-path-v1`
> 性质：**生产缺陷修复**，不是新功能。
> 证据：`CODE_HANDOVER.md` 2026-09-14 节（生产只读探针实测，ClickHouse 23.2.1.2537）
> 下游实现方案：`docs/architecture/clklog-analytics-design-user-property-path-v1.md`
> 取代归因：`docs/architecture/clklog-analytics-design-user-property-join-v1.md`（2026-09-08 的归因已被实测否证，见该文 §7）
> 状态：**已实现并上线**（2026-09-15 回写：CI 17080 起生效；CH 迁移补 `project_name`、写入侧带上、查询侧改服务端 JOIN）。

---

## 1. 问题（用户可见现象）

| 现象 | 影响面 | 证据 |
|---|---|---|
| 用「用户属性」做**筛选或分组** → 查询报错（missing columns） | 事件 / 漏斗 / 留存三类分析的 user scope 筛选项 | `attribute-resolver.service.ts:84-88` 生成的 SQL 实测执行报 `Code 47 UNKNOWN_IDENTIFIER` |
| 用「用户属性」做**分析主体** → 同样报错 | 分析主体（属性型） | `subject-expr.ts:30-39` 同类构造 |
| 自定义 SQL / AI 查询里写 `sa_user_profiles` → 报 `project_name` 缺列 | 自定义 SQL 报表、AI 只读查询 | `sql-ast-guard.service.ts:136-137` 会注入 `project_name = '<project>'`，而该列在生产表不存在 |

现状兜底只有一处：AI Harness 侧 `scope=user` 已 **fail closed**（主动挡住），平台侧没有兜底 —— 用户点下去就是报错。

## 2. 根因（两条互相独立）

| # | 根因 | 实证 |
|---|---|---|
| R1 | **表结构漂移**：生产 `sa_user_profiles` 只有 `distinct_id,user_key,properties,updated_at`，**没有 `project_name`**，排序键也与脚本不一致 | `system.columns` 实测；`init-clickhouse.ts:45-54` 目标结构带 `project_name` 且 `ORDER BY (project_name, distinct_id)`。`CREATE TABLE IF NOT EXISTS` 不会迁移既有表，且该脚本没有任何发版入口调用（同批发现） |
| R2 | **相关子查询不被 23.2.1 支持**：子查询内无法引用外层列 | `SELECT (SELECT max(batch_id) FROM clklog_sa.sa_cohort_members WHERE uid = sa_events.distinct_id) …` → `Missing columns: 'sa_events.distinct_id'`；最小反例与"列齐备"重测均失败 |

> 2026-09-08 那次修复把问题归因为"缺项目条件"，据此补 `project_name = sa_events.project_name` + `LIMIT 1`。实测表明该归因不成立：这两个改动的组合在 23.2.1 上**必然报错**（R1 让它缺列，R2 让它无法解析相关引用）。

## 3. 目标与范围

修完之后应达到：

1. 事件 / 漏斗 / 留存的 `scope=user` 筛选与分组**可用**，且**项目隔离正确**（同 `distinct_id` 跨项目不串值）。
2. 属性型分析主体（`scope=user`）可用。
3. 自定义 SQL / AI 查询能正常读 `sa_user_profiles`。
4. 表结构对齐是**幂等、可回滚、有审计**的，不删数据。

范围：表结构迁移（重建 + RENAME 切换 + 旧表保留）、写入侧补 `project_name`、查询侧把相关子查询改成**服务端 JOIN 注入**、清理失去意义的旧补偿逻辑。

## 4. 验收标准

- [ ] **V1** 三类分析各一个带用户属性筛选的查询成功返回，结果与"手写 JOIN `sa_user_profiles`"一致。
- [ ] **V2** 项目隔离：造同 `distinct_id` 在两个项目的用户属性数据 → 互不串值。
- [ ] **V3** `SELECT count() FROM sa_user_profiles` 经守卫注入后**可执行**（不再缺列）。
- [ ] **V4** 迁移幂等：连跑两次，第二次 no-op。
- [ ] **V5** 可回滚：旧表保留期内 RENAME 回切即可恢复（**迁移不删数据**）。
- [ ] **V6** 生成的 SQL 中，子查询内**不再出现** `sa_events.` 相关引用（单测断言）。
- [ ] **V7** 属性型分析主体同一批验收通过。
- [ ] **V8** 既有 spec 全绿 + `python3 scripts/arch_ratchet.py` 通过。

## 5. 非目标

- 不做 ID-Mapping / `track_signup` 归并；不实现 `user_set_once` / `user_append` / `user_increment` 的读-改-写语义（现状是覆盖写 + 日志警告，本次不动）。
- 不动社区版表与官方容器；不改 `sa_events` 结构。
- 不放宽自定义 SQL / AI 的表白名单。
- 本次**不解除** Harness `scope=user` 的 fail-closed（三类对拍通过后另行评估）。

## 6. 影响面、发布与回滚

| 项 | 内容 |
|---|---|
| 迁移窗口 | 迁移前暂停 ingestor，切换后启动（表仅 5.8 万行，秒级）；窗口内事件留在 CKafka，重启后补消费，不丢数据 |
| 回滚 | 旧表以 `sa_user_profiles_old_<日期>` 保留 7 天，反向 RENAME 即回滚；代码 revert |
| 审计 | 迁移前后行数 / 耗时 / 执行人留档；不静默改写数据 |
| 发版路径 | 迁移走幂等入口（`migrate-clickhouse`）并在 `server-upgrade.sh` 内执行，失败即中止升级 |

## 7. 与「数据表 v2」的关系

两者需要**同一个机制**：把"跨表取数"从相关子查询改成**服务端 JOIN 注入**。建议：

- 先做本次修复（它同时交付 `JoinRegistry`），数据表 v2 直接复用；
- 反过来，若 v2 先做 JOIN 注入，本次修复的查询侧改动也能直接复用。

即：**一次实现，两处受益**。顺序建议先修缺陷（现网功能已经坏了）。

## 8. 待确认

1. 迁移窗口安排（需短暂停 ingestor，建议低峰）。
2. 是否与数据表 v2 的 JOIN 注入合并为一次实现（建议合并；见实现方案 §6.4）。
3. 旧表保留期 7 天是否合适。

## 9. 更新记录

| 日期 | 变更 |
|------|------|
| 2026-09-14 | 首稿。用户确认"生产缺陷要修复"后立项；依据 CODE_HANDOVER 2026-09-14 两条实证根因定范围与验收。 |
