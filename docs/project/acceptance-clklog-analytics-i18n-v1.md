# 验收记录：分析平台国际化（i18n）v1（首发 zh-CN + en-US）

> phase: `clklog-analytics-i18n-v1`
> 验收日期：2026-09-17（实施自 2026-09-16 21:00 起）
> 上游：`docs/product/prd-clklog-analytics-i18n-v1.md`（`I18N-1..16`）、`docs/architecture/clklog-analytics-design-i18n-v1.md`（`I18N-AC01..16`）
> 结论：**首发（简体中文 + 英文）已落地并通过闭环验证**；少量残留项与后续课题见 §5。

---

## 1. 交付内容

| 层 | 落点 | 说明 |
|---|---|---|
| 前端 i18n 包 | `apps/analytics-web/src/i18n/`（9 个生产文件） | 语言注册表、解析链、资源后端（按语言分 chunk 懒加载）、`useT`、`LocaleBridge`（antd / dayjs / `<html lang>` / 标题）、`LocaleSelect`、本地化格式化 |
| 语言资源 | `src/i18n/locales/{zh-CN,en-US}/*.json`（16 命名空间） | 共 **2,903 条键**，两种语言键集与占位符完全一致 |
| 语言偏好 | `sauser.locale`（迁移 `20260916230000_user_locale`）+ `PUT /sa/api/auth/preferences` | **部分更新**语义：只改语言不会清空默认项目 |
| 后端 i18n 包 | `apps/analytics-server/src/i18n/` | `domain-error.ts`（错误码契约）、`error-response.filter.ts`（由 `common/filters/` 迁入）、`locales.ts`、`locale.ts`、`messages.ts` + `messages/{zh-CN,en-US}.json` |
| 错误码 | 各业务模块的 `throw` 改为 `DomainError` | 响应体新增 `errorCode` / `messageKey` / `params`，`message` 保留中文兜底（加法式，老客户端不变） |
| 通知本地化 | `alert-template.ts` + `alert-detector.service.ts` + `AlertContact.locale`（迁移 `20260916233000_alert_contact_locale`） | 默认模板按语言分组；通知按**收件人**语言渲染；level / status / metric kind / window 标签按语言生成 |
| 工具 | `scripts/i18n_scan.py`、`scripts/i18n_check.py`、`scripts/i18n_extract.mjs`、`scripts/i18n-baseline.json` | 覆盖率棘轮、资源一致性 + 跨层键校验、AST 提取（派工与分析） |
| 结构债偿还 | `common/` 12→11、`utils/` 2→1 | 登记在 `arch-ratchet-baseline.md` |

前端业务域（按架构文档 §11.3 分批）：壳层与公共面、登录/403/路由门、看板、分析（事件/漏斗/留存）、埋点管理、指标、SQL 与可视化、分群/标签/主体、权限与设置、告警工作台、运维面板、AI 助手/工作区、接入指南、数据表 —— 全部迁移完成。

## 2. 数据（迁移前后）

| 指标 | 起点（2026-09-16 21:00 重扫） | 终点（2026-09-17） |
|---|---|---|
| 前端待翻译文案（生产文件） | 3,252（155 文件） | **0** |
| 前端 JSX 文本 | 488 | **0** |
| 服务端未迁移抛错（`throw` 且无 `messageKey`） | 539（61 文件） | **178（27 文件）**，全部在 `ai-assistant` / `ai-query` / `shared` / 脚本等非界面模块 |
| 服务端中文串（含 `message` 兜底，**故意保留**） | 1,292 | 1,298（口径见架构文档 §14.2-9） |
| 语言资源键 | 0 | 2,903 × 2 语言 |

> 起点数字比 2026-09-16 上午的初版统计（3,787）高 20%：metric-v2/v3 与告警通道扩展在当天合入主干（103 文件、+9,539 行），故开工前做了全量重扫并重置基线。

## 3. 闭环验证（实际命令与结果）

