# 实现方案：Debug 重查询异步化（两段式 + 后台执行 + 同一条留档）

> phase: `clklog-analytics-debug-async-query-v1`
> 配对 PRD：`docs/product/prd-clklog-analytics-debug-async-query-v1.md`
> 状态：实施中

**目标**：快查询保持单次往返秒回；超预算的查询转后台执行、结果写入同一条留档、前端轮询后就地渲染。
**非目标**：不扩盘/不缩短保留期/不建 projection；不改 `GET /recent`；不做分布式队列。

---

## 1. 接口契约（**变更点**）

| 方法 | 路径 | 变化 |
|---|---|---|
| `POST` | `/sa/api/meta/debug/query` | **两段式**：快路径返回 `{ items, matched_total, window, limit, archived, record_id?, truncated? }`（与现状一致）；超预算返回 `{ status: 'running', record_id, window, limit }`（无 `items`） |
| `GET` | `/sa/api/meta/debug/records/:id` | 行上新增 `status / error_code / started_at / finished_at`；前端据此轮询 |
| `GET` | `/sa/api/meta/debug/records` | 列表项新增 `status / error_code`（历史列表显示状态） |
| `GET` | `/sa/api/meta/debug/recent` | **不变**（外部/AI 调用方仍走同步查询，最长 300s） |

判定「超预算」用 ClickHouse 的 `max_execution_time`：同步尝试带 `max_execution_time = DEBUG_SYNC_BUDGET_S`（默认 5s），
捕获 CH 超时错误码（`159 TIMEOUT_EXCEEDED` / `160`）即转入后台，其余错误仍按 500 返回。
⚠️ 这是**近似预算**：CH 按周期检查执行时间，实际可能略超（文档与文案都不承诺精确秒数）。

## 2. 状态机与数据模型（复用 `metadebugrecord`）

```
pending ──(worker 认领)──> running ──成功──> done
                              └──失败/超时──> failed（error_code）
```

新增列（迁移 `20261008150000_debug_query_async`，全部可空/带默认，历史行视为 `done`）：

| 列 | 说明 |
|---|---|
| `status` | `pending / running / done / failed`，默认 `done`（历史数据不回填语义） |
| `error_code` | `timeout` / `query_failed` / `worker_stopped`（前端按语言渲染） |
| `started_at` / `finished_at` | 排队与执行时长可观测 |

`pending`/`running` 行的 `matched_total`、`row_count` 保持 0，行快照为空 —— 前端不把它当结果渲染。

## 3. 后台执行（`DebugQueryWorker`）

照既有后台任务范式（`CardCacheWorker` / `MetaStatsRefreshJob`）：

- **门禁**：`onModuleInit` 里 `if (!appConfig.background_workers) return;`（ingestor 与本地进程不跑，避免双跑）；
- **节奏**：`setInterval(tick, DEBUG_WORKER_INTERVAL_MS = 1500)`，`timer.unref()`；`running` 标志防重入；`onModuleDestroy`/`onApplicationShutdown` 清表；
- **认领（原子）**：`UPDATE metadebugrecord SET status='running', started_at=now WHERE id=<候选> AND status='pending'`，
  以影响行数 1 为认领成功（Prisma `updateMany` 返回 count）；
- **并发**：每 tick 串行跑 **1** 个任务（`DEBUG_WORKER_CONCURRENCY = 1`），保护 ClickHouse；
- **执行**：用记录里的条件重建查询，`now = record.created_at`（**窗口以用户提交时刻为准**，不因排队漂移），
  预算 `DEBUG_JOB_BUDGET_S = 120`；
- **落结果**：成功 → 复用留档的快照写入逻辑（同一套截断上限）→ `status='done', matched_total, row_count, truncated, duration_ms, finished_at`；
- **失败**：`status='failed', error_code`（CH 超时 → `timeout`，其它 → `query_failed`），细节进服务端日志；
- **超时回收**：tick 开始时把 `running` 且 `started_at < now - DEBUG_JOB_STALE_MS(10min)` 的任务判为 `failed(timeout)`，
  并写 `finished_at`（防卡死占位）；
- **去重**：`POST /query` 转后台前先查「同项目 + 同条件 + 同窗口 + status in (pending, running)」的记录，命中则直接返回它（AS-5）。

## 4. 前端

- `services/meta.service.ts`：`debugQuery` 返回类型改为联合（带 `status?: 'running'`）；
- `DebugQuery.tsx`：
  1. 收到 `status==='running'` → 显示「查询较慢，已转后台执行；完成后可在下方历史记录查看」，并**开始轮询**该记录（2s 一次，上限 2 分钟）；
  2. 轮询到 `done` → 就地渲染 `items`（与同步路径同一表格与口径）并显示留档提示；`failed` → 显示按语言渲染的错误；
  3. 同步路径逻辑不变（AS-1 不回归）；
- `DebugHistory.tsx`：新增状态列（运行中 / 完成 / 失败+原因）；列表在存在 `pending/running` 行时每 5s 自动刷新一次，全部完成即停；
- i18n：新增键落 `meta:debug.*`（`handoff / polling / statusRunning / statusDone / statusFailed / errorTimeout / errorQueryFailed` 等），**13 语言同步补齐**。

## 5. 契约与文档同步

- PRD §3.5 的「失败（超时/报错）不留档」**改为**「失败留痕」：失败任务保留记录并标 `failed + error_code`
  （可追溯性更强；不留结果行）。本 phase 的 PRD/设计与验收记录同步写明。
- `docs/architecture/` 的接口契约表登记 `POST /query` 的两种返回形态与 `status` 字段。
- i18n 术语表：不新增术语，沿用既有命名空间。

## 6. 验收与验证（对应 PRD AS-1~AS-8）

1. 单测：worker 认领/成功/失败/超时回收/去重、controller 的两段式分支（快→同步、CH 超时→建任务）、
   快照写入复用（截断不变）；
2. 前端用例：`status==='running'` 的握手文案与轮询、`done` 后就地渲染、`failed` 的错误渲染、历史状态列与自动刷新；
3. 生产实测：AS-1（快查询单请求）、AS-2（慢查询 ≤6s 出提示且完成后就地渲染）、AS-3（状态流转）、
   AS-4（后台结果与同步结果逐值一致）、AS-5（连点去重）、AS-7（超时回收，可用人为置 stale 验证）、
   AS-6（ingestor 进程日志无任务执行）；
4. 发版与核对按既有流程；**留档按用户要求保留**。

## 7. 风险与回滚

| 编号 | 风险 | 处置 |
|---|---|---|
| R-1 | worker 停摆 → 任务永远 pending | tick 的重启即恢复；`background_workers` 关闭时前端仍能看到 pending 行（文案说明），并由超时回收兜底 |
| R-2 | 同步尝试的 5s 白跑 | 可接受（CH 侧被超时中断，不继续消耗）；预算可配 |
| R-3 | 轮询与后台任务放大 CH 负载 | 串行 + 去重 + 列表条件轮询 |
| R-4 | 回滚 | 前端对 `status==='running'` 无感知即旧行为；后端可通过把 `DEBUG_SYNC_BUDGET_S` 调到 300 退化为「全同步」；迁移列可空、无需回滚数据 |
