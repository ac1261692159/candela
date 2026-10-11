# 实现方案：AI 助手读写事件分析的图表配置（v1）

- phase: `clklog-ai-event-chart-v1`
- 帽子：架构（`docs/architecture/`）
- 对应 PRD：`docs/product/prd-clklog-ai-event-chart-v1.md`
- 上游 SSOT：`docs/architecture/clklog-ai-analytics-design.md`（Page Bridge 总契约）、`docs/architecture/clklog-ai-analytics-design-sql-chart-v1.md`（SQL 侧同类能力）、`docs/architecture/clklog-analytics-design-event-chart-binding-v1.md`（事件 `ChartConfigV1` 的来处）
- 状态：待评审

---

## 0. 执行入口

先读：

| 要说清什么 | 读哪篇 |
|---|---|
| Page Bridge 的 action 枚举、快照形状、清洗规则 | `docs/architecture/clklog-ai-analytics-design.md` §14 |
| SQL 侧图表提案怎么做出来的（本方案的同构参照） | `docs/architecture/clklog-ai-analytics-design-sql-chart-v1.md` §2 |
| 事件 `ChartConfigV1` 的字段与域白名单 | `docs/architecture/clklog-analytics-design-event-chart-binding-v1.md` §6 |
| 代码架构硬门禁（文件数/行数/包边界） | `AGENTS.md`「系统代码架构硬门禁」 |

---

## 1. 阶段目标与范围（程序门禁要素①）

### 1.1 目标

让 Harness 对事件分析的图表配置**可读、可提案**：

1. **读** —— 事件页快照带上当前 `chart_config`、`_view` 与结果列元数据（含列角色）。
2. **写** —— 新增域中立的 `analysis_chart_edit` action 与 `clklog_propose_event_chart` 工具；事件侧提案**落到一条待确认条**，用户点「应用」才生效。
3. 读写都不写库、不触发后端重查。

### 1.2 代码范围

| 层 | 文件 |
|---|---|
| Web 事件页 | `apps/analytics-web/src/pages/Analysis/EventAnalysisPage.tsx` |
| Web 结果组件 | `apps/analytics-web/src/features/query/EventAnalysisResult.tsx` |
| Web 提案监听 | `apps/analytics-web/src/features/ai-analysis/`（新增事件图表提案的监听） |
| Web revision | `apps/analytics-web/src/features/ai/page-context-revision.ts` |
| Web 类型 | `apps/analytics-web/src/types/ai.types.ts` |
| Server 桥 | `apps/analytics-server/src/modules/ai-assistant/page-bridge.service.ts` |
| Server 网关 | `apps/analytics-server/src/modules/ai-assistant/harness-gateway.service.ts` |
| Server 物化器 | `apps/analytics-server/src/modules/ai-assistant/sql-chart-proposal.ts` |
| Harness 插件 | `apps/analytics-harness-host/plugins/analytics-tools/index.mjs` |
| Harness 规范 | `ai_workspace/default/TOOLS.md`、`ai_workspace/default/AGENTS.md`、`ai_workspace/default/tools/analysis-playbook.md` |
| i18n | `apps/analytics-web/src/i18n/locales/*/ai.json`、`*/analysis.json`、`*/sql.json` |

### 1.3 不变边界

1. **SQL 侧行为不变**：`/tools/page/propose-sql-chart` 仍自动写入结果区（PRD 非目标 6 只约束事件侧）。
2. **事件页的查询链路不变**：不碰 `EventAnalysisQuery`、不碰 `runQuery`。
3. **表单提案通道不变**：`clklog_propose_analysis` 与 `dsl-form.ts` 的键白名单一行不改（PRD 非目标 5）。
4. **红线**：不新增对外网络出口、不把密钥或用户 PII 送进快照（清洗器既有规则继续生效，见 §8）。

---

## 2. 验收标准（程序门禁要素②）

