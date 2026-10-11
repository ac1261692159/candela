# ClkLog 分析能力扩展方案：埋点管理 / 事件分析 / 漏斗分析 / 留存分析 / 自定义报表

> phase: clklog-analytics-v1
> 对标：神策分析（Sensors Analytics）。基线：ClkLog 社区版 1.3.0 标准模式（生产主机，CKafka + Flink + ClickHouse）。
> 调研日期：2026-07-28。本文档为调研结论 + 总体方案；详细 PRD、实现方案、项目计划已拆分至 `docs/` 各帽子目录。

---

## 一、调研结论（关键事实）

### 1.1 ClkLog 社区版的能力边界

| 能力 | 社区版现状 | 依据 |
|------|-----------|------|
| 基础访问统计（PV/UV/会话/渠道/地域/设备/页面/搜索词/崩溃） | ✅ 已有 | 库内 19 张 `*_bydate/byhour` 聚合表 |
| 事件分析（自选事件×自选指标×任意分组筛选） | ❌ 无 | 官网将"自定义分析"列为 PRO 功能 |
| 漏斗分析 | ❌ 无 | 官网将"转化漏斗"列为 PRO 功能 |
| 留存分析 | ❌ 无 | 无任何留存表与界面 |
| 自定义报表/看板 | ❌ 无 | 仅有固定预置报表 |
| 埋点管理（元事件/属性/虚拟事件/埋点方案） | ❌ 无 | 无元数据管理模块 |

**结论：五大模块全部需要自研，且应建在社区版旁边，不侵入社区版代码（保证后续可跟随官方升级）。**

### 1.2 数据资产现状（已连生产库实测）

唯一原始明细表 `clklog.log_analysis`（MergeTree，`PARTITION BY stat_date`，`ORDER BY distinct_id`）：

| 维度 | 已有字段 | 评价 |
|------|---------|------|
| 用户标识 | `distinct_id`（访客ID）、`user_key`（登录ID）、`is_logined`、`track_signup_original_id`、`identity_cookie_id`、`device_id` | ✅ 具备神策式"匿名ID+登录ID"打通基础 |
| 事件主体 | `event`（事件名）、`typeContext`（track/user_set）、`log_time`、`stat_date`、`stat_hour`、`time`、`event_duration`、`is_first_day`、`is_first_time` | ✅ 够用 |
| 预置维度 | url/url_path/title/referrer、country/province/city、brand/model/os/browser、utm_*、app_*、lib_*、element_* 等 ~100 列 | ✅ 预置维度丰富 |
| 会话 | `event_session_id` | ✅ 支持 Session 级分析 |

### 1.3 三个硬缺口（决定方案走向）

1. **自定义事件属性未入库** ⭐ 最大缺口
   receiver 接收神策 SDK 格式（`properties: {...}` 任意 KV），但 Flink 清洗时只物化预置列，**自定义属性被直接丢弃**。没有自定义属性，事件分析的"按商品ID分组、按金额求和"等一切神策式玩法都不成立。
2. **用户属性未入库**
   `typeContext='user_set'` 的数据已进入链路（实测有 1 条），但同样只物化预置列，自定义用户画像属性（会员等级、注册渠道等）无处存储。
3. **无通用分析模型层**
   社区版是"23 个固定统计脚本 → 19 张固定聚合表"的路子，没有"分析 DSL → 动态 SQL"的通用查询引擎。

### 1.4 有利条件

- **原始神策格式 JSON 就在 CKafka `clklog` topic 里**（receiver 原样转发，含完整 properties），可旁路消费补齐数据，**零侵入社区版**。
- ClickHouse 23.2 自带 `windowFunnel()`、`retention()` 聚合函数，漏斗/留存有原生高性能实现路径。
- 神策漏斗/留存的精确计算语义已从官方手册提取（见附录 A），可直接作为验收标准。
- 团队技术栈即 Java/Spring Boot + MySQL + Redis + ClickHouse，新增服务无违和感。

---

## 二、总体架构

