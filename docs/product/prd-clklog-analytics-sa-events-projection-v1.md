# PRD：`sa_events` projection——把 7 天设备/账号查询压进秒级

> phase: `clklog-analytics-sa-events-projection-v1`
> 状态：待评审（演练中）
> 来源：`docs/project/acceptance-clklog-analytics-sa-events-skip-index-v1.md` §4/§5（跳数索引只兑现了账号维度 2.3×，未达秒级）
> 前置 phase：`clklog-analytics-debug-query-v1`（窗口 + `stat_date` 裁剪）、`clklog-analytics-sa-events-skip-index-v1`（bloom 索引，已上生产）

---

## 1. 背景与问题

跳数索引上线后的**实测瓶颈已定位**（见验收记录 §4）：bloom filter 的粒度是 granule（8192 行），
「按设备/账号取最近 N 条」仍要读**候选 granule 里的 `properties`**：

- 账号 `user_key` 7 天窗：命中 1.9 万行 → 读 894 万行 / 约 9GB 解压量 → **10.2s**；
- 设备 `distinct_id` 7 天窗：横跨约 300 个事件段（排序键首列是 event）→ 读 1849 万行 → **5.1s**。

根因是**表按 (event, stat_date, …) 排序**：任何「不带 event」的用户维度查询都拿不到「按人取最近」的有序性。
**projection 正是为这种「同一份数据的第二种排序」提供的机制**（相比建第二张表 + 物化视图，它由表自身维护、不侵入写入链路）。

## 2. 阶段目标与范围

**做**：

1. 在 `clklog_sa.sa_events` 上增加面向「按人取最近」的 projection（`ORDER BY (project_name, distinct_id, log_time)`）；
2. **先演练量清三件事**：查询收益、存储增量、写入开销（不接受「没量就上」）；
3. 幂等落仓库（`migrate-clickhouse.ts` 一步）并上生产；查询侧不改 SQL（CH 自动选用 projection）。

**不做（非目标）**：

- 不改排序键/分区键/TTL、不动社区版（红线 1/2）；
- 不做异步查询任务队列（本 phase 先靠 projection 解决；异步作为「查询本身超长」的兜底，另立 phase）；
- 不为 `user_key` 再建一份**同规模**的投影副本 —— 是否值得看演练数据再定（见 §5 R-2）；
- 不改变 Debug 页的窗口语义、接口契约与文案。

## 3. 需求

- **P1**：7 天窗 + 设备维度（`distinct_id`，无 event）端到端 **<2s**（当前 5.1s）；
- **P2**：7 天窗 + 账号维度（`user_key`）若无法用同一 projection 受益，则如实标注并给出下一步（不要假装它变快了）；
- **P3**：`event=` 前缀类查询（事件分析/埋点管理主路径）**无回归**；
- **P4**：写入链路不被打垮 —— 单条 INSERT 的额外开销有实测数字，且不超过约定阈值（见 §5 R-3）；
- **P5**：projection 可单独回滚（`DROP PROJECTION`），不影响基础表数据与既有索引。

## 4. 验收标准

| 编号 | 判据 |
|---|---|
| PJ-1 | 演练（同数据、同查询、带/不带 projection 对照）：设备维度读行数与耗时下降 ≥10×；结果逐值一致 |
| PJ-2 | 演练：存储增量实测并记录（投影列数固定为查询所需列）；写入开销实测并记录（同切片拷入「有投影/无投影」两张表的耗时差） |
| PJ-3 | 生产：7 天窗 + 设备查询 <2s（P1）；给出账号维度的真实数字与结论 |
| PJ-4 | 幂等：重复执行迁移为 no-op；`system.parts.projections` 可查投影存在；无失败 mutation 残留 |
| PJ-5 | 回滚演练：`DROP PROJECTION` 后查询回到基线开销 |
| PJ-6 | `event=` 前缀查询无回归（读行数/耗时） |
| PJ-7 | 门禁全绿；本 phase 若无界面文案新增，i18n 计数持平 |

## 5. 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| R-1 | projection 需覆盖查询引用的全部列（少一列则 CH 不用它），因此体积接近「这些列的一份全量副本」 | 只放 Debug 查询真正用到的 7 列；实测体积占比后决策 |
| R-2 | 一个 projection 只服务一种排序：`user_key` 维度用不上 | 演练实测「账号维度是否受益」；若不受益则**如实记录**，不为其再复制一份全量（除非数据支持） |
| R-3 | 写入放大：每行多写一份（含 `properties`） | 实测同切片插入耗时差；阈值：额外开销 ≤50% 才接受 |
| R-4 | 生产物化 171GiB 的 IO 冲击 | 后台 mutation、可观进度；必要时按分区 `MATERIALIZE PROJECTION ... IN PARTITION` |
| R-5 | 误判「投影一定更快」 | 以演练/生产前后对照为准；无收益则 DROP 并记录结论 |