| # | 验收项 | 核对方式 |
|---|---|---|
| AC1 | 事件页快照的 `analysis` 含 `chart_config`、`view`、`result_columns`（带 `role`） | `page-bridge.service.spec.ts` 断言快照形状 + 浏览器实测 `clklog_page_read` |
| AC2 | 事件页 `chart_config` 变化会 bump `revision` | `page-context-revision.spec.ts`（新增事件分支用例） |
| AC3 | 服务端接受 `analysis_chart_edit`：SQL 页走 SQL 域、事件页走事件域；漏斗/留存页返回 409 | `page-bridge.service.spec.ts` |
| AC4 | `sql_chart_edit` 旧名仍被接受且与 `analysis_chart_edit` 等价 | 同上 |
| AC5 | 事件域物化器接受 `stack/cumulative/distribution`、拒绝 `funnel`；SQL 域行为逐项不变 | `sql-chart-proposal.spec.ts` 扩充（两域对照） |
| AC6 | 事件域拒绝 `category`（该域用 `x`）、拒绝 AI 传 `roles` / `x_label`、拒绝引用不存在的列 | 同上 |
| AC7 | AI 提案后事件页出现提案条且**图表零变化**；点「应用」才变；点「忽略」无副作用 | 浏览器实测 + `EventChartProposal.spec.tsx` |
| AC8 | 应用提案后无 `/sa/api/query/` 请求，卡片 `dsl` 与 `updated_at` 不变 | 浏览器实测（fetch 钩子 + 读回卡片） |
| AC9 | 用过期 `revision` 提案返回 409 且原因可读 | `page-bridge.service.spec.ts` |
| AC10 | `python3 scripts/arch_ratchet.py`、`i18n_check.py`、`i18n_scan.py --check` 通过；两端构建通过 | 命令输出 |

---

## 3. 非目标（程序门禁要素③）

1. **不做自动应用**（PRD R4）。事件侧提案必须用户确认，与 SQL 侧有意的差异。
2. **不允许 AI 保存卡片**：不接受任何携带 `save` / `card_id` 的提案字段。
3. **不做漏斗 / 留存**：`analysis_chart_edit` 在这两个页面返回明确 409，不静默忽略。
4. **不做 AI 改查询**：图表提案不携带 `dsl`；携带了就拒绝。
5. **不做自动推荐**：不改 `chart-recommender`，不做「出图后 AI 主动推配置」。
6. **不放宽事件表单白名单**：`_view` / `chart_config` 混进 `clklog_propose_analysis` 的 `dsl` 仍被拒。
7. **不做双轴之外的图形能力**：AI 能配的轴只有 `metric_axis` 的 left/right，不引入新图形。
8. **不重构 SQL 侧的 `preferred_view` / `roles` 提案语义**。

---

## 4. 现状与差距

### 4.1 读：事件页的快照缺口

`apps/analytics-web/src/pages/Analysis/EventAnalysisPage.tsx:56-70` 发布的载荷只有四项：

```ts
publishAiContext({
  page: 'event',
  route: '/analysis/event',
  analysis: { dsl, form: draftForm ? { ...draftForm, timeRange } : null, loading },
  result: result ? { ...result } : undefined,
}, project);
```

而页面另外持有 `eventLayout` / `eventChart` / `durationPlain` / `eventStatCalcs` / `eventYUnit` / `cardChartConfig`（`:45-51`），**一个都没进载荷**。

`dsl.chart_config` 与 `dsl._view` 唯一的组装点是 `EventAnalysisResult.tsx:173-180` 的 `dslWithView`，而它**只流向 `AnalysisCardSave`**（保存卡片），从不回写 store、也从不进快照。所以 AI 的盲区是结构性的。

**AI 现在能间接读到的两处**（都不是当前工作台）：

| 窗口 | 能读到 | 读不到 |
|---|---|---|
| `clklog_get_card` / `clklog_list_cards`（`card.service.ts:744` 原样返回 `dsl`） | **已保存卡片**里的 `_view` 与 `chart_config` | 用户此刻未保存的调整；也不能改 |
| `clklog_page_read` 的 `result.columns` | 有哪些列、各自 `role` 是 time/dimension/metric | 当前 X 轴选了谁、谁在右轴、每指标什么单位 |

