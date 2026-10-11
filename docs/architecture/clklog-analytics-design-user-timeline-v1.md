# 实现方案：单用户行为序列（复用主体 / 两段式异步 / 同一查询记录表）

> phase: `clklog-analytics-user-timeline-v1`
> 配对 PRD：`docs/product/prd-clklog-analytics-user-timeline-v1.md`
> 状态：**设计（未实现）**
> 前置能力：`clklog-analytics-debug-query-v1`（查询记录 + 项目开关）、`clklog-analytics-sa-events-skip-index-v1`（跳数索引）、`clklog-analytics-debug-async-query-v1`（两段式 + worker）

---

## 1. 复用清单（本功能**不新造**这些）

| 能力 | 复用点 | 说明 |
|---|---|---|
| 用户标识语义 | 服务端 `subjectExpr(subject, joins)`（`modules/subject/subject-expr.ts`） | 预置主体 = `if(user_key != '', user_key, distinct_id)`；属性主体走 `JSONExtractString(properties, ...)`（用户属性主体需 `JoinRegistry`，与既有查询一致） |
| 主体选择器 | 前端 `SubjectSelect`（`features/subject/SubjectSelect.tsx`） | 事件分析同款 |
| 时间范围 | `TimeRangeControl`（`features/time-range/`） | 复用既有区间能力（含展示时区） |
| 时间列渲染 | `features/meta/debug-columns.tsx` 的 `renderLogTime` | **必须**：CH 墙钟串按平台时区还原（曾偏 8 小时） |
| 结果表格 | `components/DataTable` 或 antd Table + `expandedProperties` | 展开行看完整 properties |
| 两段式异步 | 控制器分支 + `DebugQueryWorker` 的机制（预算 → CH 超时 → 登记任务 → worker 执行 → 就地渲染） | 本功能**沿用同一查询记录表与同一 worker**，按 `kind` 分支执行 |
| 查询记录/留档 | `metadebugrecord` + `metadebugrecordrow`（已具备 status/error_code/时间戳/截断标记） | 时间线结果同样入这套表（kind 区分） |
| 项目留档开关 | `DebugArchiveService.isEnabled/setEnabled`（`ops.owner.assign` 可改） | 关闭时不留痕（超预算查询不转后台，如实报超时） |

## 2. 数据模型（增量、不动 Debug 既有列）

`metadebugrecord` 增加两个字段（迁移 `20261009xxxxxx_user_timeline`）：

| 列 | 说明 |
|---|---|
| `kind` | `debug`（默认，历史行即此）/ `user_timeline` |
| `spec_json` | **仅时间线使用**：`{ subject_id, value, from, to, events[], order }`；Debug 继续用既有 `window/cond_*` 列 |
| `window` 改为可空 | 时间线没有「1h/24h/7d」档位，区间真值在 `spec_json`；避免把 `custom` 这类假值塞进语义列 |

> 异步管道位置：`DebugQueryWorker` 与策略常量上移到 **`modules/query-job/`**（管道成为两种 kind 的共用基础设施，
> 按 `kind` 分派到各自的 runner：`DebugJobRunner`（meta）/ `TimelineJobRunner`（timeline））；各 kind 的结果写入由各自的 service 独占（单一写入方）。
>
> 取舍说明：**不**为时间线新建第二张记录表 + 第二个 worker —— 状态机（pending/running/done/failed）、
> 卡死回收、去重、审计、前端状态列这些「异步管道」完全同构，复制一份等于制造双份真值。
> 也不把 Debug 的 `cond_*` 列一起重构成 `spec_json`（那要回填 + 改已上线代码，收益低）。
> **触发条件**：出现**第三种**查询 kind 时，再统一重构为「`spec_json` + 通用结果行」（rule of three）。

