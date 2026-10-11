# PRD：事件分析近似计算

> phase: clklog-analytics-approx-compute-v1
> 上游：`docs/project/legacy-production-handover.md` §11.2 对拍 OOM、`docs/architecture/clklog-analytics-design-approx-compute-v1.md`
> 下游：`docs/architecture/clklog-analytics-design-approx-compute-v1.md`

---

## 1. 阶段目标与范围

事件分析提供「近似计算」开关：对**去重类指标**用 ClickHouse `uniqCombined(12)` 换约 1% 误差，降低内存与耗时。默认关闭。勾选状态写入查询 DSL `approx`，随卡片保存，看板事件卡沿用。

只改事件分析。漏斗 / 留存当前是按用户物化后再 `count()`，换 uniq 函数降不了成本，本期不做。

## 2. 验收标准

- [ ] AC-1：事件分析计算按钮左侧「近似计算」可勾选；默认关。ⓘ 说明：用近似去重（误差约 1%）换更快速度与更低内存；次数、总和、均值、分位不受影响。
- [ ] AC-2：勾选后 SQL 中去重类指标使用 `uniqCombined(12)` / `uniqCombinedIf(12)`，不出现对应的 `uniqExact` / `uniqExactIf`。未勾选保持精确。
- [ ] AC-3：去重类覆盖：触发用户数、人均次数/人均值的分母、属性去重、列表去重、元素去重；阶段汇总 `uniq_total` 与查询同一套函数。次数 / 总和 / 均值 / 分位 / 布尔计数仍精确。
- [ ] AC-4：结果区在实时查询旁标注「近似」；导出/SQL 原文可见近似函数。未勾选无该标记。
- [ ] AC-5：`approx: true` 写入卡片 DSL；打开 `?card=` 还原勾选并按近似重算。旧卡片无该字段视为精确。
- [ ] AC-6：查询缓存不串味（近似与精确结果不互换）。
- [ ] AC-7：漏斗 / 留存开关保持禁用，tooltip 说明本期仅事件分析。对拍、自定义 SQL、SQL 报表不读 `approx`。
- [ ] AC-8：单测覆盖：`approx` 真/假切换函数；非法 `approx` 400。`python3 scripts/arch_ratchet.py` 通过。

## 3. 非目标

- 不改漏斗 / 留存 SQL 形状（不把 per-user `GROUP BY uid` 改成 HLL）。
- 不建预聚合表、不改 `sa_events` 的 `SAMPLE BY`。
- 不放开近似查询的 `max_memory_usage`；不提高线程数（分析查询已是 4 线程）。
- 不对拍链路改回 `uniqExact`（对拍已用 `uniqCombined(20)`，与本开关无关）。
- 不做看板卡上的现场改开关。

## 4. 体验

计算按钮左侧：`☐ 近似计算 ⓘ`。勾选只影响本次及之后保存的卡片。结果 Tag「近似」，tooltip 同 ⓘ。
