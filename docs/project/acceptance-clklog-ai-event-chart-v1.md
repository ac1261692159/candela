# 验收记录：AI 助手读写事件分析图表配置 v1

> phase: `clklog-ai-event-chart-v1`
> 验收日期：2026-09-23
> 对应 PRD：`docs/product/prd-clklog-ai-event-chart-v1.md`
> 对应架构设计：`docs/architecture/clklog-ai-analytics-design-event-chart-v1.md`
> 状态：**已发版并在生产环境完成验收**；AI 端到端已于 2026-09-24 补跑通过（见 §5.1），期间挖出并修复一个静默丢弃提案的缺陷（§5.2）

---

## 1. 验收范围

让 Harness 对事件分析的图表配置可读、可提案：事件页快照带上当前 `chart_config` / `_view` / 结果列元数据；
新增域中立的 `analysis_chart_edit` action 与 `clklog_propose_event_chart` 工具；事件侧提案**经用户确认**才生效，
不写库、不触发重查。

不做：自动应用、AI 保存卡片、漏斗/留存读写、AI 改查询、AI 改列角色。

---

## 2. 发版记录

| 项 | 值 |
|---|---|
| 变更提交 | `4cbf645` feat(ai) 主体（含两份门禁文档） |
| CI 流水线 | **17552**（当前生产版本） |
| 发版前生产版本 | 17548 |
| 升级方式 | `scripts/server-upgrade.sh`（经 2223 隧道 stdin 执行）；无待执行迁移；重启 `clklog_analytics_server` |
| 部署核验 | `.version`=17552；supervisor RUNNING；`server/dist/.../chart-proposal.js` 存在且含 `parseChartProposal` / `EVENT_CHART_CAPABILITY`；`page-bridge.service.js` 含 `analysis_chart_edit`；前端 14 个 chunk 含提案条文案；harness 插件含 `clklog_propose_event_chart` |

⚠️ **发版踩坑（第二次踩同一类）**：推送后等 130 秒读到的 `.version`（17549）**不是本次提交的流水线**——
CI 的 server 测试 + 前端测试 + 构建比 130 秒慢，`.version` 会先于其余产物写入并被 rsync 先推上去。
更坑的是我第一遍的核验脚本用 `grep -c "chart-proposal.js"` 判存在，而这个串是 `sql-chart-proposal.js` 的**子串**，
得到假阳性。正确做法：

- 按**精确匹配**判文件（`grep -E "(^|/)chart-proposal\.js$"`）；
- 判断「是不是本次提交的产物」要看**新符号**（本次新增的函数名/常量名），而不是只看 `.version`；
- `.version` 与产物不同步时继续轮询模块，不要立刻上机升级（否则按旧产物重启）。

已把这三点补进 `docs/project/legacy-production-handover.md` §十 的发版踩坑小节。

---

## 3. 本地验收

| 检查 | 结果 |
|---|---|
| `python3 scripts/arch_ratchet.py` | passed（`features/event-chart/` 增至 5 个生产文件，仍远低于上限） |
| `python3 scripts/i18n_check.py` | 通过：13 语言 × 16 命名空间，3752 条键 |
| `python3 scripts/i18n_scan.py --check` | 通过：1401 处（基线 1401，本轮 `--force` +11，逐项见提交说明） |
| 后端 `jest`（CI 条件：清空四个密钥变量 + `APP_CONFIG_PATH` 指向不存在文件 + `--runInBand`） | 118 套件 / 907 用例通过 |
| 前端受影响域 | 全绿（`page-context-revision` 7、`chart-proposal` 12、`page-bridge` 19、`EventAnalysisResult` 4 等） |
| 两端构建 | `nest build`、`tsc && vite build` 通过 |
| 前端全量 `vitest run` | 8 个失败（AlertFeedback / MetricDefinitionForm / ChartWorkbench / UserCohortsPage），**逐一单跑全部通过** → `vite.config.ts` 里已记录的「整页渲染用例并行随机超时」既有 flake，与本改动无关 |

---

## 4. 生产验收（浏览器实测）

