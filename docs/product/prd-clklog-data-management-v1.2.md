# PRD：数据清理 v1.2 —— 定点删除 / 未登记事件 / 项目退役（phase: clklog-data-management-v1.2）

> 上游：`docs/architecture/clklog-analytics-design-data-management-v1.md`（V1.2 条目：ALTER DELETE 定点清理 + 未来时间戳专项）、
> `docs/product/prd-clklog-analytics-v1-data-governance.md`（敏感数据清洗的五步门禁与红线）、
> `docs/product/prd-clklog-data-quality-ops-v1.md`（前置对拍 / 清理登记）。
> 触发：用户实际诉求——「测试事件进了 CH 但平台看不到，怎么找出来 / 怎么删」「项目不做了怎么清干净」「怎么清一年前的数据」。

## 背景：现状能力与缺口（2026-10-09 生产核对）

| 已具备 | 缺口 |
|---|---|
| 存储概览 / 趋势 / 健康 / 清理预演与执行（**DROP PARTITION，仅月分区**，二次确认 + 前置对拍 + 审计 + 清理登记） | **定点删除（ALTER DELETE）平台内没有**：按事件名、按项目、按未来时间戳删除都做不了 |
| TTL 设置（20 张白名单表，审计 + 登记，延迟生效） | **项目退役没有通道**：MySQL 31 张表带 `project_name` 且无级联、无删除接口；sa 侧 4 张表要逐表处理 |
| CLI 敏感数据清洗 `scripts/cleanup.sh`（五步门禁、硬拒社区版库、`sa_cleanup` 账号） | 平台侧不可用；且生产未注入 `CLICKHOUSE_CLEANUP_PASSWORD`（跑之前必须提供口令） |
| 事件级差异（sa vs 社区版）、元数据发现日志 | **「数据里有、元数据没有」的事件查不到**（实测：`$SignUp` 448,923 行、`$undefined` 2 行；反向幽灵登记 4 个） |

## 阶段目标与范围

### R4-a 定点删除（平台内 ALTER DELETE，带全套护栏）

在「数据运维」页新增**定点删除**能力，条件白名单（不做任意 SQL）：

| 条件 | 语义 | 目标表（白名单） |
|---|---|---|
| 按事件名 | 删某事件的某时间段数据 | `clklog_sa.sa_events` |
| 按项目 | 删某项目的数据（退役/误上报） | `sa_events` / `sa_user_profiles` / `sa_datatable_rows` / `sa_cohort_members` / `sa_tag_members` |
| 按时间范围 | 删 `stat_date` 早于/介于某区间 | `sa_events` 及上述表 |
| **未来时间戳** | 删 `stat_date > 今天` 的脏数据（时钟错乱设备） | `sa_events` |

流程必须是**预演 → 备份 → 二次确认 → 执行 → 进度 → 审计 → 登记**：

1. **预演**：把条件翻成 `SELECT count() / min(stat_date) / max(stat_date) / uniq(event) / uniq(distinct_id)`，
   返回影响面 + **影响样例（LIMIT 5）**；不写任何数据。
2. **前置对拍**：沿用 quality-ops 规则——窗口在可信区间内必须被通过快照覆盖；超期窗口只要求一张新鲜通过快照。
3. **备份**：执行前把命中的行写入 `clklog_sa_bak.<表>_<yyyymmdd>`（`INSERT SELECT`，幂等），备份失败即中止（红线 6）。
4. **二次确认**：前端必须输入**表名 + 条件摘要哈希**（服务端签发的一次性 token，5 分钟有效），
   防止「改完条件直接点执行」。
5. **执行**：`ALTER TABLE ... DELETE WHERE <固定条件>`，**带 `project_name` + 时间上界**（设计文档 DML 契约）；
   执行后轮询 `system.mutations` 展示进度（复用现成端点）。
6. **审计 + 登记**：`ops_action_log`（action=`delete_rows`，detail 含条件/预演数字/备份表/影响行数）+
   `ops_cleanup_ledger`（`scope_type='rows'`），对拍据此跳过。

护栏：库表白名单（只 `clklog_sa.*`，**硬拒绝 `clklog` 社区版库**）；账号优先用 `sa_cleanup`
（未注入口令时接口返回明确错误并在页面提示，不回退到高权账号）；单次影响行数上限（默认 500 万，可配置）；
`system.mutations` 未清空时禁止发起新删除。

### R4-b 项目退役清理（预演优先，显式确认）

