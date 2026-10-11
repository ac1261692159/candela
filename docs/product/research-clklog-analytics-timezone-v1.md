# 调研：时区系统在分析平台中的作用（phase: clklog-analytics-timezone-v1）

> 帽子：产品（`docs/product/`）
> 下游：`prd-clklog-analytics-timezone-v1.md`、`docs/architecture/clklog-analytics-design-timezone-v1.md`
> 上游登记处：`docs/architecture/clklog-analytics-design-i18n-v1.md` §13.1（「时区本地化」后续 phase）、`docs/product/gap-clklog-analytics-vs-thinkingdata.md`（「项目时区：无」）
> 性质：调研与事实盘点，不含实现细节；所有结论附仓库内证据（`文件:行号`）或官方文档出处。

---

## 1. 结论摘要（TL;DR）

1. **时区不是一个「查询功能」，而是贯穿本程序 10 个作用面的口径基准**：上报时钟、落库写串、分区与 TTL、查询窗「今天」、粒度桶切分、留存入组日、分群/标签日更窗、告警窗口与通知、前端展示、后台任务触发，全部依赖「以哪个时区切日历」。
2. **现状 = 单一上海口径，但实现是「显式硬编码 + 隐式进程时区巧合」的混合体**：`Asia/Shanghai` 在业务代码重复硬编码 ≥6 处、compose/epp 7 处；同时 ingestor 落库、cron 触发、告警「今日」等 5 类点**悄悄依赖 Node 进程本地时区恰好等于上海**（进程本身未设 TZ，靠新加坡宿主机系统时区兜底）。
3. **已发现 8 项现存不一致 / 风险**（§5 逐条登记，ZQ-1～ZQ-8），其中 2 项属 P0（分群/标签按 UTC 今天 vs 分析按上海今天；ingestor 写串进程时区无固化），1 项曾造成生产事故（AL-01，慢查询窗偏 8 小时误报 8 天，已修但约束停留在「人遵守」层面）。
4. **对标结论**：神策有「项目时区」配置（仓内 gap 表为证）；数数支持「多时区开关 + 逐事件时区偏移 + 展示时区切换」（官方手册 §6 详列）。我们的 epoch 毫秒事件时间模型比数数的「墙钟 + 固定偏移」更简单且**天然免疫夏令时**，多时区查看只需查询期按 IANA 时区重切，数据层零改动——这是我们可以后来居上的结构性优势。
5. **建议切片**：v1 = 平台时区单点可配置 + 查询/展示口径时区化（DSL `time_range.timezone`）+ 现存不一致清零；用户偏好时区、项目级时区、通知按收件人时区、逐事件偏移结算记入后续 phase（§7）。

---

## 2. 背景与触发

| 触发源 | 内容 | 证据 |
|---|---|---|
| i18n phase 登记 | 「时区本地化：用户 / 项目时区、看板时间口径、告警窗口与展示对齐」列为 **后续 phase 第 1 条**；D12 决策「格式随语言，时区固定 Asia/Shanghai」明确与本 phase 解耦 | `docs/architecture/clklog-analytics-design-i18n-v1.md:506,145` |
| i18n PRD 声明 | 「展示时区仍为 Asia/Shanghai」「时区随用户走是独立课题，不在本次范围」 | `docs/product/prd-clklog-analytics-i18n-v1.md:70,112` |
| 对标差距 | 神策 owner 权限表含「项目配置 \| 查看/编辑 \| 项目时区」，我们记「无」；RBAC 调研未实现功能清单含「时区」 | `docs/product/gap-clklog-analytics-vs-thinkingdata.md:209`、`docs/product/research-clklog-analytics-rbac.md:162` |
| 分群 PRD 排除项 | 「不做多时区结算」（两处分群文档明示），说明需求已被识别但反复推迟 | `docs/product/prd-clklog-analytics-user-segment-v1.md:44`、`docs/product/research-clklog-analytics-user-segment.md:146` |
| 开源准备 | 时区硬编码（前端 1 处 + 后端 6 处 + 基础设施 7 处 compose TZ）被列为「内网痕迹/去硬编码」对象 | `OPEN.md:225-232` |
| 生产事故教训 | AL-01：UTC 文本参数被 CH 按服务端时区解释，慢查询窗偏 8 小时，误报 8 天 | `docs/project/acceptance-clklog-analytics-alerting-v1.md:20,106`、`docs/project/legacy-production-handover.md:619` |

