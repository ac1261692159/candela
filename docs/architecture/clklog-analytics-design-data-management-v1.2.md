# 设计：数据清理 v1.2（定点删除 / 未登记事件 / 项目退役，phase: clklog-data-management-v1.2）

> 门禁要素：phase id `clklog-data-management-v1.2`；范围/验收/非目标见
> `docs/product/prd-clklog-data-management-v1.2.md`（V12-AC1~AC8）。
> 复用面：quality-ops 的前置对拍（`RetentionService.preflight`）、清理登记（`ops_cleanup_ledger`）、
> 审计（`ops_action_log`）、mutation 进度（`system.mutations` 轮询）；不新建第二套台账。

## 1. 模块与文件

| 文件 | 动作 |
|---|---|
| `apps/analytics-server/src/modules/ops/retention.service.ts` | 复用：`preflight`（删除动作沿用「窗口覆盖」档） |
| `apps/analytics-server/src/modules/ops/cleanup-plan.ts`（新） | 纯函数：条件 → 校验 + SQL 片段 + 影响预演 SQL；白名单表/列；token 摘要算法 |
| `apps/analytics-server/src/modules/ops/data-delete.service.ts`（新） | 预演 / 备份 / 执行 / 进度；调 `sa_cleanup` 连接；写审计与登记 |
| `apps/analytics-server/src/modules/ops/data-mgmt.controller.ts` | 新增 4 个端点（见 §3） |
| （无 DTO 类） | 条件校验集中在 `cleanup-plan.ts` 的纯函数构造器：白名单/格式/边界一处生效，单测直接覆盖（比 class-validator 更适合「同一份规则既生 SQL 又校验」） |
| `apps/analytics-server/src/modules/ops/meta-reconcile.service.ts`（新） | R4-c：CH `GROUP BY event` × MySQL `meta_event` 差集 + 幽灵登记 |
| `apps/analytics-web/src/pages/Ops/DataManagementPage.tsx` | 新增两块：定点删除（预演→确认→执行）、数据与元数据对账 |
| `apps/analytics-web/src/features/ops/DataDeletePanel.tsx`、`UnregisteredEventsCard.tsx`（新） | 各自组件（避免页面继续膨胀；页面已 500+ 行） |
| `i18n/locales/*/ops.json` | 新增 `dataDelete.*` / `metaReconcile.*` 文案（13 语言） |

## 2. 条件模型（白名单，不做任意 SQL）

```
type DeleteCondition =
  | { kind: 'event';   table: 'clklog_sa.sa_events'; event: string; from?: YYYY-MM-DD; to?: YYYY-MM-DD }
  | { kind: 'project'; table: SaTable; project: string; from?: YYYY-MM-DD; to?: YYYY-MM-DD }
  | { kind: 'before';  table: SaTable; before: YYYY-MM-DD }          // stat_date < before
  | { kind: 'future';  table: 'clklog_sa.sa_events' }                // stat_date > today
```

规则（`cleanup-plan.ts` 内强制）：

1. **库表白名单**：仅 `clklog_sa.{sa_events, sa_user_profiles, sa_datatable_rows, sa_cohort_members, sa_tag_members}`；
   出现 `clklog.` 任何表 → 400（红线 1）。
2. **时间上界固定**：`to` 缺省 = 昨天（平台时区）；`to > 昨天` → 400。
   唯一例外 `kind=future`：`stat_date > today`（专门清时钟错乱数据）。
3. **必须带项目边界**：除 `kind=future` 外，SQL 一律含 `project_name = {project}`（设计文档 DML 契约）。
   跨项目删除不在本 phase（防误删）。
4. **影响行数上限**：预演返回行数 > `DELETE_MAX_ROWS`（默认 500 万，配置可调）→ 拒绝执行并给出分批建议。
5. **SQL 形态**：`ALTER TABLE <db>.<tbl> DELETE WHERE <固定片段>`，参数用 `{name:Type}` 占位（沿用现有 query 层）。
   分区键为 `project_name` 的表（`sa_cohort_members`/`sa_tag_members`）优先 `DROP PARTITION '{project}'`（秒级、无 mutation）。

## 3. API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sa/api/ops/data-mgmt/delete/preview` | 入参条件 + `project`；返回 `{ rows, min_date, max_date, events, distinct_ids, samples[5], backup_estimate_bytes, preflight, max_rows_exceeded }`；**只读** |
| POST | `/sa/api/ops/data-mgmt/delete/execute` | 入参条件 + `project` + `confirm_table` + `confirm_token`；流程：校验 token → 前置对拍 → 备份 → `ALTER DELETE` → 写审计/登记 → 返回 `mutation_id` |
| GET | `/sa/api/ops/data-mgmt/mutations?table=` | **复用既有端点**看 `system.mutations` 进度（不新增 delete/mutations）；`execute` 返回的 `mutation_id` 用于对号入座 |
| GET | `/sa/api/ops/data-mgmt/unregistered-events` | R4-c 差集（未登记事件 + 幽灵登记），支持 `project`/`limit` |

