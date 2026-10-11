# 验收记录：数据质量 × 数据运维（phase: clklog-data-quality-ops-v1）

> 门禁文档：`docs/product/prd-clklog-data-quality-ops-v1.md`（AC-1~AC-12）、
> `docs/architecture/clklog-analytics-design-data-quality-ops-v1.md`（设计契约）、
> `docs/product/research-clklog-data-quality-ops-v1.md`（调研与实测证据）。
> 本文件按 AC 逐条记录**证据来源**与结论；未完成的条目明确写「未完成」及原因，不写「待办」代替结论。

## 0. 发版与产物核验

| 版本 | 内容 | 证据 | 结论 |
|---|---|---|---|
| 17681 | R1 | 产物含 `ReconcileSchedulerService`；`supervisorctl status` 停在 STARTING | **不可用**：DI 缺陷（`AlertingModule` 未 import `MetaModule`）→ server/ingestor 启动即退、反复重启（复盘见 §5） |
| 17685 | R1 修复 + R2 + TTL 白名单 + 前置分档 | 产物标记：`meta/meta.module`（alerting.module.js）=1、`coverage_required`（retention.service.js）=2、`visitor_summary_byvisitor`（data-mgmt.service.js）=1、`out_of_retention`（quality.service.js）=4、前端 chunk：`DataManagementPage-Q83QK7K9.js`（保留策略卡片）、`QualityPage-DqMdQKcY.js`（配置弹窗）；`supervisorctl status` → `clklog_analytics_server RUNNING`、`clklog_analytics_ingestor RUNNING`；启动日志含 `[ReconcileSchedulerService] 对拍定时已启动（每 5 分钟检查一次，到点跑昨日单日对拍）` 与 `Nest application successfully started` | **可用**（服务已恢复） |
| 17686 | TTL 豁免（前置对拍分档） | 产物标记 `requireCoverage`/`requireCoverage === false`（retention.service.js）=1；`supervisorctl status` → server/ingestor 均 RUNNING；启动日志含「对拍定时已启动」与「Nest application successfully started」 | **可用**（见 §3 放行路径核验） |

## 1. AC 逐条状态

状态取值：**已验证**（有生产/本地实测证据） / **测试覆盖**（单测或集成用例覆盖，未在生产触发） /
**待用户自查**（需登录，凭据不在 Agent 手中） / **未完成**（写清原因）。