前置决策已定调：**日历口径是产品语义不是技术细节**——time-range-v1 PRD 明确「日历日以 Asia/Shanghai 为准」（`prd-clklog-analytics-time-range-v1.md:32`），其设计明确「不再用服务器本地 Date 减 7 天，避免 UTC 切日错位」（`clklog-analytics-design-time-range-v1.md:66`）。本 phase 是把「写死的上海」升级为「可配置、可切换、单点收敛」的时区系统。

---

## 3. 时区系统在本程序中的作用域地图

按时区介入的位置，全程序共 **10 个作用面**。每面列出「答错了会怎样」以说明其作用：

| # | 作用面 | 时区决定什么 | 答错的后果（现状证据） |
|---|--------|-------------|------------------------|
| A1 | 服务端「今天」 | 相对时间窗（过去 7 天…）、指标窗口、留存窗的锚日 | 日历日整体偏移，默认查询取错 7 天（time-range-v1 设计 :66 已专门避 UTC 切日错位） |
| A2 | 事件落库写串 | `log_time`/`stat_date`/`ingest_time` 字符串按哪个时区渲染 | 分区归属、过滤右值、TTL 全错（ZQ-1；ingestor 进程无 TZ 固化） |
| A3 | CH 分区与 TTL | `PARTITION BY toYYYYMM(stat_date)`、`TTL stat_date + 18 MONTH`、log_analysis `log_time + 180 DAY` | 月界 ±8h 内事件跨分区、数据提前/延后过期；数据管理保护「当月」口径错位（ZQ-4） |
| A4 | 查询窗过滤 | `start/end` 是哪本日历的起止日 | 与 A1 同源；还决定 `stat_date BETWEEN` 的右值（`event-sql-generator.service.ts:306-310`） |
| A5 | 粒度桶切分 | `toStartOfHour/Day/Monday/Month(log_time)` 按哪个时区切桶 | 时/日/周/月桶标签整体错位；周口径 `toStartOfWeek` vs `toMonday` 分歧（ZQ-7） |
| A6 | 留存口径 | 入组日（cohort_bucket）、`入组日+N > 今天` 的显示 `-` 判断 | 留存边界日归属变（`prd-clklog-analytics-explore-charts-v1.md:36` 以「Asia/Shanghai 今天」定义） |
| A7 | 分群/标签日更窗 | `computeDay` 是哪个时区的今天 | 预计算窗口与分析口径差 1 天（ZQ-2，现役不一致） |
| A8 | 告警窗口与通知 | 指标告警窗口日历、触发/恢复时间文本的展示时区 | 窗口偏（AL-01 事故）；通知时间国外团队看不懂（`alert-template.ts:441-453` 固定上海） |
| A9 | 前端展示 | 结果时间列、图表轴、管理面时间戳渲染在哪本日历 | 查询按上海、展示按浏览器的双口径混用；UTC 墙钟原样截断（§4.3 前端清单） |
| A10 | 后台任务触发 | cron（元数据统计 1AM、分群 2AM、标签 2:30AM）按哪个时区触发 | 进程时区一变，「凌晨低峰跑」漂移（ZQ-6；`@nestjs/schedule` 未设 timeZone） |

---

## 4. 现状盘点（事实，不写方案）

### 4.1 数据链路层（SDK → receiver → Kafka → {Flink, ingestor} → ClickHouse）

