# PRD：Harness 读写自定义 SQL 图表的编排（分轴与单位）

> phase: clklog-ai-sql-chart-axis-v1
> 帽子：产品（`docs/product/`）
> 上游：`prd-clklog-ai-sql-chart-v1.md`（本 phase 只改其「非目标」中的双轴一条）、`prd-clklog-analytics-sql-dual-axis-v1.md`
> 下游：`docs/architecture/clklog-ai-analytics-design-sql-chart-axis-v1.md`

---

## 1. 阶段目标与范围

自定义 SQL 结果区的折线/趋势图已经支持左右双 Y 轴，每个指标可以各自指定落在左轴还是右轴，并各自设置单位。**人已经在页面上能改，Harness 读得到、但写不了**：服务端 SQL 域的 `options` 白名单没有 `metric_axis`，能力自述 `SQL_CHART_CAPABILITY` 也不下发 `options_keys`，模型一旦尝试设分轴会拿到 `不支持的 options: metric_axis` 的 400。

本期把这条断掉的路补齐，让「编排」（图表类型 + 字段绑定 + 分轴 + 单位）在 SQL 页面对人和对 Harness 是一套可读可写的契约。

| 模块 | 本次做什么 |
|------|------------|
| 快照读取 | 保持既有行为：`clklog_page_read` 返回 `analysis.chart_config`，其中含 `options.metric_axis` 与 `options.units`（本 phase 不新增字段，只补文档与自述，让人和模型都知道要去读它） |
| 能力自述 | `SQL_CHART_CAPABILITY` 补 `options_keys`，与事件侧对称；SQL 的 `notes` 补分轴与单位写法 |
| 写回 | SQL 域的 `options` 白名单纳入 `metric_axis`，`clklog_propose_sql_chart` 可提案分轴 |
| 规范 | Workspace 的 SQL playbook 明确「要看 `analysis.chart_config` 才能知道当前分轴」 |

## 2. 用户流程

1. 人在自定义 SQL 页跑出结果，字段设置里把「用户数」放到右轴，两个指标各自选单位。
2. 用户对 Harness 说「量级差太多，看不出来」或者「把订单数也挪到右轴」。
3. Harness `clklog_page_read`，从 `analysis.chart_config.options.metric_axis` 读到当前分轴，从 `analysis.result_columns` 核对列名。
4. Harness 用 `clklog_propose_sql_chart` 提交分轴：**整份提交**（`options` 按整键替换，不是逐项合并 —— 只提交一个指标会把其余指标挤回左轴），其余键沿用页面当前配置。
5. 页面直接应用（与既有 SQL 图表提案一致，不弹确认框），左右轴与单位按提案变化；`reason` 在页面上可见。

## 3. 验收标准

- [ ] **SC-1（读）**：SQL 页 `clklog_page_read` 的 `analysis.chart_config.options` 含 `metric_axis` 与 `units`，与页面上字段设置所示一致；未设分轴时 `metric_axis` 缺省或为空对象。
- [ ] **SC-2（发现）**：`clklog_get_analysis_capabilities` 返回的 `sql_chart.options_keys` 含 `metric_axis` 与 `units`，模型无需靠试错发现可用键。
- [ ] **SC-3（写）**：`clklog_propose_sql_chart` 提交 `options.metric_axis = {"列名":"right"}` 后，SQL 页折线/趋势图出现右轴，被点名的指标画在右轴，其余在左轴；单位用 `options.units` 单独指定。
- [ ] **SC-4（校验）**：`metric_axis` 的取值只接受 `left` / `right`；非法取值拒绝且不改图，回执带原因。未白名单的键（如 `x_label`）仍按既有行为拒绝。
- [ ] **SC-5（不改图）**：分轴提案只在有 `bindings.x` 的折线/趋势图上有可见效果；对 `table`/`number`/`pie`/`funnel` 提交分轴不报错但页面不出现右轴（与人工在字段设置里看不到轴选择器一致）。
- [ ] **SC-6（无回归）**：事件分析页的分轴提案、SQL 的既有绑定提案、revision 与冲突回执行为不变。
- [ ] **SC-7（门禁）**：新增/改动单测通过，`python3 scripts/arch_ratchet.py`、`python3 scripts/i18n_check.py`、`python3 scripts/i18n_scan.py --check` 通过。

## 4. 非目标

- 不改 `metric_axis` 的存储契约（仍是 `ChartConfigV1.options.metric_axis`，以 `clklog-analytics-design-sql-dual-axis-v1.md` 为准）。
- 不让 Harness 设置 `x_label`（长标签显示档位是渲染细节，人看现象再调更准）。
- 不放宽指标数量上限，不新增图型，不改 SQL 守卫/只读账号/LIMIT/超时。
- 不改事件分析侧的分轴与单位行为。
- 不为分轴单独引入确认框：SQL 图表提案仍是直接应用。