验收对象：生产 `当时的线上入口`，既有卡片「DAU 和 付费率」（`card_uWhOsaDGti`，3 指标 46,813 / 117 / 0.001）。

| AC | 结果 | 证据（生产实测） |
|---|---|---|
| AC1 快照可读 | ✅ | 拦下页面发给 AI 的快照：`analysis` 的键为 `dsl, form, loading, **result_columns, chart_config, view**`；`result_columns` 形如 `{name:'g_0', role:'time'}` / `{name:'m_0', role:'metric', unit:'number'}`；`chart_config` 含 `bindings{x:'g_0',metrics:[m_0,m_1,m_2]}` 与 `options.metric_axis{m_1:'left',m_2:'right'}`；`view` 含 `event_layout/event_chart/stat_calcs/y_unit` |
| AC2 revision 纳入配置 | ✅ | 单测覆盖（仅 `form`、仅 `metric_axis`、仅 `view`、仅 loading 四种）；线上观测 revision 随操作递增（17 → 23） |
| AC3 action 按页分派 | ✅（单测） | `page-bridge.service.spec.ts` 19 项：事件页走事件域、SQL 页走 SQL 域、漏斗/留存 409 |
| AC4 旧名等价 | ✅（单测） | 同文件：`sql_chart_edit` 与 `analysis_chart_edit` 等价 |
| AC5 事件域白名单 | ✅（单测） | `chart-proposal.spec.ts` 12 项：接受 `stack/cumulative/distribution`、拒绝 `funnel`；SQL 域逐项不变 |
| AC6 拒绝非法提案 | ✅（单测） | 未知列 400 且回「可用列」；`category` 被拒；`roles` 被 `chart_json` 键白名单拒并列出可用键；超上限报出改法 |
| AC7 提案待确认 | ✅ | 线上注入提案后：**提案条出现并显示理由，图表一个像素都没变**（仍是双轴）；点「Apply」才变成单轴（正是注入的 `metric_axis` 全左轴）；点「Ignore」的回绝路径由单测覆盖 |
| AC8 不写库不重查 | ✅ | 点「Apply」后页面内 XHR 钩子记录的 `/sa/api/query/` 请求数 = **0**；读回卡片 `metric_axis` 仍是 `{m_1:'left',m_2:'right'}`（与注入的全左轴不同）、`updated_at` 未被本次操作改写 |
| AC9 过期 revision | ✅（单测） | `page-bridge.service.spec.ts`：过期 revision 的图表提案抛 revision 冲突 |
| AC10 门禁与构建 | ✅ | 见 §3 |

**附带验到的一条设计行为**：提案条消失后，系统级的「指标量级差异 8508×」建议条自动回来了——
即「AI 提案优先于系统建议、提案处理后建议回归」的优先级规则在线上成立。

**另一条附带验证**：重开卡片后 `chart_config` 复现（`mode: manual`、`metric_axis` 双轴在位），
说明快照发的是「当前生效配置」而非临时态。

---

## 5. 未跑通 / 未覆盖的部分（如实记录）

### 5.1 AI 端到端（2026-09-24 补跑，已通过）

首轮验收时这条没跑通（iframe 无法附着）。补跑的办法：**用绑定分析页 tab id 的票据，把 Harness UI 作为顶层标签页打开**——
`POST /sa/api/assistant/host-ticket` 显式带 `tab_id`，运行时因此绑定到分析页那一页，而对话 UI 成了可驱动的顶层文档
（顶层页面不受「iframe 无法附着」的限制）。随后由 Agent 自己向真实模型发指令，走完整链路。

实测证据（生产，版本 17563）：

