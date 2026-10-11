# 实现方案：`sa_events` 跳数索引（bloom filter on distinct_id / user_key）

> phase: `clklog-analytics-sa-events-skip-index-v1`
> 配对 PRD：`docs/product/prd-clklog-analytics-sa-events-skip-index-v1.md`
> 来源证据：`docs/project/test-report-debug-query-2026-10-08.md`（D3）+ `docs/project/acceptance-clklog-analytics-debug-query-v1.md`（§5 遗留）
> 状态：待评审（演练中）

**阶段目标**：让「无 `event`、7 天窗」的设备 / 账号维度查询能跳过绝大多数 granule，把 6–68s 压到秒级；
**非目标**：不改排序键/分区键/TTL、不动社区版、不引入异步任务队列、不改 Debug 页语义与 SQL。

---

## 1. 机制与 DDL

`sa_events` 排序键 `(event, stat_date, distinct_id, crc)`、分区键 `toYYYYMM(stat_date)`，且**当前没有任何跳数索引**
（`system.data_skipping_indices` 为空）。因此：

- `event = ?` 能吃到索引前缀（快）；
- `distinct_id = ?`（无 event）只能靠 `log_time` 过滤，`user_key = ?` 更是全无裁剪依据（实测读整表 亿级行）。

**选 bloom filter 的理由**：两个谓词都是**等值**、列基数量级 10⁶–10⁷、单个 granule（8192 行）内取值集合很小 ——
bloom 正是为「等值且能跳过大量块」设计的；minmax 对高基数列无效（每块 min/max 几乎覆盖全值域）。

```sql
-- 幂等：ADD INDEX IF NOT EXISTS；GRANULARITY 4 = 每 4 个 granule（32768 行）一个索引块
ALTER TABLE clklog_sa.sa_events
  ADD INDEX IF NOT EXISTS idx_debug_distinct_id distinct_id TYPE bloom_filter(0.01) GRANULARITY 4;
ALTER TABLE clklog_sa.sa_events
  ADD INDEX IF NOT EXISTS idx_debug_user_key user_key TYPE bloom_filter(0.01) GRANULARITY 4;

-- 历史 part 需要物化；CH 的 mutation 默认异步（立即返回，后台跑），新写入的 part 自带索引
ALTER TABLE clklog_sa.sa_events MATERIALIZE INDEX idx_debug_distinct_id, idx_debug_user_key;
```

- 误判率取 `0.01`（默认值）：index 体积与跳过率折中；GRANULARITY 4 是 CH 的常用折中（1 太小、8 以上收益递减）。
- **不加 `log_time` 索引**：`log_time` 的过滤靠时间下界已经够用，且它属于「范围」谓词，bloom 无效。

## 2. 落仓库（配置真相在仓库）

`apps/analytics-server/src/scripts/migrate-clickhouse.ts` 增加一步 `ensureSaEventsSkipIndexes(ch)`：

1. 查 `system.data_skipping_indices`（`database='clklog_sa' AND table='sa_events'`）判断是否已存在；
2. 缺则 `ADD INDEX IF NOT EXISTS`（瞬时元数据操作）；
3. **仅当本次新增时**触发 `MATERIALIZE INDEX`，**不等待**（升级脚本不能被十几分钟到数小时的物化阻塞）；把待物化 part 数打进日志；
4. 返回 `created | noop` 供 `main()` 打印。

`server-upgrade.sh` 已经调用该脚本（`[migrate] 完成：...`），因此**发版即自动对齐**，无需改运维脚本。
回滚：`ALTER TABLE clklog_sa.sa_events DROP INDEX idx_debug_distinct_id`（两枚同理），行为立即回到索引前。

## 3. 演练（`clklog_sa_staging`，先演练后生产 —— 红线 6）

