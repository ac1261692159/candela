# 验收记录：指标告警重设计 + 告警通知模板（phase: clklog-analytics-alerting-v4）

- 日期：2026-09-15
- 帽子：项目（`docs/project/`）
- 环境：**生产** 生产主机，应用版本 **17185 → 17195**（`cd97840`）→ **17196**（`754d93e` 阈值上限修复）→ **17199**（`8844f92` 通知模板单位修复）
- 上游：PRD `docs/product/prd-clklog-analytics-alerting-v4.md`、实现方案 `docs/architecture/clklog-analytics-design-alerting-v4.md`
- 关联：被取代的卡片告警 `docs/architecture/clklog-analytics-design-alerting-v2.md`、缺陷登记 `CODE_HANDOVER.md`

---

## 1. 结论

**通过**（含三项验收中实测发现：两项当场修复并复测，一项作为性能提示登记）。两条主线全部上线并实测：

- **A. 指标告警重设计**：告警对象从「分析卡片缓存」改为「数据管理 → 指标」，求值复用工作台查询链路；卡片路径（接口、模块、前端类型）整体下线。
- **B. 通知模板**：触发/恢复 × 飞书/邮件/短信六组合可编辑，默认模板预填充占位符，支持 Go 模板子集条件，保存校验/预览/恢复默认/变更审计全部实测。

**用户报告的「新建分析指标告警 500」已从根因上消除**，并在生产用**原触发条件**（重复 `project` 参数）复测为 200。

## 2. 500 的根因与修复验证

| 项 | 内容 |
|---|---|
| 现象 | `GET /sa/api/ops/alerts/cards?project=clklogapp` → 500，前端提示「服务暂时不可用」 |
| 根因 | 前端把 `project` **同时**写进 URL 字符串与 axios `params`，拦截器再补一次 → 实到请求 `?project=clklogapp&project=clklogapp`；Express 对重复 query 参数返回**数组**，原样传给 Prisma → `Argument project_name: Expected StringFilter or String, provided (String, String)` |
| 影响面 | 该功能**自上线起从未成功建过规则**（`alertrule` 中 `source='card'` 计数 = 0），用户看到的「不可用」是持续状态而非偶发 |
| 修复 | ① DTO 层 `@Transform` 规范化（数组取首值，覆盖整个告警控制器，其它接口同样受益）；② 前端 `project` 一律走 `params`，URL 不再手拼 query |
| 复测 | 生产携带**重复参数**请求：`HTTP 200，body code=0，items=3`（旧版此处必 500） |

> 说明：未认证请求返回 401（鉴权先于 DTO 校验），因此「重复参数」的线上复测用的是临时超管会话，做法与 v3 验收一致（会话值由固定短语派生、不回显、用完即删）。

## 3. 验收方法

| 手段 | 说明 |
|---|---|
| 线上真实 API | 临时超管会话直连 `127.0.0.1:3100/sa/api/ops/alerts/*`（建/改/删规则、模板清单/保存/预览/恢复默认） |
| 线上检测器 | 真实 60s 轮询链路：规则 → ClickHouse 求值 → 状态机 → 模板渲染 → 飞书投递 |
| 独立基线对拍 | 事件指标与 `clklog_sa.sa_events` 直接计数对比；留存指标与复刻平台队列口径的独立 SQL 对比 |
| 数据库证据 | `alertrule` / `alertevent` / `alertnotification` / `alerttemplate` / `ops_action_log` / `metasavedmetric` |
| 单测 | 后端全量 **76 套件 / 509 用例**（CI 条件：无 `APP_CONFIG_PATH`）；新增 `alert-template`(14)、`alert-metric-eval`(24)、`alerting-metric-rule`(14)，改写健康度/检测器/投递重试；前端切片 4 文件 / 29 用例 |
| 前端单测 | `vitest run src/features/alerting`：9 用例（含「页面不再出现分析卡片」「新建指标告警入口」「通知模板页签」） |
| 棘轮 | `python3 scripts/arch_ratchet.py` → passed |

## 4. 端到端实测（服务器时间 UTC+8）

### 4.1 造测试指标（用户要求）

| metric_id | 显示名 | 类型 | 定义摘要 | 单位 |
|---|---|---|---|---|
| `metric_alert_self1` | [测试] 今日自检事件数 | 事件 | 事件 `AlertSelfTest` · total_times | 次（规则填） |
| `metric_alert_http01` | [测试] 今日 HTTP 上报事件数 | 事件 | 事件 `base_performance_httprequest_report` · total_times | 次（规则填） |
| `metric_alert_ret01` | [测试] 进入→下单次日留存率 | 留存 | `screen_view` → `scene_trade_sell_event_trigger` · 1 天 · 留存率 | % |

> 三条指标**保留在生产**供后续自测；为它们建的临时规则在验证后已全部删除（见 §7）。

### 4.2 触发 / 持续 / 恢复 / 留存求值 / 自定义模板