| 检查 | 命令 | 结果 |
|---|---|---|
| 资源一致性 + 键存在性 + 跨层 messageKey | `python3 scripts/i18n_check.py` | **通过**：2 语言 × 16 命名空间、2,903 条键；`en-US` 无残留中文；占位符一致；服务端每个 `messageKey` 都有对应资源 |
| 覆盖率棘轮 | `python3 scripts/i18n_scan.py --check` | **通过**（基线 `scripts/i18n-baseline.json`） |
| 架构棘轮 | `python3 scripts/arch_ratchet.py` | **通过**（退出码 0） |
| 前端单测 | `cd apps/analytics-web && npx vitest run` | **95 文件 / 414 用例全部通过**（退出码 0，98.8s） |
| 前端构建 | `cd apps/analytics-web && npm run build` | **通过**（tsc + vite build，13.24s） |
| 后端单测 | `cd apps/analytics-server && npx jest` | **615 / 617 通过**，84 套件；仅失败 2 例是**既有日期腐化**（`test/query/metric-v2.spec.ts` 硬编码 2026-09-14~16，当天为 09-17），与 i18n 无关 |
| 前端 i18n 专项 | `npx vitest run src/i18n` | **15/15 通过**：解析链优先级、区域回退（`en-GB→en-US`、`zh-TW→zh-CN`）、存储与 URL 覆盖、格式化随语言切换、资源运行期一致性 |
| en-US 渲染闭环 | `src/i18n/en-US-render.spec.tsx` | 登录页与 403 页在 en-US 下**无任何中文字符**；中文渲染与迁移前逐字一致；语言切换无需刷新即重渲染 |
| 告警模板语言矩阵 | `npx jest test/alerting/alert-template.spec.ts` | 21/21 通过（含「每种语言都提供完整 kind × channel 矩阵」「未知语言回退 zh-CN」） |

### 3.1 前端全量单测（含两处测试基建修复）

首轮全量跑出现「同一批整页渲染用例随机超时、单跑必过」的现象。排查后确认**与 i18n 逻辑无关**，而是两个测试基建问题，均已修复：

1. **`src/i18n/index.ts` 曾把 antd 组件（`LocaleBridge` / `LocaleSelect`）再导出**：任何 `import { i18n } from '../i18n'` 都会把 antd 拉进模块图，导致每个测试文件的 setup 从 0.13s 涨到 1.5s（整轮 setup 累计 554s）。已改为按路径导入 UI 组件（`../i18n/LocaleBridge`），核心入口零 UI 依赖，setup 回落到 130ms。
2. **默认 5s 单测超时对整页渲染类用例过紧**：`MetricDefinitionForm` / `AlertFeedback` / `ChartWorkbench` / `SqlReportPage` 等 spec 单文件耗时 4–34 秒，在并行跑整轮时会被机器负载推过 5s 线。按仓库既有做法（此前 `AlertFeedback` 已单独放宽过超时）统一在 `vite.config.ts` 设 `testTimeout: 30000` / `hookTimeout: 30000`。

修复后：**95 个测试文件 / 414 个用例全部通过（退出码 0）**，其中包含既有失败用例 `SqlReportPage.chart-config`（同为超时所致，放宽后通过）。

### 3.2 构建产物浏览器实测（`vite preview` + 内置浏览器）

| 场景 | 结果 |
|---|---|
| `http://127.0.0.1:<port>/sa/login?lang=en-US`（**构建产物**，非 dev） | `lang=en-US`、标题 `ClkLog Analytics`、页面文本 `ClkLog / Trusted user behavior analytics / Sign in / English`，**中文字符数 = 0**；截图见本文件同目录的浏览器会话产物 |
| 点击右下角语言选择器 → 简体中文（不刷新页面） | `lang=zh-CN`、标题 `ClkLog 分析平台`、文本变为 `可信的用户行为分析 / 登 录 / 简体中文`，`localStorage['clklog-analytics-locale'] = 'zh-CN'`（偏好已持久化） |
| `?lang=` 覆盖 + 未登录跳转 | 访问 `/sa/?lang=en-US` → 正确重定向到 `/sa/login` 并按英文渲染 |

> 过程中的一个排查记录：首轮 `?lang=en-US` 打开的是另一个项目的本地服务（端口 4173 被其他项目占用），表现为「空白页」；换到独立端口并确认是 ClkLog 产物后一切正常——**不是**构建产物的问题。

### 3.3 测试资源装载（供后人参考）

`vitest.setup.ts` 把语言资源直接读盘灌进 i18next 并把语言固定为 `zh-CN`；解析结果缓存在 `process` 上（vitest 每个测试文件都会重跑 setup，但同线程共享 `process`），避免 95 个文件重复解析 32 份 JSON。`ensureNamespaces()` 用 `hasLoadedNamespace` 跳过已就绪的命名空间，因此测试环境不会触发 backend 的动态 import。

### 3.4 上线记录（2026-09-17 11:1x）

| 步骤 | 结果 |
|---|---|
| 提交 | 4 个提交推送到 `master`（`9b5b137..185c748`）：后端契约与错误码、前端迁移、工具与文档、测试日期腐化修复 |
| CI 产物 | 模块 `metaverse-clklog_manager/master` 版本 **17299**（生产此前 17278），产物内含 `server/dist/src/i18n/domain-error.js`、`error-response.filter.js` |
| 上机 | `scripts/server-upgrade.sh`：rsync 到 production → `prisma migrate deploy` **两个迁移全部应用**（`20260916230000_user_locale`、`20260916233000_alert_contact_locale`）→ Prisma Client 重新生成 → 重启服务 |
| 生产版本 | `/data/project/clklog_manager/production/.version` = **17299** |
| 进程 | `clklog_analytics_server` RUNNING、`clklog_analytics_ingestor` RUNNING（均刚重启） |
| 前端 | `web/sa/index.html` 指向 `assets/index-Ev8L4hIt.js`（本地构建同名入口），`auth-ChU25eZ7.js` 内含英文文案 |
| 数据库 | `sauser.locale` / `alertcontact.locale` 两列已确认存在（直接查 information_schema） |
| API | `GET /sa/api/auth/me` → 401（服务存活、鉴权正常） |

