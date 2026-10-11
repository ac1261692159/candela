# 验收记录：数据治理 · 敏感数据清洗（phase: clklog-analytics-v1-data-governance）

- 日期：2026-09-15
- 帽子：项目（`docs/project/`）
- 环境：**生产** 生产主机，应用版本 **17185**
- 上游：PRD `docs/product/prd-clklog-analytics-v1-data-governance.md` §5、实现方案 `docs/architecture/clklog-analytics-design-data-governance.md` §5–§6
- 关联：`CODE_HANDOVER.md` 2026-09-15 节、`docs/project/legacy-production-handover.md` §14（清洗运维）

---

## 1. 结论

**通过（含一条必须由产品/法务确认的合规边界）。** 清洗主线从零实现并完成线上端到端验收：硬拒绝、演练门禁、备份快照、审计留痕、生产执行、复检六项均以真实数据跑通；4 次执行全部成功，1 次演练按门禁**正确阻断**。

**必须确认的边界（F6）**：清洗**只作用于旁路库 `clklog_sa`**。若同一份敏感数据也存在于社区版 `clklog.log_analysis`（生产上报的 ClkLog 格式数据就是如此），本工具**清不到**——红线 1 禁止改造社区版。若合规要求「彻底删除」，需要产品/法务决策走社区版官方支持的方式。

## 2. 交付物

| 交付 | 位置 | 说明 |
|---|---|---|
| 清洗 CLI | `scripts/cleanup.sh`（1040 行） | 五步门禁；`--self-test` 离线自检 |
| 清洗账号 | CH `sa_cleanup` | SQL 建权：`clklog_sa.*` 仅 `SELECT/ALTER DELETE/ALTER UPDATE`；`clklog_sa_bak.*` / `clklog_sa_staging.*` 另给建表与写入 |
| 备份库 / 演练库 | `clklog_sa_bak` / `clklog_sa_staging` | 由 `migrate-clickhouse.ts` 的 `ensureCleanupSchema()` 幂等创建（随发版自愈） |
| 审计表 | MySQL `clklog_sa_meta.audit_cleanup` | Prisma 模型 + 迁移 `20260915190000_audit_cleanup`（红线 6 落点） |
| 凭据 | 服务器 `/root/.clklog-cleanup.env`（600） | 清洗账号口令 + 审计库连接；口令 sha256 存仓库（明文不入库） |

## 3. 端到端实测（真实数据，2026-09-15）

**造数**：经 receiver（`POST /api/gp`）上报 `zz_cleanup_probe` × 6（uid_1 ×4、uid_2 ×2，properties 含 `"phone":"13812345678"`）+ `zz_cleanup_bad` ×1（uid，`"phone":"1381234567"` 10 位，用于验证覆盖度门禁）。

| # | 动作 | 结果 |
|---|---|---|
| 1 | 演练模式 `delete-user uid_1`（无 `--execute`） | ① 影响 4 行 → ② 演练：复制 4 → 删除后剩 0 → **通过**；**生产未改动**（uid_1 仍 4 行） |
| 2 | 演练模式 `mask phone`（含 10 位异常值） | ② 演练：待掩码行归零、幂等复跑不变，但**覆盖不到 1 行（格式不匹配）→ 门禁阻断** |
| 3 | `delete-user bad_uid --execute` | ③ 备份 1 行 → ④ 审计 id=1 → ⑤ 执行 + 复检归零 |
| 4 | `mask --json-key=phone --mask=phone --execute` | ② 演练通过（覆盖不足 0、样本 `138****5678`）→ ③ 备份 6 行 → ④ 审计 id=2 → ⑤ 复检明文归零 |
| 5 | `delete-user uid_1 --execute` | ③ 备份 4 行 → ④ 审计 id=3 → ⑤ 复检归零 |
| 6 | `delete-user uid_2 --execute`（清测试数据） | 首次因 CH 估值 146s > 默认 120s 被**超时守卫快速拒绝**（提示放宽 `--query-timeout`）；加 `--query-timeout=300` 后 ③ 备份 2 行 → ④ 审计 id=4 → ⑤ 复检归零 |
| 7 | 审计表终态 | 4 条，全部 `staged=1` / `status=done`，`backup_table` 与 `affected_rows` 逐条对应 |
| 8 | 备份快照 | `clklog_sa_bak` 5 张（含 1 张中断运行的孤儿，已单独删除并记录；**有审计的 4 张保留**） |
| 9 | 演练库 | 无残留表（每次演练后自动清理） |
| 10 | 账号边界反验 | `SELECT clklog.log_analysis` → **ACCESS_DENIED**；`INSERT`/`CREATE TABLE` on `clklog_sa` → **ACCESS_DENIED**；读 `clklog_sa`、写 `clklog_sa_bak` → 允许 |
| 11 | 测试数据 | 旁路库 `zz_cleanup%` 残留 **0 行** |