| # | 时间 | 动作 | 观察结果 |
|---|---|---|---|
| 1 | 20:22:40 | 规则 `[测试] 今日自检事件缺失`（指标值 0，`lt 1`） | `alertevent` firing **value=0**；投递 `fire/success`（飞书）|
| 2 | 20:24:40 | 规则 `metric_volume_guard`（`gt 1000`）命中 | firing **value=千万级** |
| 3 | 20:24 | **独立基线**：`SELECT count() FROM sa_events WHERE event='base_performance_httprequest_report' AND stat_date=today()` | **千万级** —— 与告警取值同一数量级，差值（约 5k）来自两次测量间隔内新到数据，口径一致 |
| 4 | 20:26:40 | 阈值抬回不可达 → 恢复 | `alertevent` **resolved**；投递 `resolve/success` |
| 5 | 20:27:41 | 写入自定义 fire 模板（带「告警模板自检」标记）后再次命中 | firing **value=千万级**；投递 `fire/success`（该条飞书消息带自检标记，模板渲染生效路径实测） |
| 6 | 20:27:57 | 留存指标规则（`lt 100%`） | firing **value=11.8**（即 11.8%） |
| 7 | 20:28 | **独立基线（复刻平台队列口径：窗口内首次做初始事件的日期）** | 队列 `2026-09-14` D1 = **11.8%**，与告警取值**完全相同**；`2026-09-15` 队列未成熟被正确掩码跳过 |
| — | — | 求值失败日志 | 无（`指标求值失败` 零命中） |

> §4.2 第 3 与第 7 条是本次验收最重要的两条证据：**告警判定的数与独立算出的数一致**，说明「工作台口径 = 告警口径」成立。

### 4.3 真实 API 路径（用户操作路径）

| 接口 | 结果 |
|---|---|
| `GET /ops/alerts/metrics?project=clklogapp` | 200，3 条指标，带 `kind_label` / `alertable` / `definition_summary` / 单位（留存指标单位 `%`）|
| `GET …&project=clklogapp&project=clklogapp`（历史 500 条件） | **200** |
| `POST /ops/alerts/metrics/:id/probe` | 事件指标：千万级（1,264 ms）；留存指标：11.8%（20,294 ms）|
| `POST /ops/alerts/rules`（1e8 阈值，`window_days=2`） | 200 → `metric_de4993a07962` |
| `PUT /ops/alerts/rules/:code`（`window_days=7`） | 200；规则表读回 `窗口 7 天 / 健康 ok / 指标名带出` |
| `GET /ops/alerts/templates` | 200，6 个组合 + 20 个占位符变量；默认模板含 `{{if eq .status_code "resolve"}}` 条件 |
| `POST /ops/alerts/templates/preview` | 渲染 `✅【恢复】今日上报量过低 当前值 1,204次` |
| `PUT …/templates/fire/feishu_webhook`（非法模板 `{{if}}` 未闭合） | **400**「模板语法错误：存在未闭合的 {{if}}（缺少 {{end}}）」 |
| `PUT` 合法模板 → `DELETE`（恢复默认） | 200/200；`alerttemplate` 行数 1 → 0 |
| `ops_action_log` | `alert_template_update` / `alert_template_reset` 带 `kind`/`channel`/操作人 |

### 4.4 浏览器真实用户路径（临时超管会话，验收后已删除）

用临时超管账号（`project_owner`）在浏览器里走了一遍真实点击路径，三处界面与预期一致：

| 界面 | 观察结果 |
|---|---|
| 数据管理 → 接入指南 | 三组入口全部渲染（客户端 9 / 服务端 9 / 其他 2）；PHP、Go、HTTP 带「已实测」绿标，其余「暂未开发」；点 PHP 打开完整文档抽屉（步骤 + 代码块 + 复制）；点 Java 弹「Java：暂未开发」并给出「可先用 HTTP 协议接入」指引 |
| 运维 → 监控告警 | 页签含新增的「通知模板」；右上按钮为「**新建指标告警**」；概览显示今日触发 13 / 未恢复 0 / 通知失败 0 |
| 新建指标告警（原 500 的位置） | 抽屉正常打开；指标下拉列出 3 条测试指标并标注类型（事件指标 / 留存指标）；选中后自动带出定义摘要 `事件 base_performance_httprequest_report · 计算 total_times`；点「测试取值」显示 **当前值：千万级（今天，耗时 1290ms）**；规则名自动预填 |
| 通知模板 | 默认模板正文预填充占位符（含 `{{if eq .status_code "resolve"}}` 条件）；20 个占位符标签可点击插入；点「预览」渲染出示例通知 |

> 浏览器验证还**抓到一个缺陷**（见 §6 第 4 条）：默认模板把单位拼了两遍（`当前值：1,204次次`）。修复后已在同一界面复验：`当前值：1,204次（条件：大于 1,000次）`。

## 5. 需求 → 证据矩阵