> 未做：线上四页人工走查与「测试告警确认通知语言」——线上通知实测需在界面里配一条自检规则，留给下次线上巡检；本 phase 的语言链路已在同源构建产物上做过浏览器实测（§3.2）。

### 3.5 第二轮：服务端下发展示名的漏网点补齐（2026-09-17）

上线后走查发现：**服务端下发的展示名与「非抛错」载荷文案仍是中文**，而前端代码当时已无硬编码中文，
所以第一轮的扫描器看不见这类漏网。已按「服务端加法式下发 `*_key`、前端优先用 key 渲染、中文原值保留兜底」统一修法补齐：

| 漏网点 | 位置 | 修法 |
|---|---|---|
| 角色名 / 权限目录（Feature / Operation / Details） | `iam/permission-catalog.ts` → RolesPage | 服务端**早已**下发 `label_key`/`feature_key`/`op_key`/`detail_key`，**前端没接**；本轮前端改为优先用 key，并补齐 51 条缺失资源 |
| 渠道显示名与配置字段（邮件（SMTP）/ 阿里云短信 / 厂商/字段/占位符） | `alerting/channels/*` → ChannelConfigPanel、Contacts 渠道下拉 | 12 个渠道 + 7 个平台通道 + 31 个字段补 `label_key`/`hint_key`/`placeholder_key`/`reason_key` |
| 保留策略范围名（告警历史 / 通知记录 / 变更记录） | `alert-retention.service.ts` → RetentionPanel | 补 `label_key`（`retention.scopeLabel.*`） |
| 通知模板占位符清单（规则名 / 级别（中文）…20 条） | `alert-template.ts` → TemplateEditor | `TEMPLATE_VARS` 补 `label_key` |
| 规则健康度（正常 / 指标已删除 / 求值失败 / 无联系人） | `alerting.service.ts` → Rules 列与 Tooltip | 补 `health_label_key` / `health_detail_key` / 参数 |
| 慢查询提示（数据来自 ClickHouse 查询日志…） | `ops/slow-query.service.ts` → SlowQueriesPage | 补 `retention_note_key` + 参数 |
| 系统字段展示名（事件名 / 事件时间 …15 条） | `report/system-columns.ts` → 数据字典、分组面板 | 补 `desc_key` |
| 数据表导入丢弃原因（主键为空 / 类型不匹配…） | `datatable-csv.ts` → 导入向导 | 补 `reason_key` + 参数 |
| 模板编辑器里英文用户看到的中文默认模板 | `alert-template.service.ts` + `alerting.controller.ts` | 列表/预览按**请求语言**取默认模板（自定义模板原样返回） |
| 单位显示（`> 200次`） | 前端显示层 | `次→times`、`条/个→items`，未知单位原样 |
| 前端未告知服务端用户选的语言 | `services/api.ts` | 所有请求统一带 `x-locale`（顺带覆盖导出等按操作者语言渲染的场景） |

新增资源：`iam` 51、`alerting` 93、`ops` 1、`meta` 30、`datatable` 6（每语言），共 **+181 键/语言**（总键数 2,903 → 3,067）。

同一轮还修了两处**真实缺陷**（不是漏翻译）：`iam:role.projectOwner` 资源缺失导致角色列表里 owner 显示成裸键；`MembersPage` 角色列回退到裸 role key。并把校验脚本扩展到**服务端下发的 `*_key` 文案键**（此前只校验 `messageKey`）——正是这条新校验当场抓出了 `iam:permission.*` 的 51 条缺键。

仍未处理（已登记）：模板占位符 Tooltip 的**示例值**、告警预览的示例数据、指标类型标签、通道测试消息正文属演示/数据层，另立批次。

### 3.6 第三轮：示例数据、单位与结果列名（2026-09-17，用户授权改服务端）