### 4.2 写：唯一的图表写入口被锁在 SQL 页

`apps/analytics-server/src/modules/ai-assistant/page-bridge.service.ts:222-231`：

```ts
} else if (bridge.snapshot.page !== 'sql') {
  throw conflict({ code: 'ai.bridge.notSqlPage', messageKey: 'ai:error.bridge.notSqlPage', message: '当前绑定页面不是自定义 SQL' });
}
```

除 `analysis_edit` 外的**所有** action 都要求页面是 SQL。且其列校验源 `snapshotResultColumns`（`sql-chart-proposal.ts:118-127`）只认 SQL 页的 `analysis.result_columns`，事件页没有这个键。

### 4.3 反向护栏（已存在，保留）

若 AI 把 `_view` / `chart_config` 塞进 `clklog_propose_analysis` 的 `dsl`，事件页的键白名单会抛错并 reject 整条提案：
`apps/analytics-web/src/features/ai-analysis/dsl-form.ts:8-14` 的 `keys(dsl, ['event','metrics','filters','groups','time_range','subject_id','approx'])`，只豁免 `project` / `project_name`。

### 4.4 状态归属：发布快照的拦路石

`chart_config` 当前的拥有者是 `EventAnalysisResult`（本地 `override` state + `readEventChartConfig` 的合成结果），而发布 AI 快照的是 `EventAnalysisPage`。**页面拿不到它**，所以「读」这一步必须先解决归属。

---

## 5. 总体架构

```
事件分析页
  ┌─ EventAnalysisPage ──────────────────────────────────────────┐
  │  拥有 chart_config（本期从 Result 提升上来）                  │
  │    ├─ publishAiContext({ analysis: { dsl, form, loading,      │
  │    │      result_columns, chart_config, view } })  ──► 快照    │
  │    └─ 监听 analysis_chart_edit 提案 ──► 提案条 ──►[应用]──►    │
  │                                          setChartConfig       │
  └───────────────────────┬──────────────────────────────────────┘
                          │ 受控 props
                 EventAnalysisResult（改为受控组件）
                          │
                     ExploreChart（双轴 / 标签策略）

Harness ── clklog_propose_event_chart ──► /tools/page/propose-event-chart
                                              │
                                    pageBridge.propose('analysis_chart_edit')
                                              │
                        按 bridge.snapshot.page 分派域
                          ├─ sql   → parseChartProposal(..., 'sql')
                          └─ event → parseChartProposal(..., 'event')
                                              │
                        校验失败 400/409 · 成功则发提案事件给页面
```

三条关键设计：

- **一个 action，按页分派域**：`analysis_chart_edit`。契约已经是同一份 `ChartConfigV1`，再开一个 action 只会让 Harness 侧出现两份几乎相同的规范段落。
- **域差异集中在物化器的白名单**：图型集合、指标上限、bindings 允许键、`options` 允许键（§7.3）。共享的是校验器 `parseChartConfigV1` 与 `metrics`/`ignored` 的引用校验。
- **提案 ≠ 生效**：服务端只把配置作为提案下发，事件页落成待确认条；SQL 页维持既有的自动应用。

---

## 6. 读：快照增量

`publishAiContext` 的 `analysis` 增加三个键（SQL 页保持原样，只有 `chart_config` 是两域同名）：

```ts
analysis: {
  dsl, form, loading,                    // 既有，不动

  /**
   * 结果列元数据。SQL 域发 { name, type }；事件域发 { name, role, unit }。
   * 两域共用一个键：形状是超集，读取方按需取字段，避免两个域各占一个键后
   * 读取方还要先判断页面才知道读哪个。
   * 事件域的 name 是结果列 key（g_0 / m_0）——ChartConfigV1 的绑定引用的就是它。
   */
  result_columns: Array<{ name: string; type?: string; role?: 'time' | 'dimension' | 'metric'; unit?: string }>;

  /** 当前工作台生效的图表配置（含未保存的调整）；无配置时为 null */
  chart_config: ChartConfigV1 | null;

  /** ChartConfigV1 覆盖不到的展示态（事件域专有） */
  view: {
    event_layout: 'both' | 'chart' | 'table';
    event_chart: string;
    duration_plain: boolean;
    stat_calcs: string[];
    y_unit: string;
  } | null;
}
```