| 环节 | 时间基准 | 证据 |
|---|---|---|
| SDK 上报 | 事件顶层 `time` = **客户端本机时钟 epoch 毫秒**；三端示例一致（PHP `microtime(true)*1000`、Go `UnixMilli()`、C# `ToUnixTimeMilliseconds()`） | `docs/architecture/reporting-protocol.md:53,65`、`examples/report-sdk/go/main.go:55` |
| 事件时区属性 | 神策协议含预置 `$timezone_offset`，**全链路无人消费**（仅留在 properties JSON） | `docs/architecture/reporting-protocol.md:123` |
| receiver | 容器 `TZ=Asia/Shanghai`；原样转发 JSON 进 CKafka，加 CSV 头（receiver 侧 ts、client_ip），事件 `time` 不改 | `puppet/clklog/templates/docker-compose.yml.epp:58`、`docs/architecture/analytics-extension-plan.md:46` |
| Flink（社区版作业） | 容器/JVM `TZ=Asia/Shanghai`；config 无 `table.local-time-zone`；由 epoch `time` 生成 `log_time/stat_date/stat_hour`（口径在社区版源码，不在本仓库） | `docker-compose.yml.epp:150,173`、`processing/config.properties.epp` |
| ClickHouse 服务端 | 服务端时区 = 容器 `TZ=Asia/Shanghai`；`config.d` **无 `<timezone>`**、无 localtime 挂载；无时区参数的时间函数/字符串全按此解释 | `docker-compose.yml.epp:9`、`clklog_dc_config/clickhouse/config.d/default-config.xml`（全文确认） |
| sa_events DDL | `log_time DateTime64(3)` + `stat_date Date` 均**无时区参数**；`stat_hour MATERIALIZED toHour(log_time)` 按服务端时区算 | `apps/analytics-server/src/scripts/init-clickhouse.ts:16-18,41` |
| 旁路 ingestor | `new Date(epoch_ms)` → **Node 进程本地时区**格式化为无时区字符串 → CK 按服务端时区解析回 epoch（「进程 TZ 渲染 ↔ 服务端 TZ 解析」双转换） | `sa-event-flattener.service.ts:9,14-15,35`、`common/utils/date.util.ts:1-21` |
| server/ingestor 进程 | **未设 TZ**（supervisord、env、启动脚本均无），继承宿主系统时区；宿主在**新加坡**（Asia/Singapore 碰巧与上海同 UTC+8），系统时区值全文档未记录 | `scripts/supervisord-clklog-manager.conf:32,45`、`CODE_HANDOVER.md:598` |
| 缺省 time 兜底 | parser 缺 `time` 时兜底 `Date.now()`（消费时刻，非接收时刻） | `sa-event-parser.service.ts:86-96` |
| 客户端时钟漂移 | 生产已实证 `stat_date=2027-01-02`（客户端时钟超前），链路判据被迫改用 `system.parts.modification_time` | `clickhouse.service.ts:337-340` 注释 |

### 4.2 后端应用层（apps/analytics-server）

- **无日期库、无统一 clock service**：依赖全是原生 `Date`/`Intl`，`new Date()`/`Date.now()` 在 src 下 177 处。
- **显式上海硬编码 ≥5 处**：`query/time-range.ts:7,25-27`、`query/retention-window.ts:7-11`（重复实现第二份）、`relation/datatable-join.ts:100-103`（SQL 第三参）、`alerting/alert-template.ts:441-453`（formatShanghaiTime）、`alert-metric-eval` 同源。
- **查询过滤**：`stat_date BETWEEN {start}{end}`（YYYY-MM-DD 字符串）—— 事件 `event-sql-generator.service.ts:306-310`、漏斗 `funnel-sql-generator.service.ts:191`、留存 `retention-sql-generator.service.ts:175,181-182`。
- **粒度桶**：`toStartOfMinute/Hour/Day` + `toMonday` + `toStartOfMonth`，**均不带时区参数** → 按 CH 服务端时区切（`event-sql-generator.service.ts:496-508`、`funnel-sql-generator.service.ts:338-350`、`retention-sql-generator.service.ts:385-393`）；**例外**：自定义 SQL 周粒度用 `toStartOfWeek`（CH 默认周日始），与事件/漏斗/留存的 `toMonday` 口径不同（`sql-report.service.ts:396-401`）。
- **DSL 契约**：`time_range {start,end,relative?}`，**无 timezone 字段**（`src/types/dsl.types.ts:89-100`）。m2.1 验收记录中出现的 `"timezone":"Asia/Shanghai"` 是当时 Harness 快照残留，类型早已不含该字段。
- **定时任务**：三个 `@Cron`（meta 1AM / cohort 2AM / tag 2:30AM）均未设 `timeZone` → 按进程本地时区触发；各模块独立 `ScheduleModule.forRoot()`。
- **告警**：检测用 `setInterval` 分钟级 + `Date.now()` 相对窗（与时区安全）；**指标窗口**与**通知文案**按上海；fired_today 用 `setHours(0,0,0,0)` 进程本地零点（`alerting.service.ts:690-692`）；静默 `starts_at/ends_at` 是**无格式约束的裸字符串**，`new Date()` 解释取决于是否带 Z（`alerting/dto/alerting.dto.ts:351-363`、`alert-eval.ts:103-105`）。
- **MySQL/Prisma**：无 session `time_zone` 设置；DateTime 40+ 字段由驱动 UTC 传输。社区版 manage 侧 JDBC 显式 `serverTimezone=GMT+8`（`development.md:373`）。
- **CH 客户端**：不设 `session_timezone`；查询 settings 仅超时/行数（`clickhouse.service.ts:95-105`）。
- **API 出参**：管理面统一 `toISOString()`（UTC ISO）；**例外**慢 SQL 把 CH `event_time` 原样透传为无时区标记字符串（`ops/slow-query.service.ts:93`）。
- **测试**：metric-v2 已改「随上海今天推导」（与实现同源，提交 185c748）；AL-01 回归锁死 epoch 秒 + `toDateTime` 约定；**Jest 不设 TZ**，测试跑在开发机/CI 本地时区。