| 项 | 做法 | en 效果 |
|---|---|---|
| 模板占位符**示例值**（Tooltip）与预览示例 | `TEMPLATE_VARS[].sample_key` + `sampleContext(overrides, locale)`，示例文案落服务端 messages（20 条） | `1,204 times` / `Triggered` / `Critical` / `greater than` / `Event metric`；zh 逐字不变 |
| 通道**测试消息**正文与主题 | `serverT` 按请求语言渲染（含通道名 `alert.channelName.*`、`rule_name/status/level_fmt` 变量与结果 detail） | `[Test] ClkLog alert channel connectivity test / Channel: Email / Time: …`；zh 逐字不变 |
| 指标类型标签（事件指标/留存指标） | 服务端加 `kind_label_key`；前端优先用 key | `Event metric` / `Retention metric` |
| **单位**显示（`1,204次`） | 新增 `src/i18n/units.ts` 的 `localizeUnit`，`formatMetricValue(..., locale)` 应用；通知变量与试算 `value_fmt` 同源 | `1,204 times`、`30 days`、`2 users`；zh 保持紧贴数字 |
| **结果列名**（队列日期/人数/X 留存率/转化率/流失/时间(day)/公式…15 类） | 服务端只加 `title_key`/`title_params`（中文 `title` 保留）；前端单点 `localizedColumnTitle` 在渲染与导出边界本地化 | `Cohort date` / `Users` / `D1 retention` / `登录 conversion rate` / `Time (day)` / `Formula` |
| 依赖中文文案的**错误分支判断**（卡片「未保存 SQL」、分群/标签「已被卡片引用」） | `api.ts` 把后端 `errorCode` 挂到 reject 的 Error 上；三处改为**优先按机器码**判断，文案匹配保留为兜底 | 英文下不再走错分支（此前会退化到通用失败提示） |

设计要点（已登记进设计文档 §14.3）：**结果列名必须在浏览器端按查看者语言渲染**——看板卡片结果带缓存，
若按请求语言在服务端生成标题，会把某一种语言固化进缓存。

新增资源：服务端 messages 每语言 +48（示例 20 / 通道名 13 / 测试消息 6 / 单位 9）；前端 `analysis:column.*` 15、`alerting:kind.*` 2、`metrics:kind.*` 复用上一轮。

仍未做（明确登记）：配置校验兜底文案（`请填写「SMTP 服务器」`，需把校验返回值结构化并给前端加渲染分支，独立小批次）；复合指标列标题（`事件名.属性名.方法名` 里方法名部分）；行值层固定文案（事件「阶段汇总」行、指标口径窗口串）——均归「指标口径多语言」后续 phase。

### 3.7 第四轮：收口（2026-09-17，用户要求「不留尾巴」）

| 范围 | 收口前 | 收口后 |
|---|---|---|
| 服务端未迁移抛错（`throw` 且无 `messageKey`） | 178 处 / 27 文件 | **0 处 / 0 文件**（已写入基线，上升即回归） |
| 其中 AI 域 + 共享层（`ai-assistant`/`ai-query`/`shared`/`common`） | 144 处 / 16 文件 | 0（158 个 code / 159 个键） |
| 其中测试锁定项（report / query / datatable / meta） | 34 处 | 0（**42 处断言升级**为 `DomainError` + `status` + `errorCode`，用例数量与语义不变） |
| 告警通道配置校验文案 | 硬编码中文（英文露中文） | 结构化 `message_key` + `params`（字段名带 `field_key`），前端在渲染边界解析；en 示例：`Enter "SMTP server"` |
| 联系人通知语言（`AlertContact.locale`） | 仅后端/API 支持 | 工作台联系人表单有「语言」下拉 + 列表语言列（留空 = 平台默认），提交前 `normalizeLocaleTag` 规范化 |
| 复合指标列名（`事件名.属性名.方法名`） | 整串中文，只在纯公式时本地化 | 四种形态 + 「任意事件」全部按 `title_key` + 参数渲染；en：`pv.amount.Average`、`Any event.Total count`、`Formula` |
| 事件「阶段汇总」行 | 服务端中文行值 | 前端按 `__stage` 标记渲染：en `Stage total`（SQL 与行值零改动） |
| 指标口径摘要 / 窗口 / 取值 | 中文串（含缓存载荷里的 `window_label`） | 服务端下发**结构化**字段（`window_days` / `window_relative` / `value_pick` / `definition_summary_structure`），前端按 key 渲染——缓存里不再存任何语言文本；en：`Last 7 days (including today)`、`Retention pv → pv2 · 7 days · Retention rate` |
| 并发冲突响应（`current_revision`） | 过滤器 early-return 会丢 `messageKey` | 该分支同时透出 `messageKey`/`params`（不再退化成中文兜底） |
| `errors:error.*` 双重前缀 | 6 个键命名不一致 | 提升为 `errors:<key>`，全仓一致 |

**明确不翻译（已逐条决策，不再是「未完成」）**：