**红线 6 实测生效**：第 3 次执行时审计写入因引号问题失败 → CLI **在接触生产数据前中止**（日志：`审计记录写入失败（红线 6：无审计不执行）`），生产数据完好；修复 SQL 传递方式后重跑成功。

## 4. 验收标准判定

| AC | 判定 | 依据 |
|---|---|---|
| G-C1 按 distinct_id/user_key/事件范围删除；删除前自动全量备份 + 审计 | ✅ | 三次 `delete-user --execute`；备份行数与预演影响行数一一对应；审计 4 条 |
| G-C2 敏感字段掩码（properties 内），幂等可重放 | ✅ | 演练含幂等复跑（掩码后再跑结果不变）；线上掩码后 `13812345678` → `138****5678`；复检明文模式归零 |
| G-C3 先在 `clklog_sa_staging` 演练，通过才允许生产执行 | ✅ | 每次执行前均演练；**第 2 次因覆盖不足被阻断**，未产生任何生产变更 |
| G-C4 硬拒绝任何针对 `clklog` 库的写/删/DDL | ✅（三层） | ① CL1 目标库/表由脚本写死，不接受外部传入；② `guard_sql()` 白名单（`--self-test` 覆盖 4 例拒绝 + 3 例放行）；③ 账号级：`sa_cleanup` 对 `clklog` 连 SELECT 都没有 |
| G-S1 独立写账号，仅授必要权限，凭据不入库 | ✅ | `sa_cleanup` 精确授权（见 §2）；口令 sha256 入库、明文仅服务器 600 文件；`CREATE/ALTER USER` 语句 `log_queries=0` 防落 query_log |

## 5. 验收发现与处置

| ID | 级别 | 内容 | 处置 |
|---|---|---|---|
| F1 | P1 | **掩码覆盖度盲区**：原实现在掩码**后**统计「未掩码行」，而该统计用的正是掩码正则本身——格式不匹配的行（如 10 位手机号）保持明文却被判为「已覆盖」。演练样本里赫然留着 `/tmp` 明文值 | **已修**：改为在**掩码前**统计「带该键但格式不匹配」的行，默认**因覆盖不足而阻断**；确认可接受时显式加 `--allow-uncovered`（实测阻断 ✓） |
| F2 | P1 | **掩码条件是全表扫描**：`properties` 无索引，3 天窗口 CH 估值 **327s**，曾把 CLI 挂死 781s | **已修**：所有 CH 查询带 `max_execution_time`（`--query-timeout`，默认 120s），curl 带 `--max-time`；掩码默认窗口收窄为**当天**；超时提示「缩小范围或放宽上限」；条件改用更省的 `JSONHas` |
| F3 | P2 | 审计 SQL 经 `mysql -e "..."` 传递时被 JSON 里的引号截断 | **已修**：SQL 一律走 **stdin**；JSON 内单引号做 SQL 转义 |
| F4 | P2 | **users.d XML 建权不可用**：实测 CH 会把 `<grants>` 里的 `SELECT, ALTER DELETE, ALTER UPDATE` 扩展成含 `INSERT/DROP/CREATE DATABASE` 的宽权限；且该文件有「挂载源被未知机制还原」的历史 | **改方案**：账号由 `migrate-clickhouse.ts` 用 **SQL 精确建权**（`SHOW GRANTS` 逐条符合预期）；随每次发版幂等自愈 |
| F5 | — | 演练通过后仍可能因审计/备份失败而中止 | ✅ 预期行为：实测在触达生产数据前中止 |
| F6 | **P1（合规）** | **清洗只覆盖旁路库**：社区版 `clklog.log_analysis` 里若存在同一份数据，本工具清不到（红线 1 禁止改造社区版）。本次测试数据因格式不同未进社区版，故未直接暴露该缺口 | **待产品/法务决策**：若「被遗忘权」要求彻底删除，需明确社区版侧的处理方式（社区版官方支持的删除接口 / 单独立项评估） |

## 6. 生产痕迹

| 项 | 状态 |
|---|---|
| 测试事件（`zz_cleanup%`） | 已全部删除（残留 0） |
| 备份快照 | **保留 4 张**（1/6/4/2 行，与审计 1:1 对应）；孤儿快照（中断运行产生、无审计）已删除并记录 |
| 审计记录 | 保留 4 条（`audit_cleanup`），含操作者、备份表名、影响行数、staged 与状态 |
| 清洗账号 / 库 | 保留（`sa_cleanup`、`clklog_sa_bak`、`clklog_sa_staging`）；演练库无残留表 |
| 构建产物 | 应用版本 17185；`migrate-clickhouse` 幂等输出「清洗基础设施：… 已授权」 |