| 观察点 | 结果 |
|---|---|
| 模型调用 | `clklog_propose_event_chart`，参数正确：`x=g_0`（未用 `category`）、`options.metric_axis={m_1:right,m_2:right}` |
| 页面收到提案 | 轮询返回 `{action:'analysis_chart_edit', page:'event'}` —— **`page` 字段在位**（正是下面那个修复） |
| UI 渲染 | 提案条出现（`bar: true`）+ 到达提示出现（`toast: true`） |
| 确认前 | 图表**零变化**（仍单轴，两条小指标贴底） |
| 点「应用」 | 图表变双轴（左 0–2.1万 / 右 0–250），两条小指标可读 |
| 回执 | 页面回 `{"accepted":true,"current_revision":11,"applied_revision":11}` |
| 不写库不重查 | 页面内 XHR 钩子记录的 `/sa/api/query/` 请求数 = **0** |
| 模型侧 | 工具 1 分 21 秒返回（非 5 分钟超时），并自行观察到 `mode 由 auto 变为 manual，revision 10 → 11` |

### 5.2 这次补跑挖出的真 bug（已修，版本 17563）

**现象**：提案送达了页面，但提案条不渲染、也不回绝，服务端只能等 5 分钟超时——这正是使用者连续三次超时的原因。

**根因**：服务端发事件时 `page` 只给 `analysis_edit` 设置（`...(action === 'analysis_edit' ? { page, dsl } : {})`），
图表类 action 的 `event.page` 是 `undefined`；而 `useChartProposal` 的第一道过滤是 `incoming.page !== page`
→ `undefined !== 'event'` → **直接 return，提案被静默吞掉**。事件已在 `events` 列表里（`delivered` 会是 true），
但页面既不渲染也不 `decide`，所以状态是 `timeout` 而不是 `rejected`。

**修法**：服务端 `page` 对所有 action 都下发；客户端 `page` 缺失时放行（投递通道已按 tab 限定，`page` 只是额外守卫，
严格要求它会把「服务端没下发」变成静默丢弃）。回归断言：`events[0].page === 'event'`。

**教训（写进本节以免重犯）**：之前我「验证过」这条链路，是因为手搓注入事件时**自己多带了 `page: 'event'`**——
用服务端根本不会产生的载荷形状去测自己写的消费端，等于没测。**消费端的验证必须用生产端真实产生的载荷**。

### 5.3 仍未覆盖

| 项 | 状态 | 说明 |
|---|---|---|
| 漏斗 / 留存页拒绝图表提案 | 单测覆盖，未线上实测 | 这两页前端不挂图表提案监听；服务端 409 路径由 page-bridge 用例覆盖 |
| tab id 稳定性 | 观察存疑，未定论 | 自动化导航过程中观察到页面 sessionStorage 里的 `clklog-ai-browser-tab-id-v1` 变化，推测是自动化环境的产物（普通浏览器同源导航不会重置 sessionStorage）。若真属产品行为，页面换 tab id 后旧提案会丢，值得单独确认 |

---

## 6. 需要知会的一件事

卡片「DAU 和 付费率」(`card_uWhOsaDGti`) 的 `dsl.chart_config` 在**今日 11:02 CST** 被写入过一次
（`metric_axis: {m_1:'left', m_2:'right'}`），`updated_at` 随之更新。该写入**不是本次验收操作产生的**：
验收时注入并应用的是「全左轴」，而库里存的是「m_2 走右轴」；且 `updated_at` 早于本次验收。
该卡片此前（上一轮验收结束时）确认过 `has_chart_config: false`。最可能是使用者自己在浏览器里点了「覆盖保存」
（该卡片当时正开在应用内浏览器中）。**未做任何清理**——这看起来是使用者有意保留的双轴配置。

---

## 7. 遗留

| 项 | 说明 |
|---|---|
| 自动应用 vs 用户确认 | 事件侧本期为**用户确认**（与 SQL 侧的自动写入有意不同）。若后续要改成自动应用，只需去掉提案条、在 `useChartProposal` 收到事件时直接 apply |
| SQL 侧 revision 口径 | 事件侧无条件纳入图表配置，SQL 侧仍只在 `mode='manual'` 时纳入。统一需单独评估对既有 SQL 提案流程的影响 |
| ECB-03（`CODE_HANDOVER.md`） | 「拆分系列 + 双轴 + 系列级截断」组合仍只有单测覆盖 |
| ECB-05（`CODE_HANDOVER.md`） | 新增 spec 若触及 `src/config/configuration` 依赖链必崩 CI，仍缺机械防护 |