- **预演**：给出该项目在 sa 侧 5 张表 + MySQL 31 张表的影响行数/大小清单，以及社区版「不可按项目清理」的明确提示。
- **执行**：sa 侧——`sa_cohort_members`/`sa_tag_members` 走 `DROP PARTITION '<project>'`（分区键即项目名，秒级）；
  其余走 R4-a 的 ALTER DELETE；MySQL 侧——**先导出待删行到备份文件**（NDJSON，落 `/data/logs/.../project-retire/`）
  再逐表删，全程审计（action=`project_retire`）。
- **不做**：删 `SaProject` 行本身（保留登记，避免项目名被复用后语义混乱）；社区版数据（红线 1 + 无项目列）。

### R4-c 未登记事件视图（数据里有、元数据没有）

- 新端点：`GET /sa/api/ops/data-mgmt/unregistered-events?project=&limit=` →
  CH `GROUP BY event`（行数、首末日期、是否含未来日期）与 MySQL `meta_event.event_key` 做差集；
  同时返回**反向幽灵登记**（元数据有、数据没有）供清理。
- 页面：数据运维页新增「数据与元数据对账」卡片，两列（未登记事件 / 幽灵登记），
  每行提供两个动作：**登记为元事件**（复用既有 upsert）与**定点删除**（跳到 R4-a 预填条件）。
- 未来时间戳行在清单里单独标记（`max(stat_date) > today`），可一键预填「未来时间戳删除」。

### 未来时间戳专项

- 检测：保留策略总览的「可疑分区」（已上线）+ R4-c 的「含未来日期」标记。
- 清理：走 R4-a 的未来时间戳条件（`stat_date > today`）；**不使用 DROP PARTITION**
  （未来月分区被护栏拒绝是正确的——可能正在写入；只有 ALTER DELETE 能精准删行）。

## 验收标准

| 编号 | 判据 | 核对方式 |
|---|---|---|
| V12-AC1 | 预演给出影响行数/日期范围/样例，且不写数据 | 单测 + 生产只读实测 |
| V12-AC2 | 备份表在破坏性执行前存在且行数与预演一致；备份失败则中止 | 单测（注入失败）+ 测试环境实测 |
| V12-AC3 | 条件 token 5 分钟过期、条件变更后 token 失效；缺 token 或表名不符 → 400 | 单测 |
| V12-AC4 | 社区版库/白名单外表 → 400；账号未配置 → 400 且页面明示 | 单测 + 页面实测 |
| V12-AC5 | 执行写 `ops_action_log`（`delete_rows`）与 `ops_cleanup_ledger`（`rows`），对拍把该区间标「已清理」 | 单测 + 生产实测 |
| V12-AC6 | R4-c 差集在生产与手工脚本一致（当前：`$SignUp` 448,923 行 + `$undefined` 2 行；幽灵 4 个） | 生产实测 |
| V12-AC7 | 项目退役预演覆盖 sa 5 张表 + MySQL 31 张表，且明确提示社区版不可按项目清 | 单测 + 页面实测 |
| V12-AC8 | 未来时间戳删除只删 `stat_date > today` 的行，且不触发 DROP PARTITION | 测试环境实测 |

## 非目标

- 不做任意 SQL 删除（条件白名单制）；不做社区版数据删除（红线 1）。
- 不做「删项目登记行」（只清数据）；不做自动定时清理（一律人工触发，沿用清洗 PRD 的合规要求）。
- 不替代 `scripts/cleanup.sh`（保留其五步门禁的 CLI 路径；平台侧是其能力子集 + 前置对拍/登记联动）。
- 不改对拍/保留策略算法；不改社区版表结构。

## 依赖与授权

| 依赖 | 说明 |
|---|---|
| `CLICKHOUSE_CLEANUP_PASSWORD` | 定点删除要用 `sa_cleanup` 账号（CH 已建好、授权已就绪）。**生产当前未注入**：V1.2 上线前需通过 Puppet 注入或服务器 `./scripts/.env` 提供；未注入时功能显式不可用（不回退高权账号） |
| 前置对拍 | 复用 quality-ops 规则；删除动作沿用「窗口覆盖」判定 |
| 用户确认 | 破坏性动作一律二次确认（表名 + 条件摘要 token），不做「一键全删」 |

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| ALTER DELETE 重写 part 造成 IO/内存峰值（单机 12GiB 教训） | 单次影响行数上限 + mutation 未清空禁新任务 + 分批（按天切片）+ 低峰执行提示 |
| 误删在写数据 | 时间上界固定为「昨天」（未来时间戳专项是唯一例外，且只删 `stat_date > today`） |
| 备份表膨胀 | 备份库 `clklog_sa_bak` 单独 TTL 90 天 + 预演返回备份体积估算 |
| 项目退役期间并发写入 | 退役流程第一步先「停上报」（文档指引：禁用 API Key / 停 SDK），并在预演里检查最近 24h 是否仍有写入 |