```
                     现有链路（不动）
 SDK → nginx → receiver → CKafka(clklog) → Flink → ClickHouse.log_analysis
                              │
                              │ 旁路消费（新增，独立 consumer group）
                              ▼
              ┌───────────────────────────────┐
              │  ingestor（新增轻量消费服务）    │  全量原始事件 + 完整 properties
              └───────────────┬───────────────┘
                              ▼
        ClickHouse 新分析库 `clklog_sa`
          ├── sa_events        （全属性事件明细，宽列 + properties JSON）
          └── sa_user_profiles （用户属性，ReplacingMergeTree）
                              │
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
  ┌───────────┐      ┌────────────────┐      ┌──────────────┐
  │ meta-svc   │      │ query-svc       │      │ report-svc    │
  │ 埋点管理    │      │ 分析查询引擎     │      │ 报表/看板     │
  │ (MySQL)   │      │ DSL→CK SQL      │      │ (MySQL)      │
  └─────┬─────┘      └───────┬────────┘      └──────┬───────┘
        └────────────────────┴──────────────────────┘
                              ▼
                 analytics-web（分析控制台 SPA）
                 挂 管理后台入口 /sa/ 路径
```

**三服务一前端，逻辑划分**（物理上可先合并为 1 个 Spring Boot 应用 + 1 个 SPA，按模块分包，后续再拆）：

| 模块 | 存储 | 职责 |
|------|------|------|
| `ingestor` | — | 消费 CKafka 原始 JSON，解析/拍平/写入 `sa_events`、`sa_user_profiles` |
| `meta-svc` | MySQL | 埋点管理：元事件、事件属性、用户属性、虚拟事件、埋点方案、数据校验查询 |
| `query-svc` | ClickHouse | 分析引擎：事件/漏斗/留存/分布分析 DSL → SQL 生成与执行、结果缓存（Redis） |
| `report-svc` | MySQL | 看板、卡片（书签）、自定义 SQL 报表、定时刷新 |
| `analytics-web` | — | 分析控制台前端，ECharts 图表 |

---

## 三、数据模型设计（ClickHouse 新库 `clklog_sa`）

### 3.1 事件明细表 `sa_events`

原则：**高频维度物化为列（快），全量属性留 JSON（全），用户属性可按需 JOIN**。

```sql
CREATE TABLE clklog_sa.sa_events
(
    -- 基础
    `event`          LowCardinality(String),
    `log_time`       DateTime64(3),
    `stat_date`      Date,
    `project_name`   LowCardinality(String),
    -- 用户标识（沿用社区版口径）
    `distinct_id`    String,
    `user_key`       String,              -- 登录ID（神策 login_id 等价物）
    `device_id`      String,
    -- 高频物化维度（从 properties 提取，查询免解析）
    `url_path`       String,
    `utm_source`     LowCardinality(String),
    `utm_medium`     LowCardinality(String),
    `utm_campaign`   LowCardinality(String),
    `country`        LowCardinality(String),
    `province`       LowCardinality(String),
    `city`           LowCardinality(String),
    `os`             LowCardinality(String),
    `browser`        LowCardinality(String),
    `model`          String,
    `app_version`    LowCardinality(String),
    `lib`            LowCardinality(String),
    `is_first_day`   UInt8,
    `event_session_id` String,
    -- 全量自定义属性（核心增量）
    `properties`     String CODEC(ZSTD(3)),  -- 原始 properties JSON
    `prop_keys`      Array(String) MATERIALIZED JSONExtractKeysAndValues(properties, 'String')...,
    `created_at`     DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(stat_date)
ORDER BY (event, stat_date, distinct_id)
TTL stat_date + INTERVAL 18 MONTH;
```

自定义属性查询走两条路：

| 路径 | 用法 | 性能 |
|------|------|------|
| JSON 函数 | `JSONExtractString(properties, 'product_id')` | 全列扫描解析，够用但慢 |
| 物化列（推荐热属性升级） | 埋点管理里把某属性标记为"物化"→ 自动 `ALTER TABLE ADD COLUMN p_product_id String MATERIALIZED JSONExtractString(properties,'product_id')` | 与普通列同速 |

