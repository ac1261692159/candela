# 架构：Harness 填充 SQL 图表字段绑定

> phase: clklog-ai-sql-chart-v1
> 帽子：架构（`docs/architecture/`）
> 产品：[PRD](../product/prd-clklog-ai-sql-chart-v1.md)
> 既有 Page Bridge / 工具隔离见 `clklog-ai-analytics-design.md` §14；图表契约见 `clklog-analytics-design-charts-v1.md`。

---

## 1. 阶段目标、范围与验收

在现有 Unix Gateway → Page Bridge → 自定义 SQL 页路径上增加「图表字段绑定」提案。不新增查询、不改 ClickHouse、不改卡片保存 API。绑定写入页面已有 `ChartConfigV1`，保存卡片仍走用户操作。

验收对齐 PRD SC-1～SC-7。非目标同 PRD。

## 2. 快照增量

SQL 页 `publishContext.analysis` 增加：

```json
{
  "result_columns": [{ "name": "d", "type": "Date" }],
  "chart_config": null
}
```

`result_columns` 来自最近一次执行结果的列元数据，即使 `result` 因 128 KiB 被裁掉也保留，供工具核列名。`chart_config` 为当前工作台配置或 `null`。

revision 仍由 `editableContext` 分配：SQL / 日期 / mode / 卡片定位，加上 **`chart_config.mode === 'manual'` 时的 type/roles/bindings**。`mode === 'auto'`（执行后推荐）与 loading/result 一样不续号，避免 `sql_execute` 回执假冲突。

## 3. 工具与 Action

| 层 | 契约 |
|---|---|
| Harness 工具 | `clklog_propose_sql_chart` |
| Gateway | `POST /tools/page/propose-sql-chart` |
| Page Bridge action | `sql_chart_edit` |

工具参数：

| 字段 | 约束 |
|------|------|
| `chart_json` | JSON 对象，≤8 KiB |
| `expected_revision` | 最近 `clklog_page_read` 的 revision |
| `reason` | 口径说明，≤2000 字 |

`chart_json`：

```json
{
  "chart_type": "line",
  "bindings": {
    "x": "d",
    "metrics": ["收入金额", "付费人数"],
    "ignored": ["支付成功次数"]
  }
}
```

允许的 `chart_type`：`table | number | line | bar | pie | funnel | trend`。未出现的列在页面物化时标为 `ignored`。可选 `roles`、`preferred_view`、`options`（只接受既有 ChartOptions 键）。

指标上限与可视化常量一致：折线/趋势 5、柱状 4、饼图 1、指标卡 8。Gateway 对照快照列名校验；缺结果返回 `sql_chart_requires_result`（409）；列不存在或超限 400。

提案自动应用（与 2026-09-09 SQL 提案相同），回执 `applied` / `rejected` / `revision_conflict` / `timeout` / `page_unavailable` / `superseded`。

`GET /tools/query/capabilities` 增加 `sql_chart` 说明（类型枚举与上限），避免模型猜参数。

## 4. 页面物化

浏览器用当前结果列把提案收成完整 `ChartConfigV1`（`schema_version=1`、`mode=manual`），再 `setChartConfig`。React 状态写入，不操作 DOM。

物化规则：

- `bindings.x` → 角色 `time`（折线/趋势必填）
- `bindings.category` / `series` → `dimension`
- `bindings.metrics` → `metric`
- 其余列 → `ignored`
- `preferred_view`：`table` 类型为 table，否则 chart

列缺失、图形与绑定不匹配（缺时间轴、指标数为 0 等）时 `accepted: false`，reason 写给人看的中文。不覆盖当前配置。

`evaluateCompatibility` 对 **manual** 配置把 `MIXED_UNITS` 降为 warning，允许金额与人数同图；自动推荐仍视其为 error。这与字段设置「用户已显式选择」一致。

## 5. 文件落点

| 职责 | 路径 |
|------|------|
| 提案校验 | `apps/analytics-server/src/modules/ai-assistant/sql-chart-proposal.ts` |
| 网关路由 | `harness-gateway.service.ts` |
| 桥接 action | `page-bridge.types.ts` / `page-bridge.service.ts` |
| 页面物化 | `apps/analytics-web/src/features/visualization/sql-chart-proposal.ts` |
| 应用 | `SqlReportPage.tsx` |
| 工具 | `apps/analytics-harness-host/plugins/analytics-tools/index.mjs` |
| 手册 | `workspace-template/AGENTS.md`、`tools/analysis-playbook.md` |

不新建 `common`/`utils` 包。Page Bridge 事件可带 `chart_config`（提案原文），`sql` 对 `sql_chart_edit` 允许空串。

## 6. 红线

- 不改社区版表与采集链路。
- 提案不执行 SQL、不写卡片、不改项目。
- 密钥不入库。查询有界仍只发生在既有 `sql_execute` / 卡片执行路径。
