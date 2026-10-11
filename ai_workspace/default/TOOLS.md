# 工具契约（管理员维护）

> 字段名与上限是**契约**：写错会被 400/409 拒绝，且错误信息会连带回「可用列 / 可用键 / 你实际传了几个」。
> 照错误改一次；同一错误再出现就停止该路径并报告（见 `AGENTS.md`「错误、等待与停止」）。

## 页面读写与 SQL

| 工具 | 契约要点 |
|---|---|
| `clklog_page_read` | 每次写回前重读：拿最新 `revision`、当前页类型、`analysis.result_columns` |
| `clklog_propose_analysis` | 只填当前匹配页；`expected_revision` 必须是最近一次 `page_read` 的值 |
| `clklog_propose_sql` | 把 SQL 写进编辑器（提案自动应用），之后才能执行 |
| `clklog_request_sql_execution` | 要求编辑器当前 SQL 与请求的 SQL **完全一致**（否则 409 会说明该先做什么）；超预算失败会回 `report.sql.queryTimeout` / `queryTooLarge` |
| `clklog_execute_sql_card` | 只支持 `type=sql` 的卡片；这是「目录执行」入口 |
| `clklog_list_cards` / `clklog_get_card` | 复用旧资产前核对口径、日期与目标问题 |

## 图表字段绑定

两个域各有一个工具，**生效方式不同**：

| | `clklog_propose_sql_chart`（自定义 SQL） | `clklog_propose_event_chart`（事件分析） |
|---|---|---|
| 生效 | **自动写入**结果区字段设置 | **用户在页面上点「应用」才生效**（不点则不变） |
| 列名 | `analysis.result_columns` 的精确列名 | 结果列 key（`g_0` / `m_0`），**不是列标题** |
| 图型 | `table` `number` `line` `bar` `pie` `funnel` `trend` | `table` `number` `line` `bar` `pie` `trend` `stack` `cumulative` `distribution` |
| 维度键 | `line`/`trend` 用 `x`；`bar`/`pie` 用 `category` | 一律 `x`（可为时间列或维度列），拆分系列用 `series`；**没有 `category`** |
| 指标上限 | `bar` 4 \| `pie` 1 \| `line`/`trend` 5 \| `table` 8 | `bar`/`stack`/`distribution` 4 \| `line`/`trend`/`cumulative` 5 \| `pie` 1 \| `table` 8 |
| 额外能力 | `roles`、`row_selector`、`funnel` | `options.metric_axis`（左右分轴）、`options.units`；**不接受 `roles`** |

共同点：只用 `clklog_page_read` 给出的列；多余列放 `ignored`；写错列名/键名直接 400 并回「可用列 / 可用键」——照它改一次，不要连续试探；都不执行查询、不保存卡片。

## 查询类

- 事件/漏斗/留存统一走各自 run 工具与 `clklog_propose_analysis`；DSL 口径与边界见 `AGENTS.md`。
- 字典用 `clklog_get_schema`（先 keyword 定位事件，再按 `event_key` 取属性，遍历 `pagination.next_page`）。
- 能力与示例用 `clklog_get_analysis_capabilities`，禁止枚举猜参数。