> 神策本质也是这个思路：属性即列。我们先用 JSON 保底灵活性，再对筛选/分组高频属性一键物化，兼顾灵活与性能。

### 3.2 用户属性表 `sa_user_profiles`

```sql
CREATE TABLE clklog_sa.sa_user_profiles
(
    `distinct_id`  String,
    `user_key`     String,
    `properties`   String CODEC(ZSTD(3)),   -- 用户属性 JSON 全量
    `updated_at`   DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY distinct_id;
```

- `user_set` → 覆盖写；`user_set_once` → 仅当不存在；`user_append`/`user_increment` → ingestor 内合并后写。
- 分析时按 `distinct_id` LEFT JOIN（或用 `dictGet` 建成 ClickHouse 字典加速）。
- 登录打通（神策 IDM 简化版）：`track_signup` 事件出现时，以 `user_key` 为主键把匿名 `distinct_id` 的历史数据归并到登录身份。查询侧统一 `analysis_id = if(user_key != '', user_key, distinct_id)`，**一期建议先按这个运行时归并做，不做离线刷数据**。

### 3.3 为什么不动 `log_analysis`？

- 社区版升级（如 1.2.3→1.3.0 已发生一次）可能重建/依赖原表结构，侵入有升级风险。
- 旁路 `sa_events` 自含全量数据，社区版坏了/升级了都不影响分析域。
- 代价是双写一份存储（DAU 5 万约 1.25GB/天，18 个月 TTL ≈ 700GB 内，磁盘规划已在 development.md 按 500GB~1TB 预留，可接受）。

---

## 四、模块方案（对标神策逐项拆解）

### 4.1 埋点管理（对标神策「元数据管理 + 数据质量」）

MySQL 元数据表（核心几张）：

```
meta_event            元事件：event_key(=sa_events.event)、显示名、描述、状态(可见/隐藏)、
                      负责人、是否预置、创建来源(登记/自动发现)
meta_event_property   事件属性：event_key、prop_key、显示名、数据类型(String/Number/Bool/
                      Datetime/List)、是否物化、枚举值字典、示例值
meta_user_property    用户属性：同上（作用于 sa_user_profiles）
meta_virtual_event    虚拟事件：显示名 + 规则(元事件+筛选条件的组合)，查询引擎运行时展开
meta_tracking_plan    埋点方案：需求单 → 事件/属性设计 → 评审状态 → 联调状态 → 上线状态
meta_property_dict    维度字典（如 渠道ID→渠道名 映射）
```

功能要点（对照神策）：

| 神策功能 | 我们的实现 |
|---------|-----------|
| 元事件管理 | 自动发现（ingestor 见到新 event 自动登记为"待确认"）+ 手工登记；显示名/隐藏/描述 |
| 事件属性管理 | 自动采样属性 key 与类型（扫 properties JSON），人工补显示名/类型修正 |
| 用户属性管理 | 同上 |
| 虚拟事件 | 查询引擎 DSL 支持"事件=虚拟事件"时展开为 `event IN (...) AND (条件)` |
| 埋点方案/需求 | 简版：方案文档结构化（事件+属性+触发时机），状态流转；生成 SDK 接入代码片段 |
| Debug 实时数据查询 | 按 `distinct_id`/设备号实时查 `sa_events` 最近 N 条（数据验收用） |
| 入库校验 | 已登记属性 vs 实际上报属性的类型/必填校验报告（离线扫表） |

### 4.2 事件分析（对标神策「事件分析」）

**分析 DSL**（前端配置 → 后端 JSON）：

```json
{
  "event": "Purchase",
  "metrics": [
    {"type": "count"},                                   // 触发次数
    {"type": "uniq_user"},                               // 触发用户数
    {"type": "agg", "func": "sum", "prop": "amount"},    // 属性聚合：sum/avg/max/min/p90
    {"type": "per_user", "base": "count"}                // 人均次数（派生）
  ],
  "filters": [{"prop": "channel", "op": "=", "value": "app_store"}],
  "groups": [{"prop": "os"}, {"prop": "time", "granularity": "day"}],
  "time_range": ["2026-07-01", "2026-07-28"],
  "compare": {"type": "last_period"}                     // 时间对比
}
```