- 建同构表：`CREATE TABLE clklog_sa_staging.sa_events AS clklog_sa.sa_events`（已核对：ENGINE / PARTITION BY / ORDER BY / TTL / `index_granularity=8192` 与生产一致）。
- 切片：**按事件前缀取 1 天**（`event IN (...)` 走索引前缀，读量小；这些事件正是被验证设备/账号上报过的），
  避免全表扫 —— 曾尝试按 `stat_date` 拷 3 天，因谓词无法裁剪（无跳数索引、minmax 只对分区键有用）
  而退化成全表读 + 服务器正被应用侧对拍/统计任务压满，改为有界切片。
- 对照测量（**同一份数据、同一条 SQL、只看加索引前后**），并给每条探针打注释标记以便在 `query_log` 里定位：
  1. `/* rehears-device */`：`distinct_id='样例标识'` + 7 天窗 + `stat_date` 下界（DebugService 现形状）；
  2. `/* rehears-account */`：同上但 `user_key='样例标识'`；
  3. `/* rehears-event */`：`event='base_ui_open_trigger'` + 7 天窗（回归对照，应无变化）；
- 记录 `read_rows` / `query_duration_ms` / 结果行数，并逐值核对结果一致（含 properties）。
- 回滚演练：`DROP INDEX` 后再跑一次，确认开销回到基线（IX-5）。

**核验方法本身**：探针 SQL 先在不加索引的切片上跑一次，确认能拿到读数（避免「跑了但没量到」）。

### 3.1 演练结果（staging，4 事件 × 1 天 = 千万级行）

| 探针 | 加索引前 | 加索引后 | 结论 |
|---|---|---|---|
| device（count） | 442,627 行 / 18ms | 20,720 行 / 7ms | 21× |
| account（count） | 千万级行 / 1102ms | 82,958 行 / 16ms | **279×** |
| event（回归对照） | 百万级 行 / 483ms | 百万级 行 / 208ms | 无回归 |
| full（Debug 真实形状，LIMIT 20） | — | 20,720 行 / 202ms | — |
| 索引体积 | — | 1.65 MiB / 2.20 GiB（0.07%） | 开销可忽略 |
| 物化耗时 | — | distinct_id 20s、user_key 3s | — |

幂等（重复 `ADD INDEX IF NOT EXISTS` 无副作用、索引数不变）与回滚（`DROP INDEX` 后账号维度读行数回到 千万级）均已实测。

> ⚠️ **方法学教训（本次真踩到，必须记住）**：切片为压低拷贝成本只取了 **4 个事件**，
> 而 `distinct_id` 的「目标 granule 数」是由 **事件数 × 天数** 决定的（排序键首列是 event）：
> 4 个事件 = 4 段、~300 个事件 = ~300 段。于是演练把设备维度的收益从生产的 ~1.6× 放大成了 21×。
> **用「索引前缀」把数据切小的同时，也把被测访问模式切没了** ——
> 涉及索引/裁剪效果的演练，切片必须保留**谓词列在排序键中的分布特征**（此处即事件数），否则结论不可外推。

### 3.2 生产实测（7 天窗、真实形状、开/关索引交替各 3 次取中位数）

| 维度 | 索引关 | 索引开 | 读行数（count 探针）关 → 开 |
|---|---|---|---|
| 设备 `distinct_id` | 5.80s | 5.08s | 千万级 → 千万级（1.6×） |
| 账号 `user_key` | 23.30s | **10.18s（2.3×）** | 亿级 → 百万级（**40×**） |
| `event=` 前缀回归（`base_ui_open_trigger`） | 2.1–3.5s | 2.0–2.5s | 读行数一致（75.23M vs 75.24M，索引对该查询不参与） |

- 物化：**56/56 part 全部带上索引**，12:04 下发 → 约 12:11 收尾（约 7 分钟，远快于预估）；
  索引体积 **540 MiB / 百 GiB 级 = 0.31%**。
- UI 实测（Debug 页，7 天 + 设备）：**8s 返回**（其中 CH 侧中位 5.1s），时间列正确，命中 18,489 条，留档按约定保留。

### 3.3 判定：保留索引，但本 phase 的目标**未完全达成**

