# 用户属性关联（scope=user）JOIN 修复方案

phase: clklog-user-property-join-v1。登记来源：CODE_HANDOVER 2026-09-08「用户属性 SQL / P1」；本文是该条要求的专门方案。归属帽子：架构（本文）、程序（实现与测试）。

## 1. 背景与缺陷

用户属性解析（`attribute-resolver.service.ts::resolveUserProperty`）生成的标量子查询：

```sql
(SELECT JSONExtract…(properties, '<prop>')
 FROM clklog_sa.sa_user_profiles FINAL
 WHERE distinct_id = sa_events.distinct_id)
```

缺陷有两点：

1. **缺项目条件**：`sa_user_profiles` 按 `(project_name, distinct_id)` 建表，子查询只按 `distinct_id` 关联。同一 `distinct_id` 存在于多个项目时（如设备 ID、测试账号），会把其他项目的用户属性取到本项目的查询里——跨项目数据泄漏。
2. **无 LIMIT 1 且与正确范式不一致**：同仓库 `subject-expr.ts` 的同类子查询同时关联 `project_name = sa_events.project_name` 并带 `LIMIT 1`；resolver 未对齐，FINAL 合并前重复行可能使标量子查询报多行错误。用户报告的 missing columns 截图与此路径吻合（Harness 侧已 fail closed 挡住，平台侧暴露面见下）。

暴露面（全部调用方已枚举）：cohort 条件（`cohort-condition-sql.service.ts` 的 `buildUserProp` 与过滤 walk）；Harness 分析链路 scope=user 已 fail closed，不在本次暴露面内。

## 2. 目标

- 用户属性标量子查询同时关联 `distinct_id` 与 `project_name = sa_events.project_name`，并带 `LIMIT 1`，与 `subject-expr` 范式一致。
- profile 侧 SQL（直接查 `sa_user_profiles`、不走 sa_events 关联）的调用方字符串替换同步扩展，保证替换后仍带自身 `{project}` 参数过滤。
- 单测覆盖生成的 SQL 形状；既有 cohort/subject/查询回归保持通过。

## 3. 非目标

- 不解除 Harness scope=user 的 fail-closed 保护；对拍通过并经用户授权后才另行评估解除。
- 不改 `sa_user_profiles` 表结构、写入路径（ingestor）与 ID 归一策略。
- 不在本方案内做生产发版；线上对拍在发版后执行。

## 4. 修复内容

| 文件 | 修改 |
| --- | --- |
| `apps/analytics-server/src/modules/shared/attribute-resolver.service.ts` | `resolveUserProperty` 子查询加 `AND project_name = sa_events.project_name` 与 `LIMIT 1` |
| `apps/analytics-server/src/modules/cohort/cohort-condition-sql.service.ts` | `buildUserProp` 的 `attr.replace(/sa_events\.distinct_id/g, …)` 扩展为同时替换 `sa_events.project_name`（profile 侧 SQL 已有 `project_name = {project}` 参数过滤） |

关联安全性说明：`project_name = sa_events.project_name` 是对外层行的相关引用，与 subject-expr 相同；不引入字面量项目值，无需新的参数绑定，也无注入面（不拼接用户输入）。

## 5. 验收标准

1. 单测：断言 resolver 生成 SQL 含 `project_name = sa_events.project_name` 与 `LIMIT 1`；`buildUserProp` 生成的 profile 侧 SQL 不含 `sa_events.` 前缀且含 `project_name = {project` 参数过滤。
2. 既有回归：attribute-resolver、cohort 相关 spec、查询模块 spec 全部通过；`python3 scripts/arch_ratchet.py` 通过。
3. 三类对拍（发版后线上执行，另记录）：事件/漏斗/留存各构造一个带用户属性过滤的查询，与同口径不带该过滤的查询对比——结果集满足过滤语义（命中的主体的该属性确实满足条件），且不同项目同 `distinct_id` 数据不串。通过前 Harness fail-closed 不动。

## 6. 回滚

单文件两处小改，回滚即 revert 该提交；无数据迁移、无结构变更。

## 7. 2026-09-14 复核：结论待重开（P1）

在生产只读探测（ClickHouse `23.2.1.2537`）后，本方案的两条归因都不成立：

| 原归因 | 实测证据 | 结论 |
|---|---|---|
| 缺项目条件导致串项目 | `SELECT max(batch_id) FROM clklog_sa.sa_cohort_members WHERE uid = sa_events.distinct_id` → `Code: 47 UNKNOWN_IDENTIFIER Missing columns: 'sa_events.distinct_id'`。用**列齐备**的表重测同样报错，说明与缺列无关 | **23.2.1 不支持相关子查询（外列引用）**。§4 的"补 `project_name = sa_events.project_name`"属于同类构造，上线仍会报错 |
| FINAL 造成多行 / 只按 distinct_id 关联 | `system.columns` 实测生产 `sa_user_profiles` 只有 `distinct_id,user_key,properties,updated_at`，**没有 `project_name`** | 即便去掉相关引用，`WHERE project_name = …` 也会 `Missing columns: 'project_name'`：线上表与 `init-clickhouse.ts` 漂移 |

影响：`attribute-resolver.service.ts::resolveUserProperty` 与 `subject-expr.ts` 的 scope=user 分支生成的 SQL 在生产会直接失败（用户属性筛选/分组、用户属性作为分析主体）。

不在本文范围内修：修法需要改成 JOIN 或字典取数，涉及查询生成器改造与生产表结构对齐，须先出方案并经用户授权。证据与登记见根目录 `CODE_HANDOVER.md` 2026-09-14 节。Harness `scope=user` 的 fail-closed 保持不动。

**2026-09-14 更新（用户已确认修复）**：本文由 `docs/product/prd-clklog-user-property-path-v1.md` + `docs/architecture/clklog-analytics-design-user-property-path-v1.md`（phase: `clklog-user-property-path-v1`）取代。新方案三段修复：① 表结构幂等迁移（重建 + RENAME + 旧表保留）；② 写入侧补 `project_name`；③ 查询侧以 `JoinRegistry` 做 JOIN 注入（字典路径实测需内嵌凭证，已否）。本文 §4 的两处代码改动随该方案一并替换。