### 4.3 前端（apps/analytics-web）

- 唯一日期库 dayjs，**未加载任何 timezone 插件**；antd RangePicker 产出本地墙钟。
- **查询口径按上海**：`features/time-range/resolve.ts:8,26-28`（全站唯一把时刻换算日历日的点，Intl `timeZone: SHANGHAI_TZ`）；查询只发 `YYYY-MM-DD` + `relative`，**不带时区字段**（`dsl.types.ts:89-100`、`dsl-builder.ts:14-19`）。
- **展示口径按浏览器**：`i18n/format.ts`（`:6` 注释自证「时区仍按浏览器本地时区」）、`formatTimeAxisLabel` 数字分支、10+ 页面 ad-hoc `toLocaleString`。
- **UTC 墙钟原样截断族**：`AlertsWorkbench.tsx:65-67`、`MetricDetailDrawer.tsx:43-46`、`mute-form.tsx:122-123`、`ChannelConfigPanel.tsx:285`、`RetentionPanel.tsx:98`（`replace('T',' ').slice(0,19)`）。
- 对照组：`DebugQuery.tsx:107` **显式补 `Z` 按 UTC 解析**——同一仓库对同类时间串两种解释。
- **用户偏好只有语言**：`PUT /auth/preferences` 入参仅 `{default_project?, locale?}`（`auth.service.ts:18-19`），Profile 页无时区项；`SaUser` 表有 `locale` 列，同位可加时区列。

---

## 5. 现存不一致与风险登记（ZQ-1～ZQ-8）

> 分级：P0 = 可能导致数据/口径错误；P1 = 口径分裂或运维意外；P2 = 体验/一致性瑕疵。仅登记事实与影响，修复见下游 PRD/设计。

| 编号 | 级别 | 问题 | 证据 |
|---|---|---|---|
| ZQ-1 | **P0** | **ingestor 落库依赖进程 TZ 巧合**。log_time/stat_date 在 Node 进程本地时区渲染、由 CH 按服务端时区解析，正确当且仅当「进程 TZ == CK TZ == Asia/Shanghai」；进程 TZ 无任何配置固化（supervisor/env/脚本均无），宿主若重设为 UTC 则 log_time 整体偏 8h、stat_date 在 0 点前后 8 小时切错日。Asia/Singapore 宿主的同偏移**碰巧掩盖**了这个缺陷 | `sa-event-flattener.service.ts:14-15` + `date.util.ts:1-21` + `supervisord-clklog-manager.conf:32,45` |
| ZQ-2 | **P0** | **分群/标签按 UTC 今天，分析链路按上海今天**。`todayUtcDate()` 的 `computeDay` 在 UTC+8 的 0:00-8:00 是「上海的今天、UTC 的昨天」，日更窗口与分析查询的「过去 N 天」差 1 天；分群为预计算，事后换口径不重算 | `cohort-definition.ts:526-528` → `cohort-compute.service.ts:65,74`、`tag-compute.service.ts:45` |
| ZQ-3 | **P0** | **数据管理用 UTC 月保护分区**。`currentMonth` 取 `toISOString()` 的 UTC 月与 `toYYYYMM(stat_date)`（上海月）比较，每月首末 ±8h 窗口内保护判断错误，涉清理动作（高危动作口径必须零歧义） | `ops/data-mgmt.service.ts:197,305` |
| ZQ-4 | P1 | **同一 CH 时间串两种解析**：`data_link_stale` 判据 `Date.parse(s.replace(' ','T'))`（进程本地解释）；`data_mgmt` `new Date(s + 'Z')`（UTC 解释）。同一列两种语义，告警阈值随进程 TZ 漂移 | `alert-detector.service.ts:396` vs `ops/data-mgmt.service.ts:132,488` |
| ZQ-5 | P1 | **cron「凌晨任务」无显式时区**：meta/cohort/tag 三个 `@Cron` 按进程本地触发；告警 `fired_today` 用进程本地零点。进程 TZ 改变即静默漂移 | `meta-stats-refresh.job.ts:15`、`cohort-compute.job.ts:15`、`tag-compute.job.ts:15`、`alerting.service.ts:690-692` |
| ZQ-6 | P1 | **周粒度口径双标**：自定义 SQL `toStartOfWeek`（CH 周日始） vs 事件/漏斗/留存 `toMonday`。PRD 明定「周一=周首」，SQL 页与卡片页同数据可不同结果 | `sql-report.service.ts:399` vs `event-sql-generator.service.ts:502` |
| ZQ-7 | P1 | **查询/展示双口径**：查询按上海日历，展示按浏览器（format.ts、axis 数字分支）或 UTC 墙钟截断（alerting 族 6+ 处）。浏览器不在 UTC+8 时，「所选今天 ≠ 所见今天」，ISO 串在日界漂移一天 | `i18n/format.ts:6,30-38,57-68`、`AlertsWorkbench.tsx:65-67` 等 |
| ZQ-8 | P2 | **契约与结构散装**：① `Asia/Shanghai` 字面量重复 6+ 处无单点；② mute 时间裸字符串无校验；③ 慢 SQL `event_time` 无时区标记透传；④ parser 缺 `time` 兜底消费时刻；⑤ 客户端时钟漂移无校验（2027 实证）；⑥ Grafana 容器 UTC 与生态不一致 | `OPEN.md:225-232`、`alerting/dto/alerting.dto.ts:351-363`、`ops/slow-query.service.ts:93`、`sa-event-parser.service.ts:95`、grafana compose |

