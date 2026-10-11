# 设计：数据质量 × 数据运维 闭环（对拍可信化 + 保留策略统一）

- `phase: clklog-data-quality-ops-v1`
- 关联 PRD：`docs/product/prd-clklog-data-quality-ops-v1.md`；实测证据：`docs/product/research-clklog-data-quality-ops-v1.md`
- 既有契约：`clklog-analytics-design-data-governance.md` §4（对拍 SQL 口径 SSOT）、`prd-clklog-analytics-data-management-v1.md`（存储/清理）
- 落点：`meta/quality.service.ts`、`ops/data-mgmt.service.ts`、`ops/data-mgmt.controller.ts`、`prisma/schema.prisma`、`puppet/clklog/`（定时与 TTL）、`pages/Meta/QualityPage.tsx`、`pages/Ops/DataManagementPage.tsx`

## 0. 门禁要素（与 PRD 同一 phase 块）

- `phase`: **clklog-data-quality-ops-v1**
- **阶段目标与范围**：PRD §2 的 R1（可信化）/ R2（闭环）/ R3（灵敏度），按 §8 顺序交付，每步可独立发版。
- **验收标准**：PRD §4 的 AC-1~AC-12（产品侧可核对）；本设计补充的实现断言：
  - [ ] 三张新表（`ops_reconcile_config` / `ops_cleanup_ledger` / `ops_retention_policy`）随迁移落地，`ops_reconcile_snapshot` 扩展列可空、旧行不报错。
  - [ ] 定时对拍在**同日只跑一次**（幂等键 = 当日 auto 快照），`background_workers=false` 的进程不启动定时器，`OnApplicationShutdown` 后无残留定时器。
  - [ ] `skipped` 计算可单测：命中清理登记 → `已清理`；超出可信区间 → `超保留期`；两者都不参与 `alert_days`。
  - [ ] 清理前置检查三态（无快照 / 未通过 / 快照过期）各自返回 400 且给原因；放行时 `ops_cleanup_ledger` 带 `snapshot_id`。
  - [ ] 对拍 SQL 只读、单日默认、不含 `uniqExact`（`grep` 断言）。
- **非目标**：PRD §5；本设计额外不做——不把清理改成自动执行、不新增环境变量读取（棘轮 envReaders 只减不增）、不动告警域既有契约。

## 1. 现状与差距（代码级，实测于 2026-10-08）

| 位置 | 现状 | 差距 |
|---|---|---|
| `QualityService.reconcile()` | 手动触发（页面「开始对拍」），写 `ops_reconcile_snapshot`；范围默认昨日、上限 3 天 | 无定时；无失败告警；快照无有效期概念 |
| `QualityService.DEFAULT_THRESHOLD = 0.1` + `absDev > threshold * 100` | 实际阈值 **10%** | 与设计文档写的 0.1% 不一致；§2.4 实测日常偏差 1.08~1.39% 永不告警 |
| `reconcileCount` 的 raw 侧 | `toDate(log_time)`（未用表自带 `stat_date`） | 口径冗余：`log_analysis.stat_date` 与 `toDate(log_time)` 实测一致，但前者能走分区剪枝、语义更明确，且不受未来 TZ 变更影响 |
| `reconcileCount` 的 raw 侧过滤 `event != ''` | sa 侧不过滤 | 口径不对称，低量日制造假告警（2026-11-08 的 11.17% 里 5 行来自此处） |
| `DataMgmtService.saveReconcileSnapshot()` | **无调用方**（死代码） | 快照写入方应收敛为 1 处 |
| `DataMgmtService.latestSnapshot()` / `/ops/data-mgmt/health` | 直接复用对拍快照 | 与质量页共享「过期而不自知」的结论 |
| 清理执行 / TTL | 已实现（V1.1）但从未在生产执行；审计 0 条 | 与对拍零联动；无清理登记 |
| 保留策略 | `sa_events` TTL 540 天；`log_analysis` + 19 张聚合表**无 TTL** | 无「预期 × 实际」对照，无可信区间约束 |

## 2. 数据模型变更（MySQL `clklog_sa_meta`）

### 2.1 `ops_reconcile_config`（新增，单行配置）

```prisma
model OpsReconcileConfig {
  id             Int      @id @default(autoincrement())
  enabled        Boolean  @default(true)   // 定时对拍开关
  run_at         String   @default("03:30") // 平台时区 HH:mm（低峰）
  threshold_pct  Float    @default(10)     // 偏差阈值（**百分比**，单一语义，页面显示同值）
                                          // 现状即 10%；R3 口径对齐后再降到 0.1~0.5（PRD §2 R3-3）
  ignore_events  Json?                     // 忽略事件清单（[] 表示不过滤）
  skip_empty_event Boolean @default(true)  // sa 侧是否同样过滤 event != ''
  stale_warn_hours Int    @default(24)
  stale_error_hours Int   @default(72)
  updated_by     String
  updated_at     DateTime @updatedAt
  @@map("ops_reconcile_config")
}
```

