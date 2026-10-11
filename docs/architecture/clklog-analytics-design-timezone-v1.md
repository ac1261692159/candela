# 架构：时区系统 v1（平台时区 + 查询口径时区化）

> phase: clklog-analytics-timezone-v1
> 帽子：架构（`docs/architecture/`）
> 产品：[PRD](../product/prd-clklog-analytics-timezone-v1.md)、[调研](../product/research-clklog-analytics-timezone-v1.md)
> 既有口径：`clklog-analytics-design-time-range-v1.md`（relative 解析）、`clklog-analytics-design-i18n-v1.md` D12/§13.1、AL-01 修复约定（`clickhouse.service.ts:57-67` epoch 参数化）

---

## 1. 阶段目标、范围与验收

把 `Asia/Shanghai` 从散落的字面量升级为平台级时区系统：单点 SSOT、查询/展示口径时区化（DSL `time_range.timezone`）、现存不一致清零（ZQ-1～ZQ-6）。验收对齐 PRD SC-1～SC-8。非目标同 PRD §5（用户偏好、项目级、逐事件偏移、DDL 变更、社区版组件均不在本期）。

**设计红线复用 AL-01 教训**：任何进入 ClickHouse 的「时刻」一律用 epoch 参数（`toDateTime`/`toDateTime64` + `{x:Int64|UInt32}`），**禁止**无时区字面量以字符串进入 CH 时间比较；日历日计算一律走显式 IANA 时区（`Intl`），**禁止**依赖进程本地时区分量。AL-01 之后靠注释约束人，本期靠结构与测试约束代码。

## 2. 时区模型与 SSOT

### 2.1 两个时区概念

| 概念 | 来源 | 决定 | 默认 |
|---|---|---|---|
| 平台时区 `platformTz` | 配置 `analytics.timezone`（`config_server.yaml`，`ConfigurationService` 读取） | 落库 `stat_date` 日历、所有缺省口径、cron 声明、管理面渲染、告警窗口与通知 | `Asia/Shanghai` |
| 展示时区 `displayTz` | 请求 DSL `time_range.timezone`（IANA 名，可选） | 本次查询的「今天」、时间窗起止、粒度桶、结果渲染 | = `platformTz` |

校验：IANA 名须经 `Intl.DateTimeFormat(undefined, { timeZone: tz })` 试构通过 + 形态正则 `^[A-Za-z_]+\/[A-Za-z0-9_+\/-]+$`（拒绝 `Factory`、`Local` 等）；非法 → 400 + `messageKey`（i18n 错误码契约）。缓存校验结果（Map），进程内 O(1)。

### 2.2 后端窄包 `src/modules/time/`（新公共能力落语义窄包，不进 `common/utils/shared`）

| 文件 | 职责 | 说明 |
|---|---|---|
| `time.module.ts` | 导出 `TimezoneService`、`TimeScopeService` | 全局可用（`@Global()`），只导出两个 service |
| `timezone.service.ts` | 平台时区读取/缓存；`assertValidTz(tz) → string`；`now` 可注入 | 唯一持有默认常量 `'Asia/Shanghai'`；配置缺失/非法时 fail-fast（启动拒绝，不静默回退） |
| `calendar.ts` | 纯函数日历：`todayInTz(tz, now)`、YMD 加减、周一、月界、`epochOfDayStart(tz, ymd)`、`ymdInTz(tz, epochMs)` | 从 `query/time-range.ts`、`retention-window.ts` 迁入同构实现；`Intl` 分量取日（不读进程 TZ） |
| `time-scope.ts` | 查询窗物化：`TimeScope { displayTz, startYmd, endYmd, scanStartYmd, scanEndYmd, startEpochMs, endEpochMsExclusive, isPlatformCalendar }` 与 CH 参数生成 | §4 核心 |
| `format.ts` | 服务端渲染：`formatInTz(date, tz, opts)`（`Intl.DateTimeFormat` + timeZone） | 替代 `formatShanghaiTime`；告警/通知/管理面共用 |

迁移纪律：`time-range.ts` 的相对窗解析逻辑（`resolveTimeRange` 等）整体迁入 `calendar.ts` 并 tz 参数化（`shanghaiTodayYmd()` → `todayInTz(tz)`），原文件删除、调用方改 import，**整组搬**（门禁 16：一次一个风险轴，API 路径/DSL 形状不变）。