`confirm_token`：`hmac(sha256, CLEANUP_CONFIRM_KEY || 规范化条件 + 预演行数, 5 分钟)`；
服务端在 `/preview` 签发、`/execute` 校验（条件或行数变化即失效）。密钥优先取进程环境
`CLEANUP_CONFIRM_KEY`，未配置时用进程内随机密钥（重启即失效，属可接受降级）。

## 4. 执行流程与护栏（破坏性动作）

```
preview(只读) → 用户勾选/确认 → execute:
  ① 校验 DTO + 白名单 + token
  ② preflight（要求覆盖「被删数据里最新的一天」= 预演的 max_date，而非条件里的 9999）：
     覆盖要求有三档，与既有「超保留期豁免」同一原则——**覆盖不到的窗口不能被永久拦住**：
     1) 被删窗口在**近 30 天**内（`DELETE_PREFLIGHT_COVERAGE_DAYS`）→ 必须被通过快照覆盖；
     2) 早于近 30 天 → 只要求一张新鲜通过快照（对拍单次上限 3 天，近期快照不可能覆盖几个月前某一天）；
     3) `kind=future` → 永远只要求新鲜通过快照（未来日期天然无法被覆盖）。
  ③ 备份：CREATE TABLE IF NOT EXISTS clklog_sa_bak.<tbl>_<yyyymmdd_hhmmss> AS SELECT * FROM <tbl> WHERE <条件>
     （幂等：同名表存在则比对行数；不一致 → 中止）
  ④ 审计先落 running（action=delete_rows，detail 含条件/预演数字/备份表名）
  ⑤ 执行：ALTER TABLE ... DELETE WHERE ...（`sa_cleanup` 连接；未配置口令 → 400，不回退高权账号）
  ⑥ 轮询 system.mutations 至 is_done（上限 30 分钟，超时→审计 partial 并提示）
  ⑦ 登记 ops_cleanup_ledger（scope_type='rows'，range 取受影响 stat_date 区间；用于对拍跳过）
  ⑧ 审计更新 done/partial/failed
```

并发保护：`system.mutations` 存在未完成任务时 `/execute` 返回 409（IO 保护，沿用设计 §4.4）。

## 5. R4-c 未登记事件（差集口径）

```
CH:  SELECT event, count() AS rows, min(stat_date), max(stat_date), uniq(distinct_id)
     FROM clklog_sa.sa_events WHERE project_name = {project} GROUP BY event
MySQL: SELECT event_key FROM meta_event WHERE project_name = {project}
未登记 = CH 有 & MySQL 无（附 max(stat_date) > today 的未来标记）
幽灵登记 = MySQL 有 & CH 无（测试残留/虚拟事件）
```

限制：CH 侧扫描按项目分组全表（`sa_events` 单项目 亿级行）；用 `max_execution_time=60s` +
`max_memory_usage=1GB` + `max_threads=2` 护栏，超时返回「暂不可用」而不是拖垮 CH；
后续若变慢，改为「按最近 N 天窗口」差分（默认 30 天，页面可调）。

## 6. 测试策略

| 层 | 用例 |
|---|---|
| 单测（后端） | 条件白名单（社区版库/外表/越界时间/缺项目 → 400）；`future` 只允许 `sa_events`；token 签发/过期/条件变更失效；预演 SQL 片段含 `project_name` + 时间上界；备份失败 → 中止；影响行数超限 → 拒绝；`sa_cohort_members` 走 `DROP PARTITION`；台账写入（audit + ledger）；差集纯函数（含未来标记） |
| 单测（前端） | 定点删除面板：预演前禁用执行、二次确认输入表名 + token、超限提示；未登记事件卡片渲染两列与「登记/删除」动作 |
| 集成（测试环境） | 建表造数 → 预演 → 备份 → 执行 → mutation 清零 → 台账 → 对拍标「已清理」（沿用 `scripts/standalone-test-env/`） |
| 线上实测 | 未来时间戳删除（先删 `$undefined` 2 行这类极小样本）；未登记事件差集与手工脚本一致；项目退役预演只读核验 |

## 7. 非目标与红线

- **社区版零改动**：任何路径都不对 `clklog.*` 执行写操作；白名单在服务层硬编码校验（不依赖前端）。
- 不做任意 SQL、不做定时自动删除、不删 `SaProject` 登记行、不做跨项目删除。
- 不替代 CLI `scripts/cleanup.sh` 的合规流程（平台侧是子集 + 台账联动）。
- 备份表 TTL 90 天（`clklog_sa_bak`），由保留策略登记覆盖；删除不可逆，靠备份 + 审计留痕（红线 6）。

## 8. 实施顺序（可独立发版）

1. **R4-a 后端**：条件白名单 + 预演 + token + 备份 + 执行 + 台账（含单测）。
2. **R4-c 后端**：未登记事件差集端点（含单测）。
3. **前端**：定点删除面板 + 未登记事件卡片 + 13 语言文案（含单测）。
4. **R4-b 项目退役**：预演（sa 5 + MySQL 31）→ MySQL 备份导出（NDJSON）→ 逐表删 → 审计。
   依赖 1、2 落地后单独发版（MySQL 侧删除面最大，单独一轮验收）。