## 3. 接口契约

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/sa/api/analysis/user-timeline/query` | body：`{ subject_id, value, from, to, events?, order?, limit? }`；两段式返回（同 Debug）：快路径 `{ items, matched_total, summary, archived, record_id? }`；超预算 `{ status:'running', record_id }` |
| `GET` | `/sa/api/analysis/user-timeline/records` | 查询记录列表（复用记录表，按 kind 过滤；`{ items, total, page, pageSize }`） |
| `GET` | `/sa/api/analysis/user-timeline/records/:id` | 记录详情（含行快照与汇总） |
| `GET` | `/sa/api/analysis/user-timeline/summary?subject_id=&value=&from=&to=` | **可选**（本 phase 非必需）：只取汇总（`count()`、种类数、首末时间），用于「先看规模再决定是否拉明细」 |

权限（已定决议）：**新增权限码 `timeline.view`**（权限目录 `permission-catalog.ts`），角色位 `owner / analysis_admin / analyst` 为真、
`member / external` 为假；超管由平台角色规则自动全权。三个接口统一 `@RequirePermission('timeline.view')`，
记录删除沿用「创建者 / 超管 / 持 `timeline.edit`? 」——本 phase 记录删除**沿用 Debug 的既有规则**（创建者 / 超管 / `meta.edit`），
不新增编辑类权限码（只读功能）。项目隔离照旧；**行级数据策略不套用**（PRD O-2：与 Debug 同口径）。

## 4. 查询 SQL 形状

```sql
SELECT log_time, event, distinct_id, user_key, properties,
       count() OVER () AS matched_total          -- 命中总数（LIMIT 前求值，零额外成本）
FROM clklog_sa.sa_events
WHERE project_name = {project: String}
  AND <subjectExpr> = {value: String}            -- 预置主体：if(user_key != '', user_key, distinct_id)
  AND log_time >= toDateTime({since: UInt32})    -- 区间起点（epoch 秒，避免墙钟串时区歧义）
  AND log_time <  toDateTime({until: UInt32})    -- 区间终点（左闭右开）
  AND stat_date >= toDate({stat_from: String})   -- 分区裁剪：from - 2 天（双向余量见下）
  AND stat_date <= toDate({stat_to: String})     --             to + 2 天
  [AND event IN {events: Array(String)}]         -- 可选：事件多选（吃排序键首列，明显更快）
