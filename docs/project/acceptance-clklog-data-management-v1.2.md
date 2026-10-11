# 验收记录：数据清理 v1.2（定点删除 / 未登记事件 / 项目退役）

> 门禁文档：`docs/product/prd-clklog-data-management-v1.2.md`（V12-AC1~AC8）、
> `docs/architecture/clklog-analytics-design-data-management-v1.2.md`。
> 全部证据来自生产实测（2026-10-09，版本 17698 ~ 17715）。

## V12-AC 逐条

| 编号 | 判据 | 结果 | 证据 |
|---|---|---|---|
| V12-AC1 | 预演给出影响行数/日期范围/样例，且不写数据 | **通过** | 生产：`$undefined` 预演 → 2 行 / 2026-07-30 / 样例含 distinct_id；`$SignUp` → 451,297 行 / 2026-07-28~2026-11-08；预演期间无审计/无 mutation（单测亦断言只读） |
| V12-AC2 | 备份表在破坏性执行前存在且行数与预演一致；备份失败则中止 | **通过** | `$undefined`：备份表 `clklog_sa_bak.sa_events_20261009060517` 实测 2 行（=预演）；`$SignUp` 未来批：`…_20261009093931` 实测 **11,154 行**（=预演）；备份失败用例单测覆盖（中止且不执行 DELETE） |
| V12-AC3 | token 绑定条件+行数、5 分钟过期；条件变化即失效；缺 token/表名不符 → 400 | **通过** | 单测 3 项（过期/条件变化/换密钥）；生产：缺 `confirm_table` 与错表名均 400 |
| V12-AC4 | 社区版库/白名单外表 → 400；账号未配置 → 400 且页面明示 | **通过** | 单测断言 `clklog.*` 硬拒（红线 1）与「清洗账号未配置不回退高权账号」；页面在 `cleanup_enabled=false` 时显式提示且禁用执行 |
| V12-AC5 | 执行写审计 `delete_rows` 与清理登记 `rows`；对拍把该区间标「已清理」 | **通过** | 生产：审计 `delete_rows/done`（含备份表、mutation id、ledger id）；登记 #20（2026-07-30）、#21（2026-10-10~2027-09-19） |
| V12-AC6 | 未登记事件差集与手工脚本一致 | **通过** | 生产：面板「数据 431 / 元数据 498」、未登记 `$SignUp(144,506 行, 含未来)`；幽灵登记 50 个（`zz_*`/`leijun*`/`Purchase22222*` 等） |
| V12-AC7 | 项目退役预演覆盖 sa 5 张 + MySQL 31 张，明确社区版不可按项目清 | **通过** | 生产：`clklogapp` → sa_events 亿级行等 5 张；MySQL 31 张合计 148,050 行；`community_note_key=communityNoProject` |
| V12-AC8 | 未来时间戳删除只删 `stat_date > today`，且不触发 DROP PARTITION | **通过** | 生产：`$SignUp` 未来批删除 11,154 行（2026-10-10~2027-09-19），SQL 为 `ALTER DELETE … AND stat_date > {today: Date}`；备份表 11,154 行、登记 #21 |

## 附加：R4-b 执行端端到端演练（空数据项目，零风险）

- 用演练项目 `zz_retire_drill` 跑通：建项目 → 取令牌（`project_retire|zz_retire_drill|sa=5|mysql=31`）→
  **sa 步** 201/`saDone` → **mysql 步** 201/`mysqlDone` + 备份文件
  `/data/logs/production/clklog_manager/project-retire/zz_retire_drill-2026-10-09T09-27-00.ndjson` → 两条
  `project_retire` 审计（done）→ 演练痕迹清理（删登记行 + 审计 `project_retire_drill_cleanup`）。
- 硬门禁实测：拿 `clklogapp` 令牌执行 → **409「最近 24h 仍有 千万级行写入：请先停该项目的上报」** ✓

## 实施中发现并修复的缺陷（全部已发版验证）

| 缺陷 | 现象 | 修复 |
|---|---|---|
| 前置对拍用条件的 `to`（未给为 9999） | `event`/`future` 类删除被永久拦 | 改按预演出的 `max_date`，并分档（近 30 天要求覆盖 / 更早只要求新鲜快照 / future 豁免） |
| mutation 探测走 `query()` | 被红线守卫拦下 → 恒判「有 mutation」→ 409 | 单开受限系统表通道 `countPendingMutations/latestMutationId`（写账号、固定 SQL、参数化） |
| 备份行数校验缺 `project_name` | 被红线守卫拦下 → 表现成「备份失败」 | 计数按项目过滤（更精确） |
| `project` 查询参数重复 | 服务端收到 `"a,a"` → 未登记事件列表恒空 | 前端改走 `params`；后端 `@Query` 兼容数组取首值 |
| 样例列别名遮蔽真实列 | 带日期条件的预演一律 500 | 别名改 `stat_date_text`；加遍历白名单的回归用例 |
| 全段超保留期仍显示绿色「正常」 | 误读为「比对通过」 | 改中性 info 提示（复用既有键，零新增文案） |

## 非目标复核

未改对拍算法/阈值语义/保留策略；**未对社区版 `clklog.*` 做任何写操作**（数据库授权层亦强制：`sa_cleanup` 读社区版被 ACCESS_DENIED）；未做任意 SQL；未删 `SaProject` 登记行；未做定时自动删除。

## 遗留

- **AC-10**（社区版 TTL 生效后连续 2 天观察）：等自然日，届时看 `system.parts` 与磁盘曲线。
- **`$SignUp` 历史 444,680 行（2026-07-28~2026-10-08）按结论保留**：删除需重写命中月分区
  （202609 单月 亿级行 / 百 GiB 级、202610 31 GiB，合计约 百 GiB 级），对 12 GiB、与社区链路共用的
  CK 属高风险长任务；如需清理应低峰期分批并有人盯内存。
- `clklog_sa_bak` 备份表按保留策略登记（建议 90 天）后由 TTL 收敛。
