# 实现方案：卡片生命周期与缓存刷新健壮性

- `phase: clklog-analytics-card-lifecycle-v1`
- 对应 PRD：`docs/product/prd-clklog-analytics-card-lifecycle-v1.md`
- 日期：2026-09-07
- 作用域：`apps/analytics-server/src/modules/report/`（卡片、看板、缓存温热）

---

## 1. 现状与根因

### 1.1 孤儿关联行（缺陷 A）

`schema.prisma:305-320` 中 `DashboardCard.card` 声明了 `onDelete: Cascade`，但：

1. `datasource db` 未设置 `relationMode = "prisma"`（`schema.prisma:5-6`），即 Prisma **不会**在应用层模拟级联；
2. 实际建表的迁移 SQL 未生成该外键（历史迁移中曾 DROP，见 `docs/project/legacy-production-handover.md` §11.0）；
3. 线上 `SHOW CREATE TABLE dashboardcard` 确认无任何外键。

因此级联**完全不生效**。`card.repository.ts:43-46` 的删除仅执行 `prisma.card.delete`，注释「关联行由 onDelete: Cascade 级联清理」是错误假设。

消费侧 `dashboard.repository.ts:59-83` 使用 `include: { card: { include: { cache: true } } }`。Prisma 将 `card` 视为**非空关联**，任一关联行在 `card` 表中缺失即抛：

```
PrismaClientUnknownRequestError:
Inconsistent query result: Field card is required to return data, got `null` instead.
```

→ 整个 `GET /sa/api/report/dashboards/:dbId` 返回 500。

同类风险点：

| 位置 | 说明 |
|---|---|
| `dashboard.repository.ts:66` `findDetail` | 高危，看板详情 500 |
| `dashboard.repository.ts:79` `findDetailByShareToken` | 高危，分享页 500 |
| `card.repository.ts:51-57` `findDashboardCards` | `include: { card: true }`，看板内卡片列表同风险 |

### 1.2 缓存刷新死循环（缺陷 B）

`card-cache.worker.ts:43-71`：

- `tick()` 每 `WORKER_INTERVAL_MS = 30_000` 执行一次；
- `shouldWorkerRefresh`（`card-cache.policy.ts:23-33`）判定依据仅为「类型是否为查询卡 + `cache.refreshed_at` 是否过期」；
- `refreshOne` 失败时**只写日志**（`:67-70`），不调用 `writeCache` → `refreshed_at` 永不更新 → 该卡片在每个 30 秒周期都被重新判定为需刷新。

结果：一张必然超时的卡片会以「每 30 秒一次 × 每次占用 30 秒超时窗口」的节奏反复发起查询，并与其它卡片争抢 `WORKER_CONCURRENCY = 2` 的并发槽。线上实测累计 22537 次 Timeout，波及 20+ 张卡片。

同时，失败不写缓存意味着前端拿到的 `cache.error` 始终为 `null`，用户看到空白而非失败原因。

---

## 2. 设计决策

### D1 级联清理放在仓储层，用事务保证原子性

`CardRepository.delete` 改为在事务内先 `dashboardCard.deleteMany({ where: { card_id } })` 再 `card.delete`。理由：

- 这是**唯一**删除卡片的落库点，`CardService.delete`（`card.service.ts:114-118`）与 `SqlReportService.remove`（`sql-report.service.ts:243-253`）两个入口都经由此处，单点修复即可覆盖全部入口，符合「单一写入方」；
- 不引入数据库外键，避免 DDL 变更风险（PRD 已列为范围外）；
- 事务保证「卡片与引用同时消失」，不会出现只删一半的中间态。

`cardcache` 有真实外键，仍由数据库级联，不在本事务内重复处理。

### D2 关联查询改为两次查询 + 内存装配，孤儿行忽略

`findDetail` / `findDetailByShareToken` / `findDashboardCards` 不再用 `include: { card: ... }`，改为：

1. 查 `dashboardCard`（含布局与排序）；
2. 用 `card_id in (...)` 批量查 `card` + `cache`；
3. 内存装配，仅保留 `card` 存在的关联行。