| 判据 | 结果 |
|---|---|
| IX-1（≥10× 读行数） | **部分达成**：账号 40× ✅、设备 1.6× ❌ |
| IX-2（event 前缀无回归） | ✅ 读行数一致、耗时在噪声内 |
| IX-3（7 天设备 <5s） | **部分达成**：设备中位 5.08s（原 5.80s）、账号 23.3s → 10.2s；**60s 超时消失，但没进「秒级」** |
| IX-4 / IX-5 / IX-6 | ✅ 幂等 / 可回滚 / 结果逐值一致 |

**为什么没到秒级**：账号维度读行数降了 40×，但耗时只降 2.3× —— 剩下的时间花在**候选中选行上**：
bloom filter 的粒度是 granule（8192 行），账号在 7 天内命中 1.9 万行却要读 ~1000 个候选 granule 的 `properties`
（约 9 GB 解压量）。设备维度更明显：它横跨 ~300 个事件段，每段 1–2 个 granule，天然就要读上千个 granule，
所以 bloom filter 的边际收益很小（主键前缀已经把 `event` 维度做掉了）。

**下一步候选（不在本 phase 范围）**：① projection `ORDER BY (project_name, distinct_id, log_time)`
（能直接命中目标行，不走候选 granule）；② 重查询异步化（把 >N 秒的查询转后台任务 + 落档回看）。
本 phase 保留索引的理由：成本 0.31%、无回归、账号维度 2.3×、IO 压力显著下降（并发下更稳）。

## 4. 生产落地与验收

1. `ADD INDEX IF NOT EXISTS`（瞬时，无需停服；ingestor 持续写入不受影响）；
2. `MATERIALIZE INDEX`（后台 mutation）。**物化进度**：

```sql
SELECT count() AS parts,
       countIf(has(data_skipping_indices, 'idx_debug_distinct_id')) AS with_index
FROM system.parts WHERE database='clklog_sa' AND table='sa_events' AND active;
SELECT * FROM system.mutations WHERE table='sa_events' AND NOT is_done;
```

3. 验收判据用 PRD IX-1~IX-7；生产侧重点看：7 天窗 + 设备维度 <5s（IX-3）、账号维度不再 60s 超时、
   `event=` 前缀查询无回归（IX-2）。查询侧**不需要改任何代码** —— 跳数索引由 CH 自动选用。

> ⚠️ 记录一处操作教训（本次演练踩到）：**kill 掉本地 `curl` 不会取消服务端 CH 查询**。
> 一条 `length(properties) > 32768` 的探针在服务端继续跑了 21 分钟、读 亿级行，把 8 核机器 load 拉到 29。
> 探针要用 `KILL QUERY WHERE query LIKE '...'`（或带 `query_id`）显式收尾，并在 `system.processes` 里确认已消失。

## 5. 风险与回滚

| 编号 | 风险 | 处置 |
|---|---|---|
| R-1 | 物化在 亿级行 / 百 GiB 级 上耗时且抢 IO | mutation 异步；必要时按分区分批 `MATERIALIZE INDEX ... IN PARTITION`；避开应用侧对拍/统计任务窗口 |
| R-2 | bloom filter 的存储与内存开销 | 演练实测索引体积与表体积的比值；GRANULARITY 4 + `0.01` 是保守取值 |
| R-3 | 未物化完的 part 无收益 | 索引对新写入 part 立即生效；历史 part 逐步物化；验收记录标注完成率 |
| R-4 | 误判「一定更快」 | 一切以演练/生产前后对照数字为准；无收益即 `DROP INDEX` 并记录结论 |
| R-5 | DDL 与社区版混淆 | 只动 `clklog_sa.sa_events`（旁路库），不触碰 `clklog` 库（红线 1） |

## 6. 与 Debug 页的关系

Debug 页的窗口语义、SQL 与接口**都不动**：本次只是让 ClickHouse 有索引可用。索引生效后，
「7 天 + 设备/账号」不再需要靠缩小窗口兜底，PRD 里的成本提示文案保持原样（仍如实提示、不夸大）。