前端同构：`apps/analytics-web/src/features/time-range/resolve.ts` 同构迁移为 tz 参数化（沿用「前后端两份、禁抽 common」的既有约定），平台时区经 `/auth/me` 下发存入查询构造层。

### 2.3 契约变更（公共契约，同步更新 `clklog-analytics-design.md` §7）

```ts
interface TimeRange {
  start: string;            // 展示时区日历快照 YYYY-MM-DD
  end: string;
  relative?: TimeRangeRelative; // 既有
  timezone?: string;          // IANA 名；缺省 = 平台时区（新增，可选）
}
```

- 入参：事件/漏斗/留存/自定义 SQL/指标求值的 `time_range` 均接受 `timezone`；校验失败 400（`messageKey: analysis.timeRange.error.timezoneInvalid`）。
- 出参：`SqlExecuteResult.applied_time_range` 扩展 `{ start, end, timezone }`；查询类响应回显同样带 `timezone`（前端表格头/图注展示口径）。
- 用户上下文：`GET /sa/api/auth/me`（与 `login` 响应）增加 `platform_timezone`。
- 持久化：`Card.dsl_json` 内 `time_range.timezone` 随卡片保存；看板刷新 worker 走同一 analyze/executeFromCardDsl，无需表结构变更。**无 Prisma migration**。
- Harness 快照 `time_range` 带上 `timezone` 即自动兼容（同 relative 先例）。

## 3. Gate-0 探测清单（先有实测再定实现细节）

实现动工第一天在测试 CH（与生产同版本）实测，结果写进验收记录：

1. `toStartOfDay/toStartOfHour/toStartOfMinute/toMonday/toStartOfMonth/toDate/toHour(x, {tz:String})` 参数绑定是否被接受（`@clickhouse/client` `query_params`）。
2. `toDateTime64({ms:Int64}/1000, 3, {tz:String})` / `fromUnixTimestamp64Milli({ms:Int64})` 的形态与精度。
3. JSONEachRow 向 `DateTime64(3)` 列写**整数 epoch 毫秒**（scale ticks）回读等价性；写 `'YYYY-MM-DD HH:mm:ss.SSS'` 串与 epoch 数两种形态的回读一致性。
4. `system.time_zones` 在生产 CH 镜像存在（tzdata 可用）；美洲夏令时区（`America/New_York`）跨 DST 边界 `toDate` 正确。
5. `parseDateTime64BestEffortOrZero(toString(...))` 链（TimeExtract）是否可入 tz 参数或需改造。

参数绑定不可用的函数 → 降级为「校验后字面量注入」（`assertValidTz` 过的白名单字符串内联，防注入无风险），探测结论登记差异表。

## 4. 查询引擎：TimeScope 物化与生成器改造

### 4.1 为什么过滤要改形（核心推导）

`sa_events.stat_date` 是**平台时区日历**的物化列（历史数据永久上海；将来 = platformTz）。当 `displayTz != platformTz`，平台日界与展示日界错开最多 26 小时（IANA 极值 -12/+14），直接 `stat_date BETWEEN start AND end`（展示日历）会漏切边界事件。方案：

- **宽扫**：`scanStart/scanEnd = [start−1d, end+1d]`（展示日历；极值偏移下平台日历仍落在 ±1 天内，数学上 26h<48h，±1 天宽扫完备）。分区裁剪 `PARTITION BY toYYYYMM(stat_date)` 只退化一个月界的边界分区，成本可忽略。
- **精切**：不再把日期字符串交给 CH 解释，改 epoch 参数：`log_time >= toDateTime64({start_ms:Int64}/1000, 3) AND log_time < toDateTime64({end_excl_ms:Int64}/1000, 3)`。`start_ms = epochOfDayStart(displayTz, start)`、`end_excl_ms = epochOfDayStart(displayTz, end+1d)`。epoch 语义与时区无关（AL-01 约定的一般化）。
- **恒等快路**：`displayTz == platformTz` 时 `scanStart=start, scanEnd=end`（与今天逐字节一致，保 SC-6）。