| AC | 要求 | 状态 | 证据 |
|---|---|---|---|
| AC-1 | 定时对拍每日自动跑一次（当日 auto 快照幂等） | 见 §2 | 调度逻辑 8 项单测；生产在重启后的首个 tick 落 auto 快照（§2） |
| AC-2 | 快照过期三级 `stale_level` 两页同源，过期不再显示「正常」 | 测试覆盖 + 待用户自查 | `quality.service` 3 项单测（fresh/warn/error）；质量页与运维页都读 `/meta/quality/snapshot` 同一字段（代码同源）；页面渲染待登录自查 |
| AC-3 | 定时对拍失败 → 5 分钟内通知全部启用联系人 | 测试覆盖 | `reconcile-scheduler.spec` 覆盖「超阈通知内容」「执行失败通知」「无启用联系人」三类；生产未制造故障 |
| AC-4 | 阈值只有一个语义（百分比），页面/快照/告警同值 | 已验证 | 快照 `threshold_pct` 与配置同源（单测）；legacy `threshold` 仅请求参数兼容 |
| AC-5 | 死代码 `DataMgmtService.saveReconcileSnapshot` 移除 | 已验证 | 产物 grep `saveReconcileSnapshot` = 0（§2） |
| AC-6 | 保留策略区标出 `log_analysis` 未设置（风险）、`sa_events` 540 天、并给出可信区间数值 | 已验证（实测数据）+ 待用户自查（页面） | 实测 ClickHouse：19 张 `clklog.*` 表 `TTL` 计数 = 0；`sa_events` `toIntervalMonth(18)` = 540 天；服务输出与实测一致（§3） |
| AC-7 | 跨出两侧保留期小者的日期标「超保留期不比对」，不计入 `alert_days` | **已验证（线上）** | 请求 `2026-03-01` 单日（保留期已收紧到 180 天，下限 2026-04-12）→ 返回 43 行全部 `status=out_of_retention`、`alert_days=0`、`crc.skipped=true`、`has_alert=false`，**640ms 返回**（三组重查询按设计跳过）；另有 2 项单测 |
| AC-8 | 未通过对拍的表执行清理被拒，补一次通过的对拍后可执行 | 已验证（拒绝路径，生产只读）+ 测试覆盖（放行路径） | §3：预演返回 `preflight.ok=false` 与具体原因；分档规则单测覆盖「放行」分支 |
| AC-9 | 清理成功后 ledger 出现该区间；对拍覆盖该区间时标「已清理」 | **已验证（TTL 路径，线上）** | 19 张社区版表设 TTL 后 `ops_cleanup_ledger` 出现 19 条 `scope_type=ttl`、`range_from=1970-01-01`、`range_to=2026-04-12`、带 `snapshot_id=10` 与操作人；DROP 路径为 2 项单测（生产未执行 DROP） |
| AC-10 | 社区版表 TTL 生效后不再新增过期分区，且审计留痕 | **部分完成（已执行，观察期未满）** | 2026-10-09 经授权通过平台审计接口对 **19 张社区版表**逐个设置 `TTL stat_date + toIntervalDay(180)`：CK 侧实测 19/19 生效、审计 `set_ttl` 20 条全 `done`（操作人 admin）、清理登记 19 条；执行前量化影响：仅 `log_analysis` 有 8 个分区 / 602 行（2019 年起垃圾）早于截止日，17 张聚合表 **0 行**受影响（真实数据始于 2026-07-28）。「连续 2 天不再新增过期分区」需继续观察 |
| AC-11 | 快照/UI 事件级差异与发现日志直读 | **已验证（页面实测）** | 页面显示事件级差异 Top 20（含 `base_network_socket_reconnect_start +67,040 / +37.18%`）、246 个不一致事件的总数提示、元数据发现 50 条；**验收中发现并修复缺陷**：变化类型列有 4 种取值显示成原始 key（`quality.changeType.user_property_type_changed`）→ 服务端改通用 snake→camel、前端改白名单翻译（未知类型显示原始标识），补 13 语言 7 键 + 回归测试 |
| AC-12 | 双向对拍（抽样内容一致率 + 重复/少记判定）+ 阈值收紧 + 低峰期大范围专项 | **已完成** | ① **R3-a** 白皮书（10-08 归因：Top20 差异占总量差 93.3%、全部正差、CRC 重复 0.054%）；② **R3-b** 双向抽样：sa→raw 99.50%、raw→sa 100.00%、定向 reconnect_start 66.67%，键结构对照定位机制为「社区版侧少计」（详见白皮书 §4）；③ **阈值收紧**：2026-10-09 页面改为 **3%**（审计 `reconcile_config_update`，`threshold_pct=3`）；④ **R3-c** 低峰期大范围专项：八日逐日对拍全部 ok（+1.23%~+1.63%，见白皮书 §2.1），工具为 `scripts/reconcile.sh --type=range`（单日护栏 + 天间隔 + `--max-days` 上限） |

## 2. R1 线上核验（17685，deployed 代码实跑）

核验方式：在服务器上用**已部署的 dist 代码**直接构造服务（`PrismaClient` + `ClickHouseService` + `RetentionService`/`QualityService`/`DataMgmtService`/`ReconcileSchedulerService`），
全部为只读调用；调度一次按「到点时刻」注入（`tick(2026-10-08T19:31:00Z)` = 平台时区 03:31）。

| 检查 | 结果 |
|---|---|
| AC-1 自动对拍 | 快照 `ran_at=2026-10-08T17:46:12Z`、`range=2026-10-08~2026-10-08`、**`trigger=auto`**、`total_days=1`；报告落盘 `/data/logs/production/clklog_manager/reconcile/reconcile-auto-2026-10-08T17-46-12.txt`；审计 `reconcile_run` 记录 `operator=system`、`status=done` |
| AC-1 幂等 | 同日的后续 tick 返回 `already_ran`（真实定时器在 03:30 后只跑一次；注入早于 03:30 的模拟 tick 会再跑一次，属预期语义） |
| AC-4 阈值单一语义 | 快照与审计里 `threshold_pct=10`（配置默认值），与页面同源；请求级 `threshold`（比例）仅兼容旧调用 |
| AC-5 死代码 | 生产产物 grep `saveReconcileSnapshot` = **0 处** |
| AC-2 过期结论 | `latestSnapshot()` 返回 `stale_level=error`、`age_hours=421.3`（老快照）→ 页面据此不再宣称「一致性正常」（渲染待用户自查） |
| 对拍结果（真实数据） | `sa_cnt=千万级` / `raw_cnt=千万级`，偏差 **+1.22%** → `status=ok`；CRC `dup_rows=19,462`（容忍带内 → pass）；事件级差异 **20** 条（Top：`base_network_socket_reconnect_start` sa 246,764 / raw 180,313 = +36.85%，与调研复现一致）；元数据发现变化 50 条；`out_of_retention_days=0` |
| AC-3 失败告警 | 未在生产制造故障；`reconcile-scheduler.spec` 覆盖「超阈通知（含阈值/报告路径）」「执行失败通知」「无启用联系人」三类路径 |

