# 实现拆包：ClkLog 分析平台 v1

> phase: clklog-analytics-v1
> 版本：v1.0（2026-07-28）｜ 上游：`docs/architecture/clklog-analytics-design.md`
> 本文档把设计进一步拆成可执行的前后任务、API、页面与验收点，是进入 `apps/` 编码前的最后一层设计。

---

## 1. 拆包原则

- 每个任务必须可独立验收（有输入、输出、检查清单）。
- 前后端接口以 `clklog-analytics-design.md` §9 API 契约为准。
- 数据层变更必须先在本地/测试 ClickHouse 演练，再进 Puppet SQL 模板。
- 不侵入 ClkLog 社区版；所有新增逻辑走 `clklog_sa` / `clklog_sa_meta`。

## 2. 全局公共项（所有模块依赖）

### 2.1 后端公共项

| # | 任务 | 说明 | 验收点 |
|---|------|------|--------|
| C1 | 项目上下文拦截器 | 所有 `/sa/api/**` 接口从 session 取当前 `project_name` 并注入查询 | 未带 project 参数的请求自动补全；跨 project 请求被拒绝 |
| C2 | ClickHouse 连接池 + 只读账号 | `sa_readonly` 用于 DSL 查询；ingestor 用写账号 | `readonly=1`，权限验证通过 |
| C3 | Redis 缓存模板 | `sha256(规范化DSL)` 为 key，TTL 300s，`refresh=true` 跳过 | 压测命中率 > 60% |
| C4 | 统一响应包装 | `{code, message, data}`；查询类返回 `columns/rows/elapsed_ms/sql` | 所有接口格式一致 |
| C5 | 全局异常处理 | CK 超时、SQL 注入尝试、Kafka 消费异常统一处理 | 错误码不泄露堆栈给前端 |

### 2.2 前端公共项

| # | 任务 | 说明 | 验收点 |
|---|------|------|--------|
| F1 | 项目选择器 | 顶部导航同步社区版当前 project | 切换 project 后所有分析模块重载 |
| F2 | 时间范围组件 | 快捷（今天/昨天/近7天/近30天）+ 自定义 | 与 DSL `time_range` 互转 |
| F3 | 条件筛选编辑器 | 事件属性/用户属性、操作符、且/或组合 | 支持嵌套一层 and/or |
| F4 | 分组选择器 | 事件属性/用户属性 + 时间粒度 | 最多 2 个属性分组 + 1 个时间分组 |
| F5 | 图表组件 | ECharts 折线/柱状/漏斗图/留存表/数值卡 | 同一份数据可切换 chart_type |
| F6 | 通用表格 | 分页、排序、导出 CSV | 前端分页 100 行/页 |

---

## 3. P0 数据补齐拆包

### 3.1 ingestor（后端）

| # | 子任务 | 详细说明 | 输入 | 输出 | 验收点 |
|---|--------|----------|------|------|--------|
| P0-B1 | Kafka 消息采样 | 从 `clklog` topic 拉 100 条样例，确认单条/数组格式、字段名 | CKafka 只读权限 | `apps/ingestor/samples/sample-{ts}.json` | 样例覆盖 track/track_signup/user_set 三种 type |
| P0-B2 | 解析器 | Jackson 解析神策 JSON；未知字段不抛异常 | 样例文件 | `SaEventParser` | 三种 type 都能解析；异常数据进 DLQ |
| P0-B3 | 属性拍平 | 从 properties 提取预置维度到列，剩余进 `properties` JSON | 解析结果 | 拍平后的 `SaEventRecord` | 高频维度（utm/os/browser/省市等）命中样例 |
| P0-B4 | CRC 生成 | 对上报原文计算 SHA-256 作为幂等键 | 原始 JSON | `crc` 字段 | 同一消息重放 crc 相同 |
| P0-B5 | 批量写入 CK | 500 条/2s 攒批；失败 3 次指数退避 | `SaEventRecord` 流 | `sa_events` 表数据 | 单批写入延迟 < 5s |
| P0-B6 | 用户属性处理 | track_signup/user_set/user_set_once 路由到 `sa_user_profiles` | Kafka 消息 | `sa_user_profiles` 数据 | user_set 覆盖、user_set_once 仅首次写入 |
| P0-B7 | 位点管理 | 手动提交 offset；写入 CK 成功后提交 | Kafka consumer | offset 记录 | kill 重启后从位点续传 |
| P0-B8 | 历史回灌 | 独立 consumer group 从头消费 topic 保留期内数据 | CKafka | `sa_events` 历史数据 | 与 `log_analysis` 行数对拍 < 0.1% |