**历史事故（已修，教训沉淀）**：AL-01 —— UTC 文本参数被 CH 按上海解释，「近 5 分钟」实为「近 8 小时」，`slow_query_spike` 误报 8 天。修复为 epoch 秒 + `toDateTime({x:UInt32})`。该约定目前只在注释与单测层面存在，属「人遵守」型约束，且新代码（如慢查询外的其它调用点）无系统性防线。

---

## 6. 对标：神策与数数怎么做时区

### 6.1 数数科技 TA（官方手册为准）

来源：`https://docs.thinkingdata.cn/ta-manual/v3.4/user_guide/advanced_analysis/timezone.html`（2026-09-17 调研摘录）。

1. **项目时区是项目级配置**：管理员在「项目管理 → 分析配置」开启「多时区开关」；**默认关闭**，关闭时「直接按上报数据的原始时间计算和展示」。
2. **逐事件偏移模型**：须配置「时区偏移属性」（数值型，记录事件时间与 UTC 的偏移小时，范围 -12~14；新版 SDK 自动采集 `#zone_offset`），可选默认偏移。
3. **换算公式**：`展示时间 = 事件时间 +（展示时区 − 事件时区）`——即事件时间被当作**事件本地墙钟**，展示在目标时区重切。
4. **展示时区可切换**：设一个默认展示时区 + 多个可选时区，分析时切换（海外团队按本地看，默认时区作统一沟通口径）。
5. **作用范围（适用）**：分析时段与粒度（天/周切分）、表格/图表/下载的时间数据、筛选时间条件、全局时间筛选、行为序列、时间属性分组汇总；**预警按默认时区**。
6. **不适用**：报表/看板「数据更新时间」、定时更新任务、SQL 直连计算、虚拟属性的计算过程（仅最终结果偏移）。
7. **局限性**：偏移是**固定小时数**（-12~14），手册未提夏令时——使用固定偏移，夏令时切换前后切日会错 1 小时，只能靠换偏移属性规避。

### 6.2 神策（仓内证据 + 公开常识）

- 仓内 gap 表：owner 权限含「项目配置 \| 查看/编辑 \| **项目时区**」（`gap-clklog-analytics-vs-thinkingdata.md:209`），RBAC 调研列为未实现功能组（`:265`）。
- 神策事件时间 `time` 同为 epoch 毫秒；其分析口径以项目时区切日，修改项目时区只影响之后的查询口径，不回溯重算（私有化通行的「口径不动数据」原则；此表述为公开常识级描述，落地前如需逐条对齐神策行为，应补一轮官方文档核对）。

### 6.3 对我们的启示