要点：

- `chart_config` 发的是**当前生效值**（`override ?? 自动合成` 合并 `_view.event_chart` 之后的），不是卡片里存的那份。AI 要看到用户此刻在看什么。
- `result_columns.name` 用列 key 而非标题：标题是用户数据且随语言变（i18n v1 §14.3），绑定必须引 key。
- 事件域不发 `type`（事件结果列没有 ClickHouse 类型），SQL 域不发 `role`/`unit`。
- **不进快照的**：`x_label`（AI 不改标签策略）、`ignored`（同）。不是安全考虑，是减少噪音——AI 读到用不上的旋钮只会增加误用面。

---

## 7. 写：action / 物化器 / 工具

### 7.1 action：`analysis_chart_edit`（+ 旧名容错）

`page-bridge.service.ts` 的门禁改为按 action 分派：

| action | 允许的页面 | 说明 |
|---|---|---|
| `analysis_edit` | event / funnel / retention | 既有，不动 |
| `analysis_chart_edit` | **sql / event** | 本期新增；按 `snapshot.page` 选域 |
| `sql_chart_edit` | sql / event | **旧名，同一处理**。仅为部署顺序容错（server 先更新而 host 插件还是旧的时，SQL 图表提案不会突然全挂）。注释标注可在下个迭代删除 |
| 其余 | sql | 既有 |

漏斗 / 留存页收到 `analysis_chart_edit` → 409 `ai.bridge.chartPageUnsupported`（明确拒绝，不静默忽略；PRD R6）。

### 7.2 服务端路由

| 路由 | 处理 |
|---|---|
| `POST /tools/page/propose-sql-chart`（既有） | 保留；内部改发 `analysis_chart_edit`（行为不变，因为页面是 sql） |
| `POST /tools/page/propose-event-chart`（新增） | 发 `analysis_chart_edit` |

网关白名单（`harness-gateway.service.ts` 的 `handleTools`）增加新路径。

### 7.3 物化器按域分派

`sql-chart-proposal.ts` 的 `parseSqlChartProposal(input, columnNames)` 重命名为
`parseChartProposal(input, columnNames, domain: 'sql' | 'event')`（服务端内部函数，调用点只有 `page-bridge.service.ts` 与 spec，不留别名），域差异集中在两张表：

| 维度 | `sql` | `event` |
|---|---|---|
| `chart_types` | table / number / line / bar / pie / **funnel** / trend | table / number / line / bar / pie / trend / **stack / cumulative / distribution** |
| `limits` | line 5、trend 5、bar 4、pie 1、number 8、funnel 8 | line 5、trend 5、cumulative 5、bar 4、stack 4、distribution 4、pie 1、number 8、table 8 |
| `bindings` 允许键 | `x` / `category` / `metrics` / `ignored` | `x` / `series` / `metrics` / `ignored`（**无 `category`**：事件侧饼图也用 `x`） |
| 必填绑定 | line/trend 要 `x`；bar/pie 要 `category` | line/trend/cumulative 要 `x`；bar/stack/distribution/pie 要 `x` |
| `options` 允许键 | 既有集合 | 只允许 `units` / `metric_axis` |
| `roles` | AI 不发，服务端补 | 同左：由 `result_columns[].role` 生成；AI 传了就 400 |

其他共同点（沿用既有 `parseSqlChartProposal` 的行为）：

- 列引用必须命中 `result_columns` 的 `name`，报错时**把可用列回给调用方**（`columnHint`），AI 据此一次改对；
- 超出上限的列一律要求进 `ignored`；
- 产出前过一遍 `parseChartConfigV1(input, columns, domain)`（两域共用的校验器，域白名单已在上一 phase 参数化）。