### 3.2 数据层

| # | 子任务 | DDL/操作 | 验收点 |
|---|--------|----------|--------|
| P0-D1 | 创建分析库 | `CREATE DATABASE clklog_sa` | 库存在且可读写 |
| P0-D2 | 创建事件明细表 | 见设计 §5.1（含 crc、ingest_time、ReplacingMergeTree） | 表结构与设计一致 |
| P0-D3 | 创建用户属性表 | 见设计 §5.2 | 表结构与设计一致 |
| P0-D4 | 创建 MySQL 元数据库 | `CREATE DATABASE clklog_sa_meta` | 库存在 |

### 3.3 部署

| # | 子任务 | 说明 | 验收点 |
|---|--------|------|--------|
| P0-O1 | docker-compose 新增 `clklog-analytics` 服务 | 双进程：server(8085) + ingestor | `docker compose config -q` 通过 |
| P0-O2 | nginx 新增 `/sa/` location | 反向代理到 8085 | `/sa/` 返回前端入口 |
| P0-O3 | env 模板参数化 | Kafka/CK/MySQL/Redis 连接信息走 Puppet | 无密钥硬编码 |
| P0-O4 | Puppet 应用 | `puppet agent -t` | 服务在 生产主机 启动 |

---

## 4. P1 埋点管理 + 事件分析拆包

### 4.1 埋点管理（后端 meta-svc）

| # | 子任务 | API/实现 | 验收点 |
|---|--------|----------|--------|
| P1-M1 | 元事件 CRUD | `GET/PUT /meta/events?status=&keyword=` | 列表、搜索、更新状态 |
| P1-M2 | 元事件自动发现 | ingestor 插入新 event 时写 `meta_event(status='pending')` | 新 event 5 分钟内出现 |
| P1-M3 | 事件属性 CRUD | `GET/PUT /meta/events/{event_key}/properties` | 属性列表、类型修改 |
| P1-M4 | 属性自动采样 | 定时任务（每 10min）扫描 `sa_events` 采样 prop_key/type/sample | 采样值与实际上报一致 |
| P1-M5 | 用户属性管理 | `GET/PUT /meta/user-properties` | 同事件属性 |
| P1-M6 | 虚拟事件 CRUD | `GET/POST/PUT/DELETE /meta/virtual-events` | 创建后可在分析模块使用 |
| P1-M7 | Debug 实时查询 | `GET /meta/debug/recent?distinct_id=&event=&limit=100` | 按条件查最近 100 条 |
| P1-M8 | 入库校验报告 | `GET /meta/quality/report` | 类型不符/未登记/缺失必填 三类清单 |
| P1-M9 | 属性物化 | `POST /meta/properties/{id}/materialize` → 异步 ALTER TABLE | 物化后查询走列 |

### 4.2 埋点管理前端页面

| # | 页面 | 主要区块 | 验收点 |
|---|------|----------|--------|
| P1-FM1 | 元事件列表 | 搜索框 + 表格（event_key/显示名/状态/负责人/操作） | 可搜索、可编辑显示名/状态 |
| P1-FM2 | 事件详情抽屉 | 基础信息 + 属性列表 + 近 7 天量 | 属性可改类型/显示名 |
| P1-FM3 | 用户属性列表 | 同元事件列表 | 支持属性管理 |
| P1-FM4 | 虚拟事件编辑器 | 名称 + 规则（事件 + 筛选条件） | 规则可增删改 |
| P1-FM5 | Debug 查询页 | distinct_id/user_key/事件名 输入 + 结果列表 | 能看到原始 JSON |
| P1-FM6 | 数据质量报告页 | 三类问题清单 + 下载 | 可导出 CSV |

### 4.3 事件分析（后端 query-svc）

