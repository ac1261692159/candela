# 验收记录：数据管理清理执行流（phase: clklog-analytics-data-management-v1）

- 日期：2026-09-15
- 帽子：项目（`docs/project/`）
- 环境：**生产** 生产主机，应用版本 **17175**（`f695088` → `28323f9` → `3c19ff6` → `307ead5`）
- 上游：PRD `docs/product/prd-clklog-analytics-data-management-v1.md`（DM-AC1～DM-AC12）、实现方案 `docs/architecture/clklog-analytics-design-data-management-v1.md`
- 关联：`CODE_HANDOVER.md` 2026-09-15 节、`docs/project/legacy-production-handover.md` §13

---

## 1. 结论

**通过（含一条需注意的语义变化）。** 首轮判定为「有条件通过」，本轮已把 B5（TTL 代价）修成纯元数据操作并在生产大表上闭环，B7 亦已验证；剩余未执行项仅为「真实分区删除」（破坏性，待授权）。

**语义变化提示**：TTL 现在只改表定义，过期数据在后续 merge 时逐步清理，**不会立即释放磁盘空间**——这是本次修正的预期行为（原先的「立即重写」才是异常代价）。 权限、盘点、预演、护栏、审计、日志治理全部实测通过；**执行类动作（DROP PARTITION / TTL）只验证到执行路径与可回退性，未对真实业务数据进行破坏性执行**。

本轮验收发现 **7 处问题**，其中 **6 处已修复并发版**：B1 TTL 语法错误致功能完全不可用、B2 TTL 解析缺失、B3 护栏错误 500、B4 按日分区表预演无说明、B5 TTL 触发全表重写、B7 长 DDL 导致审计丢失；B6 为操作教训（已如实记录，无数据损失）。

## 2. 逐条判定

| AC | 判定 | 证据 |
|---|---|---|
| DM-AC1 权限 | ✅ | 非超管 `/ops/data-mgmt/overview` → **403**、`cleanup/preview` → **403**；超管 → 200 |
| DM-AC2 存储概览 | ✅ | 盘点 **25 张表**，字段含 rows / compressed_bytes / total_bytes / partitions / last_write_at / ttl_days；`sa_events` rows=亿级、compressed=94.0 GB、parts=8 |
| DM-AC3 表存储趋势 | ✅ | `/trend?hours=168` → 200 |
| DM-AC4 数据健康 | ✅ | `/health` → 200（有对拍快照） |
| DM-AC5 预演只出过去月份 | ✅ | `sa_events` 60 天 → 候选 `['202510','202601','202602']`（当月 202609、未来 202610/202701 均被排除）；格式非 YYYYMM 一律拒绝（单测） |
| DM-AC6 预演护栏 | ✅ | 预演走 `queryReconcile` + `RECONCILE_GUARDS`（只读、内存/线程/时间上限），不接受调用方 SQL |
| DM-AC7 TTL | ✅ | 三轮闭环：B1 修语法（修复前完全不可用）→ B2 修解析 → **B5 改纯元数据操作**。终态在 亿级行 `log_analysis` 上实测：设置 TTL **0.11s 返回**、**不产生 MATERIALIZE TTL mutation**、TTL 写入 `system.tables`、审计留痕（`set_ttl/done/3650`）；越界 → 400；已 `REMOVE TTL` 回退，行数只增不减 |
| DM-AC8 分区清理执行流 | ✅（护栏）/ ⚠️（真删未做） | 确认表名不匹配 → **400**；当前月分区 → **400「当前月分区正在写入，禁止删除」**；执行路径写入审计（`drop_partition` 行含 done/partitions）。**未对真实分区执行删除**（破坏性，需授权） |
| DM-AC9 日志目录治理 | ✅ | `GET /ops/log-cleanup` → 200（白名单 receiver、保留 3 天、enabled）；白名单目录预演 → 200；**非白名单目录 → 400**（修复前 500）；自动清理运行 **373** 条审计 |
| DM-AC10 动作审计 | ✅ | `ops_action_log`：`log_cleanup` 373 条 + `drop_partition` 2 条，含 operator/status/detail/时间 |
| DM-AC11 超管双闸 | ✅ | 控制器 `assertOpsAdmin()` + 权限码；查询类走 `queryReconcile`（只读设置） |
| DM-AC12 门禁 | ✅ | 棘轮 exit 0；新增测试与实现同包；CI 全量后端单测（73 suites / 433 tests） |

## 3. 验收发现与处置