**SQL 生成模板**（直接可用）：

```sql
SELECT toDate(log_time) AS d, os,
       count() AS cnt,
       uniqExact(analysis_id) AS users,
       sum(JSONExtractFloat(properties, 'amount')) AS amount_sum
FROM clklog_sa.sa_events
WHERE project_name = {project}
  AND stat_date BETWEEN {start} AND {end}
  AND event = {event}
  AND JSONExtractString(properties, 'channel') = 'app_store'
GROUP BY d, os
ORDER BY d;
```

功能对照：

| 神策能力 | 一期 | 二期 |
|---------|------|------|
| 多指标（次数/用户数/属性聚合/人均） | ✅ | |
| 筛选（事件属性+用户属性，且/或组合） | ✅ | |
| 分组（事件属性+用户属性+时间粒度 时/天/周/月） | ✅ | |
| 时间对比（上期/同期/自定义） | ✅ | |
| 数值属性自定义分组区间 | | ✅ |
| 查看单个用户行为序列（下钻） | | ✅ |

### 4.3 漏斗分析（对标神策「漏斗分析」）

**一期：按人数漏斗**，用 ClickHouse 原生 `windowFunnel`：

```sql
-- 步骤: 浏览商品 → 加购 → 支付；窗口期 1 天
SELECT level, count() AS users FROM (
    SELECT analysis_id,
           windowFunnel(86400)(
               toUnixTimestamp(log_time),
               event = 'ViewProduct' AND JSONExtractString(properties,'category') = '女装',
               event = 'AddCart',
               event = 'Pay'
           ) AS level
    FROM clklog_sa.sa_events
    WHERE project_name = {project}
      AND stat_date BETWEEN {start} AND {end}
    GROUP BY analysis_id
)
GROUP BY level ORDER BY level;
-- 第 N 步人数 = sum(users WHERE level >= N)；转化率 = 逐级相除
```

| 神策能力 | 实现方式 | 分期 |
|---------|---------|------|
| 窗口期（1分钟~3650天自定义） | `windowFunnel(window)` 参数 | 一期 |
| 步骤=事件+筛选条件（最多64步） | 条件数组透传 | 一期 |
| 按人数（首次最长转化序列） | `windowFunnel` 原生语义即"有序、允许穿插、取最长" | 一期 |
| 漏斗图/转化率/流失率 | 前端 ECharts | 一期 |
| 按天/周/月趋势 | 外层按时间分桶各算一次 | 一期 |
| 分组（按某步骤属性/用户属性分组看漏斗） | 组内分别跑 windowFunnel | 二期 |
| 属性关联（浏览→支付同一商品ID） | 需自研序列匹配（arrayReduce/groupArray 按 analysis_id 排序后自写序列状态机） | 二期 |
| 按次数漏斗 | 同上自研序列匹配（windowFunnel 不支持） | 二期 |
| 转化中位时间 | `quantile(0.5)(stepN_time - step1_time)`，自研序列匹配时顺带输出 | 二期 |
| 漏斗模板 | meta 表存模板，复用 | 一期 |

> ⚠️ 语义红线：`windowFunnel` 的判定规则与神策"按人数"口径（有序、允许穿插 X、取首次最长转化序列）一致，验收时用神策手册附录 A 的用例集逐条对拍。

### 4.4 留存分析（对标神策「留存分析」）

用原生 `retention()`：

