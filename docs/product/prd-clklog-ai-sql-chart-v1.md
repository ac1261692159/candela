# PRD：Harness 填充自定义 SQL 图表字段绑定

> phase: clklog-ai-sql-chart-v1
> 帽子：产品（`docs/product/`）
> 上游：`prd-clklog-ai-workspace-v1.md`、`prd-clklog-analytics-charts-v1.md`
> 下游：`docs/architecture/clklog-ai-analytics-design-sql-chart-v1.md`

---

## 1. 阶段目标与范围

自定义 SQL 跑出结果后，自动推荐经常只能给明细表（列名是 `d`、中文指标过多、混单位等）。分析师这时会打开「字段设置」手工选时间轴和指标。本期让 Harness **读到当前结果列与已有绑定，并自动写入字段设置**，与现有 SQL 提案一样直接应用、不弹确认框。

| 模块 | 本次做什么 |
|------|------------|
| 页面快照 | `clklog_page_read` 带上结果列名和当前 `chart_config` |
| 写回 | 新工具把图表类型 + 列角色写进结果区，立刻出图 |
| 修订 | 自动推荐不占用 revision；用户或 AI 改绑定才续号 |
| 混单位 | 用户/AI 显式勾选的指标允许混单位出图（提示，不阻断） |

## 2. 用户流程

1. 人在自定义 SQL 页，Harness 已写入并执行 SQL，结果区有表。
2. 自动模型停在明细表（例如 6 个指标超过折线上限 5）。
3. 用户说「做成折线图」或 Harness 自己判断需要出图。
4. Harness 再读页，按列名提出绑定：时间轴 `d`，最多 5 个指标，其余忽略。
5. 页面自动应用，切到图表视图；不保存卡片。用户仍可打开字段设置改。

## 3. 验收标准

- [ ] **SC-1**：SQL 页 `clklog_page_read` 含 `analysis.result_columns`（列名+类型）和 `analysis.chart_config`（无配置则为 `null`）。纯结果刷新、自动推荐不增加 revision。
- [ ] **SC-2**：`clklog_propose_sql_chart` 在绑定 SQL 页、已有结果时自动写入字段设置与图形类型，模型收到 `applied`；页面出现对应图（或表格，若选了 table）。
- [ ] **SC-3**：折线/趋势最多 5 个指标、柱状最多 4、饼图 1 个、指标卡最多 8。超出或列名不在当前结果中时工具/页面拒绝，原图与 SQL 不变，回执带原因。
- [ ] **SC-4**：无查询结果、不在 SQL 页、revision 过期，均拒绝且不改页面。
- [ ] **SC-5**：用户或 AI 显式绑定后，金额与人数等混单位只警告仍出图；自动推荐逻辑不变。
- [ ] **SC-6**：不自动保存卡片、不改 SQL、不执行查询。与 SQL 提案相同：过期/冲突/页面离线走既有回执。
- [ ] **SC-7**：相关自动测试与 `python3 scripts/arch_ratchet.py` 通过。

## 4. 非目标

- 不放宽自动推荐的指标数量上限，不猜 `d` 以外的时间别名来「修好自动模型」。
- 不做双轴、不把漏斗从收入总览类结果里硬编出来。
- 不把字段绑定写进看板格子 `display_json`。
- 不改 SQL 守卫、只读账号、LIMIT/超时。
- 不训练模型权重；Workspace 规则随模板发布后才进入已有会话。