| ID | 级别 | 内容 | 处置 |
|---|---|---|---|
| **B1** | P1 | **TTL 设置完全不可用**：生成的 DDL 是 `MODIFY TTL log_time + TO INTERVAL '180' DAY`，ClickHouse 23.2 报语法错误（数值不能加引号）→ 每次调用 500 | **已修**（`+ INTERVAL ${days} DAY`），发版 17170，实测 TTL 成功写入 |
| **B2** | P2 | `parseTtlDays` 只认 `INTERVAL 'N' DAY`，解析不出生产 `sa_events` 实际的 `toIntervalMonth(18)` → 概览把**已有 TTL 显示为「无保留期」** | **已修**（兼容 4 种写法，按月 ×30 折算），现 `ttl_days=540` |
| **B3** | P2 | 动作类护栏错误抛 `Error` → **HTTP 500**（确认表名不匹配、无可执行分区、TTL 越界、表不在盘点范围） | **已修**（`BadRequestException`），实测 4 类均 400 |
| **B4** | P3 | `previewCleanup` 对**按日分区**的表（`log_analysis`，磁盘占用最大）恒返回空候选且无说明，用户会把「工具不支持月分区清理」误读成「没东西可清」 | **已修**：返回 `note`「该表按日分区（55 个分区，如 2009-01-01），分区清理仅支持按月分区（YYYYMM）；请用「TTL 设置」管理保留期」 |
| **B5** | **P1 → 已修** | **TTL 在亿级表上不是廉价操作**：`MODIFY TTL` 触发 `MATERIALIZE TTL` mutation（重写既有全部 part），`log_analysis`（亿级行 / 55 分区）上实测 HTTP 调用 **>120s 未返回**；`mutations_sync=0` 也未能让它立即返回。设计文档 D1「TTL 代价低、可随时回退、首选」的假设在本实例**不成立** | **已修（发版 17175）**：根因是 ClickHouse 的 `materialize_ttl_after_modify` 默认为 **1**，`MODIFY TTL` 会对既有数据执行 MATERIALIZE TTL。现显式置 **0** → 只改元数据、不重写历史 part（保留期语义不变，过期数据在后续 merge 逐步清理）。临时表实测置 0 后不再产生 mutation；生产 亿级行表实测设置 TTL **0.11s 返回、0 个新 mutation**。前端文案同步说明「不会立即释放磁盘，需立即释放请用删除分区」 |
| **B6** | P2（操作副作用） | 回退 B5 时我用 `KILL MUTATION WHERE database='clklog' AND table='log_analysis'`，**连带终止了一个不是我发起的 mutation**：`DELETE WHERE (event = '') AND (distinct_id = '')`（清理空键垃圾行） | 已核实：当前 `event='' AND distinct_id=''` 的行数为 **0**（该清理或已完成或无匹配），**无业务数据损失**；但那个操作的执行被中途打断，需其所有者确认是否需重跑。**教训：KILL MUTATION 必须按 mutation_id 精确定位，不要按表级过滤** |
| **B7** | P1 | **长 DDL 会导致审计丢失**：B5 那次 TTL 变更**已生效**（`system.tables` 可见 TTL），但客户端 120s 超时断开后 `set_ttl` 审计**一行都没写**——事后补记的审计模式在长 DDL 下不成立（红线 6 不允许「改了没留痕」） | **已修**：`set_ttl` 与 `drop_partition` 改为**先落 `status='running'` 审计行 → 执行 DDL → 更新为 done/failed**；DDL 失败还会带出可读原因（400）。发版 17172，实测执行路径审计正常写入 |

## 4. 未执行的动作（需授权）

| 动作 | 原因 |
|---|---|
| 对**真实分区**执行 `DROP PARTITION` | 不可恢复的破坏性操作，无人值守时不执行。已验证确认/白名单/当月拒绝/审计四道护栏与执行路径（用不存在的分区 `202001` 走完全程） |
| 在生产**重复执行 TTL 设置** | B5 已证明代价高昂（触发全表 part 重写）；修复后的语法正确性由「首次实测写入成功 + 单测」双重覆盖，不再重复施加于生产 |

## 5. 生产痕迹

| 项 | 状态 |
|---|---|
| `log_analysis` 的 TTL | 已 `REMOVE TTL` 回退到**原始无 TTL 状态**；`engine_full` 与操作前一致 |
| 数据行数 | 操作前后 亿级 → 亿级（**增加**，为持续写入；无删除） |
| 我发起的查询/mutation | 全部终止；`system.mutations` 无未完成项 |
| 审计行 | 保留（`drop_partition` ×2、`set_ttl` 无——B7 已修，历史那次未留痕已如实记录） |
| 临时超管 / 非超管 token | 均已从 `sausertoken` 删除 |
| 业务数据 | 未删除、未修改任何业务行 |

## 6. 下一步

1. B5 的 UI/进度改造（建议下一步做：它决定运维敢不敢在大表上动 TTL）。
2. B6 的外部 mutation 是否需重跑，需确认所有者。
3. 遗留：口令轮换（`docs/project/legacy-production-handover.md` §13）、数据表 v2 的 A3/A4/A8-20万/A9 尾巴、DT-EQ。