`TimeScope` 由 `TimeScopeService.materialize(time_range, projectTz?)` 单点产出，校验/相对窗解析/上限守卫（SQL 90 天、分钟粒度 1 天）在物化后照旧执行。

### 4.2 粒度桶与抽取 tz 参数化

| 粒度/抽取 | 现状 | 本期 |
|---|---|---|
| minute/hour/day | `toStartOfMinute/Hour/Day(log_time)`（服务端时区） | `toStartOf*(log_time, {tz:String})`，tz=displayTz |
| week（事件/漏斗/留存） | `toMonday(log_time)` | `toMonday(log_time, {tz:String})` |
| week（自定义 SQL） | `toStartOfWeek`（周日始，ZQ-6） | **改 `toMonday(log_time, {tz:String})`**（口径修正，PRD §6 已声明） |
| month | `toStartOfMonth(log_time)` | `toStartOfMonth(log_time, {tz:String})` |
| TimeExtract（hour_of_day 等） | `toHour(parseDateTime64BestEffortOrZero(toString(...)))` | 按 Gate-0-5 实测注入 tz |
| 桶标签渲染 | CH 服务端时区字符串 | `formatDateTime(bucket, fmt, {tz})`（或 epoch 出参前端渲染，见 §7） |

### 4.3 落点清单（生成器与查询服务）

| 文件 | 改造 |
|---|---|
| `query/time-range.ts`、`query/retention-window.ts` | 迁入 `time/calendar.ts`；消重（ZQ-8-①、`retention-window.ts:7` 的第二处 SHANGHAI 常量删除） |
| `query/dsl-validator.service.ts:585-601` | 校验扩展 `timezone` 字段；物化走 `TimeScopeService`（relative 覆盖快照逻辑不变） |
| `query/event-sql-generator.service.ts:306-310,496-508` | 过滤换 TimeScope 宽扫+epoch 精切；桶 tz 参数化；listUsers（:418-420）同改 |
| `query/funnel-sql-generator.service.ts:191,338-350` | 同上；`windowFunnel` 秒窗不受时区影响保持不变 |
| `query/retention-sql-generator.service.ts:175,181-182,385-405` | 宽扫；`cohort_bucket = toDate(log_time, {tz})`（替代 `toDate(stat_date)`，展示时区切日）；`addWeeks/addMonths/addDays` 日历运算在服务端日历函数完成 |
| `report/sql-report.service.ts:396-401` + `normalizeRange` | 走 TimeScope；90 天上限不变；周改 `toMonday`；`applied_time_range` 回显 tz |
| `query/metric-window.ts`、`alerting/alert-metric-eval.ts:34-45` | `shanghaiTodayYmd` → `todayInTz(platformTz)`（告警/指标窗口按平台时区，PRD §2-5） |
| `relation/datatable-join.ts:100-103` | `formatDateTime(...,'Asia/Shanghai')` → 第三参经单点注入 platformTz |
| `report/system-columns.ts`、`meta/quality.service.ts:211-221,300-306` | `toDate(log_time)` → `toDate(log_time, {tz:platform})`；默认对拍日 `normalizeDate` 用平台日历（ZQ 清零） |

## 5. 写入侧固化（ZQ-1）

| 点 | 现状 | 本期 |
|---|---|---|
| `common/utils/date.util.ts:1-21` | 进程本地时区分量格式化 | **删除**改用方；新写串走 `time/format.ts` 或 epoch（`common/` 结构债只减不增） |
| `ingestor/sa-event-flattener.service.ts:9,14-15,35` | `log_time/stat_date/ingest_time` 进程本地渲染字符串 | `log_time` 写**整数 epoch 毫秒**（Gate-0-3 验证；不留字符串双转换）；`stat_date = ymdInTz(platformTz, epochMs)`；`ingest_time` 用 CK 默认值 `now()`（服务端时钟，删应用侧渲染） |
| `ingestor/sa-user-profile-writer.service.ts:44` | 同上 | `updated_at` 同样 epoch 化 |
| parser 兜底（ZQ-8-④） | 缺 `time` → `Date.now()` | 显式注释为「设计如此：消费时刻兜底」，并在 meta discovery/质量面板可观测（现状已可观测）——不改行为 |