理由：Prisma 的 `include` 无法对非空关联做缺失过滤，而 `where: { card: { isNot: null } }` 在此关系上不可靠（关系本身非空，过滤条件恒真）。两次查询语义明确、可控，且天然忽略孤儿。

为控制改动面，三处共用同一装配逻辑，返回结构保持与现有 `include` 结果一致，上层 `DashboardService.toDetail` / `CardService.listByDashboard` 无需改动。

### D3 失败状态持久化 + 指数退避

`refreshOne` 捕获失败后：

1. 调用 `writeCache(card_id, 上次成功结果或 null, 错误消息)`，写入 `error` 并更新 `refreshed_at`；
   - 使失败对前端可见（`cache.error` 已有字段，前端无需改动）；
   - 使该卡片不再被 30 秒周期反复判定为需刷新，退化为按 TTL 重试。
2. 在 worker 内维护 `Map<card_id, { fails, nextAttemptAt }>` 记忆连续失败次数，按 `min(base * 2^(fails-1), max)` 计算下次尝试时间，未到时间则跳过。

退避参数（集中在 `card-cache.policy.ts`）：

```
WORKER_FAIL_BACKOFF_BASE_MS   = 5 * 60_000   // 首次失败后 5 分钟
WORKER_FAIL_BACKOFF_MAX_MS    = 30 * 60_000  // 上限 30 分钟
```

成功刷新后清除该卡片的失败记忆。

理由： TTL 退避（D3.1）解决「每 30 秒重试」；指数退避（D3.2）进一步避免持续失败的慢卡片长期霸占有限的并发槽，把槽位让给可成功的卡片。退避状态只存在于 worker 进程内存，进程重启后退避重置——可接受，因为此时持久化层已有 TTL 兜底。

### D4 不调整超时与资源限额

`max_execution_time`(30s)、`max_rows_to_read`(6 亿) 等限额属红线 4 约束，本次不改动。慢查询本身的性能优化另立任务。

---

## 3. 影响面

| 改动 | 文件 |
|---|---|
| 删除卡片级联清理 | `card.repository.ts` |
| 关联查询容错（3 处） | `dashboard.repository.ts`、`card.repository.ts` |
| 失败写缓存 + 退避 | `card-cache.worker.ts`、`card-cache.policy.ts` |

Prisma schema、数据库结构、API 契约、前端组件均不变。

## 4. 风险与回滚

- **风险**：`findDetail` 改为两次查询后，若 `dashboard_cards` 为空，`card_id in ([])` 需短路返回空数组，否则 Prisma 可能生成非法 `IN ()`。实现中显式处理空数组。
- **风险**：失败写缓存会覆盖 `result_json`。为保留上一次可用结果，`writeCache` 在失败分支传入既有 `result_json`；若无历史结果则写入 `null`。需确认 `upsertCache` 的 `update` 分支会写入传入值（当前实现是），失败时前端展示「刷新失败」而非旧数据。
- **回滚**：改动均为应用层，回滚即重新发布上一版本；无数据库结构变更，无需迁移回滚。

## 5. 验收（对应 PRD AC1-AC7）

| 验收 | 实现落点 |
|---|---|
| AC1 / AC2 | `CardRepository.delete` 事务级联；单测覆盖多看板引用场景 |
| AC3 / AC4 | `findDetail` / `findDetailByShareToken` 忽略孤儿；单测构造孤儿行验证 |
| AC5 | `refreshOne` 失败分支调用 `writeCache(..., error)`；单测断言 `error` 与 `refreshed_at` |
| AC6 | 退避策略纯函数 `nextRetryAt(fails)`；单测断言退避序列与上限 |
| AC7 | 交付前运行 `python3 scripts/arch_ratchet.py` |

## 6. 非目标（与 PRD 一致）

不优化查询性能、不调整 ClickHouse 限额、不补建外键、不做历史孤儿定时清理、不改变前后端功能边界与交互。
