# 复盘：数据表 Gate 0 生产探测（2026-09-14）

> 关联 phase：`clklog-analytics-datatable-v1` / `-v2`、`clklog-user-property-path-v1`
> 触发原因：评审要求先验证 ClickHouse 23.2.1 的跨表取数能力，再决定实现路径；用户授权在生产执行只读探针，随后授权一次临时字典 DDL 探针。

## 1. 授权与范围

| 时间 | 用户授权 | 实际执行 |
|---|---|---|
| 2026-09-14 | "授权你在生产跑只读探针" | 11 次只读探测（含 `system.parts` / `system.columns`）；账号 `sa_readonly`；全部带项目过滤与行数上限（5000/2000/LIMIT 2） |
| 2026-09-14 | "1"（授权临时字典 DDL 探针） | 1 次 DDL 探针：`CREATE/DROP DICTIONARY clklog_sa.__probe_dt_dict`（临时对象，建后即删） |

**OVERRIDE-REASON**：红线⑥要求 ClickHouse DDL 先在测试库演练，但当前**没有测试 ClickHouse 实例**。本次为用户明确授权的一次性临时字典探针：不触碰任何业务表与数据、建后立即删除、已复查 `system.dictionaries` 残留为 0。

凭证处理：口令从目标进程环境读取，仅在远端 shell 内使用；未回显、未落盘、未写入任何文件或提交说明。

## 2. 结果（要点）

| 探针 | 结果 |
|---|---|
| 相关标量子查询（表名形式 / 最小反例 / 列齐备重测） | **不可用**（`Code 47 UNKNOWN_IDENTIFIER`） |
| `LEFT JOIN`（等值列 / 表达式关联键 + 维表子查询） | **可用** |
| 类型构造与未命中语义 | 可用（定值已写入 v2 设计 §7） |
| 字典：建 / 查元信息 / 删 | 建与删可行（懒加载）；`dictGet*` 与 `SYSTEM RELOAD` **失败**（源连接 516 认证失败） |

## 3. 探测中发现的问题（登记 `CODE_HANDOVER.md` 2026-09-14）

1. 生产 `sa_user_profiles` **缺 `project_name` 列**（表结构漂移）。
2. 相关子查询不被 23.2.1 支持 → 用户属性筛选/分组与属性型分析主体在生产报 missing columns。
3. `scripts/` 无 `init-clickhouse` 调用 → 新增 DDL 不会随升级生效（漂移会持续）。
4. 2026-09-08 的"用户属性关联修复"归因不成立（该方案已加修订说明待重开）。

## 4. 后续动作

| 动作 | 状态 |
|---|---|
| 数据表 v2 取数路径定案为 JOIN（字典不采纳：需内嵌凭证） | 已写入 `clklog-analytics-design-datatable-v2.md` §4.4 |
| 用户属性缺陷修复立项（PRD + 实现方案） | 已交付 `prd-clklog-user-property-path-v1.md`、`clklog-analytics-design-user-property-path-v1.md`，待评审与发版授权 |
| 新增 ClickHouse 幂等迁移入口并接入 `server-upgrade.sh` | 已写入两份实现方案，待实现 |

## 5. 经验

1. **生产没有测试库**是当前最大的工程风险：任何 DDL 都要走"用户授权 + 建后即删 + 复盘"的非常规路径。建议尽快起一个可销毁的 ClickHouse 测试实例，把 DDL 演练常态化。
2. **既有代码的字面存在不等于可执行**：`sa_user_profiles` 的 `project_name` 关联与相关子查询写法在仓库里存在且带单测，但从未在生产形态下验证过。凡涉及跨表/相关引用的查询，验收必须包含"在生产实例上跑一次"。
3. **表结构漂移要能被发现**：`CREATE TABLE IF NOT EXISTS` + 无发版入口 = 线上结构与脚本静默分叉。建议加一条部署后校验：比对 `system.columns` 与脚本目标结构，不一致即告警。