**进程 TZ 固化**：`scripts/supervisord-clklog-manager.conf` 的 server/ingestor environment 增加 `TZ=UTC`（先决：全仓进程本地时区分量调用点清零，见 §10 清单）；`scripts/env.example` 标注。CI/本地 `npm test` 以 `TZ=UTC` 跑，防回归（SC-2）。

## 6. 调度、后台任务与「今天」口径统一

| 点 | 改造 |
|---|---|
| `@Cron`（`meta-stats-refresh.job.ts:15`、`cohort-compute.job.ts:15`、`tag-compute.job.ts:15`） | 显式 `timeZone: platformTz 注入值`（从 `TimezoneService` 读；ScheduleModule 支持注册时传参，需在 register 时已定值） |
| ZQ-2：`cohort-definition.ts:526-533 todayUtcDate()` | 改 `todayInTz(platformTz)`；`resolveConditionTime` 窗口随动。**口径修正**（PRD §6），首日重算 |
| ZQ-3：`ops/data-mgmt.service.ts:179,197,305` | `cutoffDate`/`currentMonth` 改平台日历（epoch 差 → `ymdInTz`）；`Date parse` CH 时间串统一走显式平台时区解析助手（ZQ-4 同点） |
| ZQ-4：`alert-detector.service.ts:396` vs `ops/data-mgmt.service.ts:132,488` | `parseChDateTime(s, platformTz)` 单点函数，两调用方共用 |
| ZQ-5：`alerting.service.ts:690-692` fired_today | 进程本地零点 → `epochOfDayStart(platformTz, today)` 起算 |
| `meta/quality.service.ts:333-337` normalizeDate | 默认日改平台日历 |
| `alert-retention.service.ts`、`ops/log-cleanup.service.ts` | epoch 毫秒比较，与时区无关，**不改**（复核注释标注） |

## 7. 告警与前端前端

**告警**：`alert-template.ts:441-453 formatShanghaiTime` → `formatInTz(date, platformTz)`（函数改名，行为等价）；通知模板其余不变（收件人时区=非目标）。ZQ-8-②：`CreateMuteDto.starts_at/ends_at` 加 `@Matches(ISO8601_WITH_OFFSET)` 校验 + `resolveMuteWindow` 显式解析；非法 400（契约固化，前端已提交 `toISOString()`，天然兼容）。

**前端**（查询口径与展示口径统一 = 展示时区）：

| 点 | 改造 |
|---|---|
| `features/time-range/resolve.ts` | tz 参数化（同构后端 `calendar.ts`）；默认常量单点 |
| `TimeRangePanel/TimeRangeControl` | 面板底部时区选择器（IANA 搜索 + 当前偏移显示，如 `America/New_York (UTC-4)`）；选择写回 `time_range.timezone`；触发器副文案显示非常用时区（≠平台时区才显示，避免噪音） |
| `utils/dsl-builder.ts:14-19` | materialize 带上 `timezone`；所有 build*Query 透传 |
| `i18n/format.ts` `formatDate/formatDateTime` | 增加 `tz` 参数（默认平台时区），实现改 `Intl.DateTimeFormat(..., { timeZone: tz })`，不再用本地年/月/日字段（修 `formatDate` 日界漂移） |
| `features/time-axis/format-label.ts` | 数字分支按 displayTz 渲染（字符串分支保持字面量直取，标签由服务端 tz 渲染后本就是 displayTz 口径） |
| UTC 墙钟截断族（`AlertsWorkbench.tsx:65-67`、`MetricDetailDrawer.tsx:43-46`、`mute-form.tsx:122-123`、`ChannelConfigPanel.tsx:285`、`RetentionPanel.tsx:98`） | 统一走 `formatDateTime`（管理面 platformTz） |
| `DebugQuery.tsx:107` 显式补 Z | 保留（服务端原始返回确为 UTC ISO 时才补 Z；改为先判断串形态，避免双解释） |
| 平台时区初始化 | `login/me` 响应 `platform_timezone` → `stores/auth.store`（或查询构造层单点），默认常量兜底 |
| `main.tsx` / `antd` picker | 不改：DatePicker 选的是「日历日」（YYYY-MM-DD 无时区语义）；含时刻的 RangePicker（静默）提交语义 = 在 platformTz 下取墙钟转 epoch（在 `mute-form` 提交处显式换算，替换 `toISOString()` 直发） |