| 需求 | 证据 | 结论 |
|---|---|---|
| A-1 指标为告警来源、不再有卡片 | §4.3 metrics 接口 + 前端规则表「指标」列与「不再出现分析卡片」用例 | ✅ |
| A-2 500 消失且同类缺陷修复 | §2 复测 200 + `normalizeProjectParam` 回归测试 | ✅ |
| A-3 清单 + 测试取值 | §4.3（含耗时、单位）| ✅ |
| A-4 规则可配项 | §4.3 建/改规则 + 规则表读回 | ✅ |
| A-5 健康度可见 | 单测 `metric_missing` / `metric_eval_failed`（连续 3 轮失败）| ✅ |
| A-6 求值有界 | 单轮每规则 1 查询（日志无并发求值）、`MAX_METRIC_RULES=20`、窗口白名单 1/2/7/30 | ✅ |
| A-7 端到端取证 | §4.1 + §4.2 | ✅ |
| A-8 迁移干净 | 迁移把 `source='card'` 停用；生产卡规则数 0 | ✅ |
| B-1 六组合可编辑 + 默认预填充 | §4.3 templates | ✅ |
| B-2 占位符清单可插入 | 20 个变量 + 前端空格子点击插入 + 单测（清单变量与默认模板一致）| ✅ |
| B-3 Go 模板子集 | 单测 13 例（含 `or (eq …) (eq …)`、嵌套、`{{- -}}` 裁剪）| ✅ |
| B-4 保存校验 400 | §4.3 非法模板 400 | ✅ |
| B-5 预览 | §4.3 preview 渲染结果 | ✅ |
| B-6 恢复默认 | §4.3 行数 1 → 0 | ✅ |
| B-7 变更审计 | §4.3 审计行 | ✅ |
| B-8 邮件主题 / 短信截断 | 单测（`collapseForSms` ≤40）+ 模板清单含 `subject` | ✅ |
| B-9 模板渲染真实生效 | §4.2 第 5 条（自定义模板投递成功）| ✅ |

## 6. 验收中发现的问题

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 中（已修） | **阈值上限 100 万**：`POST /rules` 提交 1e8 被 400 拒绝（`threshold must not be greater than 1000000`）。当日事件量已达 1000 万+，「大于阈值」类告警永远命中 → 该用法不可用 | 上限放宽到 1e12（前后端同步），补「千万级可用 / 1e12 以上仍拒绝」单测；发版 17196 后按真实 API 复测通过 |
| 2 | 低（登记） | **留存指标求值较慢**：31 天窗口 + 两事件，单次 20.3 秒（事件指标 1.3 秒）。60s 轮询下不会叠加（重入保护），但留存类规则多时一轮检测会明显变长 | 见 `CODE_HANDOVER.md` AL-04：建议留存类指标支持更长的评估间隔或收窄窗口 |
| 3 | 提示 | 首次留存对拍我用了错误基线（把队列当成「当天做过初始事件的人」），算出 45% 与告警 11.8% 不符；复刻平台口径（窗口内**首次**触发初始事件的日期）后完全一致 | 记入 `CODE_HANDOVER.md` AL-05，避免下次再误判为缺陷 |
| 4 | 中（已修，浏览器实测发现） | **通知内容单位重复**：`{{.value}}` / `{{.threshold}}` 渲染时已由 `formatMetricValue` 带上单位，默认模板又追加 `{{.unit}}` → 实际通知与预览都会出现「当前值：1,204次次」「条件：大于 1,000次次」 | 默认模板（含短信）去掉 value/threshold 之后的 `{{.unit}}`；示例值带上单位使预览=真实渲染；补结构断言（value/threshold 后不得紧跟 unit）+ 渲染断言（不得出现「次次」/「%%」）；发版 17199 后在界面复验通过 |

## 7. 收尾状态

| 项 | 状态 |
|---|---|
| 生产版本 | **17199**，`clklog_analytics_server` / `clklog_analytics_ingestor` 均 RUNNING |
| 迁移 | `20260915210000_alert_metric_template` 已应用（`alertrule.metric_id` / `window_days` / `alerttemplate`）|
| 指标规则 | 0 条（临时验证规则全部删除，无遗留触发中的规则，不会继续发飞书）|
| `alerttemplate` | 0 行（自定义模板已恢复默认）|
| 测试指标 | **保留 3 条**（`metric_alert_self1` / `metric_alert_http01` / `metric_alert_ret01`），可在「数据管理 → 指标」查看并直接用于建告警 |
| 临时账号 | 已删除（`sauser` 中 `zz_alert_verify` 计数 0）|

### 复现测试规则的方法（界面上 3 步）

1. 运维 → 监控告警 → **新建指标告警**；
2. 项目 `clklogapp` → 指标选「[测试] 今日 HTTP 上报事件数」→ 点**测试取值**确认当前值；
3. 条件填「> 1000 万」→ 保存，等 60 秒看是否触发与飞书内容（模板可在「通知模板」页签改）。