| # | 子任务 | 说明 | 验收点 |
|---|--------|------|--------|
| P1-Q1 | DSL 校验器 | 校验 project/event/metrics/filters/groups/time_range | 非法 DSL 返回明确错误 |
| P1-Q2 | 属性解析器 | 物化列优先 → JSONExtract 按 meta data_type | sum/avg 走 Float，count/uniq 走 String |
| P1-Q3 | 用户属性子查询生成 | 对 `sa_user_profiles` 生成 `IN (SELECT distinct_id ...)` | 用户属性筛选生效 |
| P1-Q4 | 时间粒度函数 | hour/day/week/month → `toHour/toDate/toMonday/toStartOfMonth` | 各粒度结果正确 |
| P1-Q5 | 时间对比 | none/last_period/last_year/custom | 对比曲线同时展示 |
| P1-Q6 | TopN + 其他桶 | 分组 LIMIT 20，超出合并为「其他」 | 总数 = TopN + 其他 |
| P1-Q7 | 指标计算 | count/uniq_user/agg/per_user | 与手工 SQL 对拍 |
| P1-Q8 | SQL 执行与缓存 | 参数化 + Redis 缓存 | 注入 case 全部失败 |

### 4.4 事件分析前端页面

| # | 页面 | 主要区块 | 验收点 |
|---|------|----------|--------|
| P1-FE1 | 事件分析主页 | 顶部事件选择器 + 指标区 + 筛选区 + 分组区 + 图表 + 表格 | 完整 DSL 配置到出图 |
| P1-FE2 | 指标编辑器 | 添加指标：类型/属性/别名 | 支持多指标 |
| P1-FE3 | 保存卡片弹窗 | 名称 + 图表类型 + 目标看板 | 保存后可在看板打开 |

---

## 5. P2 漏斗 + 留存拆包

### 5.1 漏斗分析（后端）

| # | 子任务 | 说明 | 验收点 |
|---|--------|------|--------|
| P2-F1 | 漏斗 DSL 校验 | steps 2~8，每步 event + filters | 非法步骤数拒绝 |
| P2-F2 | windowFunnel SQL 生成 | `windowFunnel(window_seconds)(toUnixTimestamp(log_time), cond1, ...)` | 与神策用例对拍 |
| P2-F3 | 时间粒度趋势 | granularity=day/week/month 外层分桶 | 趋势数据正确 |
| P2-F4 | 漏斗模板 CRUD | `meta_funnel_template` | 可保存/应用模板 |
| P2-F5 | 转化率计算 | 第 N 步人数 = sum(level >= N) | 逐级/总体转化率正确 |

### 5.2 漏斗前端页面

| # | 页面 | 主要区块 | 验收点 |
|---|------|----------|--------|
| P2-FF1 | 漏斗编辑页 | 步骤列表（可拖拽排序）+ 窗口期 + 全局筛选 | 2~8 步 |
| P2-FF2 | 漏斗结果页 | 漏斗图 + 转化率表格 + 流失人数 | 与神策语义一致 |
| P2-FF3 | 漏斗趋势页 | 按时间粒度看各步转化率 | 切换粒度不重配 |
| P2-FF4 | 漏斗模板管理 | 模板列表 + 应用 | 可复用 |

### 5.3 留存分析（后端）

| # | 子任务 | 说明 | 验收点 |
|---|--------|------|--------|
| P2-R1 | 留存 DSL 校验 | start_event/retain_event/cohort/granularity/n_list | n_list 任意组合 |
| P2-R2 | cohort 子查询 | `first_day` 用 `is_first_day=1`；`all` 用 `minIf` | 两种口径对拍 |
| P2-R3 | retention SQL 生成 | `retention(cond1, cond2, ...)` 数组 | D1/D7/D30 正确 |
| P2-R4 | 周/月粒度映射 | `toMonday/toStartOfMonth` | cohort 聚合正确 |

### 5.4 留存前端页面

| # | 页面 | 主要区块 | 验收点 |
|---|------|----------|--------|
| P2-FR1 | 留存配置页 | 初始事件 + 回访事件 + cohort 口径 + 粒度 + N 日 | 配置可切换 |
| P2-FR2 | 留存结果页 | cohort 表（日期 × N 日）+ 留存率曲线 | 表与曲线数据一致 |

---

## 6. P3 自定义报表拆包

### 6.1 后端 report-svc

| # | 子任务 | API/实现 | 验收点 |
|---|--------|----------|--------|
| P3-B1 | 看板 CRUD | `GET/POST/PUT/DELETE /report/dashboards` | 基本 CRUD |
| P3-B2 | 卡片 CRUD | `/report/dashboards/{id}/cards` | 卡片增删改查 |
| P3-B3 | 卡片 DSL 快照 | 保存 Event/Funnel/Retention DSL 或 SQL id | 打开时实时重算 |
| P3-B4 | 自定义 SQL 执行 | 只读账号 + 黑名单 + 超时/行数限额 | `DROP TABLE` 被拦截 |
| P3-B5 | 全局筛选下推 | 看板级 time_range/project 覆盖卡片默认值 | 所有卡片同步刷新 |
| P3-B6 | 分享链接 | `share_token` 只读访问 | 未登录访问只读 |