## 8. 部署与运维

- `config_server.yaml` / `config_dev.yaml` / `scripts/env.example` 增加 `analytics.timezone`（默认 `Asia/Shanghai`），`ConfigurationService` 加载校验（非法 fail-fast）。
- `scripts/supervisord-clklog-manager.conf`：server/ingestor `environment` 增加 `TZ=UTC`。
- **不动**：CH/社区版容器 `TZ`、`docker-compose*.epp`、CH `<timezone>`、Grafana（PRD 非目标）。
- 发布顺序：应用先行（含 SC-6 对拍）→ 进程 TZ 切换随该次发布 supervisor 配置更新重启生效；数据上报回归（`/tmp/test_report.py` + `clklog.log_analysis` 行数 + `sa_events` 抽样 stat_date 核对）按 AGENTS 实现规则执行。
- CI：i18n 检查不变；新增 `TZ=UTC npm --prefix apps/analytics-server test` 与前端 `TZ=UTC vitest`（或既有 runner）一条防线。

## 9. 测试

| 层 | 用例 |
|---|---|
| 纯函数矩阵 | `calendar.spec.ts`：todayInTz/解析表 11 种 relative × {Asia/Shanghai, UTC, America/New_York, Pacific/Kiritimati(+14), Pacific/Honolulu(-10)}；DST 切换日（纽约 3/11、11/4 前后）；月界/周界 |
| TimeScope | 恒等快路（=platform）与原行为同参同 SQL；非恒等宽扫 ±1d 且 epoch 边界精确；上限守卫不变 |
| 生成器 | 事件/漏斗/留存/SQL：带 tz 的 SQL 快照（golden）锁定 `toStartOfDay(log_time, {tz:String})` 形态与参数表 |
| API 契约 | 非法 timezone 400 + messageKey；`applied_time_range.timezone` 回显；old-payload 兼容（无 timezone 字段请求→platform） |
| 清零回归 | ZQ-2 computeDay 平台日历；ZQ-4 双调用点一致；mute 非法格式 400；`alert-metric-eval` 窗口不变式 |
| 进程时区防线 | `TZ=Pacific/Auckland npm test` 全绿（package script `test:tz-audit`，CI 挂载） |
| CH 实测 | Gate-0 五项 + SC-5 三时区结果矩阵（写入边界事件 ±1h 断言行数/桶标签） |

前端：`resolve.spec` 换基（tz 参数）；`format.spec` 新增 tz 渲染矩阵（含 Honolulu 浏览器模拟：`Intl` 注入时区断言不受 `Date` 本地影响）；面板交互 spec（选择→DSL 带 timezone）。

**SC-6 对拍**：上线前在生产影子查询同 DSL（无 timezone）×现网/改造后各 N=20 组，结果集逐字节 diff（复用 `scripts/reconcile.sh` 只读模式思路，新脚本不建表）。

## 10. ZQ 清零映射与实施分批

| 批次 | 内容（对应 ZQ） | 行为变化 |
|---|---|---|
| P0 基座 | `modules/time/` 建立与整组搬（ZQ-8-①）；`date.util.ts` 改造与写串 epoch 化（ZQ-1）；ZQ-2/3/4/5 统一平台日历；`@Cron` 显式时区；`toMonday` 统一（ZQ-6）；mute 契约固化（ZQ-8-②）；supervisord `TZ=UTC` | 默认路径零变化；ZQ-2/3/6 口径修正随 PRD §6 声明 |
| P1 平台时区可配置 | config/校验/下发（`me.platform_timezone`）；前端初始化 | 默认仍上海，零变化；可配置 |
| P2 口径时区化 | DSL `timezone`、TimeScope、生成器、面板切换、展示贯通、`applied_time_range` | 带 tz 查询生效；无 tz 零变化（SC-6 对拍） |
| P3 验收 | Gate-0 登记、SC-1~8 证据、INDEX/主契约文档同步、`docs/project/` 验收记录 | — |

实施注意：P0 的「整组搬」与 P2 的「过滤改形」分两次评审；P2 单独一个 PR，SC-6 对拍报告随 PR。每个 PR 声明「门禁未自动检：单文件/目录规模以外的 C/D/E 类条目」。

## 11. 风险与回退