ORDER BY log_time {ASC | DESC}
LIMIT {limit: UInt32}                            -- 单页条数（≤500）
```

要点：

- **区间两端都留 stat_date 余量（±2 天）**：`stat_date` 按项目时区切日、`log_time` 按平台时区，两者边界可能差一天；
  这与 Debug 的下界余量同一理由（Debug 当时只加下界是因为「最近 N 天」没有上界）。
- **上界用 `<`（左闭右开）**：行为序列的「到某时刻」语义如此；也避免同一毫秒边界重复。
- **命中总数与截断**：`count() OVER ()` 给出命中总数；物化时按上限（R5 的 5000 行）截断并置 `truncated=true`，
  界面标注「仅显示前 N 条（命中 M 条）」。
- **`properties` 仍需读取**（展开要看原文）；单行仍按 32KB / 单条 1MB 的既有上限截断（复用 `buildRows`）。

## 5. 性能与异步（沿用已验证的两段式）

实测基线（生产，7 天窗、无 event 条件、含跳数索引）：

| 维度 | 耗时 | 读行数 |
|---|---|---|
| 设备 `distinct_id` | ~5.1s | 1850 万 |
| 账号 `user_key` | ~10.2s | 894 万 |

→ **区间越长越慢**（7 天 5–10s；30 天按线性外推 20–40s），因此：

- 同步预算 **8 秒**（比 Debug 的 5 秒宽：时间线的典型查询天然更重，用户对「行为回溯」的等待预期也更宽松）；
- 超预算走**既有 `DebugQueryWorker`**（按 `kind` 分派到时间线执行器）：串行、单任务 120s 预算、卡死 10 分钟回收、同条件去重；
- 前端同 Debug：提示「已转后台执行（已等待 N 秒）」+ 轮询记录 + 完成后就地渲染；
- **提示而非拦截**：区间 > 7 天时界面提示「可能较慢，建议先选事件名或缩短区间」，不硬性禁止。

## 6. 多语言（i18n）计划

- **不新增命名空间**（新增一个命名空间要在 13 个语言目录各加一个文件 + 注册 + 走术语表流程，收益不抵成本）：
  文案落 **`analysis`** 命名空间（`analysis:userTimeline.*`）+ 菜单标签落 **`shell`**（`shell:menu.userTimeline`）。
- 计划键（约 22 个，实现时以 `scripts/i18n_export.py` 交给翻译）：
  `title / subject / value / valuePlaceholder / timeRange / events / eventsPlaceholder / eventsHint / order / orderAsc / orderDesc / pageSize / query / querying / hitTotal / shownTotal / kinds / span / firstEvent / lastEvent / empty / truncated / handoff / handoffSlow / statusRunning / statusDone / statusFailed / errorTimeout / errorQueryFailed / recordsTitle / viewDetail`
- **不翻译的**（AGENTS.md §24）：事件名/属性名（用户数据）、主体与标签的显示名（用户自建）、用户标识值、properties 原文。
- 交付前必跑：`scripts/i18n_check.py`（13 语言键集/占位符一致）与 `scripts/i18n_scan.py --check`（硬编码清零棘轮只减不增）；
  界面实测至少覆盖 zh-CN 与 en-US 两种语言（切换语言后 `<html lang>`、页面标题、关键文案正确）。

## 7. 前端

- 新页 `pages/Analysis/UserTimelinePage.tsx`（路由 `/analysis/user-timeline`，菜单挂 **用户** 组，权限 `timeline.view`；`shell-menu.ts` 增加 `showTimeline` 标志）；
- 表单：`SubjectSelect` + 标识输入 + `TimeRangeControl` + 事件多选（`EventSelect` 多选）+ 排序 + 条数；
- 结果：汇总条（命中/显示/种类/跨度/首末）+ 表格（复用 `renderLogTime`、`expandedProperties`）+ 分页（本地分页，数据来自记录快照）；
- 查询记录区：复用 Debug 的「状态列 + 轮询」交互（提示文案一致，避免两套异步心智）；
- 深链：`?subject=&value=&from=&to=` 直接带条件打开（可分享）。

## 8. 测试与验收

1. **后端单测**：SQL 形状（主体表达式、区间两端、stat_date 双向余量、count() OVER ()、事件多选、ORDER/LIMIT）、
   汇总计算、截断标记、两段式分派（kind）、超时/失败/回收、去重、留档开关关闭时不落痕；
2. **契约测试**：`{ items, matched_total, summary, status }` 字段快照；
3. **前端用例**：汇总渲染、时间列口径（与 Debug 同断言）、截断提示、转后台握手与轮询就地渲染、错误态；
4. **生产验收**（照 UT-1~UT-10）：直查对拍逐行一致、汇总正确、事件多选加速实测、长区间转后台、截断标注、
   记录回看、权限 403、13 语言键集；
5. **留档**：按用户既有要求，验收产生的记录**保留**（可回看）。

## 9. 风险与回滚

| 编号 | 风险 | 处置 |
|---|---|---|
| R-1 | 复用 `metadebugrecord` 让表承担两种 kind | 增量列 + `kind` 默认 `debug`（历史行语义不变）；出现第三种 kind 时统一重构（rule of three） |
| R-2 | 长区间查询拖住 ClickHouse | 串行 worker + 120s 预算 + 前端提示；必要时给时间线单独设更小预算 |
| R-3 | 单用户全量事件属敏感数据 | 与 Debug 同级口径；建议后续加「谁查了谁」的访问审计（PRD O-3） |
| R-4 | 5000 行上限对极端活跃用户不够 | 如实标注截断；后续做「按时间分段加载」（PRD O-4） |
| R-5 | 回滚 | 新页面与新接口独立，删菜单项/路由即可下线；数据模型为增量列，回滚不需改数据 |


---

## 10. v2 改版实现（`phase: clklog-analytics-user-timeline-ux-v1`）

### 10.1 接口（在 v1 之上增量，不改既有字段）

| 方法 | 路径 | 变化 |
|---|---|---|
| `POST` | `/analysis/user-timeline/query` | 响应**新增 `overview`**：`{ daily: [{date, count}], events: [{event, count}] }`；其余字段不变（明细仍两段式） |
| `GET` | `/analysis/user-timeline/profile?value=` | **新增**：`{ attributes: Record<string,string>, tags: [{tag_id, name, value}] }`；按项目隔离，权限 `timeline.view` |

- **`overview` 用聚合查询单独取数（不读 properties）**：`toDate(log_time)` 分组的两条聚合与主体+区间同条件，
  成本远低于明细（明细要读 properties）——这正是「概览先行」成立的前提；明细超预算转后台时概览已返回。
- **`profile`**：用户属性取 `clklog_sa.sa_user_profiles`（`project_name` + `distinct_id`/`user_key` 命中，取 1 行）；
  标签取 `clklog_sa.sa_tag_members` 按 `uid` 取**最新批次**（`argMax(tag_value, batch_id)`），名称来自 MySQL `MetaUserTag`。

### 10.2 前端结构

```
查询条：主体 ▾ | 用户标识（支持多行 / 从分群带入） | 起~止 | 事件多选 | 排序 | 条数 | 查询 | 查询记录(抽屉)
┌ 左栏（画像，span 6） ─────────────┐ ┌ 右栏（行为，span 18） ───────────────────────┐
│ 用户卡：标识 + ◀ 上一个 / 下一个 ▶ │ │ 概览卡：每日趋势（折线）+ 事件占比（饼图）    │
│ 属性卡：用户属性（键值表）          │ │ 外显属性：多选（默认取事件元属性前几个）      │
│ 标签卡：标签名 + 最新值（可搜索）    │ │ 明细卡：事件表（时间/事件/ids/外显属性/展开） │
│ 汇总卡：命中/种类/首末时间          │ │ （转后台时此处显示等待提示，概览不受影响）    │
└────────────────────────────────┘ └──────────────────────────────────────────┘
```

- 图表用平台既有依赖 `echarts` + `echarts-for-react`（不引新库）；
- 外显属性：从每行 `properties` 解析出所选键；候选项 = 已出现过的属性键（按频次排序，取前 30）∪ 埋点元属性；
- 切换用户：标识输入支持多行/逗号；「从分群带入」调既有 `GET /meta/cohorts/:id/members` 取其 `distinct_id`（去重、最多 200）；
- 记录区：`Drawer` 内复用 v1 的记录表（状态列/查看/删除/自动刷新）；
- i18n：新增文案（面板标题、图表标题/图例、外显属性、切换用户、抽屉等）落 `analysis:userTimeline.*`，13 语言同步。

### 10.3 风险与回滚

| 编号 | 风险 | 处置 |
|---|---|---|
| R-1 | 概览多两次聚合扫描 | 只读 `log_time`/`event` 两列（不读 properties），实测对比后若明显拖慢则改为按需加载 |
| R-2 | 用户属性/标签查询失败 | 面板降级为空态（不影响行为数据），错误只提示不阻断 |
| R-3 | 回滚 | v2 只改前端布局 + 增量接口；后端接口新增字段/新路径，前端回滚即回到 v1 视图 |


---

## 11. 按业务属性查用户（`phase: clklog-analytics-user-timeline-ux-v1` 增量，2026-10-08）

### 11.1 问题（使用者原话）

> 「我作为使用者并不知道用户标识是什么……如果使用者只想用指定的用户属性如 `massid` 为 `YYZ000014552557` 进行查询，我们的平台做不到，你怎么解决这个问题」

现实：业务同学手里只有业务属性（`massid` / 手机号 / 账号 ID），平台的查询主键却是内部标识
（`distinct_id`，形如 `1_14552557`）。平台必须自己把两者翻译好，而不是要求使用者先记住内部 ID。

### 11.2 设计：**两段式解析**，禁止把属性条件 JOIN 到事件表

```
请求：id_kind=user_property, id_key=massid, value=YYZ000014552557
 ① 解析（只扫画像表，十万行级）
    SELECT distinct_id, user_key FROM clklog_sa.sa_user_profiles FINAL
    WHERE project_name = {project} AND JSONExtractString(properties, {id_key}) = {value}
    LIMIT 200
 ② 限定事件（与默认口径同形，不引入 JOIN）
    … FROM clklog_sa.sa_events WHERE project_name = {project}
      AND if(user_key != '', user_key, distinct_id) = {ident}   -- 单标识
      AND if(user_key != '', user_key, distinct_id) IN {idents}  -- 多标识
      AND log_time >= … AND stat_date BETWEEN …   -- 其余条件与 id_kind=subject 完全一致