### 6.2 前端页面

| # | 页面 | 主要区块 | 验收点 |
|---|------|----------|--------|
| P3-FB1 | 看板列表 | 我的看板 + 分享给我的 | 可进入编辑 |
| P3-FB2 | 看板编辑页 | 网格布局 + 卡片拖拽 + 全局筛选器 | 布局可保存 |
| P3-FB3 | 卡片配置弹窗 | 选择分析类型 + 图表类型 + 刷新策略 | 四类卡片都支持 |
| P3-FB4 | 自定义 SQL 编辑器 | SQL 输入 + 字段映射 + 图表预览 | 危险语句被拦截 |
| P3-FB5 | 报表分享页 | 只读看板视图 | 无编辑权限 |

---

## 7. 前端路由设计

所有前端页面挂载在 `/sa/` 路径下：

```
/sa/
  /events              元事件管理
  /events/:key         事件详情
  /user-properties     用户属性管理
  /virtual-events      虚拟事件管理
  /debug               Debug 实时查询
  /quality             数据质量报告
  /analysis/event      事件分析
  /analysis/funnel     漏斗分析
  /analysis/retention  留存分析
  /dashboards          看板列表
  /dashboards/:id      看板详情/编辑
  /sql                 自定义 SQL 报表
```

---

## 8. 测试拆包

| # | 任务 | 说明 | 验收点 |
|---|------|------|--------|
| T1 | 造数脚本 | 生成 30 天已知答案数据集 | 可复现所有验收用例 |
| T2 | SQL 生成器单测 | 事件/漏斗/留存各 ≥ 10 case + 注入 case | 单测全部通过 |
| T3 | ingestor 单测 | 样例文件驱动解析与写入 | 覆盖 track/user_set/track_signup |
| T4 | 语义对拍脚本 | PRD §5 D1~D11、E1~E5 | 脚本化后可 CI 执行 |
| T5 | 接口集成测试 | 端到端 API 调用 | A1~F3 覆盖 |
| T6 | 前端 E2E | 核心流程：创建分析 → 保存卡片 → 上看板 | 关键路径可用 |
| T7 | 性能压测 | DAU 5 万 × 30 天 | 达成量化目标 |

---

## 9. 关键难点与实现策略

### 9.1 自定义属性查询性能
- 策略：热属性物化列；查询引擎按 meta 表判断走列还是 JSONExtract。
- 兜底：查询超时 30s；超时时提示用户缩小时间范围或联系管理员物化属性。

### 9.2 用户属性 JOIN 性能
- 策略一期：子查询 `IN (SELECT distinct_id FROM sa_user_profiles FINAL WHERE ...)`。
- 若性能不足：改为 ClickHouse 字典 `dictGet` 或把常用用户属性物化到 `sa_events`。

### 9.3 漏斗语义边界
- 策略：`windowFunnel` 原生语义与神策"按人数"口径基本一致；边界 case 用 PRD §5.4 D1~D11 对拍，不一致处显式声明偏差。
- 二期按次数漏斗再考虑自研序列匹配。

### 9.4 ingestor 容错
- 策略：解析失败不入主流程，写 DLQ 文件；每日告警 DLQ 数量。
- 位点提交在 CK 写入成功后，保证 at-least-once + crc 幂等。

### 9.5 自定义 SQL 安全
- 策略：独立只读账号 + 关键字黑名单 + 强制 `max_execution_time=30` + `max_result_rows=100000`。
- 前端 SQL 编辑器不可关闭 LIMIT；后端再次校验。

---

## 10. 与上下游文档的边界

- 业务意图、交互、验收标准 → `docs/product/prd-clklog-analytics-v1.md`
- DSL Schema、API 契约、表结构终稿、ID 约定 → `docs/architecture/clklog-analytics-design.md`
- 排期、里程碑、风险 owner → `docs/project/plan-clklog-analytics-v1.md`
- 前端线框图与页面交互 → `docs/product/wireframes-clklog-analytics-v1.md`
- 本文档聚焦：把上述设计拆成可执行前后端任务与验收点。