| 风险 | 级别 | 缓解 |
|---|---|---|
| CH 参数绑定时间函数不被接受 | 中 | Gate-0 探测先行；降级为校验白名单字面量注入 |
| 宽扫 ±1 天放大扫描量 | 低 | 分区裁剪仍有效；实测比对 `EXPLAIN`/query_log 行数；恒等快路不受影响 |
| 周口径修正改变既有 SQL 卡片结果 | 中 | PRD §6 声明 + 发布说明；不迁移数据 |
| 分群 computeDay 改口径首日断面 | 低 | 首日重算；分群定义含窗口的族类在发布说明点名 |
| `TZ=UTC` 后遗留某处进程本地分量 | 中 | §6 清单逐点改造 + `test:tz-audit` + 上线影子对拍 |
| 前端旧缓存 DSL 无 timezone | — | 缺一即平台时区，天然兼容 |
| fail-fast 配置非法阻断启动 | 低 | 仅配置错误时触发，属预期安全行为（胜过静默回退错口径） |

## 12. 后续 phase 登记（本期不做）

1. 用户展示时区偏好（`SaUser.timezone`，同 `locale` 模式；Profile 设置 + 登录下发 + 通知按收件人时区）——i18n 设计 §13.1 原位。
2. 项目级时区（`SaProject.timezone`，配合 RBAC v2 项目设置页；多项目异时区时分群预计算重口径）。
3. 客户端时钟漂移治理（receiver/ingestor 侧 `time` 偏差校验与告警；ZQ-8-④⑤）。
4. Grafana/运维面层时区与「按时段（0-23 时）筛选」等体验项（调研 §5/ZQ-8-⑥、gap §2.6）。

---

## 13. 实施记录与差异登记（2026-09-17，一期落地）

> 规则同源（见 i18n 设计 §0-4）：实现与契约不一致必须写进文档，不得静默另立一套。

### 13.1 已落地

| 项 | 落点 | 证据 |
|---|---|---|
| time 窄包 | `apps/analytics-server/src/modules/time/`：`calendar.ts`（IANA 日历/DST 迭代）、`format.ts`、`timezone.service.ts`、`time-scope.ts`（恒等快路+宽扫精切）、`time.module.ts`、`cron-timezone.ts` | `test/time/*.spec.ts` 40 用例，TZ=UTC/Auckland 双跑通 |
| 平台时区可配置 | `config_dev.yaml`/`config_server.yaml` 增加 `analytics.timezone`（默认 Asia/Shanghai，非法启动 fail-fast）；`/auth/me` 与 `login` 响应下发 `platform_timezone` | `test/auth/platform-timezone.spec.ts` |
| DSL 契约 | 前后端 `TimeRange.timezone?`；`TimeRangeDto` 增 `timezone`；`applied_time_range` 回显 `{start,end,timezone}`；主契约 `clklog-analytics-design.md` §7.1 已同步 | `test/query/timezone-sql.spec.ts` 8 用例 |
| 查询引擎 | 事件/漏斗/留存生成器 + sql-report 走 `TimeScope`：恒等路径 SQL 与改造前逐字节一致（既有 golden 未动即过），异时区 `stat_date` 宽扫 ±1d + `fromUnixTimestamp64Milli` epoch 精切 + 桶 `{display_tz:String}` 参数 | 既有 93 套件未改断言全绿 |
| ZQ 清零 | ZQ-1 ingestor 显式平台时区写串（`date.util.ts` 删除，`common/utils` 2→1）；ZQ-2 分群/标签 `computeDay` 平台日历；ZQ-3 数据管理保护月按平台日历；ZQ-4 `parseChDateTimeInTz` 单点（data-mgmt 与 data_link_stale 同源）；ZQ-5 三 `@Cron` 显式 `timeZone: PLATFORM_CRON_TIME_ZONE` + fired_today 平台零点；ZQ-6 全仓 `toStartOfWeek` 归零（builder 改 `toMonday`）；ZQ-8-② mute DTO `ISO8601_WITH_OFFSET` 校验 | `test/time/zq-closure.spec.ts` |
| 前端 | `resolve.ts` 时区参数化 + `setPlatformTimeZone`（login/me 下发，MainLayout 引导）；`i18n/format.ts` 加 tz 参数 + `formatDateTimeFixed`；utc 截断族 10 处与 Ops/管理页 `toLocaleString` 时间格 11 页全部收回 format 工具；时间面板底部时区选择器（IANA 全集+偏移）；mute 表单按平台墙钟换算；趋势图预测日标签按平台取日 | `resolve.spec.ts`/`format.spec.ts`/`mute-platform-tz.spec.ts`，前端 98 套件 446 用例全绿 |
| 进程时区防线 | supervisord server/ingestor `TZ=UTC`；本机验收 TZ=UTC 与 TZ=Pacific/Auckland + ZQ-2/ZQ-5（`python3 scripts/arch_ratchet.py` 通过；`i18n_check.py` 通过） | 见 §13.3 |

