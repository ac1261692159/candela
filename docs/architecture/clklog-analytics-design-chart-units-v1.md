# 实现方案：分析图 Y 轴单位 / SQL 缓存回填 / 纯色与图例独立显示

> phase: clklog-analytics-chart-units-v1
> 帽子：架构（`docs/architecture/`）
> 上游：`docs/product/prd-clklog-analytics-chart-units-v1.md`

---

## 1. 阶段目标与范围

对应 PRD 四项。不改社区版表、不改 Kafka/Flink、不新增 Prisma 列。单位白名单写入 `chart_config.options.units` 与事件/留存 `_view.y_unit`。

## 2. 验收标准

- [ ] **ARCH-U-1**：`MetricUnit` 白名单含 `number | percent_0_100 | ratio_0_1 | currency | currency_cny | currency_usd | duration_sec | duration_ms | bytes | bytes_iec`。前后端 validator 同一份枚举。未知 id 拒绝保存。
- [ ] **ARCH-U-2**：`formatChartNumber` 按 PRD 表换算；单测锁定 万/亿、秒→分钟、0–1→%、¥/$. Y 轴 `axisLabel.formatter` 与 tooltip 复用该函数。
- [ ] **ARCH-U-3**：`GET /report/cards/:id` 附带 `cache`（与看板卡片同形）。事件 / 漏斗 / 留存 / SQL 页打开时把 `cache.result` 填进结果区且不自动重查；无缓存再现场查询。SQL 无行但有 `chart_config` 时用角色列做占位结果。SQL 展示/图形/字段放在顶部 `AnalysisResultSettings` 齿轮。
- [ ] **ARCH-U-4**：`aria.decal.show = false`。实测 `lineStyle.type = 'solid'`，不按系列轮换 dashed/dotted。预测保持 dashed。
- [ ] **ARCH-U-5**：`nextLegendIsolate`：未独立时点击 → 只开该名；已独立同一名再点 → 全开。ECharts `legendselectchanged` 用该函数覆盖默认 toggle-hide。
- [ ] **ARCH-U-6**：`python3 scripts/arch_ratchet.py` 通过；不向 `shared/` / `utils` 加生产文件。

## 3. 非目标

与 PRD §4 相同。禁止伪模块包。不把单位格式化函数放到 `src/utils`。

## 4. 契约

### 4.1 单位 id

沿用已有 `options.units: Record<column, MetricUnit>`。新增 id 只加白名单，旧卡 `currency` 格式化为人民币。事件/留存图没有按列 units，用 `_view.y_unit`（缺省 `number`；留存比率图缺省 `ratio_0_1`，因现网 `model.percent === true`）。

### 4.2 卡片缓存

`CardCache.result_json` 已存执行结果。`getCard` 解析为：

```
cache: { result, error, row_count, refreshed_at, stale } | null
```

前端按卡片类型认结果：

- SQL：`result.columns[].name` + `result.rows` → `SqlExecuteResult`
- 事件 / 留存：`result.columns[].key` + `result.rows` → `QueryResult`
- 漏斗：同上，外加可选 `steps[]`

体积截断的 `{ reason: 'cache_too_large' }` 不当作可绘图缓存，打开后走现场查询。

### 4.3 图例独立显示

纯函数，不读 ECharts 默认 selected：

1. 当前独立名 === 点击名 → 所有系列 `true`，独立名清空
2. 否则 → 仅点击名为 `true`，独立名 = 点击名

用 `setOption({ legend: { selected } })` 盖掉 ECharts 先执行的 hide。`setOption` 触发的二次事件用锁丢掉。

### 4.4 文件

| 路径 | 职责 |
|------|------|
| `features/visualization/metric-units.ts` | 白名单、换算、轴/tooltip |
| `features/explore-charts/legend-isolate.ts` | 图例独立显示 |
| `features/report/sql-cache-result.ts` | 缓存 JSON → SQL 结果 / 占位列 |
| `features/query/analysis-cache-result.ts` | 缓存 JSON → 事件 / 漏斗 / 留存结果 |
| `chart.types.ts` / `chart-config.ts` / `chart-config.validator.ts` | 枚举 |
| `FieldBindingPanel.tsx` / `EventViewSettings.tsx` / `SqlViewSettings.tsx` | 单位与 SQL 展示 UI |
| `SqlReportPage.tsx` / `card.service.ts` | 回填缓存 |
| `adapters/shared.ts` / `line|bar|trend.adapter.ts` / `explore-chart-option.ts` | 纯色、轴格式、图例事件 |
| `ExploreChart.tsx` / `ChartWorkbench.tsx` | 挂载 isolate |

## 5. 迁移

无 DDL。已存 `units.currency` 继续合法。新 id 仅新保存写入。