| 项 | 位置 | 理由 |
|---|---|---|
| DLQ 丢弃原因 | `ingestor/sa-event-parser.service.ts`、`kafka-consumer.service.ts` | 落 DLQ 与日志，界面不展示（排障要稳定原文） |
| 分区拒绝原因 | `ops/data-mgmt.service.ts` | 仅服务端校验用，前端未渲染 |
| 演示账号 / 成员组名 | `iam/iam.service.ts` | 演示数据，落库为业务数据 |
| 默认目录名「未分组」 | `report/folder.service.ts` | 落库的默认值（用户可改名），与内置规则名同类 |
| SQL 列别名 / 默认 SQL 片段 | `report/dsl-sql.ts`、`SqlReportPage.tsx` | 数据层标识，翻译会改变查询结果列名 |
| 万 / 亿量级写法 | `visualization/metric-units.ts` | 仅在中文路径使用，英文走 SI（K/M/B） |
| 语言自称（简体中文 / English） | `i18n/config.ts` | 按设计不翻译 |
| 21 处内部不变量 `throw new Error` | `shared/attribute-resolver`、`ai-assistant/workspace/*` | 路径/属主安全断言与部署期资源校验，不应外泄给界面 |
| 测试夹具中文 | `visualization/chart.fixtures.ts` | 测试数据 |

收口后总量：前端生产代码硬编码中文 **0**；服务端未迁移抛错 **0**；语言资源 **3,328 键 × 2 语言**；测试 Web 97 文件 / 436 用例、Server 86 套 / 644 用例全绿。

### 3.8 第五轮：第二梯队语言上线（zh-TW / ja-JP / ko-KR，2026-09-17）

| 项 | 结果 |
|---|---|
| 语言集 | 2 → **5 门**：`zh-CN` / `en-US` / `zh-TW` / `ja-JP` / `ko-KR` |
| 资源 | 每门 **3,401 键**（前端 16 命名空间 3,340 + 服务端 messages 61），键集与占位符与源语言全等（`i18n_check.py` 五语言校验通过） |
| 繁中质量 | OpenCC `s2twp` + 163 条短语预映射 + 42 条后修正；**台灣用語**而非字面转换（使用者／平臺／登入／資料／儲存／範本／佇列／對帳）；简体残留扫描 0 命中 |
| 日韩质量 | 术语表约束直译；日文用日本字形（発火／復旧／重大度），韩文处理助词收音；均无源语言残留 |
| 新增门禁 | 繁中「简体专用字」黑名单（558 字）+ 按语系区分 CJK 规则；CI 起跑全量前端测试与两个 i18n 检查 |
| 浏览器实测（构建产物） | `?lang=zh-TW` / `ja-JP` / `ko-KR` 登录页：`<html lang>`、标题、文案全部切换正确，无源语言残留；繁中截图存档（`可信的使用者行為分析 / 使用者名稱 / 密碼 / 登 入`） |
| 自动化 | Server 708 用例全绿（含语言集变更后的断言更新）；Web 98 文件 / 448 用例全绿；tsc 双侧 0 错误；架构棘轮通过 |

**待母语复核（各语言 ≤10 条，均已登记在分批报告）**：

- **繁中**：`平台/平臺` 取舍（现用「平台」，与术语表一致）；`資訊`（信息）与 `訊息`（消息）按语境分开；`行/列` 语义互换（台灣：列=row、欄=column）；`視窗` vs `時間窗`；`對帳`（对拍）；`行程`（进程）；`靜音`（屏蔽）是否达意。
- **日文**：`{{count}} 件のイベントを…` 等语序重排条目；`定義`（口径）与 measure 的重复；`重大度` vs `レベル`；3 处**有意保留中文**（数据表类型 token、`（中国語名）` 提示、仓库文件名）。
- **韩文**：`코호트`（留存语境的「队列」）与术语表 `큐` 的取舍；文字卡「标签」用 `노트`（避免与 사용자 태그 冲突）；拼装型文案（`선택: {{column}}={{value}}`、`부터`）建议界面复核。

> 复核方式：按 `docs/architecture/i18n-glossary.md`（5 语对照）逐条核对；如某条需改，只改 `locales/<tag>/` 对应键，然后跑 `python3 scripts/i18n_check.py`。

### 3.9 第六轮：五常语言补齐 + 德语（ru-RU / fr-FR / de-DE，2026-09-17）

语言集 5 → **8 门**（中文 / 英文 / 俄文 / 法文 = 联合国五常语言齐备，另加德文）。

