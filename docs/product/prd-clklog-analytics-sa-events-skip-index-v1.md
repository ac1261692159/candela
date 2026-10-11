# PRD：`sa_events` 跳数索引——让设备 / 账号维度的 Debug 查询进秒级

> phase: `clklog-analytics-sa-events-skip-index-v1`
> 状态：待评审
> 来源：`docs/project/test-report-debug-query-2026-10-08.md` D3 与 `docs/project/acceptance-clklog-analytics-debug-query-v1.md` §5 遗留项
> 前置 phase：`clklog-analytics-debug-query-v1`（已发版，窗口三档 + `stat_date` 裁剪已把 7 天窗读行数从 千万级行降到 千万级行）

---

## 1. 背景

Debug 实时查询的「按设备 / 账号查最近 N 小时」是排障与接入验证最自然的入口，但 `sa_events` 的排序键是
`(event, stat_date, distinct_id, crc)`、分区键是 `toYYYYMM(stat_date)`：

- 给了 `event` 时能吃到索引前缀（实测 0.1–0.7s）；
- **不给 `event`** 时，`distinct_id` 只能靠 `log_time` 的 minmax 跳过部分 granule，`user_key` 更是完全没有可裁剪依据
  ——前者读 千万级行、后者**读整表 亿级行**，7 天窗下分别要 6–48s 与 68.6s（后者直接撞穿前端 60s 超时）。

已上线的缓解是「窗口三档（默认 24h）+ `stat_date` 下界」，把常见场景压到 2–3 秒；但用户一旦要看满 7 天，
设备维度仍是十几秒量级，账号维度仍可能超时。**根因是「非排序键前缀列没有可用的跳数索引」。**

## 2. 阶段目标与范围

**做**：

1. 给 `clklog_sa.sa_events` 增加 `distinct_id` 与 `user_key` 的跳数索引（bloom filter），并在测试库演练通过后落到生产；
2. DDL 写回仓库（`apps/analytics-server/src/scripts/migrate-clickhouse.ts` 幂等一步），保证「配置真相在仓库」；
3. 用与线上一致的查询形状做**前后对照实测**（读行数 / 耗时 / 结果一致性 / 对 `event` 前缀查询无回归）。

**不做（非目标）**：

- 不动社区版 `clklog` 库与任何官方表（红线 1）；
- 不改 `sa_events` 的排序键 / 分区键 / TTL / 写入链路（红线 2；换排序键要重建表，收益不确定且风险大）；
- 不做异步查询任务队列（若索引把设备/账号维度压到秒级，Debug 页不再需要它；仍超时的极端场景另立 phase）；
- 不引入新的查询入口或改变 Debug 页的窗口语义。

## 3. 需求

- **R1**：`distinct_id` 与 `user_key` 的等值过滤在「无 `event`、7 天窗」下可跳过绝大多数 granule；
- **R2**：对已有 `event=...` 前缀查询无性能回归（读行数不增加、耗时不变差）；
- **R3**：DDL 幂等、可回滚（`DROP INDEX`）、不阻塞发版（物化在后台跑，不在升级脚本里同步等）；
- **R4**：索引建立期间与之后，写入链路（ingestor）与 Debug 查询结果**不发生变化**（结果集与索引前逐值一致）。

## 4. 验收标准

| 编号 | 判据 |
|---|---|
| IX-1 | 测试库演练：同数据同查询，加索引后设备维度读行数下降 ≥10×、账号维度下降 ≥10×；结果行数与内容与加索引前**逐值一致** |
| IX-2 | `event=` 前缀查询（如 `fish_open`）加索引前后读行数/耗时无回归（读行数增幅 ≤10%） |
| IX-3 | 生产：7 天窗 + 设备维度（无 event）在生产实测 **<5s**；账号维度不再撞 60s 前端超时 |
| IX-4 | DDL 幂等：重复执行迁移为 no-op；`system.data_skipping_indices` 可见两枚索引；`system.mutations` 无失败残留 |
| IX-5 | 回滚路径可用：`ALTER TABLE ... DROP INDEX` 后查询行为回到索引前（在测试库验证） |
| IX-6 | 结果一致性：抽查若干设备/账号，索引前后 Debug 结果逐行一致（含时间列与 properties） |
| IX-7 | 门禁：`arch_ratchet` / `i18n_check` / `i18n_scan --check` / 后端 958+ / 前端 622+ 全绿（本 phase 若无界面文案新增则 i18n 计数持平） |

## 5. 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| R-1 | `MATERIALIZE INDEX` 在 亿级行 / 百 GiB 级 上耗时长、占用 IO | 迁移脚本只 `ADD INDEX`（瞬时元数据）并触发物化，**不等待**；物化进度看 `system.mutations`；必要时分批（按分区）物化 |
| R-2 | bloom filter 对高基数 String 的内存/存储开销 | 用 `bloom_filter(0.01) GRANULARITY 4`；演练实测索引体积并与表体量对比 |
| R-3 | 索引未物化完时收益不完整 | 在验收记录中如实标注「新写入的 part 自带索引、历史 part 逐步物化」；给出物化完成率查法 |
| R-4 | 误判「索引一定更快」 | 一切以演练与生产的前后对照为准；无收益则回滚 `DROP INDEX` 并记录结论 |
