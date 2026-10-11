# 验收记录：Harness 读写自定义 SQL 图表的编排（分轴与单位）v1

> phase: `clklog-ai-sql-chart-axis-v1`
> 验收日期：2026-09-24
> 对应 PRD：`docs/product/prd-clklog-ai-sql-chart-axis-v1.md`
> 对应架构设计：`docs/architecture/clklog-ai-analytics-design-sql-chart-axis-v1.md`
> 状态：**已发版并在生产环境完成验收**（读 + 写两向，两页都实测；过程中挖出并修掉一个线上回归）

---

## 1. 发版记录

| 版本 | 提交 | 内容 |
|---|---|---|
| 17579 | `ecb531c` | SQL 域 `options` 白名单补 `metric_axis`；`SQL_CHART_CAPABILITY` 补 `options_keys` 与分轴说明；工具描述与 Workspace 规范补「读 `analysis.chart_config`」；harness release 17579 安装 + broker 重启 + `ai-workspace-sync.sh push default` |
| 17580 | `dcec71c` | 修 §4 的线上回归（SQL 页认下图表提案正式名） |

生产 `<html>` 与后端进程均已重启；`.version` 17580，`clklog_analytics_server` RUNNING。

---

## 2. 读：编排对 Harness 是可读的（两页实测）

读入口是模型调用的 `GET /tools/page/read`（`clklog_page_read`）。本轮用**运行时真实凭据**直接调用该 Unix Socket 网关，取回的就是模型看到的那份载荷。

### 2.1 自定义 SQL 页

界面里手工设成「DAU 走右轴 + DOU 单位=美元」后读回：

```
page=sql revision=3 result_columns=[d:Date, DAU:UInt64, DNU:UInt64, DOU:Int64]
chart_config: chart_type=trend mode=manual
  bindings.x=d  bindings.metrics=[DAU,DNU,DOU]  bindings.ignored=[]
  options.metric_axis={"DAU":"right"}   options.units={"DOU":"currency_usd"}
```

四要素（图型 / 字段绑定 / 分轴 / 单位）与页面上所见完全一致 —— 这两处都是**任何推荐器都不会给**的值（最大的指标走右轴、人数用美元），答对即证明是读到的而不是猜的。

### 2.2 事件分析页（修订）

```
page=event revision=22
result_columns=[g_0:time, g_1:dimension, m_0:metric, m_1:metric, m_2:metric]
chart_config: chart_type=line mode=manual
  bindings={x:g_0, series:g_1, metrics:[m_2], ignored:[m_0,m_1]}  options.metric_axis={} options.units={m_2:number}
view={event_layout:both, event_chart:line, duration_plain:false, stat_calcs:[max], y_unit:number}
```

事件侧除编排外还带**展示方式**（`view`）与列角色，读的粒度比 SQL 侧更细。

### 2.3 可发现性

`GET /tools/query/capabilities` 线上返回：

```
sql_chart.options_keys = [orientation, donut, sort, top_n, include_other, units, metric_axis, aggregation, trend, stat_calcs]
sql_chart.notes 含 metric_axis = true
```

（改动前 SQL 侧根本没有 `options_keys` 这一项，模型只能靠试错撞 400。）

---

## 3. 写：模型可以把编排写回去（两页实测）

写侧走模型同款工具路由，载荷形状取自插件实现（`plugin → gatewayCall('/tools/page/propose-*-chart', {chart, expected_revision, reason})`）。

### 3.1 自定义 SQL 页：直接应用

| 观察点 | 结果 |
|---|---|
| 提交 | `POST /tools/page/propose-sql-chart`，`options.metric_axis={"DAU":"right"}` |
| 回执 | `{"status":"applied","applied_revision":6,"delivered":true}` |
| 页面回读 | `mode=manual chart_type=trend bindings.x=d metrics=[DAU,DNU,DOU] metric_axis={DAU:right}` |
| 渲染 | 图表出现两根 Y 轴：左 1,000–9,000（DNU/DOU）、右 8,100–10,200（DAU），DAU 蓝线贴右轴 |

### 3.2 事件分析页：提案 + 用户确认

| 观察点 | 结果 |
|---|---|
| 提交 | `POST /tools/page/propose-event-chart`，`metrics=[m_0,m_2]`、`metric_axis={m_2:right}`（提交里点名「当前只画了人均」以证明读到的现状被用于决策） |
| 页面 | 出现提案条：「AI 建议调整图表：…」+「应 用 / 忽 略」 |
| 确认前 | 图表零变化（与既有设计一致：事件侧必须用户点「应用」） |
| 点「应用」 | 提案条消失，页面回读 `revision=23 bindings={x:g_0,metrics:[m_0,m_2],ignored:[m_1]} metric_axis={m_2:right}` |
| 渲染 | 双轴：左 0–5,000（消耗总量）、右 0–300（消耗均值_人均） |