能力自述（喂给模型的契约）新增 `EVENT_CHART_CAPABILITY`，形状与 `SQL_CHART_CAPABILITY` 一致，`notes` 里点明两件最容易错的事：

> 结果列 key 形如 `g_0` / `m_0`（**不是列标题**）；维度的键名是 `x`（X 轴）或 `series`（拆分系列），**没有 `category`**；
> 指标上限 bar/stack/distribution 4、line/trend/cumulative 5、pie 1；写错列名会 400 并回可用列。

### 7.4 Harness 工具

新增（`analytics-tools/index.mjs`，与 `clklog_propose_sql_chart` 同构）：

```js
register({
  name: 'clklog_propose_event_chart',
  description:
    '把事件分析结果区的图表类型与字段绑定作为提案送到当前页，用户在页面上确认后才生效。' +
    '先 page_read 看 analysis.result_columns 与 analysis.chart_config；' +
    '列名用 g_0/m_0 这类结果列 key；维度键名是 x 或 series，没有 category。' +
    '不执行查询、不保存卡片、不改列角色。',
  parameters: {
    chart_json: { type: 'string', required: true, description: 'JSON：{chart_type, bindings:{x?, series?, metrics[], ignored?}, options?:{units?, metric_axis?}}。' },
    expected_revision: { type: 'integer', required: true, description: 'clklog_page_read 返回的 revision。' },
    reason: { type: 'string', required: true, description: '为何这样绑定与分轴，会显示给用户。' },
  },
  // → POST /tools/page/propose-event-chart
});
```

Harness 侧规范（`ai_workspace/default/`）同步：`TOOLS.md` 增加该工具段；`AGENTS.md` 的「图表字段绑定」从只提 SQL 改为两域并列，并写明**事件侧是提案、SQL 侧是直接写入**这个差异；`analysis-playbook.md` 补一条「量级差异大时优先提议右轴」。

---

## 8. 提案落地（前端）

### 8.1 状态归属重构

`chart_config` 的所有权从 `EventAnalysisResult` 提升到 `EventAnalysisPage`：

| 现在 | 改后 |
|---|---|
| `EventAnalysisResult` 内部 `const [override, setOverride]` + `readEventChartConfig(...)` | `EventAnalysisPage` 持有 `chartConfig` 与 `setChartConfig`；`readEventChartConfig` 的调用移到 Page |
| Result 通过 `initialChartConfig` 等 8 个 props 接收初始值，内部再合 | Result 改为受控：接收 `chartConfig` 与 `onChartConfigChange`，删掉内部的配置状态 |

**单一写入方仍然是单一写入方**（硬门禁 A.13）：从「Result 组件」变成「Page」，没有出现第二个写入者。附带好处是 Result 组件的 props 从 8 个 `initial*` 收敛为受控三件套。

风险：`EventAnalysisPage.tsx` 已经 170 行左右，会再增，但离 1200 行上限很远，且 `features/query/` 生产文件数保持 29（不新增文件）。

### 8.2 revision

`page-context-revision.ts` 的非 SQL 分支（`apps/analytics-web/src/features/ai/page-context-revision.ts:12-15`）现在是：

```ts
const state = context.page === 'sql'
  ? { mode, sql, dsl, time_range, card_id, chart: manualChart }
  : { form: analysis.form, ...(analysis.form ? {} : { dsl: analysis.dsl }) };
```

事件页要带上「AI 会改的那些字段」，否则 AI 基于旧配置提的案不会被 revision 拦下：

```ts
: { form, ...(form ? {} : { dsl }),
    chart: manualChart && {          // 与 SQL 分支同源，另加事件侧会改的 options
      chart_type, roles, bindings,
      metric_axis: options.metric_axis, units: options.units,
    },
    view: analysis.view,             // 展示方式变化也要换版本
  }
```

### 8.3 提案条

