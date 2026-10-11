# 实现方案：探索图扩展 + 公式窄栏 + 核心数据拆卡

> phase: clklog-analytics-explore-charts-v1
> 帽子：架构（`docs/architecture/`）
> 上游：`docs/product/prd-clklog-analytics-explore-charts-v1.md`

---

## 1. 阶段目标与范围

事件/留存结果区扩展图形与 Grafana 风格显示值；公式编辑器改为纵向槽；卡片 `chart_type` 增加新枚举字符串。新渲染落在 `apps/analytics-web/src/features/explore-charts/`，不向已接近上限的 `features/query/` 再堆生产文件，不把堆叠/累计/分布塞进 SQL `ChartTypeV1`（SQL 只加 `stat_calcs`）。

查询 DSL、ClickHouse SQL、指标上限 10 不变。

## 2. 验收标准

- [ ] **ARCH-EC-1**：`explore-charts/` 含纯函数 `series-stats`、`explore-chart-option`、组件 `ExploreChart` / `StatCalcsPicker`；无 `process.env`。
- [ ] **ARCH-EC-2**：`EventChartType` 增加 `trend|stack|cumulative|distribution|pie`；未知值回退 `line`。
- [ ] **ARCH-EC-3**：留存 `_view` 为 `retention_layout` + `retention_chart=nth_trend`；旧 `layout=trend` 与 `chart_type=trend|line|daily_trend` 规范化为第 N 日趋势。
- [ ] **ARCH-EC-4**：`ChartOptions.stat_calcs` 为 `last|avg|max|min|first|total` 数组，最长 6、去重；前后端白名单一致，未知键拒绝。
- [ ] **ARCH-EC-5**：看板 `CardWidget` 事件卡与留存卡走 `ExploreChart`；留存只用 `nth_trend`。
- [ ] **ARCH-EC-6**：`python3 scripts/arch_ratchet.py` 通过；`explore-charts` 生产文件 ≤30。
- [ ] **ARCH-EC-7**：事件 SQL 有 `scope=time` 分组时 `ORDER BY g_* ASC`；无时间分组仍按第一指标 DESC。
- [ ] **ARCH-EC-8**：`CreateCardDto.chart_type` 含 `stack|cumulative|distribution|nth_trend|daily_trend`。
- [ ] **ARCH-EC-9**：留存 `first_day` 同时匹配系统列 `is_first_day=1` 与 `properties.$is_first_day`。
- [ ] **ARCH-EC-10**：`shapeResult` 将未到期窗口写成 null；缓存键含 `_shape: ret-null-v1`。
- [ ] **ARCH-EC-11**：第 N 日趋势用 `ExploreChart`，不用 SQL `ChartWorkbench`。

## 3. 非目标

- 不扩展 SQL `ChartTypeV1`（无 stack/cumulative/distribution）。
- 不新增 Prisma 列；`Card.chart_type` 仍为 String。
- 不把两张核心数据卡自动挂到某个看板；只写入卡片库。

## 4. 契约

### 4.1 事件 `_view`

```ts
event_layout: 'both' | 'chart' | 'table'
event_chart: 'line' | 'bar' | 'number' | 'trend' | 'stack' | 'cumulative' | 'distribution' | 'pie'
stat_calcs?: Array<'last'|'avg'|'max'|'min'|'first'|'total'>
```

`Card.chart_type` 与 `event_chart` 对齐；`table` 只表示布局。

### 4.2 留存 `_view`

```ts
retention_layout: 'both' | 'chart' | 'table'   // 旧值 'trend' → chart + nth_trend
retention_chart: 'nth_trend'                  // 旧 daily_trend → nth_trend
```

第 N 日：`modelFromRetentionNth` + `ExploreChart`。未到期点为 null，折线不连空。人数表与留存率表分列。
勾选预设 `1/2/3/7/15`，默认 `n_list=[1,2,3,7]`；自定义 N 以可删标签展示，不把旧卡多余 N 铺回勾选行。

### 4.3 `options.stat_calcs`

缺省按图形类型填默认（见 PRD §5）。数值卡归约用勾选的第一项，缺省 `last`。空值不参与平均/最大/最小；系列全空则该统计为 null，不显示 0。

### 4.4 公式 DOM

`.formula-expr` 纵向 flex；每个 Slot 全宽。不再把运算符、格式和左右槽放进同一水平 `.formula-slots`。

## 5. 文件

| 路径 | 职责 |
|------|------|
| `features/explore-charts/*` | 统计、ECharts option、图、显示值勾选 |
| `features/query/event-view.ts` | 类型解析 |
| `features/query/retention-view.ts` / `retention-tables.ts` | 布局与人数/留存率拆表 |
| `features/visualization/chart.types.ts` 等 | 仅 `stat_calcs` |
| `analytics-server/.../chart-config.validator.ts` | 白名单 `stat_calcs` |
