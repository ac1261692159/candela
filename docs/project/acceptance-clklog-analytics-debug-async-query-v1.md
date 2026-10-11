# 验收记录：Debug 重查询异步化（两段式）

> phase: `clklog-analytics-debug-async-query-v1`
> 验收日期：2026-10-08
> 对应 PRD：`docs/product/prd-clklog-analytics-debug-async-query-v1.md`
> 对应实现方案：`docs/architecture/clklog-analytics-design-debug-async-query-v1.md`
> 状态：**已发版并在生产环境完成验收**（AS-1~AS-8 全部通过）
> 发版版本：首版 17652（`a807d8e` + `046f5f7`）；验收中发现并修复一处后用 17653（`f9799bc`）发版收口

---

## 1. 发版记录

| 版本 | 提交 | 内容 |
|---|---|---|
| 17652 | `a807d8e` | docs：PRD + 实现方案（两段式契约、状态机、worker 策略、回滚路径） |
| 17652 | `046f5f7` | 代码：两段式 `POST /query` + `DebugQueryWorker` + 迁移 `20261008150000_debug_query_async` + 前端握手/轮询/状态列 + 13 语言文案 |

- 就绪判据（按新符号）：模块里出现新文件 `server/dist/src/modules/meta/debug-query.worker.js`（4659B、`DebugQueryWorker` 命中 7 处）、新迁移文件 539B 含 `status` 列定义。
- 升级：`prisma migrate deploy` 应用迁移；`[migrate] 完成：noop`、`跳数索引：...noop`（幂等）；两进程重启正常。
- 落库核对：`metadebugrecord` 新增 `status`（默认 `done`）/`error_code`/`started_at`/`finished_at` 四列；既有留档记录被默认视为 `done`，语义不变。

## 2. 生产实测

| 编号 | 判据 | 实测 | 结论 |
|---|---|---|---|
| AS-1 | 快查询单次往返、无转后台提示 | `event=fish_open` 24h → **217ms** 单次返回 `{ items, matched_total:0, archived:true }`（该事件近 24h 无数据，命中 0 是对的） | ✅ |
| AS-2 | 慢查询 ≤6s 出提示、完成后自动渲染 | 7 天 + 设备：接口层 **5.4s** 返回 `{ status:'running', record_id }`；浏览器实测 **6s** 出现「查询较慢，已转后台执行（已等待 N 秒）」，后台完成后**就地渲染**「命中 15,486 条 · 已显示最近 20 条」+「本次结果已留档」，全程约 8s | ✅ |
| AS-3 | 状态流转 pending → running → done；失败带错误码 | `d25f2225`：`started_at`/`finished_at` 均有值、`duration_ms=7613`、`matched_total=15846`、`row_count=20`、`status=done`；`5790b09f`（AS-7 探针）为 `failed + error_code=timeout` | ✅ |
| AS-4 | 后台结果与同步结果逐值一致 | 同条件同窗口：后台落档的 20 行与 `GET /recent`（同步路径）**逐行完全一致**（`log_time｜event｜distinct_id｜user_key｜properties 长度` 序列相等，`matched_total` 均为 15846） | ✅ |
| AS-5 | 同条件连发只产生 1 条任务 | 立即重复提交同条件慢查询 → 返回**同一个** `record_id`（`d25f2225`，`reused` 语义生效） | ✅ |
| AS-6 | `background_workers=false` 的进程不执行任务 | server 日志：`Debug 异步查询 worker 已启动（间隔 1500ms，串行执行）`；ingestor 日志：`Debug 异步查询 worker 未启动（非 server 进程）` | ✅ |
| AS-7 | 卡死任务判超时，不永久占位 | 人为插入一条 `running` 且 `started_at` 为 15 分钟前的记录 → **6 秒内**被 worker 回收为 `failed(error_code=timeout)` 并写 `finished_at` | ✅ |
| AS-8 | 门禁 | 后端 `nest build` + **126 套件 / 976 用例**；前端 `tsc+vite build` + **115 文件 / 628 用例**；`arch_ratchet` passed；`i18n_check` 13 语言 × 16 命名空间 **3802 键**；`i18n_scan --check` 通过（基线 1424 → **1431**，+7 为 worker 的 7 行中文日志，按规程 `--force --update` 并在提交说明写明原因） | ✅ |

**观察（预算为近似值，如实记录）**：一次 7 天 + 设备查询在 **~5.5s** 内跑完、未被中断（CH 按周期检查执行时间，超一点点不必然被杀），因此走了同步路径；同一条件的另一次（账号维度）稳定超过预算并转后台。**接口与文案都不承诺精确秒数**。

## 3. 留档清单（按用户要求**全部保留**）

| id | 条件 | 状态 | 命中 / 行 | 耗时 | 用途 |
|---|---|---|---|---|---|
| `48f94061` | 7d / distinct_id | done | 18489 / 20 | 6821ms | 上一 phase（跳数索引）验收留下的记录 |
| `e9059076` | 24h / event=fish_open | done | 0 / 0 | 105ms | AS-1 快路径 |
| `d25f2225` | 7d / distinct_id | done | 15846 / 20 | 7613ms | AS-2/AS-3/AS-4/AS-5 后台任务 |
| `5790b09f` | 7d / event=zz_stale_probe | **failed(timeout)** | 0 / 0 | — | AS-7 卡死回收探针（保留为证据） |
| `0d251f33` | 7d / distinct_id | done | 15846 / 20 | 5085ms | 同步路径在预算内跑完的样本 |
| `494455b1` | 7d / distinct_id+user_key | done | 15486 / 20 | 9172ms | AS-2 浏览器实测（转后台后渲染） |

合计 6 条记录 / 80 行快照，全部留在 `metadebugrecord` 供回看。

## 4. 未覆盖 / 已知小缺口

| 项 | 状态 | 说明 |
|---|---|---|
| 后台任务并发（多用户同时） | 未实测 | 设计为串行（并发 1）；单用户顺序验证通过 |
| 轮询上限（2 分钟）到点后的提示 | 未实测 | 单测覆盖文案分支；生产未造出超过 2 分钟的任务 |
| 失败任务在 UI 的渲染 | 单测覆盖 | 生产列表里 `5790b09f` 显示「失败」并带原因（截图外的接口读取已确认 `error_code`） |
| 后台调度摘要的跳过清单 | 已知缺口（cosmetic） | ingestor 启动摘要的 `跳过=...` 未列出「Debug 异步查询」；worker 自身日志已如实说明（`未启动（非 server 进程）`）。补这行需再改 `configuration.ts` 并重发版，价值低，登记为后续 |
| 异步查询与留档开关的关系 | **验收中发现并已修（17653）** | 关掉留档时，超预算查询原本仍会建任务（任务本身就是一条留档）→ 与 PRD F2「关闭时不落档」矛盾。已改为：留档关闭时**不转后台**，如实返回超时错误（文案提示缩小时间范围）；单测「项目关闭留档时不转后台」覆盖（`debug.controller.spec.ts`）；该修复发版后以「部署产物哈希与模块一致」+ 单测佐证，**未再切换生产开关做行为复测**（避免反复改生产状态） |

## 5. 清理

| 项 | 处置 |
|---|---|
| 临时会话 token | 已从 `sausertoken` 删除（验收入口用，未用于任何写业务数据） |
| 留档 | **按用户要求全部保留**（见 §3） |
| 生产 DDL | 仅迁移新增四列（可空/带默认），无数据改写 |
| 演练/临时文件 | 服务器 `/tmp/zz_*` 已清 |