> 迁移把现值 **10%** 显式写入（与线上行为一致），R3 再调低——**本期不动灵敏度，只统一语义**（PRD AC-4）。

### 2.2 `ops_cleanup_ledger`（新增，清理登记）

```prisma
model OpsCleanupLedger {
  id           BigInt   @id @default(autoincrement())
  target_db    String                      // clklog_sa | clklog（后者仅测试环境演练）
  target_table String
  scope_type   String                      // partition | ttl | dir_log
  range_from   String                      // 已清理/已设策略的日期区间（含）
  range_to     String
  action       String                      // drop_partition | set_ttl | log_dir_clean
  detail       Json?                       // 分区名清单 / TTL 表达式 / 目录与保留天数
  snapshot_id  BigInt?                     // 前置对拍快照（通过的那条）
  operator     String
  executed_at  DateTime @default(now())
  @@index([target_table, range_from, range_to])
  @@map("ops_cleanup_ledger")
}
```

### 2.3 `ops_reconcile_snapshot`（扩展）

| 新增列 | 说明 |
|---|---|
| `events Json?` | 事件级差异（Top N + 仅一侧存在），页面直读（PRD AC-11） |
| `discovery_count Int @default(0)` | 当次发现日志条数（页面直读时用于提示） |
| `skipped Json?` | 被跳过的日期及原因：`已清理` / `超保留期` |
| `threshold_pct Float` | 当次实际阈值（快照自带，避免"拿旧快照配新阈值"解释不清） |
| `report_path String?` | 报告文件路径 |

## 3. 求值与联动契约

### 3.1 定时对拍（in-process，与卡片缓存同模式）

```
ScheduleModule（服务端已有）→ 每 5 分钟 tick：
  now(platformTz) ≥ 今日 run_at 且 今日未跑 且 enabled 且 background_workers
    → QualityService.reconcile({ from: 昨日, to: 昨日, trigger: 'auto' })
    → 写快照（threshold_pct/report_path/events/skipped）
    → 偏差超阈或抛错 → 复用告警域通知（alert 通道 + `alert_` 前缀审计）
```

- 与 `AlertRetentionService`/`CardCacheWorker` 同一模式：`background_workers` 为真才启动、`OnApplicationShutdown` 清理定时器；**多实例/多进程安全**：以「当日是否已有 auto 快照」为幂等键（`ran_at::date` 唯一）。
- CLI `scripts/reconcile.sh` 保留为**运维应急通道**；其 SQL 与 §3.2 同源（本期在脚本头注明「口径以 design §4/§3.2 为准」，避免两处漂移）。

### 3.2 对拍 SQL 口径（对齐既有 SSOT 的三处修正）

| 项 | 现状 | 改为 | 理由 |
|---|---|---|---|
| raw 侧日期列 | `toDate(log_time)` | `stat_date` | 表自带列、**命中分区键可剪枝**（日分区：现状单日也要扫 90 个分区；改后只扫 1 个），且不受未来 TZ 变更影响。实测两者计数一致（2026-10-07 均为 千万级），是纯收益修正；落地后用 `system.query_log.read_bytes` 留对比证据 |
| 空 event | raw 侧过滤、sa 侧不过滤 | 由 `skip_empty_event` 统一（默认两侧都过滤） | 消除不对称假告警（PRD AC-7 相关） |
| 忽略清单 | 无 | `ignore_events`（客户端名清单） | 结构差异事件（如 `android_gateway_error` +562%）先隔离，避免天天告警（R3 里逐个归因） |

### 3.3 可信区间与跳过规则

```
可信区间 = [today - min(两侧保留期, 硬上限 90 天), today]
两侧保留期：sa_events = 解析 TTL（540 天）；raw = 解析 TTL（未设置 → 用「最早分区」兜底并标风险）
对拍范围 ∩ 清理登记区间 → 标 skipped=已清理
对拍范围 − 可信区间        → 标 skipped=超保留期
只有「可信区间内且未清理」的日期参与 alert_days
```

### 3.4 清理前置与登记（R2-3 / R2-4）

```
previewCleanup / executeDropPartitions / setTtl  之前：
  1) 找覆盖目标区间的最近快照：存在 且 summary.has_alert=false 且 ran_at ≥ now - 7d
  2) 不满足 → 400，body 带原因（无快照 / 快照未通过 / 快照过期）
执行成功 → 写 ops_cleanup_ledger（含 snapshot_id）→ 审计
对拍时读 ledger → 命中的日期标 skipped=已清理（不参与 alert）
```