## 3. R2 线上核验（17685，deployed 代码实跑，只读）

实测环境：生产主机（ClickHouse 23.2.1，容器 12 GiB memcg）。

| 检查 | 命令口径 | 结果 |
|---|---|---|
| 社区版 TTL 现状 | `SELECT ... FROM system.tables WHERE database='clklog'` | 19 张表 `TTL` 命中数 **0**（全部无 TTL） |
| sa_events `stat_date` 列 | `system.columns` | 19 张 `clklog.*` 表全部有 `stat_date`（`Date`），与分区键同列 |
| 脏日期分区 | `system.parts` | `clklog.log_analysis` 分区自 **2019-09-07** 至 **2027-09-19**（真实数据始于 2026-07-28）；`clklog_sa.sa_events` 月分区含未来月 `202709` |
| AC-6 保留策略总览 | `RetentionService.overview()`（实跑） | 20 行；`unset=19`（社区版 19 张全部未设置 TTL，`raw_unset=19`）；`sa_events` 预期 540 / 实际 540 / `ok`；`log_analysis` 预期 180 / 实际 null / `unset`；可信区间 **2025-04-17 ~ 2026-10-08**（`retention_days=540`，`bound_by=clklog_sa.sa_events`，raw 侧无 TTL → 不限） |
| AC-6 可疑分区 | 同上 | 4 个未来月分区（`clklog_sa.sa_events` 202611 / 202701 / 202706 / 202709），只提示不清理 |
| AC-8 拒绝路径 | `previewCleanup('clklog.log_analysis', 180)` | `preflight.ok=false`、`reason=not_covered`、`coverage_required=true`、`required_to=2026-04-12`、快照 `range=2026-09-19`、`age_hours=421.3`（同时超过 168h）→ 拒绝执行；页面在预演阶段即展示原因并禁用执行按钮 |
| AC-8 日分区表说明 | 同上 | `note` 存在：`log_analysis` 按日分区，月分区清理不支持，应走 TTL |
| **AC-8 放行路径（17686）** | `preflight('2026-04-12', { requireCoverage: false })`（TTL 动作） | `ok=true`、`coverage_required=false`，依据当日自动快照（`range=2026-10-08`、`age_hours=0.1`、`has_alert=false`）→ 社区版 TTL 可执行 |
| DROP 仍是严格闸门（17686） | `preflight('2026-04-30', { requireCoverage: true })` | `ok=false`、`reason=not_covered`、`coverage_required=true` → 未被验证的窗口不许 DROP |
| 清理候选盘点（17686） | `previewCleanup('clklog_sa.sa_events', 30)` | 候选 7 个月分区（202509…202608，未来月被排除），`preflight.ok=false / required_to=2026-08-31` |

## 4. 未完成与风险

- AC-10 的「不再新增过期分区」需要 2 天观察窗口（TTL 已生效，观察待续）。
- 社区版在**哪一层**抑制了错误类事件（receiver 限流 / Flink 过滤 / 会话折叠）超出本平台旁路可观测范围，
  需要在社区版容器侧取日志或端到端跟踪才能定论（白皮书 §4 开放项 4）。
- 本次未执行 DROP PARTITION（AC-9 的 DROP 路径只有单测）：`sa_events` 的 4 个历史小分区（202509/202510/202601/202602，
  共 1,694 行）经预演已确认可清（前置对拍按新规则放行），但属不可恢复动作，留给操作者一键执行。
- R1 发版曾导致生产不可用（DI 缺陷），已修复并补模块装配守卫；修复过程的复盘见 §5。

## 5. 事故复盘（R1 发版，2026-10-09）

- **现象**：17681 上线后 `clklog_analytics_server` 与 `clklog_analytics_ingestor` 启动即退（exit 1），
  supervisor 每 1~2 秒重启一次；平台不可用，sa_events 侧停止消费（Kafka 保留消息，无数据丢失）。
- **根因**：`ReconcileSchedulerService`（alerting 域）注入 `QualityService`（meta 域）；
  `MetaModule` 已 export 该 provider，但 `AlertingModule` 的 imports 未加 `MetaModule`。
  Nest 只在启动时解析 DI 图，各文件的单测自建 provider，全量 jest 不会 boot 应用。
- **修复**：`AlertingModule` imports 补 `MetaModule`（单向 alerting → meta）。
- **防复发**：`test/app-di.spec.ts` 断言「跨域注入必须 import 对应模块」「meta 不反向依赖告警域」；
  发版验收流程补两步：`supervisorctl status` 必须是 RUNNING、启动日志必须出现监听行（不再只看产物符号）。
- **流程缺陷**：本次「产物就绪」判据只核对了产物内容，没有核对**进程是否起来**；同类事故的兜底是
  发版后 5 分钟内的健康核验（本次缺失，已补入流程）。
