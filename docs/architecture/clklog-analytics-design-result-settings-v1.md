# 实现方案：分析结果设置齿轮

> phase: clklog-analytics-result-settings-v1
> 上游：`docs/product/prd-clklog-analytics-result-settings-v1.md`

---

## 1. 阶段目标与范围

前端展示层开关。查询 DSL 与 SQL 不变。显示偏好存在卡片 `dsl._view`，不新增 API。事件 / 留存的图表·表格分段从工具栏挪进齿轮（漏斗时间维度仍在工具栏）。

## 2. 验收标准

与 PRD RS-1～RS-7 对应。

- `funnel-display.ts`：`conversion` 默认；过滤 `*_conversion` / `*_churn`；流失率 = 流失人数 / 上一步人数。
- `event-view.ts` / `retention-view.ts`：解析 `_view` 缺省值；非法值回落默认。
- `AnalysisResultSettings`：齿轮 + Popover。
- `FunnelResult` / `EventAnalysisResult` / `RetentionResult` 共用齿轮壳；漏斗写入漏斗字段，事件/留存写入各自 layout 字段。
- `CardWidget`（`type=funnel`）共用过滤与图 option。
- 交付前 `python3 scripts/arch_ratchet.py` 通过。

## 3. 非目标

与 PRD §3 相同。不扩大 `utils/`。

## 4. 结构

| 文件 | 职责 |
|------|------|
| `features/query/funnel-display.ts` | 比率模式、列过滤、单元格格式、漏斗图 option |
| `features/query/event-view.ts` | 事件展示 / 图类型 / 时长 `_view` |
| `features/query/retention-view.ts` | 留存展示 `_view` |
| `features/query/AnalysisResultSettings.tsx` | 结果齿轮 |
| `FunnelViewSettings` / `EventViewSettings` / `RetentionViewSettings` | 齿轮内容 |
| `FunnelResult` / `EventAnalysisResult` / `RetentionResult` | 漏斗：齿轮在时间维度与视图切换左侧；事件/留存：视图分段只在齿轮内 |
| `CardWidget` | funnel 卡读 `_view.funnel_rate` |

## 5. 卡片字段

查询引擎忽略未知键。与 `_form` 并列。

```
dsl._view.funnel_rate: 'conversion' | 'churn'          // 缺省 conversion
dsl._view.funnel_layout / funnel_color / funnel_table_col_chars  // 漏斗展示，见 funnel-display-v1
dsl._view.event_layout: 'both' | 'chart' | 'table'     // 缺省 both
dsl._view.event_chart: 'line' | 'bar' | 'number'       // 缺省 line；保存时同步卡片 chart_type
dsl._view.duration_plain: boolean                      // 缺省 false
dsl._view.retention_layout: 'both' | 'chart' | 'table' | 'trend'  // 缺省 both
```
