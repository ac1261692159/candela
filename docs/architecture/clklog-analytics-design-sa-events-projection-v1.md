# 实现方案：`sa_events` projection（演练完成，因磁盘容量**暂不上线**）

> phase: `clklog-analytics-sa-events-projection-v1`
> 配对 PRD：`docs/product/prd-clklog-analytics-sa-events-projection-v1.md`
> 状态：**机制已验证、成本已实测、按容量结论暂不落地**（不是失败，是容量不允许）

---

## 1. 设计（若容量允许时的形态）

```sql
ALTER TABLE clklog_sa.sa_events
  ADD PROJECTION IF NOT EXISTS proj_debug_distinct (
    SELECT project_name, event, log_time, stat_date, distinct_id, user_key, properties
    ORDER BY (project_name, distinct_id, log_time)
  );
-- 账号维度需要**第二份**投影（一份投影只服务一种排序）：
ALTER TABLE clklog_sa.sa_events
  ADD PROJECTION IF NOT EXISTS proj_debug_user_key (... ORDER BY (project_name, user_key, log_time));
```

要点（均已演练验证）：

- **列必须覆盖查询引用的全部列**（少一列则 CH 直接不用这份投影）：Debug 查询用到
  `project_name / stat_date / distinct_id / user_key / log_time / event / properties` 共 7 列，故投影就放这 7 列；
- `ADD PROJECTION IF NOT EXISTS`（23.2 支持，实测重复执行无副作用）→ 幂等；
- 自查已存在的投影：`system.projection_parts`（按 name 聚合）
  或 `system.parts.projections`（`hasAny(projections, ['proj_x'])`）；23.2 **没有** `system.projections`；
- 物化：`MATERIALIZE PROJECTION <名字>`（同样**一次一个**），实测 327 万行 / 48 秒；
- 回滚：`ALTER TABLE ... DROP PROJECTION <名字>`；
- 查询侧不改一行代码（`optimize_use_projections` 默认开）。

## 2. 演练实测（staging，2 小时切片 = 327 万行、**319 个事件**）

> 切片这次刻意保留事件多样性（上一 phase 的教训：切片切掉了访问模式就失去意义）；
> 且**先确认探针非空**（该设备在切片内 2445 行）再比较 —— 上一轮曾因切片时段选错
> （设备最后上报在昨天，切片取了今天）而拿 0.1s 的空查询当结论，属于「核验方法本身没验」。

| 探针（Debug 真实形状，LIMIT 20） | 基础表（无投影） | 有投影 | 结论 |
|---|---|---|---|
| 设备 `distinct_id` | 1.4s / 读 **618,470** 行 | **0.11–0.20s / 读 32,213 行** | 读行数 **19×**、耗时 ~10× |
| 账号 `user_key` | 0.19–0.71s | **0.019–0.027s**（加第二份投影后） | 同样量级提升 |

- 读行数为什么是 32,213 而不是该设备的 2445 行：投影按 granule（8192 行）组织，
  命中 20 行仍需读 4 个 granule ≈ 32,768 行 —— 这已是「按人取最近」的理论下限 ✓。
- 账号维度加**第二份**投影后才快 → 印证 PRD R-2：一份投影只服务一种排序。

### 2.1 成本实测

| 项 | 实测 |
|---|---|
| 单份投影存储 | ≈ 基础数据的 **45%（合并后）～90%（新写入 part）** |
| 两份投影存储 | ≈ 基础数据的 **0.9×～1.8×** |
| 写入开销（同切片交替插入） | 单份 **+17%**；两份 **+43%** |
| 物化 | 327 万行 / 48 秒（生产 亿级行按此推算需数十分钟） |

## 3. 为什么**不上线**：磁盘容量不允许（硬约束）

| 事实 | 数值 |
|---|---|
| `/data` 总量 / 已用 / 可用 | 2.9T / 543G / **2.3T** |
| `clklog_sa.sa_events` 现占 | 百 GiB 级（近 3 个月：8 月 18.6 + 9 月 126.4 + 10 月 27.0） |
| 实测日增（9–10 月） | **4.04 GiB/天** |
| TTL | `stat_date + toIntervalMonth(18)` → 稳态 ≈ 4.04 × 548 ≈ **2.21 TB** |
| 其它占用 | `clklog` 社区库 47.6 GiB（且在增长）+ 系统/其它 ≈ 百 GiB 级 + 当前 百 GiB 级 |
| 结论 | 基础表按现有 TTL 的稳态已占满磁盘约 **89%**（2.21T + 0.37T ≈ 2.58T / 2.9T）：**只剩约 0.3TB 余量，装不下任何一份投影**（单份 +1.0TB、双份 +2.0TB） |

**据此本 phase 不动生产**（决策与依据一并留档；PRD 的 R-5「以对照为准、无收益不上」在这里表现为
「收益确凿但成本撞容量红线」）。

## 4. 若要继续，四条可选路线（需产品/运维决策）

| 路线 | 代价 | 效果 |
|---|---|---|
| ① 缩短 `sa_events` 保留期（如 18 → 6 个月） | 历史分析/看板可回看范围变短（需产品确认） | 基础表稳态 2.21T → 0.74T，双投影≈1.4T ✓ 装得下 |
| ② 扩盘（+1–2TB） | 成本/运维动作 | 直接解决；投影可上线，设备/账号都进 0.1–0.5s |
| ③ **重查询异步化**（无存储成本） | 需要异步任务与前端轮询（留档功能已具备「回看」载体） | 解决「等 5–10s」的体验：提交后后台跑，结果落档后回看 |
| ④ 窄投影 + 两步查询（投影只放 ids/log_time/crc，properties 从基础表按主键取） | 要改 Debug 查询与前端（两步）；投影体积降到 ~10–20% | 存储增量约 +0.2–0.4TB，仍在余量边缘 |

**建议**：先做 ③（零存储、与已有留档功能天然契合），把 ①（保留期）作为产品侧议题单独定；
②是纯预算决策；④工程量最大、收益不如②。

## 5. 运维附注：磁盘本身值得提前看

按实测日增 4.04 GiB/天推，`sa_events` 会在约 13 个月后触及 18 个月 TTL 的稳态 2.21TB；
叠加社区库与其它占用，**该盘在稳态下只剩约 0.3TB（≈11%）余量**。
若上报量继续增长，稳态会同步上升 —— 建议把「磁盘水位 + TTL」纳入常规巡检（数据管理页已有 TTL 工具）。