```sql
-- 初始事件: AppLaunch(首日)；留存事件: AppLaunch；N日留存
SELECT cohort_date,
       count()                       AS new_users,
       sum(r[1]) AS d1,  round(sum(r[1])/count()*100, 2)  AS d1_rate,
       sum(r[2]) AS d7,  round(sum(r[2])/count()*100, 2)  AS d7_rate,
       sum(r[3]) AS d30, round(sum(r[3])/count()*100, 2) AS d30_rate
FROM (
    SELECT analysis_id,
           cohort_date,
           retention(
               stat_date = cohort_date,
               stat_date = cohort_date + 1  AND event = {retain_event},
               stat_date = cohort_date + 7  AND event = {retain_event},
               stat_date = cohort_date + 30 AND event = {retain_event}
           ) AS r
    FROM (
        SELECT analysis_id, stat_date, event,
               minIf(stat_date, event = {start_event}) OVER
                   (PARTITION BY analysis_id) AS cohort_date
        FROM clklog_sa.sa_events
        WHERE project_name = {project}
          AND stat_date BETWEEN {start} AND {end} + 30
    )
    GROUP BY analysis_id, cohort_date
)
GROUP BY cohort_date ORDER BY cohort_date;
```

| 神策能力 | 分期 |
|---------|------|
| 自定义初始事件/回访事件（可不同事件） | 一期 |
| 日/周/月粒度留存表 + 留存率曲线 | 一期 |
| 新用户口径（is_first_day）或"触发初始事件即入组"两种 | 一期 |
| 分组对比留存（渠道/版本） | 二期 |
| 自定义 N 天列表（D1~D90 任选） | 二期 |

### 4.5 自定义报表（对标神策「报表/看板 + 自定义 SQL」）

```
rpt_dashboard     看板：名称、布局(JSON grid)、所有者、权限
rpt_card          卡片：类型(事件分析/漏斗/留存/SQL)、分析DSL快照、图表类型
                  (折线/柱/漏斗图/留存表/数值卡)、刷新策略
rpt_sql           自定义 SQL：语句（仅 SELECT，强制 LIMIT/超时/只读账号执行）、
                  字段映射、图表配置
```

- 看板 = 卡片网格，卡片保存"分析 DSL 快照"，打开时实时重算（神策"书签"同款逻辑）。
- 自定义 SQL 走独立 ClickHouse 只读账号 + `max_execution_time`/`max_rows_to_read` 限额 + 关键字黑名单（INSERT/ALTER/DROP/ATTACH）。
- 全局筛选器（时间、项目）下推所有卡片。

---

## 五、关键技术决策

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| 1 | 数据补齐方式 | **旁路消费 CKafka** 写 `sa_events`，不 fork clklog-processing | 零侵入、社区版可升级；Flink 改源码要长期维护分支 |
| 2 | 自定义属性存储 | **JSON 列保底 + 热属性一键物化** | 灵活性与性能兼顾；纯 Map 列对多类型值不友好 |
| 3 | 用户标识 | 运行时归并 `if(user_key!='',user_key,distinct_id)`，不做离线 ID-Mapping 刷数 | 一期成本最低；神策 IDM 全量打通属后期演进 |
| 4 | 分析引擎 | 自研 DSL→SQL 生成器（Java），不引第三方 OLAP | 需求边界清晰（4 类模型），SQL 可控可优化 |
| 5 | 后端形态 | 先单体 Spring Boot 按模块分包（meta/query/report），后按需拆分 | 降低一期部署运维成本，与现有容器栈一致 |
| 6 | 前端 | 独立 SPA（React/Vue + ECharts），nginx 挂 `/sa/` 与社区版 UI 并存 | 不侵入 clklog-ui 源码 |
| 7 | 认证 | 复用社区版 MySQL `sys_user` 体系或接统一 SSO，一期可先共享 admin session | 避免重复造账号体系 |

## 六、分期实施计划（概要）