```

契约（`POST /query`）：

| 字段 | 取值 | 语义 |
|---|---|---|
| `id_kind` | `subject`（默认）/ `user_property` / `event_property` | 标识口径 |
| `id_key` | 属性键（`id_kind` 非 subject 时必填） | 如 `massid` |
| `value` | 标识值或属性值 | 按所选口径解释 |

- `user_property` → 先解析；解析不到 → **400 `timeline.userNotFound`**（`analysis:error.timeline.userNotFound`，带 `{key,value}` 插值）；匹配多个 → 主体表达式 `IN` 数组（同一个人出现多份标识时合并展示）。
- `event_property` → 直接吃事实表 `properties`（无需解析、无需 JOIN）。
- 筛选 `filter_scope=user` 同样走解析；解析不到 → 条件恒假（`1 = 0`，**空结果而不是报错**，因为筛选「筛不到」是正常语义）。

**红线（用一次生产故障换来的）**：任何以「用户属性」为条件的查询都**不得**把
`JSONExtractString(sa_user_profiles.properties, …)` 作为 `sa_events` 的过滤条件（JOIN 形式也不行）。
实测（2026-10-08，版本 17668）：`LEFT JOIN sa_user_profiles + JSONExtractString(up.properties,'massid')` 的
2 小时查询让事实表失去全部剪枝能力，ClickHouse 预估 `95504511` 行 / `180.27` 秒，超过 120 秒上限 →
后台任务以 `query_failed` 直接失败（该用户区间内其实只有 1495 条事件）。两段式解析把这段成本压回
「画像表一次小扫描 + 原本就有的主体查询」。

### 11.3 画像与「已解析为」

`GET /profile` 增量接受 `id_kind` / `id_key`，并回报：

| 字段 | 语义 |
|---|---|
| `resolved` | `{ distinct_id, user_key }`——解析到的标识（页面据此显示「已解析为用户标识 1_14552557」） |
| `matched_users` | 匹配到的标识个数（0 = 属性键或值不对） |

标签查询口径随之变为 `uid IN {主体值…, 原始入参}`：既覆盖解析后的标识，也保留「没有画像行但有标签」的老行为。

### 11.4 前端

```
标识类型 ▾ 用户标识 / 用户属性  →  属性键 ▾（取自用户属性字典）  →  值输入
提示文案：
  用户标识 = 项目的用户 ID（user_key 优先，否则 distinct_id，形如 1_14552557）
  用户属性 = 按业务属性查：直接填属性值（如 massid 的 YYZ000014552557），无需知道内部 ID
查询后回带：`已解析为用户标识 1_14552557`（蓝色标签，紧贴提示文案右侧）
```

### 11.5 非目标与遗留

- **不做**「属性 → 标识」的反查列表页（输入属性键列出全部匹配用户）：先验证单人查询闭环，批量场景走用户分群。
- **不做**模糊/多值匹配（`LIKE`、`IN`）：属性值等值是唯一语义，避免误伤。
- 事件属性口径（`event_property`）同样无法用跳数索引剪枝（口径本身要求扫窗口内全部事件），
  实测未单独计时；与主体口径同为「超预算转后台」路径。
