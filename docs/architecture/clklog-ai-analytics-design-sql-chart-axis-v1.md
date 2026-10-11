# 架构：Harness 读写自定义 SQL 图表的编排（分轴与单位）

> phase: clklog-ai-sql-chart-axis-v1
> 帽子：架构（`docs/architecture/`）
> 产品：[PRD](../product/prd-clklog-ai-sql-chart-axis-v1.md)
> 上游契约：`clklog-analytics-design-sql-dual-axis-v1.md`（`options.metric_axis` 的存储与渲染）、`clklog-ai-analytics-design-sql-chart-v1.md`（Page Bridge 路径）、`clklog-ai-analytics-design-event-chart-v1.md`（事件侧同能力，本 phase 与它对称）
> Page Bridge / 工具隔离见 `clklog-ai-analytics-design.md` §14。

---

## 1. 阶段目标、范围与验收

本 phase **不新增通道**，只补一个已存在通道上的能力缺口：事件的图表提案支持 `options.metric_axis`，SQL 的图表提案不支持；同时 SQL 能力自述缺 `options_keys`，模型无法发现可用键。改动集中在 `chart-proposal.ts` 的两个常量、插件工具描述、Workspace 文档与测试。

验收对齐 PRD SC-1～SC-7。非目标同 PRD。

## 2. 读取面（本 phase 不改代码，只确认契约并写进规范）

`GET /tools/page/read` → `pageBridge.read()` 原样返回页面快照，SQL 页 `publishContext.analysis` 已无条件发布：

```json
{
  "mode": "sql",
  "result_columns": [{ "name": "d", "type": "Date" }],
  "chart_config": {
    "schema_version": 1, "mode": "manual", "chart_type": "line",
    "bindings": { "x": "d", "metrics": ["订单数", "用户数"], "ignored": [] },
    "options": { "metric_axis": { "用户数": "right" }, "units": { "用户数": "number" } }
  }
}
```

即「编排」对 Harness 是**可读的**，四要素（图型 / 字段绑定 / 分轴 / 单位）都在 `analysis.chart_config` 里。

一处**有意的不对称**保留不动：`editableContext` 里 SQL 分支只在 `chart_config.mode === 'manual'` 时把图型/绑定纳入 revision（自动推荐不续号），事件分支无条件纳入。因此 SQL 侧改「编排」是否换版本，取决于该配置是不是 manual；这是 `clklog-ai-sql-chart-v1` 的既有设计，本 phase 不动。

## 3. 写入面：改什么

`apps/analytics-server/src/modules/ai-assistant/chart-proposal.ts`：

| 常量 | 改动 |
|------|------|
| `SQL_DOMAIN.optionKeys` | 增加 `metric_axis`（原为 `orientation / donut / sort / top_n / include_other / units / aggregation / trend / stat_calcs`） |
| `SQL_DOMAIN.notes` | 补「分轴用 `options.metric_axis`（`{"列名":"right"}`），单位用 `options.units`」 |
| `SQL_CHART_CAPABILITY` | 补 `options_keys: SQL_DOMAIN.optionKeys`，与 `EVENT_CHART_CAPABILITY` 对称 |

`metric_axis` 的取值校验不在本层：提案物化后由页面 `parseChartConfigV1` 校验（key 必须是本次结果列、值只能是 `left`/`right`），非法值走既有 `STALE_CONFIG` 报错路径。服务端**不**复制这层校验，避免两处规则漂移。

**合并语义（读为什么是必需的）**：页面物化是 `{...当前 options, ...提案 options}` —— **按整键替换**。因此提案里出现的 `metric_axis` 会整份覆盖页面当前的那份，这一点不能改成逐项深合并（深合并后「把某个指标挪回左轴」无法表达：只能是提交一份不含该键的完整映射）。所以模型正确的动作是「先读 `analysis.chart_config.options.metric_axis`，在读到的那份上改一处，再整份提交」，这条已写进工具描述与 Workspace 规范。

去掉 `metric_axis` 后仍然拒绝的键（例：`x_label`）行为不变，报错文案含可用键列表，模型可一次改对。

## 4. 分发物

| 层 | 文件 | 改动 |
|----|------|------|
| Harness 工具 | `apps/analytics-harness-host/plugins/analytics-tools/index.mjs` | `clklog_propose_sql_chart` 描述补「先 `page_read` 看 `analysis.chart_config` 的当前分轴；分轴用 `options.metric_axis`，单位用 `options.units`」 |
| Workspace | `ai_workspace/default/tools/analysis-playbook.md`、`ai_workspace/default/AGENTS.md` | SQL 侧也要求读 `analysis.chart_config`（原只有事件侧写了这条） |

Workspace 是分发物：改完必须 `ops/ai-workspace-sync.sh push default`（`init` 是 `--ignore-existing`，不会覆盖）。

## 5. 与既有 phase 的边界

- `clklog-ai-sql-chart-v1` 的非目标里写着「不做双轴」——那是在 `clklog-analytics-sql-dual-axis-v1` 让页面支持双轴之前。本 phase 显式取代这一条，其余非目标（不放宽上限、不改守卫、不写看板格子）继续有效。
- 事件侧（`clklog-ai-event-chart-v1`）的分轴路径与文案不动。
- 不新增 action、不新增网关路由：`sql_chart_edit` / `POST /tools/page/propose-sql-chart` 沿用。