| 阶段 | 内容 | 关键产出 |
|------|------|---------|
| **P0 数据补齐** | ingestor 服务；`sa_events`/`sa_user_profiles` 建表；回灌历史 Kafka 数据 | 完整自定义属性入库，与 `log_analysis` 行数对拍一致 |
| **P1 埋点管理 + 事件分析** | meta 表 + 管理界面；事件分析 DSL/SQL/图表 | 任意事件×指标×分组×筛选出图 |
| **P2 漏斗 + 留存（按人数）** | windowFunnel/retention 封装；漏斗图/留存表 | 附录 A 神策语义用例集对拍通过 |
| **P3 自定义报表** | 看板/卡片/书签/自定义 SQL | 分析可存为卡片上看板，SQL 报表有安全限额 |
| **P4 增强** | 按次数漏斗、属性关联、转化时长、分组留存、用户下钻、物化列管理 | 视优先级排期 |

> 详细排期、里程碑、人日估算、风险 owner 见项目帽文档 `docs/project/plan-clklog-analytics-v1.md`。

## 七、风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| CKafka 消息保留期内 P0 未上线，历史 properties 丢失 | 历史数据无自定义属性 | 立即启动 P0（ingestor 先行）；确认 topic 保留时长并调长 |
| JSON 属性查询性能差 | 分析慢 | 物化列机制 + 按 event 的 ORDER BY + 查询超时/采样 |
| windowFunnel 语义与神策边界 case 不一致 | 数据口径争议 | 附录 A 用例集作为验收门禁；不一致处在文档显式声明 |
| ClickHouse 单点（当前无副本） | 分析可用性 | 与 development.md 的 3 节点 Keeper 演进合并规划；新表直接用 ReplicatedMergeTree 预留路径 |
| 社区版升级改变 Kafka 消息格式 | ingestor 解析失败 | 解析层容错（未知字段不报错）+ 升级时回归测试清单 |
| 多项目数据隔离 | 越权 | 所有表带 `project_name`，查询引擎强制注入项目过滤 |

## 八、下一步

按 `AGENTS.md` 门禁要求，进入「程序/实现」前需确认以下文档已齐备：

1. **PRD（产品帽）**：`docs/product/prd-clklog-analytics-v1.md` — 五大模块的交互、字段、验收标准。
2. **实现方案（架构帽）**：`docs/architecture/clklog-analytics-design.md` — DSL Schema 定义、SQL 生成器详细设计、ingestor 解析规格、API 契约、表结构终稿。
3. **项目计划（项目帽）**：`docs/project/plan-clklog-analytics-v1.md` — 排期、里程碑、依赖、风险 owner。

本文定位为调研结论与总体方向；具体字段 SSOT、接口契约、DDL 终稿以上述三份文档为准。

---

## 附录 A：神策漏斗/留存计算语义（验收基准）

### A.1 漏斗（按人数）

1. 时间范围 = 漏斗**第一步**发生的时间范围；窗口期 = 从第一步到最后一步的最大时限（1分钟~3650天）。
2. 转化序列**有序**，步骤间**允许穿插其他事件**（A > X > B > X > C 仍算转化）。
3. 同一用户多次完成，仅计 1 次，取**首次最长转化序列**；未完成时取靠后的最长序列用于判定流失步骤。
4. 转化事件优先归功于离它近的前序事件（A > B1 > B2 > C 取 B2）。
5. 指标：每步独立用户数、逐级转化率、总体转化率、流失人数；中位转化时长为增强项。
6. 边界：窗口期可勾选"限制在时间区间内"（截断超出部分）。

### A.2 漏斗（按次数，二期）

1. 每次触发起始事件即开一个新分桶；同一分桶内每步事件至多计 1 次。
2. 窗口期按本次起始事件时间计算；分桶重叠时先开先匹配。

### A.3 留存

1. 留存 = T 日触发初始事件的用户，在 T+N 日触发回访事件的比例；初始/回访事件可不同。
2. 粒度：日/周/月；口径：首日新用户（is_first_day）或时段内触发初始事件全量用户。
3. 输出：留存人数表（cohort × N）+ 留存率曲线。

### A.4 事件分析

1. 指标：触发次数、触发用户数、属性值 总和/均值/最大/最小/去重数/分位数、人均值。
2. 筛选：事件属性+用户属性，且/或组合；分组：同上+时间粒度。
3. 筛选/分组作用于**事件本身**（与漏斗的"先定转化人再筛选"不同）。