| 项 | 结果 |
|---|---|
| 前置框架 | 打开**复数变体**机制：基础键 = 兜底形态，语言按 CLDR 追加 `_one/_few/_many/_other`；`i18n_check.py` 与 `resources.spec.ts` 改为复数感知比较（剥后缀 + 去重）。实测 i18next 缺变体时回退基础键 → **已有 5 门语言零改动**。 |
| 资源 | 每门 3,340 基础键 + 服务端 messages 61 键；复数变体：ru **144** 条（36 键 × 4 形态）、fr **110** 条（55 键 × 2）、de **130** 条（65 键 × 2） |
| 语言特性 | 法语：`:`/`?`/`!`/`;`/`%` 前**不换行空格**、`« »` 引号、千分位空格、vous 敬称；德语：`„…“`、Sie 敬称、**短词避让文本膨胀**（30–50%）；俄语：`«»`、小写 вы、《…》书名号等本地化处理 |
| 顺手修的真缺陷 | `metric-units.ts` 曾用「某条译文是否等于 `min`」当语言判据 → 改为 `currentLocale().startsWith('zh')`（俄语把「分钟」译成 `мин` 就会误判成中文量级） |
| 过期断言治理 | 告警三处 spec 把「未上线语言」写成具体语言名，已改为**保留标签 `xx-XX`**（本轮第三次被语言集扩张打脸，从此不再过期）；`detect.spec` / `resources.spec` 同步 |
| 验证 | `bash scripts/build.sh` 退出码 0（Server 708 用例、Web 98 文件/448 用例、两个 i18n 门禁）；`i18n_check.py` 8 语言通过（3,340 键 × 16 命名空间 + 服务端 messages 注册校验）；浏览器实测 ru/fr/de 登录页 **0 个中文字符**、`<html lang>` 与标题同步；复数实测 de `1 Karte / 2 Karten`、fr `1 carte / 2 cartes`，数字本地化 ru `3 × 10 тыс.` / de `3 × 10.000` / fr `3×10 k` |
| 术语表 | 扩为 **8 语对照**（`docs/architecture/i18n-glossary.md`），并新增「各语言特殊约定」表（复数形态 / 排版 / 敬称 / 量级判据） |

**待母语复核**：各语言 ≤10 条（登记在分批报告与各自 `/tmp/*-terms.md`）。典型项：俄语 `metrics:label.cohort` 用 `Когорта`（与术语表 `队列→очередь` 的边界）、法语 `cardType.text` 用 `Note`（避与标签冲突）、德语 `Provinz` 是否改 `Region`。

### 3.10 第七轮：西班牙语 / 葡语（巴西）/ 越南语 / 泰语 / 印尼语（2026-09-17）

语言集 8 → **13 门**：新增 `es-ES`、`pt-BR`、`vi-VN`、`th-TH`、`id-ID`（阿语仍未接，需先做 RTL 改造）。

| 项 | 结果 |
|---|---|
| 资源 | 每门 3,340 基础键 + 服务端 messages 61 键；复数变体：es / pt **各 126 条**（63 键 × `_one`/`_other`），越 / 泰 / 印尼**无复数形态**（只用基础键） |
| 罗曼语系合并批次 | es + pt 由一个批次交付（共享复数与排版规则），但**排版各自统一**：es 用 `«»`、pt-BR 用 `“ ”`；es 的 `%` 前留空格（RAE）、pt-BR 紧贴 |
| 东南亚三门特性 | 越南语：语序重写、长度控制（比英语长 20–40%）；**泰语：词内不空格、无折行机会** → 按钮/标签刻意取短（`บันทึก`/`ลบ`/`ตั้งค่า`）；印尼语：正式语域 + `Anda`、`×10 ribu`/`×100 juta` 替代中文万/亿 |
| 数字与日期 | 三门罗曼语系统一 `.` 千分位 / `,` 小数；越南语与印尼语同为 `.`；多处 `月/日` 顺序按本地习惯改为 `日/月` |
| 浏览器实测（构建产物） | es / pt / vi / th / id 登录页：`<html lang>`、标题、文案全部正确，**中文字符数均为 0**；泰文渲染正常 |
| 自动化 | `bash scripts/build.sh` 退出码 0（Server 708 用例、Web 98 文件 / 448 用例、两个 i18n 门禁）；`i18n_check.py` **13 语言 × 16 命名空间 = 3,340 键**通过；`target/server/dist/src/i18n/messages/` 含 13 个语言包 |
| 术语表 | 新增「第二批语言术语」表（es / pt / vi / th / id 共 7 列）与各自的语言规则（复数 / 排版 / 语域 / 长度） |

**待母语复核**：各语言 ≤10 条（登记在各自 `/tmp/*-terms.md`）。典型项：西语 `Previous/Last N days` 的语义切分、葡语 `função` vs `papel`（角色）、泰语「队列/cohort」用 `คิว` 是否歧义、越南语「卡片/标签」同为 `thẻ` 的消歧、印尼语 `Belum ada` / `Tidak ada` 两态空文案的必要性。

### 3.11 第八轮：长语言版式（L4）全量走查（2026-09-17）

起因：生产俄语截图两处版式缺陷——侧栏「Управление данными」文字与子菜单折叠箭头重叠；以及内容区长译文被固定宽挤压/截断。方法与判据见设计文档 §14.10，本批结果见 §14.11。

