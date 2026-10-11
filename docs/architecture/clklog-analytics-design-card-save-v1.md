# 实现方案：分析卡片覆盖保存 / 另存为

> phase: clklog-analytics-card-save-v1
> 上游：`docs/product/prd-clklog-analytics-card-save-v1.md`
> 契约：`PUT /report/cards/:id`（`UpdateCardDto`）、`POST /report/sql/save`、`PUT /report/sql/:id`

---

## 1. 阶段目标与范围

四个分析页共用一套保存按钮语义；后端沿用已有创建/更新接口，不新增路径。

## 2. 验收标准

与 PRD CS-1～CS-5 对应。实现侧：

- `CardSaveActions`：`bound=false` 只渲染「保存为卡片」；`bound=true` 渲染「覆盖保存」+「另存为卡片」。
- 事件/漏斗/留存：`AnalysisCardSave` 调 `updateCard` / `createCard`（经 `SaveAsCardModal`）。
- 自定义 SQL：有卡时 `updateSqlReport` + 另存走现有 `saveSqlReport` 弹窗。
- 交付前 `python3 scripts/arch_ratchet.py` 通过。

## 3. 非目标

与 PRD §3 相同。不新增 `common/utils` 包；保存按钮放 `features/report`，分析三类装配放 `features/query`。

## 4. 前端结构

| 文件 | 职责 |
|------|------|
| `features/report/CardSaveActions.tsx` | 无卡 / 有卡两种按钮组合 |
| `features/query/AnalysisCardSave.tsx` | 分析三类：覆盖 `updateCard`（dsl + `_form` + 可选 `chart_type`），另存打开 `SaveAsCardModal` |
| `SaveAsCardModal` | 仅新建；可选预填「原名 副本」 |
| `EventAnalysisResult` / `FunnelResult` / `RetentionResult` | 用 `AnalysisCardSave` 替换单一「保存为卡片」 |
| `SqlReportPage` | 有卡显示覆盖 + 另存；无卡「保存为卡片」 |

分析页从 `getCard` 带出 `cardName`，供覆盖 toast 与另存预填。覆盖不改 `searchParams`。另存成功：SQL `setSearchParams({ card: newId })`；分析三类不改 URL。

`chart_type` 覆盖映射：事件用结果区当前折线/柱/数值；漏斗非纯表格则为 `bar`，纯表格为 `table`；留存非纯表格为 `line`，纯表格为 `table`。

## 5. API

不改契约。

- 覆盖分析卡：`PUT /report/cards/:cardId`，body 含 `dsl`（查询 + `_form`）、可选 `chart_type`。不传 `name`。
- 覆盖 SQL 卡：`PUT /report/sql/:id`，沿用 `SaveSqlReportDto`（name 保持当前卡名）。
- 另存：`POST /report/cards` 或 `POST /report/sql/save`。