### 13.2 与契约的差异（均已在本节登记）

1. **ingestor 仍写字面量串**（`log_time`/`stat_date`/`ingest_time`/`updated_at`），未按设计 §5 切 epoch 整数写入。原因：Gate-0-3（JSONEachRow 向 `DateTime64(3)` 写整数刻度）需测试 CH 实测，属验收环境动作；现实现为「显式平台时区渲染同一形态字符串」，在上海口径下与现有库内数据逐字节一致，ZQ-1 的进程时区依赖已解除。Gate-0-3 通过后可在 ingestion 层再切 epoch 形态（行级值不变，无 DDL 变更）。
2. **`datatable-join.ts` 的 tz 走校验后字面量内联**而非 `{tz:String}` 参数（设计 Gate-0 允许的降级路径）；该 SQL 走既有无参执行链路，参数化改造记待定项（连同 §12-后续）。
3. **保留 `retention-query` 等服务构造器的「缺省兜底」**（`new TimezoneService(undefined)` 包装为默认参数）：纯校验/纯单测可省装配，生产 DI 必真注入（TimeModule @Global）。属便利折衷，非门禁违规（依赖仍是单项公开契约）。
4. **`@Cron` 装饰器时区**经新文件 `time/cron-timezone.ts`（模块加载期读 `appConfig`）而非 `timezone.service.ts`：后者保持无配置副作用（曾有 10 个单测因 yaml/env 缺失在 import 期爆掉，已复盘修正）。
5. **i18n 覆盖率基线 `--force --update`（+1）**：总量 1290→1291。增量成分：`modules/time` 11 处中文 = 10 处从 `query/time-range.ts` **整组搬移**（原样中文错误文案，净变化 0）+ 1 处新错误码 `analysis.time_range.timezone_invalid` 的 DomainError 中文兜底（i18n 契约要求）。mute DTO 校验文案与启动期配置错误均取英文，未进基线。原因说明同步写入 PR 描述（棘轮程序要求）。
6. **locale 驱动展示维持原状**：`formatDateTime` 仍随语言定「格式」、随 tz 定「时刻」（D12 的原意延期到本期兑现）；`formatDateTimeFixed` 为管理面新增的定形 ASCII 渲染（替代 ISO 截断族），原渲染形状不变。
7. **`sql-report` builder 模式向 `querySql` 传 `bucketParams`（SQL 模式不传）**：Builder 桶带 `{display_tz:String}` 参数所需；原始 SQL 模式避免改变现网参数形状。
8. **留存「今天」取 `materialize` 后的展示时区**（原固定上海）：`maskImmatureRetentionRow` 的 `>` 判定随之在展示日历上成熟——非上海浏览者看到的成熟边界与其所选时区一致（口径修正，同 ZQ 声明家族）。

### 13.3 验收对拍

- 后端：`TZ=UTC npx jest` 93 套件 696 用例全绿；`TZ=Pacific/Auckland npx jest` 同绿（SC-2）。
- 前端：`npx vitest run` 98 套件 446 用例全绿（SC-7 用例在 `format.spec.ts`/`resolve.spec.ts`）。
- 门禁：`python3 scripts/arch_ratchet.py` 通过；`python3 scripts/i18n_check.py` 通过；`i18n_scan.py --check` 通过（基线按 §13.2-5 更新）。
- 生产侧 CH 实测（Gate-0 五项、SC-5 三时区行数矩阵、数据上报回归 `stat_date` 抽查）属部署验收动作，见 `docs/project/` 验收记录（随发版补齐）。