- 红线不变：只允许 `clklog_sa*`；社区版 TTL 变更（R2-5）单独走「用户授权 + 测试环境演练 + Puppet 记录」，不进这条自动路径。

### 3.5 保留策略总览（R2-1）

数据源：既有 `system.parts`/`system.tables` 盘点（`DataMgmtService.overview()`） + 新增策略登记（可以是 `ops_retention_policy` 表，或先复用 `ops_reconcile_config` 之外的简单 JSON 配置；本期落地为表）：

```prisma
model OpsRetentionPolicy {
  id          Int      @id @default(autoincrement())
  target_db   String
  target_table String
  keep_days   Int
  mode        String   // ttl | partition
  enabled     Boolean  @default(true)
  updated_by  String
  updated_at  DateTime @updatedAt
  @@unique([target_db, target_table])
  @@map("ops_retention_policy")
}
```
页面按表展示：`预期保留（策略） × 实际 TTL × 状态（已设置/未设置（风险）/偏离策略） × 对拍可信区间`。

## 4. API 变更

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/sa/api/meta/quality/config` | 对拍设置（阈值/时刻/忽略清单/过期阈值），审计 `reconcile_config_update`；写入仅平台超管（403 带 `messageKey`） |
| GET | `/sa/api/meta/quality/reconcile` | 手动对拍（原有，走心跳保活），响应补 `skipped`、`threshold_pct`、`report_path` |
| GET | `/sa/api/meta/quality/snapshot` | 响应补 `stale_level`（fresh/warn/error）、`events`（仅 diffs/only_in_one/ignored_events）、`skipped`、`report_path` |
| GET | `/sa/api/meta/quality/discovery-logs` | 已有，页面改为直读（不受快照限制）；`change_label` 改为 `change_key`（稳定 key，前端翻译） |
| GET | `/sa/api/ops/data-mgmt/health` | 响应复用同一 `stale_level`（两页同源） |
| GET | `/sa/api/ops/data-mgmt/retention` | 保留策略总览（预期 × 实际 × 可信区间） |
| PUT | `/sa/api/ops/data-mgmt/retention/:db/:table` | 登记预期保留（审计 `retention_policy_update`） |
| POST | `/sa/api/ops/data-mgmt/cleanup/preview` | 响应补 `preflight`（最近快照结论 / 是否放行 / 原因） |
| POST | `/sa/api/ops/data-mgmt/cleanup/execute` | 前置检查不通过 → 400；成功 → 写 ledger |
| POST | `/sa/api/ops/data-mgmt/ttl` | 同上（登记 ledger，`scope_type=ttl`） |

### 4.1 载荷形状（R1 落地后的现状契约）

- 阈值只有一个字段：`threshold_pct`（百分比）。legacy 的 `threshold`（比例）仅在请求参数上兼容，响应不再带。
- 日行 `status`：`ok` | `ALERT` | `skipped`；`skipped` 行附 `skipped_reason`（稳定标识 `cleaned`）与 `skipped_source`（`<action>@<time>`），文案由前端翻译。
- `events`：实时响应带 `sa_events` / `log_analysis` 两侧全量清单 + `diffs`(Top 20) / `diff_total` / `only_in_one` / `ignored_events`；**快照只存后者**（全量清单太大）。
- `discovery_logs[].change_key`：`eventCreated` / `propertyCreated` / `propertyTypeChanged`，前端按查看者语言渲染（服务端不再下发中文展示名）。
- 落盘报告（`report_path`）是**机器可读诊断产物**：字段名固定英文（`## daily` / `date\tsa_cnt\t...`），不随语言变化；给人看的结论走通知（按收件人语言）与页面（按查看者语言）。

### 4.2 保留策略与清理前置（R2 落地后的现状契约）

- **对拍可信区间**（`GET /ops/data-mgmt/retention` 的 `trusted_range`）= **物理保留期**两侧取小：
  sa 侧取 `clklog_sa.sa_events` 的 TTL，raw 侧取 `clklog.*`（含 18 张聚合表）TTL 的最小值；
  未设置 TTL 视为「不限」。**只认实际生效的 TTL**，不把登记的预期策略当地板（预期是目标，不是现状）。
- 请求范围跨越可信区间时：区间外的日期以 `status: 'out_of_retention'` 显式成行（不参与 `alert_days`），
  比对 SQL 收敛到可信区间；整段都超保留期时三组重查询直接跳过（不白扫 ClickHouse）。
  响应带 `out_of_retention: { from, to } | null` 与 `retention_days`。