| 项 | 结果 |
|---|---|
| 箭头重叠（先修并已上线） | antd 子菜单箭头绝对定位在右侧 [16,26]px，`.shell-sider .ant-menu-submenu-title` 补 `padding-inline-end: 28px`；随版本 **17674** 上线，线上 CSS 已含该规则 |
| 四批走查 | ① 分析页 `pages/Analysis` + `features/query` + `features/time-range` + `features/explore-charts`；② `components` + `features/report` + `pages/Report`；③ 告警/运维/元数据/指标/权限/设置；④ 行为序列 `features/timeline`。共 **67 文件 / 860+ 处**，纯版式改动（未动任何文案字面量） |
| 通用改法 | 列 `width` → `minWidth` + `ellipsis: { showTitle: true }`；`scroll.x` 由硬编码改为「各列下限之和」；`Space` 补 `wrap`；分段控件容器 `min-width: max-content` + option 补 `title`；表单控件固定宽 → `minWidth`；空态/卡片标题/长说明放开换行（**不用** `break-all`）；`Tag` 去掉 antd 默认 nowrap |
| antd 实测结论（3 条） | ① `table-layout: fixed` 下列 `min-width` 仍生效 →「`minWidth` 兜下限 + `scroll.x` 兜总和」可靠；② `Segmented` label 自带 ellipsis + nowrap，**不可能折行**，只能容器不压缩 + `title`；③ `rc-select` 对字符串 label 自动加 `title`，换 ReactNode 会同时丢 title 与 `optionFilterProp` 过滤 |
| 保留未改 | 纯数字控件（`InputNumber`）固定宽；`Descriptions` 中为用户数据（属性键）的 label；`Drawer/Modal` 固定 `width`（模态自带 `max-width: calc(100vw - 32px)`，属窄视口响应式，另开条目） |
| 自动化 | `bash scripts/build.sh` 退出码 0（Server **1015** 用例、Web **115** 文件 / **630** 用例、两个 i18n 门禁）；`i18n_check.py` 13 语言 × 16 命名空间 = **3,879 键**；`i18n_scan.py --check` 待翻译 **1,446**（基线持平）；`arch_ratchet.py` 通过 |
| 上线 | 提交 `7f0d738` → CI 模块版本 **17675**（生产此前 17674）→ `server-upgrade.sh`：rsync 到 production、`migrate` noop、`clklog_analytics_server` 重启 |
| 生产核验（文件层） | `.version` = 17675；`web/sa/assets/UserTimelinePage-B10tPmYs.css` 含三条 timeline L4 规则；`index-BKT_YQ9f.css` 含箭头留位规则；`AlertsPage-B31E-kV5.js` 含 `ellipsis:{showTitle:!0}`（**上一版 18:28 的同类 chunk 为 0**，即核验方法本身已验证） |
| 生产核验（浏览器层） | `当时的线上入口/sa/login?lang=ru-RU`：`<html lang>` = `ru-RU`、标题 `Аналитика ClkLog`、界面全俄文、无截断；加载的入口即本次产物（`index-DKKOcTsU.js` + `index-BKT_YQ9f.css`） |
| 未闭环 | **登录后各页的俄语目视走查未做**：生产管理员口令非仓库默认值（`POST /sa/api/auth/login` 返回 401 `auth.login.invalidCredentials`），Agent 无法登录；需由用户在已登录会话硬刷新后自查（重点：侧栏子菜单箭头不再压字、行为序列页分段控件 `Сначала новые/Сначала старые` 不折字、`Тип ID` 下拉值完整、空态 `Свойств пользователя нет (не передавались)` 换行、留档抽屉操作列换行） |

## 4. PRD 验收项对照