| 启示 | 判断 |
|---|---|
| 「默认关闭/默认单时区」是对的做法 | 我们的 v1 默认 = Asia/Shanghai，行为零变化，兼容旧卡片 |
| 展示时区切换是核心价值 | 海外/多时区团队按本地日历看同一份数据；沟通口径仍是默认时区 |
| 逐事件偏移属性我们**不需要** | ClkLog 事件 `time` 是 **epoch 毫秒（绝对时刻）**，不是墙钟；展示 = 绝对时刻在目标 IANA 时区的日历切分，纯查询期重切即可完成，**数据层零改动**。数数需要 `#zone_offset` 恰恰因为部分链路把事件时间当墙钟 |
| IANA 时区优于固定偏移 | Node `Intl` 与 CH 时区参数都吃 IANA 名，夏令时自动正确（数数固定偏移做不到） |
| 预警/定时类按「默认时区」口径 | 告警窗口与通知默认按平台时区；「通知按收件人时区」属后续（同「通知按收件人语言」模式） |
| SQL 直算、虚拟属性过程不偏移 | 与我们对齐：自定义 SQL 的时间函数交给用户/平台时区处理，不二次偏移 |

---

## 7. 能力分层：时区系统可以长多大

把「完整时区系统」拆成五层能力，标注各层价值/成本/依赖，作为切片依据：

| 层 | 能力 | 对标 | 价值 | 成本/风险 | 建议 |
|---|---|---|---|---|---|
| L1 | **平台时区单点可配置**（实例级，默认 Asia/Shanghai） | 神策/数数项目时区之最小核 | 去硬编码（开源准备）、口径一处可改 | 低；配置化 + 全链路单点收敛 | **v1** |
| L2 | **查询/展示口径时区化**（DSL `time_range.timezone`，面板可切换，默认平台时区） | 数数展示时区切换 | 多时区团队核心诉求；卡片口径随行 | 中；查询过滤要改「宽扫 + epoch 精切」保分区裁剪（见设计 §4） | **v1** |
| L3 | **现存不一致清零**（ZQ-1～ZQ-6 + 契约固化） | — | 修的即是现役 bug 与未爆弹 | 低-中；含 2 处口径修正须声明 | **v1** |
| L4 | **用户展示时区偏好 + 通知按收件人时区**（`SaUser.timezone`，同 locale 模式） | 神策/数数个人偏好 | 个人体验闭环 | 低；依赖 L1/L2 贯通 | 后续 phase（i18n §13.1 原位） |
| L5 | **项目级时区 / 逐事件偏移 / 时钟漂移治理** | 神策项目时区、数数 zone_offset、TA 默认关闭项 | 多项目多地域部署 | 高；涉分群预计算重口径、时钟校验体系 | 后续 phase，需求出现时评估 |

**结构性判断**：事件时间是 epoch 毫秒 → L2 的「多时区查看」在我们这里**没有数据层改造成本**（无需补采偏移属性、无需重算历史），这比数数的路径短。真正的成本在「全链路散落的时区假设收敛」——它本身是 L3 该还的结构债。

---

## 8. 约束与红线关联

- **红线 1（不侵入社区版）**：Flink/clklog-api/manage 与 19 张聚合表不动；时区化只发生在旁路 `clklog_sa` 与分析服务/前端。CH 容器 TZ 维持 `Asia/Shanghai` 不改（服务端时区退出语义依赖后已无改它的必要）。
- **红线 4（查询有界）**：时区化后查询仍强制 `project_name` + 时间范围 + LIMIT/超时；「宽扫 ±1 天 + 精确裁切」以 epoch 参数实现，不放开窗口上限。
- **红线 6（不可删数据）**：ZQ-3 是清理保护口径缺陷，修正前后须在测试库演练（属 DDL/删除类审慎区）。
- **服务器配置真相在 Puppet**：平台时区放应用配置（`config_server.yaml`，分析平台由 CI rsync 发布），不新增 Puppet 参数；compose `TZ` 动与不动都须回写模板。
- **结构门禁**：时区公共能力新建**语义窄包**（如 `src/modules/time/`），禁止塞进 `common/utils/shared`；`Asia/Shanghai` 常量收敛后应只在一处默认定义。

---

## 9. 附：本调研的证据来源

1. 三路代码扫描（2026-09-17，本仓库）：后端 `apps/analytics-server`、前端 `apps/analytics-web`、基础设施 `puppet/` + `scripts/` + compose，逐条 `文件:行号` 见 §4。
2. 仓内文档：time-range-v1 PRD/设计、i18n-v1 PRD/设计（D12、§13.1）、gap 活文档、user-segment 两档文档、OPEN.md §3、docs/project/legacy-production-handover.md §619、CODE_HANDOVER.md:214、AL-01 验收记录。
3. 外部官方文档：数数 TA 手册《项目时区》（URL 见 §6.1，2026-09-17 访问）。神策细节暂以仓内 gap 截图研究为准，实施对齐神策行为前如需精确条款应补核官方文档。
