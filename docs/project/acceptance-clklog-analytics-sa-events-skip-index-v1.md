# 验收记录：`sa_events` 跳数索引（bloom filter on distinct_id / user_key）

> phase: `clklog-analytics-sa-events-skip-index-v1`
> 验收日期：2026-10-08
> 对应 PRD：`docs/product/prd-clklog-analytics-sa-events-skip-index-v1.md`
> 对应实现方案：`docs/architecture/clklog-analytics-design-sa-events-skip-index-v1.md`
> 状态：**已落地到生产（`clklog_sa.sa_events`）**；目标部分达成，见 §4 判定

---

## 1. 变更

| 项 | 内容 |
|---|---|
| 生产 DDL（已执行） | `ALTER TABLE clklog_sa.sa_events ADD INDEX IF NOT EXISTS idx_debug_distinct_id distinct_id TYPE bloom_filter(0.01) GRANULARITY 4`；`idx_debug_user_key user_key` 同 |
| 物化 | 逐个 `MATERIALIZE INDEX`（**CH 23.2 一次只接受一个索引名**，写 `a, b` 会 SYNTAX_ERROR —— 演练先挖出来的坑，仓库代码已按此实现） |
| 落仓库 | `apps/analytics-server/src/scripts/migrate-clickhouse.ts` 新增幂等一步 `ensureSaEventsSkipIndexes()`（已存在即 noop；新增才触发物化且不等待）；`server-upgrade.sh` 已调用该脚本，无需改运维脚本 |
| 回滚 | `ALTER TABLE clklog_sa.sa_events DROP INDEX idx_debug_distinct_id`（两枚同理），已演练 |

## 2. 演练（`clklog_sa_staging`，4 事件 × 1 天 = 千万级行）

| 探针 | 加索引前 | 加索引后 | 倍数 |
|---|---|---|---|
| device（count） | 442,627 行 / 18ms | 20,720 行 / 7ms | 21× |
| account（count） | 千万级行 / 1102ms | 82,958 行 / 16ms | 279× |
| event（回归） | 百万级 行 / 483ms | 百万级 行 / 208ms | 无回归 |
| 索引体积 | — | 1.65 MiB / 2.20 GiB（0.07%） | — |

幂等（重复 ADD 无副作用）与回滚（DROP 后账号读行数回到 千万级）均实测通过。

> ⚠️ **方法学教训**：切片只取 4 个事件 → `distinct_id` 的目标 granule 数被大幅低估
> （排序键首列是 event：4 个事件 = 4 段，生产 ~300 个事件 = ~300 段），
> 于是演练把设备维度的收益从生产的 ~1.6× 放大成了 21×。**切片保留了数据却没保留访问模式。**

## 3. 生产实测（7 天窗、真实形状、开/关索引交替各 3 次取中位数）

| 维度 | 索引关 | 索引开 | 读行数（count 探针）关 → 开 |
|---|---|---|---|
| 设备 `distinct_id` | 5.80s | 5.08s | 千万级 → 千万级（1.6×） |
| 账号 `user_key` | 23.30s | **10.18s（2.3×）** | 亿级 → 百万级（40×） |
| `event=` 前缀（`base_ui_open_trigger`，回归） | 2.1–3.5s | 2.0–2.5s | 读行数一致（75.23M vs 75.24M） |

- 物化：**56/56 part 全部覆盖**，12:04 下发 → 约 12:11 收尾；索引体积 **540 MiB / 百 GiB 级 = 0.31%**。
- UI 实测（Debug 页，7 天 + 设备 `样例标识`）：**8s 返回**（CH 侧中位 5.1s），
  时间列 `2026/10/07 13:04:28` 正确，命中 18,489 条；**该条留档按要求保留**（`metadebugrecord` 1 条 / 20 行快照）。

## 4. 判定

| 判据 | 结果 | 说明 |
|---|---|---|
| IX-1 ≥10× 读行数 | **部分达成** | 账号 40× ✅；设备 1.6× ❌（原因见下） |
| IX-2 event 前缀无回归 | ✅ | 读行数一致、耗时在噪声内 |
| IX-3 7 天设备 <5s | **部分达成** | 设备中位 5.08s、账号 23.3s → 10.2s；**60s 超时消失，但未进「秒级」** |
| IX-4 幂等 | ✅ | 重复执行 no-op；`system.data_skipping_indices` 两枚 |
| IX-5 可回滚 | ✅ | 演练 DROP 后开销回基线 |
| IX-6 结果一致 | ✅ | 演练与生产探针结果逐值一致（device 2153 / account 2153 / event 百万级；生产 18,489） |
| IX-7 门禁 | ✅ | 后端 tsc + nest build；`arch_ratchet` / `i18n_check` / `i18n_scan --check` 持平（本 phase 无界面文案） |

**结论：保留索引**（成本 0.31%、无回归、账号维度 2.3×、IO 压力大降），
但**本 phase 的核心目标（7 天 + 设备/账号进秒级）没有达成** —— 瓶颈不在「能不能跳过 granule」，
而在「候选中选行」的量：bloom filter 的粒度是 8192 行，账号 7 天命中 1.9 万行却要读约 1000 个候选 granule 的
`properties`（约 9GB 解压量）；设备横跨 ~300 个事件段，天然要读上千个 granule。

## 5. 遗留（登记为下一步，不在本 phase）

1. **projection** `ORDER BY (project_name, distinct_id, log_time)`：让「按设备取最近 N 条」直接命中目标行，
   不再扫候选 granule（代价是额外存储与物化）；
2. **重查询异步化**：Debug 页把 >N 秒的查询转后台任务，结果落档后回看（与已有留档功能天然契合）；
3. Debug 页的窗口默认值（当前 24h）在索引生效后可再评估是否放宽——**本次实测显示 7 天仍是 5–10s，暂不放宽**。

## 6. 清理与运维教训

| 项 | 处置 |
|---|---|
| 演练副本 | `clklog_sa_staging.sa_events`（2.2 GiB）已 DROP；库保留给后续演练 |
| 临时 SQL / 临时 token | 服务器 /tmp 探针文件、验收用会话 token 均已删除 |
| 留档 | Debug 页实测产生的 1 条留档**按要求保留**（含 20 行快照） |
| 生产索引 | 两枚索引保留在生产 `clklog_sa.sa_events` 上 |

> ⚠️ **运维教训（本次踩到）**：**kill 掉本地 `curl` 不会取消服务端 ClickHouse 查询**。
> 一条 `length(properties) > 32768` 的探针在服务端继续跑了 21 分钟、读 亿级行，把 8 核机器 load 拉到 29，
> 连带把演练拷贝拖成龟速。探针收尾要用 `KILL QUERY WHERE query LIKE '...'`（或 `query_id`）并回查 `system.processes` 确认消失。