事件页新增对 `analysis_chart_edit` 的监听（复用 Page Bridge 事件的既有分发，新增一个与 `useAnalysisProposal` 同构的 hook，或在其旁边加一个 `useChartProposal`）：

```
接收提案 → 校验 revision 未过期 → setChartProposal({ config, reason })
        → 渲染提案条（复用既有建议条的 Alert 样式）
        → [应用] setChartConfig(proposal.config) + setChartProposal(null)
        → [忽略] setChartProposal(null)
```

规则：

- **一次只保留最新一条**，新提案覆盖旧提案。
- 用户自己改了图表配置（`setChartConfig` 来自非提案路径）→ 未应用的提案**自动作废**（已过时）。
- 卡片切换（`cardId` 变化）→ 提案清空。
- 应用提案**不写库**：卡片要等用户点「覆盖保存」。

**placement 与既有建议条的关系**：两者可能同时出现。规则是**提案条优先**——AI 的提案是用户主动要的结果，量级建议是系统主动提的，前者优先级更高；建议条在有提案时隐藏，提案被忽略后再出现（`axis-suggest` 本来就每次都重新计算）。

---

## 9. 安全与限额

| 关注点 | 结论 / 处置 |
|---|---|
| 清洗器会不会吃掉 `chart_config` | **不会**。`ai-context-sanitizer.service.ts:10` 的 `SENSITIVE_KEY` 只按键名匹配，`chart_config` 下的键（`chart_type`/`roles`/`bindings`/`options`/`metric_axis`/`units`/`x`/`series`/`metrics`/`ignored`）均不命中；`metrics` 是数组值，值不做键匹配 |
| 深度限制 `MAX_DEPTH = 8` | `analysis.chart_config.options.units.<key>` 深度 5，安全 |
| 大小限制 128 KiB | `chart_config` 由服务端校验器限制在 32 KiB；快照超限时的三级降级**先丢 `result`**，比 `analysis` 后丢，配置能保住 |
| 敏感值掩码 | 沿用既有（手机号/邮箱/身份证） |
| 用户 PII | `roles` / `bindings` 的键是列 key（`g_0`/`m_0`），值是枚举；不含用户数据 |
| 越权 | 提案走 `pageBridge.propose(identity, ...)`，identity 绑定 runtime，页面必须已连接；不改 IAM |
| 写库 | 提案通道**不写任何表**；卡片保存仍走既有 RBAC 校验（AI 没有保存能力） |
| SSRF / 任意 ECharts option | 沿用既有拒绝（`parseChartConfigV1` 拒绝 `option`/`formatter`/`echarts`） |

---

## 10. i18n

新增文案：

| key | zh-CN | 说明 |
|---|---|---|
| `analysis:aiChartProposal.title` | AI 建议调整图表 | 提案条标题 |
| `analysis:aiChartProposal.reason` | {{reason}} | AI 给的理由（用户数据/模型输出，不翻译） |
| `analysis:aiChartProposal.apply` | 应用 | |
| `analysis:aiChartProposal.ignore` | 忽略 | |
| `analysis:aiChartProposal.applied` | 已按 AI 建议更新图表（未保存到卡片） | toast，明确"未保存" |
| `ai:error.bridge.chartPageUnsupported` | 当前页面不支持 AI 调整图表配置 | 漏斗/留存页 409 |
| `ai:error.bridge.eventChartBindingInvalid` | 图表绑定与结果列不匹配：{{columns}} | 服务端物化失败 |

约定：`{{reason}}` 与 `{{columns}}` 是模型输出 / 列 key，属**不翻译**范畴（硬门禁 24）。13 语言全量补齐；`sql:chart.listSeparator` 继续复用为列举分隔符。

---

## 11. 测试设计

