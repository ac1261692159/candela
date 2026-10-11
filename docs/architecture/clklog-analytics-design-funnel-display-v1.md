# 实现方案：漏斗结果横纵布局与阈值配色

> phase: clklog-analytics-funnel-display-v1
> 上游：`docs/product/prd-clklog-analytics-funnel-display-v1.md`
> 覆盖：`clklog-analytics-design-result-settings-v1.md` 中漏斗图 `type: 'funnel'` + 彩虹色内部标签。

---

## 1. 阶段目标与范围

仅前端展示层。查询 DSL / SQL / 校验不变。显示偏好继续放在卡片 `dsl._view`。

## 2. 验收标准

与 PRD FD-1～FD-9 对应。

- `funnel-display.ts`：方向默认、相对基数步比率、分档颜色、横向 `type: 'funnel'` / 纵向 bar、表格列宽、从某步切片、tooltip 相对上一步。
- `FunnelExploreChart`：点击条/块切片；空白还原。
- `FunnelResult` 齿轮写入 `_view`；`CardWidget`（`type=funnel`）读取同一套并共用点击切片。
- 交付前 `python3 scripts/arch_ratchet.py` 通过。

## 3. 非目标

与 PRD §3 相同。不扩大 `utils/`。

## 4. 结构

| 文件 | 职责 |
|------|------|
| `features/query/funnel-display.ts` | 视图解析、默认方向、配色、ECharts option |
| `features/query/FunnelViewSettings.tsx` | 齿轮内：比率 / 方向 / 默认色 / 三档阈值 |
| `features/query/FunnelExploreChart.tsx` | 点击某步切片 / 点空白还原 |
| `FunnelResult` | 未保存按步数默认方向；保存写入 `_view` |
| `FunnelAnalysisPage` | `?card=` 还原 layout/color |
| `CardWidget` | funnel 卡读 `_view` |

## 5. 卡片字段

与 `_form` 并列，查询引擎忽略未知键。

```
dsl._view.funnel_rate: 'conversion' | 'churn'     // 已有，缺省 conversion
dsl._view.funnel_layout: 'horizontal' | 'vertical' // 缺省：步数 < 10 → horizontal，≥ 10 → vertical
dsl._view.funnel_table_col_chars: number           // 表格默认列宽（字符），缺省 6，下限 6，上限 32
dsl._view.funnel_color: {
  default: '#1677ff',
  levels: [
    { gte: 80, lt: 90, color: '#faad14' },
    { gte: 50, lt: 80, color: '#ff4d4f' },
    { gte: 0,  lt: 50, color: '#531dab' },
  ]
}
```

`gte`/`lt` 一律按**相对上一步的转化率**百分数存储（0–100）。流失率模式展示与着色时用 `churnPct = 100 - conversionPct` 换算同一档。相对**当前可见第一步**（默认整链第一步；点击切片后为被点中的那步）的图上数字不参与分档。切片只改图，不改查询、不改表。

第一步（或切片后的新基数步）着色用默认色。第 n 步颜色看 `count[n] / count[n-1]`（切片后仍用相邻可见步）。

点击图上某步：`visible = series.slice(dataIndex相对整链的绝对下标)`，该步人数作为 funnel/bar 的 `max`。点空白：`slice(0)`。会话内状态，不进 `_view`。

## 6. 图

- 横向：`series.type = 'funnel'`，`sort: 'none'`，`funnelAlign: 'center'`。左侧标签 `{原序号} {标题}` 左对齐、相对**当前基数步**比率右对齐。
- 纵向：底部 `{原序号} {标题}`；柱顶相对当前基数步；步数 ≥ 10 时底轴标签旋转以免竖字。
- 表格：列宽 `max(设置字符数, 6, 表头字数) × 14px + 内边距`；`white-space: nowrap`；`scroll.x`。
- tooltip：`trigger: 'item'`，文案与现网一致（名 / 人数 / 相对上一步比率）。
- 漏斗块宽 / 柱高 = 该步人数。纵向仍用 bar，不用 funnel。