### 3.3 还原

两页的编排均已还原成测试前的绑定（`metric_axis={}` / 事件侧回到 `series=g_1, metrics=[m_2]`）。**未保存任何卡片**：SQL 侧工具语义是「只写字段设置、不保存卡片」，事件侧应用只改页面状态。

---

## 4. 本次挖出的真 bug（已修，版本 17580）

**现象**：`clklog_propose_sql_chart` 的提案 100% 被拒，回一句「执行请求不是编辑器中的当前 SQL」，页面零变化。

**根因**：上一阶段把图表 action 统一成两域共用的 `analysis_chart_edit`（服务端网关与 page-bridge 都改发新名，旧名 `sql_chart_edit` 只作为「server 先更新、插件还是旧的」部署顺序容错保留），但自定义 SQL 页的处理器**仍只匹配旧名**。于是提案穿过图表分支，落进后面的「执行 SQL」分支，拿空 `sql` 与编辑器比对后被拒 —— 一句完全误导的报错。

**为什么单测没拦住**：那条用例用的是前端自己造得出来的旧名 `sql_chart_edit`，绿灯一直亮着。这与 `acceptance-clklog-ai-event-chart-v1.md` §5.2 记的是同一类错误：**消费端的验证必须用生产端真实产生的载荷**。修完后用例改用 `analysis_chart_edit` + `page:'sql'`。

**修法**：图表分支同时接受两个名字；并在执行分支前加一道显式守卫「只处理 `sql_execute`」—— 以前未识别动作会掉进执行分支，最坏情况是**真的把 SQL 跑起来**。

---

## 5. 未跑通 / 需如实说明的部分

| 项 | 状态 | 说明 |
|---|---|---|
| 浏览器里驱动**真实模型对话** | 本轮未跑通 | 把 Harness UI 作为顶层标签页打开（测试手法，非产品功能）后，视图停在只读预览态：`peer_sessions=0`、消息能输入但 Send 无任何网络请求与 React 事件，dom 节点点击亦无效；应用内面板是跨域 iframe，自动化无法附着。因此 §2/§3 的模型侧调用由 Agent 以**工具边界的等价载荷**发起，并在页面上验证真实行为 |
| 坐标点击注入 | 本环境失效 | `cua.click` 报成功但页面收不到任何 pointer/mouse 事件（已用捕获阶段监听确认）。本轮用页面内 `element.click()` 派发代替；这是测试环境的限制，不是产品缺陷 |
| 漏斗 / 留存页拒绝图表提案 | 仍未线上实测 | 与上一 phase 相同：前端不挂监听，服务端 409 由单测覆盖 |
| SQL 页快照 revision 落后于回执 `applied_revision` | 观察记录 | 提案回执 `applied_revision=6`，随后读回的发布 revision 仍是 5；下一次提案用 5 仍被接受，流程自洽。若后续要做「AI 连续两次改配置」，值得单独确认是否会让第二次误判过期 |

---

## 6. 覆盖对照

| PRD 验收项 | 结果 |
|---|---|
| SC-1 读：`analysis.chart_config.options` 含 `metric_axis` 与 `units` | ✅ 两页实测（§2） |
| SC-2 发现：`sql_chart.options_keys` 含 `metric_axis` | ✅ 线上能力自述实测（§2.3） |
| SC-3 写：提案 `options.metric_axis` 后出现右轴、其余在左轴 | ✅ SQL 页 applied + 截图；事件页确认后生效 + 截图（§3） |
| SC-4 校验：非法轴取值拒绝（页面层） | ✅ 前端 `parseMetricAxis` 单测；服务端只放行白名单键、白名单外仍 400（服务端用例） |
| SC-5 无 X 轴的图型不受影响 | ✅ 单测覆盖（分轴只在 line/trend 的 adapter 生效） |
| SC-6 无回归（事件侧分轴、SQL 绑定提案、revision 与冲突回执） | ✅ 事件侧本轮实测通过；前端 36 文件 / 208 用例、服务端 ai-assistant 14 套 / 131 用例通过 |
| SC-7 门禁 | ✅ `arch_ratchet` 通过；`i18n_check` 通过；`i18n_scan --check` 持平（服务端 `SQL_CHART_CAPABILITY.notes` 新增文案已按规则 `--force --update` 上调 1401→1403 并在提交说明注明） |