| 文件 | 覆盖 |
|---|---|
| `apps/analytics-server/test/ai-assistant/page-bridge.service.spec.ts`（新增/扩充） | AC1 快照形状；AC3 三页面的 action 放行/拒绝矩阵；AC4 旧名等价；AC9 过期 revision 409 |
| `apps/analytics-server/test/ai-assistant/sql-chart-proposal.spec.ts`（扩充） | AC5 两域图型白名单对照（event 拒绝 funnel、sql 拒绝 stack）；AC6 事件域拒绝 `category`、拒绝 AI 传 `roles`/`x_label`、未知列 400 且回可用列 |
| `apps/analytics-web/src/features/ai/page-context-revision.spec.ts`（扩充） | AC2：仅 `form` 变化、仅 `metric_axis` 变化、仅 `view` 变化、加载态变化四种 |
| `apps/analytics-web/src/features/query/EventChartProposal.spec.tsx`（新增） | AC7：提案条渲染 reason；点「应用」调 `onChange`；点「忽略」不调；用户改配置后旧提案消失；`cardId` 变化清空 |
| `apps/analytics-web/src/features/visualization/chart-config.spec.ts`（既有） | 不改：域白名单已覆盖 |

浏览器实测（release 环境）：

1. 事件分析页 `clklog_page_read` 能读到 `chart_config` / `view` / `result_columns`（含 role）。
2. 让 AI 把「付费率」拆到右轴 → 出现提案条（含理由）→ **先确认图表未变** → 点「应用」→ 双轴出现 → 确认无 `/sa/api/query/` 请求。
3. 读回卡片 `dsl`，确认 `chart_config` 未被写入、`updated_at` 未变。
4. 漏斗分析页让 AI 调图表 → 收到明确的"当前页面不支持"。

---

## 12. 实施拆分与依赖顺序

| # | 切片 | 产物 | 依赖 | 可独立合并 |
|---|---|---|---|---|
| 1 | 状态归属重构 | `chart_config` 提到 Page、Result 改受控 | — | ✅（纯重构，行为不变） |
| 2 | 快照增量 | Page 发布 `chart_config` / `view` / `result_columns`；`ai.types.ts` 扩类型 | 1 | ✅（此时 AI 已能「读」） |
| 3 | revision | `page-context-revision.ts` 事件分支 | 2 | ✅ |
| 4 | 物化器分域 | `parseChartProposal(..., domain)` + `EVENT_CHART_CAPABILITY` + 两域单测 | — | ✅（SQL 行为逐项不变） |
| 5 | action 与路由 | `analysis_chart_edit` 门禁分派 + `/tools/page/propose-event-chart` | 4 | ✅ |
| 6 | 前端提案条 | 提案监听 + 提案条 + i18n | 2, 5 | ✅（此时「写」通） |
| 7 | Harness 工具与规范 | `clklog_propose_event_chart` + `ai_workspace/default/` 三处 | 5 | ✅ |
| 8 | 实测与验收 | 浏览器全流程 + 验收记录 | 1-7 | ✅ |

切片 1 与 4 无依赖，可并行。切片 1 是唯一有回归风险的（受控化改造），先做并单独验证「改绑定/应用建议/保存卡片」三条既有路径不变。

---

## 13. 验证命令与交付证据

```bash
# 门禁
python3 scripts/arch_ratchet.py
python3 scripts/i18n_check.py
python3 scripts/i18n_scan.py --check

# 后端（CI 条件：清空四个密钥变量 + APP_CONFIG_PATH 指向不存在文件）
cd apps/analytics-server && env -u CLICKHOUSE_PASSWORD -u READONLY_CH_PASSWORD \
  -u MYSQL_PASSWORD -u DATABASE_URL APP_CONFIG_PATH=/nonexistent/nope.yaml \
  ./node_modules/.bin/jest --runInBand

# 前端
cd apps/analytics-web && npx vitest run && npm run build
```

交付后按 `AGENTS.md`「实现专用规则」的 release 流程发版，并在浏览器完成 §11 的 4 项实测，
把结果写进 `docs/project/acceptance-clklog-ai-event-chart-v1.md`。

---

## 14. 回滚与失败策略