- **清理前置对拍**：`preview/execute`（DROP PARTITION）与 `POST /ttl` 都要求存在
  `summary.has_alert=false`、`ran_at` 在 `PREFLIGHT_MAX_AGE_HOURS`（默认 168h）内的快照；
  不满足 → 400，错误码 `ops.dataMgmt.preflight.<reason>`（`no_snapshot` / `not_covered` /
  `snapshot_failed` / `snapshot_stale`）。预演接口同时返回 `preflight` 供页面先展示原因。
  覆盖要求按被清理窗口分两种（`coverage_required`；否则旧分区永远清不掉——对拍单次上限 3 天，
  不可能覆盖几个月前的区间）：
  - 窗口**在可信区间内**（`required_to ≥ trusted_from`）→ 快照必须覆盖 `required_to`：能对得上才允许删；
  - 窗口**已超物理保留期**（数据本来就会随 TTL 走）→ 只要求「近期通过快照」，证明链路当前健康、
    不是边写边删。
  `required_to` 取值：DROP 取所选月分区末日；TTL 取保留截止日（`today - days`）。
- **TTL 动作豁免覆盖要求**（`requireCoverage=false`）：TTL 是保留策略变更，删除由后续 merge 逐步发生，
  且被删窗口按定义比新保留期更老 —— 其边界日不可能被近期快照覆盖（对拍单次上限 3 天）。
  因此 TTL 只要求「近期通过快照」（无告警 + 168h 内），DROP PARTITION 仍要求窗口覆盖。
  否则首次给社区版表设 TTL 会被永久拦住（可信下限来自 sa_events 的 540 天，边界日落在可比范围内）。
- **清理区间登记**：DROP 成功按「月分区 → 该月首末日」逐条写 `ops_cleanup_ledger`；
  TTL 成功写 `range_from='1970-01-01' ~ range_to=保留截止日`；两条路径都带前置快照 id 与操作人。
  对拍侧 `skippedDates` 把 `sa_events` 与 `log_analysis` **两侧**的已清理区间都算作跳过。
- 可疑日期分区（未来分区 / 早于可信区间的历史脏数据）在保留策略总览里只提示**不自动清理**（R2-6 默认忽略清单）。

## 5. 定时与部署（Puppet 边界）

- 定时在**服务端进程内**（不需要服务器 crontab）；`puppet` 只需保证 `background_workers` 只在 server 进程为真（现状已如此）。
- 报告落盘目录：`/data/logs/production/clklog_manager/reconcile/`（与既有日志同级、按天轮转），避免写进发布目录（rsync 覆盖）。
- 社区版 TTL（R2-5）走 Puppet 清单 + 独立测试环境演练，禁止在服务器手工 `ALTER` 后不回写（红线 7）。

## 6. 红线与有界性

- 对拍/统计 SQL **全部只读**；`sa_events` 侧强制 `project_name` 过滤，raw 侧跨库只读。
- 定时任务默认**单日**；范围上限 3 天不变；禁用 `uniqExact`（历史 OOM 根因），继续用 `uniqCombined(20)` + 容忍带。
- 清理/ TTL 是**动作类**能力：人工确认 + 二次输入表名 + 审计 + 前置对拍；社区版变更需显式授权。
- 不新增环境变量读取（棘轮 envReaders 只减不增）。

## 7. 测试策略

| 层 | 用例 |
|---|---|
| 单测（后端） | 阈值语义（百分比，含 0 与超界）；`skip_empty_event` / `ignore_events` 生效；可信区间与 skipped 计算（保留期解析、清理区间命中）；前置对拍判定（无快照/未通过/过期）；ledger 写入与审计；定时幂等（同日只跑一次、失败重试） |
| 单测（前端） | 过期三级状态渲染（fresh/warn/error，过期时不再出现「正常」文案）；保留策略区状态标签；清理预演里 preflight 展示与禁用逻辑 |
| 集成（测试环境） | `scripts/standalone-test-env/`：建表 → 造数据 → 清理预演 → 前置检查拒绝 → 补对拍 → 放行 → ledger → 再对拍标「已清理」 |
| 线上验收 | PRD AC-1~AC-12 逐条（含 CH 内存峰值记录、飞书告警实收、TTL 生效后磁盘曲线） |

## 8. 实施顺序（每步可独立发版）

1. **R1-1 配置表 + 定时 + 幂等 + 失败告警**（含 `stale_level` 计算与两页同源展示）
2. **R1-2/R1-3 口径统一**（阈值单源、`stat_date`、`skip_empty_event`、`ignore_events`）+ 死代码收敛
3. **R2-1/R2-2 保留策略总览 + 可信区间/跳过**
4. **R2-3/R2-4 前置对拍 + 清理登记**（测试环境先跑通集成用例）
5. **R2-5/R2-6 社区版 TTL（需授权）+ 脏日期分区清理**
6. **R3 口径白皮书 → 双向对拍 → 阈值收紧 → 快照扩展 → 低峰期专项**