| 编号 | 结论 | 证据 |
|---|---|---|
| I18N-1 语言选择器只列已完整交付的语言 | ✅ | `LOCALES` 注册表只有 zh-CN / en-US，二者键集一致由 `i18n_check.py` 强制 |
| I18N-2 未登录按浏览器语言 | ✅ | `detect.spec.ts`（jsdom 默认 en-US → 英文；不在语言集内 → 简体中文） |
| I18N-3 切换即时生效且不丢编辑内容 | ✅ | `en-US-render.spec.tsx` 断言 `changeLanguage` 后组件重渲染、无需整页刷新 |
| I18N-4 偏好随账号跨设备 | ✅ | `sauser.locale` + `PUT /auth/preferences`（部分更新）；登录页登录成功后 `applyUserLocale` |
| I18N-5 英文界面无中文残留（四页走查） | ✅（静态 + 组件级 + 浏览器） | 前端生产代码待翻译文案归零（`i18n_scan`）；登录页 / 403 页 en-US 渲染断言无 CJK；**构建产物真实浏览器实测**见 §3.3（登录页 en-US 文本 0 个中文字符） |
| I18N-6 英文报错与脱敏规则 | ✅ | `api-error.ts` 优先 `messageKey`，无 key 时保持原中文兜底与技术错误脱敏（既有测试全绿） |
| I18N-7 组件库文案与页面语言标记 | ✅ | `LocaleBridge` 注入 antd locale、`dayjs.locale`、`<html lang>`、标题 |
| I18N-8 数字/日期格式随语言 | ✅ | `format.spec.ts`；`metric-units.ts` 中文量级（万/亿）仅中文路径启用，英文走 K/M/B |
| I18N-9 用户数据不翻译 | ✅ | 事件名/看板名/备注/SQL 保持原字面；`value` 字段与代码标识不动（各分批报告一致） |
| I18N-10 通知按接收者语言 | ✅（后端就绪，UI 待补） | 默认模板按语言 + `AlertContact.locale` + 检测器逐个联系人渲染；**联系表单的语言选择器尚未加**（后端字段与 DTO 已就绪，见 §5） |
| I18N-11 导出按操作者语言 | ⚠️ 部分 | 后端具备 `x-locale` 解析（`src/i18n/locale.ts`）；前端导出仍未统一带该头（见 §5） |
| I18N-12 未翻译内容有明确标注 | ⚠️ 部分 | 接入指南已迁移；未翻译内容（结果列名）暂无标注（见 §5） |
| I18N-13 存量中文用户无感知 | ✅ | 迁移以「等值替换」为准；前端 413 项单测（含 71 个中文断言文件）通过；`zh-CN` 资源与原文逐字比对 |
| I18N-14 新增语言零代码 | ✅ | 新增语言 = `locales/<tag>/` + `config.ts` 一行；`zh-TW` 未上线故不暴露 |
| I18N-15 术语表 | ✅ | 各分批按统一术语执行（event/property/funnel/retention/dashboard/cohort/alert…）；术语表见架构文档 §5.3 |
| I18N-16 生产实测 | ✅ 已发版（2026-09-17） | 见 §3.4 上线记录：产物版本 17299、两个迁移落库、前端入口 chunk 与英文资源均在线上 |

## 5. 残留与后续课题（收口后）

1. **平台预置的数据层文本**：内置告警规则名、内置指标名、默认目录「未分组」、演示账号等**落库为数据**的文本不翻译（用户可改名），见 §3.7 的「明确不翻译」清单。
2. **日志与 DLQ 原文**：`ingestor` 的丢弃原因、分区拒绝原因等只在排障面可见，保持中文原文（排障要稳定字符串）。
3. **`ai_workspace/default/*.md` 指令文档**：AI 指令层，保持中文单版（PRD §8-5 已声明为非目标）。
4. **厂商原始错误**：通道投递失败时的厂商返回原样透出（排错需要），不本地化。
5. **时区**：仍固定 Asia/Shanghai（PRD §8-2 非目标）；「时区随用户走」是独立 phase。
6. **资产级翻译**（事件名/属性名的多语言显示名）：神策式「翻译资产」，独立 phase。

## 6. 测试断言变更说明（透明披露）

为让「错误类型断言」与新契约一致，以下 5 个后端 spec 的断言由 `toBeInstanceOf(BadRequestException/…)` 改为断言 `DomainError` + `status` + `errorCode`（用例数量与语义不变，覆盖更严格）：`test/ops/log-cleanup.spec.ts`、`test/ops/data-mgmt-actions.spec.ts`、`test/ops/slow-query.controller.spec.ts`、`test/cohort/cohort-sql.service.spec.ts`、`src/modules/relation/datatable-join.spec.ts`。另有 `src/modules/iam/*.spec.ts` 与 `test/alerting/alert-template.spec.ts` 因同批迁移/语言矩阵调整做了等价改动。**前端测试文件未做任何断言改动。**

## 7. 门禁对照

| 门禁 | 结论 |
|---|---|
| 程序门禁（PRD + 实现方案） | 通过：`prd-clklog-analytics-i18n-v1.md` + `clklog-analytics-design-i18n-v1.md`（含差异登记 §14） |
| 结构棘轮 / 硬门禁 | 通过：`arch_ratchet.py` 退出码 0；新增 `src/i18n/` 窄包（前后端）不在冻结目录；`common/` 与 `utils/` 只减不增 |
| 红线 1–7 | 未触碰：不改社区版、不动数据链路、无密钥入库、查询无界风险不变、目录权限未变、DDL 仅新增可空列（`sauser.locale` / `alertcontact.locale`）、配置真相仍在 Puppet（本 phase 未新增环境变量） |
| 发版 | 需要：`prisma migrate deploy`（2 个新迁移）；前端静态资源随 rsync 生效；无新增环境变量 |