| 失败点 | 表现 | 处置 |
|---|---|---|
| 切片 1（受控化）出问题 | 事件图表配置错乱 | 单独回滚切片 1，回到 Result 自持状态；此时 AI 仍不能读 |
| 切片 2/3（快照与 revision）出问题 | AI 读到过期配置 | 回滚：快照少发一个键，AI 退回「看不见配置」但不报错 |
| 切片 5（门禁）出问题 | SQL 图表提案受影响 | 回滚门禁改动，`sql_chart_edit` 退化为 SQL-only；事件侧失效 |
| 切片 6（提案条）出问题 | 提案无法确认 | 提案不应用 = 图表不变，是安全失败方向；回滚前端不影响后端 |
| 切片 7（工具）出问题 | AI 不知道有新工具 | 回滚插件与规范，后端能力保留但无入口 |
| 整体回滚 | 不动数据库 | 本 phase **无 schema 变更、无迁移**；回滚只回代码 |

**不允许的处置**：为了让提案通过而放宽 `parseChartConfigV1` 的域白名单、把事件侧也改成自动应用、或让 AI 获得保存卡片的能力。

---

## 15. 实现记录（2026-09-23）

### 15.1 与本方案的偏离

| 处 | 方案原文 | 实现 | 原因 |
|---|---|---|---|
| §7.3 | 物化器重命名为 `parseChartProposal` | 同左，且文件 `sql-chart-proposal.ts` → `chart-proposal.ts`（前端同名文件仍是 SQL 域专用，未改） | 文件名叫 sql 但服务两域会误导；服务端该文件的两个调用点与 spec 一起改了 |
| §7.3 | 「`roles` 由 AI 传了就 400」 | 靠 `chartJsonKeys` 白名单在**更早**的位置拒绝（事件域的 `chart_json` 不含 `roles`） | 原设计里另写一个 `allowRoles` 分支是死代码：白名单已经拦住，且它的报错更好（直接列出可用的键）。删掉分支，只留一个真相来源 |
| §8.1 | `chart_config` 提到 Page，`EventAnalysisResult` 改受控 | 同左，但配置的生命周期封装在 `features/event-chart/use-event-chart-config.ts`（新文件）里由 Page 调用 | 状态归属与生命周期是同一件事；Page 里散着 `useState + useMemo` 不如一个带 `resetKey` 的 hook 清楚，也让 Result 组件的 props 从 8 个 `initial*` 收敛成受控三件套 |
| §7.4 | 新工具参数含 `chart_json` / `expected_revision` / `reason` | 同左；`/tools/page/propose-sql-chart` 与新增的 `/tools/page/propose-event-chart` **合并成一个网关分支**，都发 `analysis_chart_edit` | 两个路径只是入口，处理逻辑完全相同；分开写会复制一段 chart 体解析 |
| §6 | 快照增量 `result_columns` 事件域发 `{name, role, unit}` | 同左，并在 `snapshotResultColumns` 的测试里补了事件形状的用例 | 两域共用同一个键，形状是超集 |

### 15.2 与 SQL 侧的有意差异（复核要点）

| | SQL | 事件 |
|---|---|---|
| 生效方式 | 自动写入结果区 | **用户点「应用」才生效** |
| 拒绝语义 | 不适用 | 点「忽略」→ `accepted:false` + 原因回给 AI；不点 → 5 分钟 TTL 后 timeout |
| revision 纳入 | 仅 `mode='manual'` 时纳入 chart | **无条件纳入**（含 `options.metric_axis` / `units`） |

事件侧 revision 无条件纳入的理由：AI 会基于当前绑定提案，绑定一变，基于旧绑定的提案就该被拦下；
SQL 侧保持原样是因为动它会改变既有 SQL 提案流程的接受/拒绝边界，属本 phase 非目标。

### 15.3 未做 / 待补

- 漏斗 / 留存的图表配置读写：`analysis_chart_edit` 在这两页明确 409（PRD 非目标 3）。
- `preferred_view` / `pivot` 的事件侧语义：事件没有透视视图，提案里的 `preferred_view` 会被接受但不影响展示。
- 自动化回归只有单测覆盖「应用提案不写库」；线上实测见验收记录。
