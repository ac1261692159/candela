# CODE_HANDOVER

> 阶段性架构审计/调试中发现的问题登记（AGENTS.md「阶段性架构审计」约定）。修复须经用户确认授权，不自动扩大范围。

## 2026-10-09：告警平台邮件复用（PRD UX-7）生产实测——DI 元数据退化致回落从未生效

触发：用户要求「用平台邮件通道向指定邮箱发测试告警邮件」，在已登录的生产页面（`/sa/ops/alerts`）上实测。
过程与现象：联系人表单里「邮件」选项为 **disabled** → 读接口 `GET /ops/alerts/channels` 得
`email.available=false` / `smtp.platform_fallback=false`；但用**同一份部署产物 + 同一份生产数据**直接调用服务
（`new AlertChannelConfigService(prisma, audit, new AuthMailService({env, configKey}, prisma))`）却得到
`available=true / platform_fallback=true`。可用性判定（发版 `5ce23bb`）已在线，差异只能出在运行时装配。

### 本轮关闭

| 项 | 结果 |
|---|---|
| 平台邮件回落未生效（AL-09） | ✅ 根因定位 → 修复 → 发版 `fcb389c`；补两条走**真实 Nest DI 装配**的回归用例（`@nestjs/testing`），把导入改回 `import type` 时必失败（实测 2 failed / 9 passed） |
| 同类问题全仓排查 | ✅ 扫描 `src/**`「`import type` + 构造器注入类型」组合：**仅此一处**（审计脚本正则需正确处理 `@Optional()` 的括号，第一版脚本被截断漏报过） |

### 问题登记

发现日期与最后复查日期均为 **2026-10-09**。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| AL-09 / P1 ✅ 已修复 | 告警邮件通道（DI） | 编译产物 `channel-config.service.js` 的 `__metadata("design:paramtypes", [PrismaService, AlertAuditService, Function])`——第三项是 `Function` 而非 `AuthMailService`，且文件内没有 `require(".../auth-mail.service")`（`grep -c` = 0）。根因：`import type { AuthMailService }` 让 `emitDecoratorMetadata` 退化成 `Function`，Nest 解析不到该 provider，`@Optional()` **静默**注入 `undefined`（不报错、不打日志）。影响：v3.2（PRD UX-7）上线以来**发送侧**的平台邮件回落一直拿到 `null`，只有告警侧自发配置或 `ALERT_SMTP_*` 存在时才会发信；本次可用性判定是同一条链上的第二个受害者 | 已修：改为值导入；新增两条用例走真实 Nest DI 装配（provider 提供 `AuthMailService` 后断言 `caps.email.available`），把导入改回 `import type` 即失败——这类「元数据退化」只有装配层用例能拦住，手工 `new` 的单测永远绿 |
| AL-09 备注（同类风险） | 全仓 DI | 该 bug 逃过 v3.2 全部单测的原因：`platform-mail.spec.ts` 只测 resolver 绑定，其余用例手工 `new` 服务并显式传桩，**没有任何用例覆盖「Nest 真的把 provider 注进去了」** | 后续凡是「跨模块 `@Optional()` 注入」的新增依赖，交付时至少留一条 `@nestjs/testing` 装配用例；不建议为此改棘轮（成本高于收益） |

## 2026-09-23：事件图表字段绑定发版验收（17535 → 17547 → 17548）与两处返工

触发：发版后在生产环境做验收。首个提交 `fe7d325` 的 pipeline 失败返工一次（`3e2c708`），
验收又发现一处线上回归并修复发版（`1386cbe`）。验收记录见
`docs/project/acceptance-clklog-analytics-event-chart-binding-v1.md`。

### 本轮关闭

| 项 | 结果 |
|---|---|
| pipeline 失败（新增 spec 拉崩 CI） | ✅ `test/query/event-column-role.spec.ts` 顶层 import 的服务依赖链会加载 `src/config/configuration`（模块加载期读 YAML + 按 `${CLICKHOUSE_PASSWORD}` 插值），CI 无密钥即整套 failed to run。按仓库既有约定在 spec 顶部 `jest.mock` 掉该模块后，**本地复刻 CI 条件**（清空四个密钥变量 + `APP_CONFIG_PATH` 指向不存在文件 + `--runInBand`）118 套件 / 894 用例全绿 |
| 线上回归：两张数值卡变「暂无数据」 | ✅ 自动绑定漏了改造前的 `columns[0]` 兜底，无分组的 `chart_type='number'` 卡片 `categories` 为空 → `ExploreChart` 渲染空态。补回回退后空态 2 → 0，全量核对 69 张卡片无其他受影响者 |
| 发版脚本静默半同步 | ✅ 记录进 `docs/project/legacy-production-handover.md`（§十 新增「发版踩坑」小节）：rsync 输出被 `head`/`tail` 管道 SIGPIPE 掉后脚本继续跑，`.version` 与 supervisor 都正常但产物是旧的 |

### 问题登记

发现日期与最后复查日期均为 **2026-09-23**。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| ECB-05 / P2 待修（本次仅登记） | 服务端单测 | **任何触及 `src/config/configuration` 依赖链的新 spec 都会在 CI 崩**，而本地默认环境下**测不出来**（本机 `config_dev.yaml` 能被正常插值，同一条 spec 本地绿、CI 红，容易反复踩）。仓库已有约定（`scripts/build.sh` 的后端单测说明 + `jest.mock('../../src/config/configuration', …)`），但约定只在脚本注释里、散在各个 spec 顶部 | 加一层机械防护：要么在 jest 配置里放统一的 `setupFiles` 把 `src/config/configuration` 建成全局 mock（需要各 spec 声明的 `appConfig` 形状足够通用），要么加一个检查脚本——扫 `test/**`、`src/**` 下新增的 spec，若其 import 图能到达 `configuration` 且文件内无对应 `jest.mock` 就报错。属独立改造，需另开 phase |
| ECB-06 / P2 待修（本次仅登记） | 图表自动绑定 | 「自动绑定的兜底链必须与改造前逐级等价」只在本轮靠人工核对发现（ECB-02 与本次回归都是这一类）：兜底少一级，某类旧卡就从「有图」变「空态」，而单测用例恰好都带分组、覆盖不到。当前没有「旧卡形状 × 渲染结果」的回归基线 | 为 `autoEventChartConfig` 补一组**形状矩阵** fixture：无分组 / 只有时间 / 只有维度 / 时间+维度 / 多分组，逐项断言合成的 `bindings.x` 与「模型非空」；线上再定期做一次 69 张卡片的只读形状普查。属独立改造 |

## 2026-09-22：事件分析图表字段绑定（双轴 / 拆分系列 / 长标签）交付 + 架构审计

触发：用户要求「事件分析折线图能不能像自定义 SQL 一样选字段/维度并优化显示」。改动 28 个代码文件（含 6 个 spec）+ 13 个语言资源 ×3 命名空间，触发「单次实现改动 ≥20 个代码文件」的阶段性审计条件。门禁文档：`docs/product/prd-clklog-analytics-event-chart-binding-v1.md` + `docs/architecture/clklog-analytics-design-event-chart-binding-v1.md`（实现记录见其 §18）。

### 本轮关闭

| 项 | 结果 |
|---|---|
| 量级差异把指标压平 | ✅ 新增 `options.metric_axis`，指标可分配到左右轴；量级断层 ≥50 倍时出建议条，**点「应用」才写配置** |
| 第二个分组列被静默丢弃 | ✅ `modelFromEventResult` 只取 `groups[0]` 的遗漏已修；X 轴与拆分系列改为用户可选，透视按 (X, 系列) 求和合并 |
| X 轴长维度标签重叠/被裁 | ✅ `resolveXLabel` 按分类数与标签长度自动旋转/截断，`containLabel` 保不裁切，tooltip 表头给全文 |
| 事件侧图表配置无 schema | ✅ 改为复用 SQL 卡同一份 `dsl.chart_config: ChartConfigV1`，服务端同一份校验器按 `domain` 收窄图型白名单 |
| 列角色靠猜 | ✅ 服务端在结果列上下发 `role`（`granularity='total'` 归维度），前端优先读它、缺失回退前缀 |
| 测试 | ✅ 后端 896 用例（119 套件）、前端 558 用例（111 文件；1 个既有慢用例在并行下随机超时，单跑通过）；`arch_ratchet` / `i18n_check` 通过；i18n 覆盖率基线 1389 → 1390（`--force`，原因：3 个新错误码的中文 `message` 兜底，硬门禁 21 的必要组成） |

### 问题登记

发现日期与最后复查日期均为 **2026-09-22**。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| ECB-01 / P2 待修（本次仅登记） | 架构门禁 | `features/visualization/adapters/shared.ts:3` 反向 `import` `features/explore-charts/explore-chart-option` 的 `EXPLORE_COLORS`——SQL 图表引擎依赖事件图表包，违反「依赖单向」。事件侧新增的 `features/event-chart` 本身是单向依赖（→ visualization、→ explore-charts），本 phase 未加剧，但倒挂仍在 | 把 `EXPLORE_COLORS` 等色板常量抽到 `features/chart-palette/` 语义窄包，两侧同时改为引用它。属独立重构，需另开 phase 授权 |
| ECB-02 / P3 已在本轮修掉（留作模式记录） | 卡片配置读取 | 卡片重开时绑定丢失：`EventAnalysisPage` 分发 `_view` / `_form` 到页面 state，却**没把 `card.dsl.chart_config` 传下去**；结果组件从 store 的 `dsl` 读配置，而 store 里是 `buildEventQuery()` 重建出的**查询**，天然不含卡片配置 | 已修（改用 `initialChartConfig` prop）。**模式**：store 的 `dsl` 是查询，卡片配置在卡片 dsl 上，两者只在「保存」方向重合；今后任何「从 store dsl 读卡片配置」的写法都是错的 |
| ECB-03 / P3 待修（组合未实测） | 图表绑定 | 「拆分系列 + 双轴 + 系列级截断」三者同时生效的表现只有单测覆盖（`event-binding.spec.ts`），**没有浏览器实测**；本 phase 实测只覆盖了双轴与单维度绑定 | 下一轮补一组「时间 X 轴 × 维度拆分 × 3 指标 × 超 5 系列」的实测，重点看 `SERIES_LIMIT_EXCEEDED` 截断与右轴归属是否互相干扰 |
| ECB-04 / P3 已知残余 | i18n | 事件侧字段区复用了 `sql:field.*` 文案（同一面板两个域），键名前缀与实际使用域不一致；用户不可见，但会让后来者按前缀找文案时找错地方 | 若将来 SQL 侧双轴落地、面板进一步分叉，再把共享面板文案抽到中性命名空间（如 `chart:`）；现在抽只会制造 13 语言的大范围改动 |

## 2026-09-22：AI 模型供应商网页设置（model-providers）交付 + 架构审计

触发：用户要求「在设置中的 AI Workspace 管理增加供应商设置，用于设置 DeepSeek Harness 的模型供应商，而不是靠配置文件」。改动 23 个 `.ts/.tsx`（含 6 个 spec）+ 13 个语言资源，触发「单次实现改动 ≥20 个代码文件」的阶段性审计条件。门禁文档：`docs/product/prd-clklog-ai-model-providers-v1.md` + `docs/architecture/clklog-ai-analytics-design-model-providers-v1.md`。

### 本轮关闭

| 项 | 结果 |
|---|---|
| 供应商改配置即发版 | ✅ 供应商清单与默认模型入库（`saaimodelprovider` / `saaimodelsettings`），超管在「AI Workspace 管理 → 模型供应商」增删改 + 测连接 + 选默认模型 |
| 明文密钥入仓（红线 3） | ✅ `config_server.yaml` 两个 `api_key` 已清空，密钥改密文入库（AES-256-GCM，复用 `channel-crypto` 与 `ALERT_CONFIG_KEY`）；**轮换与历史重写仍未做**（见 `OPEN.md` §1.1、§1.8） |
| 默认模型对老用户不生效 | ✅ `dsh-home/settings.yaml` 由「只写一次（`flag: 'wx'`）」改为读-合并-原子写，仅值变化时落盘，保留 DSH 写入的其他键 |
| 配置漂移（红线 7） | ✅ `scripts/supervisord-clklog-manager.conf` 补 `ALERT_CONFIG_KEY`（服务器 ini 早已手工注入，仓库模板缺失） |
| 测试 | ✅ 后端 ai-assistant/config 15 套件 108 用例；前端新增 5 用例；`arch_ratchet` / `i18n_check` / `i18n_scan --check` 通过 |

### 问题登记

发现日期与最后复查日期均为 **2026-09-22**。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| MP-01 / P2 待修（本次仅登记） | 架构门禁 | `model-provider-store.service.ts` 直接 `import` 告警域的 `alerting/channels/channel-crypto`，而 `AlertingModule` 并未导出该文件——违反「modules 只依赖对方 NestJS module exports 的公开契约」。同款先例：`auth/auth-mail.service.ts:8`（账号邮件也这样引用）。影响：告警域的加密实现被三个域隐式共享，改签名会连带影响 AI 与账号域，且门禁只能人检、棘轮不查 | 抽 `src/modules/credential/credential-crypto.ts` 语义窄包，alerting / auth / ai-assistant 三处改为经它引用（`AlertingModule` 导出或纯函数直用）。属独立重构，需另开 phase 与 PRD 授权 |
| MP-02 / P3 已知残余风险 | AI / 密钥 | 主密钥（`ALERT_CONFIG_KEY`）轮换或丢失后，库内供应商密钥密文不可解密：页面红字告警 + 供应商按「不可用」处理（**不静默回退配置文件**），需管理员重新填写。与告警通道、账号邮件同策略，无自动轮换 | 需要「密钥轮换」能力时，按 `keyId` 前缀实现多主密钥并行解密（密文格式已预留 `keyId:iv:tag:ciphertext`） |
| MP-03 / P3 已知残余风险 | AI / 生效时序 | 供应商配置变更对**运行中的会话**不立即生效（惰性重建），依赖用户下次打开助手；「立即应用」会中断这些会话。已用 `settings.yaml` 合并写保证默认模型对老用户生效 | 若要求强一致，可在保存后主动 `recycleAll()`（会打断对话，需产品决策）；当前保留人工选择 |

## 2026-09-18：项目权限口径修正 v3（选择器与治理分离 / 指标归属）

触发：项目权限验收实测发现两处口径缺陷（分析师可见埋点/数据管理与对拍、可删他人指标）。门禁文档：`docs/product/prd-clklog-analytics-rbac-v3.md` + `docs/architecture/clklog-analytics-design-rbac-v3.md`。

### 本轮关闭

| 项 | 结果 |
|---|---|
| 选择器与治理分离 | ✅ 新增只读码 `meta.picker.view`（8 条清单接口，清单见设计文档 §5），分析师收回 `meta.view`；Debug / 数据质量 / 对拍 / 数据表管理回到 owner 与分析管理员档 |
| 指标归属判定 | ✅ `metric.edit_own` 不再等同「可写全部指标」；`metric.edit_others` 首次被消费；指标审计 operator 由占位 `system` 改为真实用户 |
| 侧栏裁剪 | ✅ 「数据管理」分组按子项权限渲染，分析师只剩「指标」；「埋点管理」整组对分析师消失 |
| 测试 | ✅ 后端 104 套件 / 771 用例（`--runInBand`，CI 同条件）、前端 99 文件 / 452 用例；`arch_ratchet` 与 `i18n_check` 通过；i18n 覆盖率基线 1350 → 1354（`--force`，原因：新增目录行的中文原值 ×3 + 归属 403 兜底文案 ×1，均已配 13 语言译文） |

### 问题登记

发现日期与最后复查日期均为 **2026-09-18**。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| RB3-01 / P2 待修（本次仅登记） | 数据权限 | `DebugService.recent()` 直接读 `clklog_sa.sa_events` 原始行（含 `properties`），只按 `project_name` 过滤，**未接 DataScope**；DataScope 的消费方只有事件 / 漏斗 / 留存 / SQL 守卫 / 看板卡片五条路径。影响：被挂数据权限策略（限定事件、行过滤）的 owner / 分析管理员可用 `distinct_id` 绕过策略读个人级明细。v3.2 之前仅管理员可达，v3.2 期间分析师也可达（rbac-v3 已收回分析师入口，缺口本身仍在） | 读前接 `DataScopeService`：事件白名单 + 行过滤谓词并入 SQL；或在数据权限章节把 Debug 显式登记为第六条读路径并补断言。需先补 PRD / 实现方案再改 |

## 2026-09-16：告警通知通道扩展（多通道 + 平台化配置）交付

触发：用户要求告警从「只接飞书」扩到钉钉/企微/邮件（平台可配发信邮箱）/短信（阿里云、腾讯云、AWS 等）/Telegram/WhatsApp，并明确**本项目要开源、要覆盖海外**。门禁文档：`docs/product/prd-clklog-analytics-alert-channels-v1.md` + `docs/architecture/clklog-analytics-design-alert-channels-v1.md`；配置指南与手动测试清单：`docs/product/guide-clklog-analytics-alert-channels-v1.md`。

### 本轮关闭

| 项 | 结果 |
|---|---|
| 通道覆盖 | ✅ 13 个通道（飞书/钉钉/企微/Slack/Discord/Teams/Telegram/通用 Webhook/ntfy/Gotify/邮件/短信×4/WhatsApp），注册表驱动 |
| 平台化配置 | ✅ `alertchannelconfig` 表 + AES-256-GCM 加密 + 只写不读 + 发送测试 + 审计 |
| 限流硬约束 | ✅ 令牌桶 + 发送间隔 + 积压合并（≥3 条合摘要）；钉钉/企微/Telegram 各 20 条/分钟 |
| 去重复开发 | ✅ 手写 SMTP → `nodemailer`；手写腾讯云 TC3 → 官方 SDK；两个旧文件已删除 |
| 许可门禁 | ✅ `scripts/license-check.mjs` 接入 `build.sh`，按 **AGPL-3.0 兼容**判定（见下 AC-04） |
| 测试 | ✅ 后端 79 套件 / 554 用例（新增 24）、前端切片 50 用例、棘轮通过 |
| 环境变量读取 | ✅ 主密钥读取收敛到 `src/config`（见 AC-01），棘轮通过 |

### 问题登记

发现日期与最后复查日期均为 **2026-09-16**。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| AC-01 / P2 ✅ 已修 | 架构门禁 | 新加的 `channel-crypto.ts` 直接读 `process.env`，被 `arch_ratchet.py` 拦下（非 `src/config`/`src/scripts` 目录禁止新增 env 读取） | 主密钥读取移入 `configuration.ts`（`alerting.configKey`），crypto 改为纯函数 `parseMasterKey()` |
| AC-02 / P2 ✅ 已修 | 通道限流 | 单测暴露两处实现缺陷：① 同一批内逐条发送**没有拉开间隔**（只批间间隔）→ 仍会踩厂商限流；② 无合并窗口，突发消息第一条总被单独发走，合并几乎不生效 | 改为每条发送前 `waitTurn()`；新增 `coalesceMs`（默认 250ms）攒批窗口 |
| AC-03 / P2 ✅ 已修 | 通道发送测试 | `/channel-configs/:channel/test` 只认**联系人通道**，而配置页测的是凭证级通道（`smtp`/`sms_*`）→ 404 | 增加「配置通道 → 联系人通道」映射（smtp→email、sms_*→sms+provider 覆盖等） |
| AC-05 / P2 ✅ 已修（用户反馈） | 通知模板 | 触发与恢复共用一份默认模板、内部用 `{{if}}` 区分两态 → 模板页两个页签内容完全一样，使用者无法判断改的是哪一条 | 拆成两份独立默认模板（🚨 / ✅），`{{if}}` 仍可用；见 HANDOVER §19.4 |
| DQ-01 / P1 ⏳ 待修 | 数据质量（对拍） | **对拍从未定时执行**：root crontab / `/etc/cron.d` / supervisor 均无 reconcile，设计承诺的「每小时 count、每日 detail」未落地，`logs/reconcile/` 不存在；唯一入口是质量页手点。最后快照 2026-09-21（调研日 2026-10-08，已 17 天） | 见 `docs/product/research-clklog-data-quality-ops-v1.md` §3 P0-1（Puppet 托管低峰每日单日对拍 + 报告落盘） |
| DQ-02 / P1 ⏳ 待修 | 数据质量 / 数据运维 | **陈旧结论被当现状**：质量页与数据运维页「健康」共用 `ops_reconcile_snapshot`，17 天前的快照仍渲染「数据一致性正常」，无过期提示 | 同文档 §3 P0-2（>24h 黄、>72h 红，两页同步；失败走告警通道） |
| DQ-03 / P1 ⏳ 待修 | 数据质量（阈值口径） | **阈值三处不一致、灵敏度形同虚设**：设计写默认 0.1%，实现与 CLI 为 `absDev > threshold*100`（默认 10%），页面直接显示「阈值 10%」。实测**完整日**稳定偏差 1.08~1.39%（2026-10-06：sa 千万级 vs raw 千万级；2026-10-05：千万级 vs 千万级），在 10% 下**永不告警**；直接收紧到 0.1% 又会天天告警 | 同文档 §3 P0-3（统一口径 + 差异配置化）、P2-1/P2-3（先口径对齐再收紧） |
| DQ-04 / P1 ⏳ 待修 | 数据质量（基准口径） | **两侧不可逐行比对**：单日事件级差可达 +57%~+562%（2026-10-06 `base_network_socket_reconnect_start` sa 289,273 / raw 183,438；`android_gateway_error` 38,500 / 5,813），完整日复现，重复结构不同（sa 99.5% 唯一「用户×秒」，raw 68%）→ 「sa 比 raw 多」无法归因；raw 侧硬过滤 `event != ''` 而 sa 侧不过滤（2026-10-07 raw 有 51,490 行空 event），低量日制造假告警（2026-11-08 的 11.17% 偏差里 5 行来自此处） | 同文档 §3 P2-1/P2-2（口径白皮书 + 双向对拍）、P0-3（过滤规则配置化） |
| DQ-05 / P1 ⏳ 待修 | 数据运维（保留与磁盘） | **保留策略一侧有、一侧没有**：`sa_events` TTL 540 天（月分区）；`clklog.log_analysis` **无 TTL**（日分区、90 分区、每天 +~2GB），19 张聚合表全无 TTL；两表都有 2019/2023/2027 脏日期分区（大范围对拍误报）。清理执行与 TTL 设置**从未在生产执行过**（审计 0 条） | 同文档 §3 P1-2/P1-5（补 TTL 需用户授权，涉社区版表）、P1-4（试用 `scripts/standalone-test-env/` 演练后补验收） |
| DQ-06 / P3 ⏳ 待修 | 代码卫生 | `DataMgmtService.saveReconcileSnapshot()` 无调用方（快照写入实际只有 `QualityService.reconcile` 一处） | 同文档 §3 P0-4（删除或接唯一写入方） |
| MV-06 / P1 ✅ 已修 | 留存队列范围 > 90 天被判非法（上限混用） | 给留存放宽到 180 天后，`validateRetentionWindow` 内部仍通过 `metricTimeRange()` 取天数，而后者按**指标通用上限 90 天**校验 → 120 天窗口被判「队列范围不合法」（线上实测复现，创建即失败） | `metricWindowDays()` 改为直接 materialize 相对范围，不经过通用上限；补 `validateRetentionWindow` 的直接用例（120/180 通过、200 提示 180、1 天提示至少 2 天、绝对日期拒绝）。教训：**放宽上限时要连内部取值路径一起看**，只改入口校验不够；用例要盖被调用方而不是只盖底层函数 |
| MV-03 / P1 ✅ 已修 | 留存队列范围校验形同虚设 | `mergeMetricDefinition` 的留存分支只合并 n/measure/cohort/granularity，**漏了 time_range**：编辑留存指标改队列范围时提交值在合并阶段被丢掉，保存校验（≥ 周期+1 天、≤ 180 天）根本跑不到。线上实测：改成 1 天或 200 天都返回 200（应 400） | 留存分支显式合并 time_range（null = 清空回按周期推导）；补 3 条合并用例。教训：**白名单式 normalize + 合并的组合里，任何新字段都要同时进两处**，否则校验会静默失效 |
| MV-04 / P1 ✅ 已修 | 指标卡永不刷新 | 缓存 worker 的候选查询类型白名单是 `['sql','event','funnel']`，`card-cache.policy` 的 QUERY_TYPES 也没有 `metric` → 指标卡即使放到看板也不会被刷新，卡片永远空白（验收时缓存表里查不到该卡的行） | 两处白名单都加 `metric`；策略用例锁住 `isQueryCardType('metric') === true` |
| MV-05 / P1 ✅ 已修（自引入） | 数值变换被应用两次 | v2 让指标求值既走 SQL（`applyMetricTransform`）又在 JS 里 `applyTransform`，有变换的指标会被算两遍（÷1000 变 ÷1000000）。因为保存白名单在此之前一直丢弃 transform，线上没有带变换的指标，问题被掩盖 | 统一为**只在 SQL 侧应用一次**（`buildTransformSql`），删掉 JS 应用函数；`metric-eval` 断言变换随查询下传而不是本地重算。数值变换的测试向量也随之改为断言 SQL 片段 |
| MV-01 / P2 ✅ 已处理 | 指标 v2 试算接口的模块归属 | 试算要复用查询链路（`EventQueryService`），但 `QueryModule` 已经 `imports MetaModule`（查指标元数据），把控制器放 meta 会形成模块环（Nest 起不来） | 控制器落 `query/metric-eval.controller.ts`，**路径仍是 `/sa/api/meta/metrics/preview`**、权限仍是 `metric.view`；已写进设计文档 §5.1 偏差表 |
| MV-02 / P3 ✅ 已处理 | 指标查询时间的文案漂移 | 后端 `metric-window.relativeRangeLabel` 写「近 7 天（含今天）」，前端 `time-range` 的既有控件写「最近7天」；若各写一套，同一指标在告警预览、列表摘要、通知模板里会出现两种说法 | 前端新增 `metricWindowLabel`，与后端**同一批字面量**，两侧各有用例；`recent_n`（含今天）与 `past_n`（不含今天）的差别写进文案，避免误读 |
| AC-09 / P1 ✅ 已修（用户反馈"harness 出 bug 了，只能选择工作区并且选不了"） | Harness 面板全部交互失效 | 2026-09-14 的 `91276c2`（大表上传）把 body 解析改成显式注册，`json()`/`urlencoded()` 被放在 harness 反向代理**之前**：代理自己读原始流转发，于是 `application/json` 的请求体先被解析器吃掉，代理只能发空 body（content-length: 0），上游 DSH 的 RPC 处理器 `request.json()` 失败 → **400 `body is not JSON`**。客户端选工作区是 `POST /api/session/create`，失败后在 `.catch` 里回滚乐观选中，UI 永远停在「选择工作区」；发消息同理。工作区列表来自页面初始负载，所以「看得见、点不动」 | 代理注册提前到所有 body 解析之前；`test/ai-assistant/harness-proxy-order.spec.ts` 锁源码顺序 + 真实 HTTP/unix socket 双向集成（代理在前 body 原样到达；解析器在前 body 为空）。线上 curl 复现口径：同路径 `application/json` → 400 body is not JSON，改 `text/plain` → 415（证明 body 能到上游） |
| AC-10 / P1 ✅ 已修（同一次排查发现） | 沙箱 iframe 的两处结构性缺陷 | ① 注入 shim 用 `e.origin !== location.origin` 校验续期消息，而面板 iframe 是 sandbox 无 `allow-same-origin` 的 opaque origin（`origin === "null"`），判断恒真 → 合法续期前缀被丢弃，平台重启后旧签名失效时面板再也接不上，只能手动刷新；② 修复 ① 时我把代理提到最前，顺手把 `enableCors` 留在了后面 → 代理直接结束响应，CORS 中间件不再生效，`Access-Control-Allow-Origin` 丢失。opaque origin 下**所有请求都是跨域的**，模块脚本（`crossorigin`）与 fetch 全部被浏览器拦掉 → 面板渲染成纯黑（同源 iframe 正常、沙箱 iframe 全黑，对照复现） | 续期改按发送方身份（`e.source === parent`）+ 同运行时前缀正则校验；`enableCors` 移到代理之前（只写响应头、不读 body），顺序测试补一条断言。线上验证：响应头恢复 `access-control-allow-origin: *`，`POST /api/session/create` 返回 200 并真的建出会话，真实面板里会话列表与会话内容都能从宿主加载 |
| AC-07 / P1 ✅ 已修 | CI 门禁（新增用例拖垮流水线） | 新增的 `AlertFeedback.spec.tsx` 里 3 条整页渲染用例本地 ~3s 通过、CI runner ~6s 超过 vitest 默认 5000ms → 流水线 `exit 1`，**产物未发布**（模块版本停在上一版 17240）。危害不只是红一次：我按「版本号变大」误判 CI 已完成，把旧构建当成新版部署过一次 | 5 条整页渲染用例显式 `20_000` 超时；发版判据改为**看产物内容**（`server/prisma/migrations/` 是否含新目录、新 chunk 是否含新文案），不再只看 `.version`。已在 `docs/project/acceptance-*.md` 与 HANDOVER §19.4.3 写明 |
| AC-08 / P1 ✅ 已修（潜在数据损坏） | 联系人编辑 | 列表接口返回的是**脱敏地址**（`ab***kl`），编辑弹窗若回填再保存，会把掩码当成新地址写进库（真实地址被覆盖且不可恢复）。本轮新增编辑功能时先按前端不回填实现，服务端再补一道：`updateContact` 把「空串或与当前掩码一致」视为未修改 | 前端：编辑框不回填地址/密钥，占位符提示「留空不修改（当前 …）」；后端：`maskAddress` 比对兜底；用例 `AlertContact 编辑（脱敏地址不得写坏）` 3 例锁住 |
| AC-06 / P2 ✅ 已修（用户反馈） | 通道配置表单 | ① 浏览器自动填充把登录用户名/密码填进「API 地址」「Phone Number ID」等字段（截图可见 admin 与••••）；② 字段全部挤在一行、保存与测试控件位置混乱 | 表单 `autoComplete=off` + 密码框 `new-password`；字段改网格（lg 3 列/md 2 列/xs 1 列）、凭证区单独分组、底部一行放保存与测试 |
| AC-04 / P1 ✅ 已修 | 许可门禁语义 | 我最初按「只允许宽松许可」写白名单，但用户当日已决定本仓库以 **AGPL-3.0-only** 开源（因复制集成了上游 AGPL 的 ClkLog 社区版）→ GPL/AGPL 依赖其实**兼容**，原白名单会把可用的 copyleft 依赖误判为违规 | 改为「与 AGPL-3.0 兼容」判定：允许 copyleft 家族，拦 proprietary/SSPL/BUSL/Elastic/Commons Clause；未声明仅告警（`--strict` 可强制失败） |

## 2026-09-16：AI 工作区内容入仓与双向同步（ai_workspace）交付

触发：用户要求「代码里加 ai_workspace/default、写双向同步脚本、把 ai_workspace/app/clklogapp 纳入同步、发版把 ai_workspace/ 带到目标机」，并要求把运行时 workspace 同步回仓库。门禁文档：`docs/product/prd-clklog-ai-workspace-sync-v1.md` + `docs/architecture/clklog-ai-workspace-sync-design-v1.md`。验收记录：`docs/project/acceptance-clklog-ai-workspace-sync-v1.md`。生产 **17213 → 17219**。

### 本轮关闭

| 项 | 结果 |
|---|---|
| 仓库与运行时同构 | ✅ `ai_workspace/{default,app/<项目>}` 一一对应；workspace-template 迁入 default 成为唯一内容真源 |
| 双向同步脚本 | ✅ init/push/pull/diff/status/migrate + `--self-test`；macOS（bash 3.2）与服务器两种运行方式 |
| 密钥门禁 | ✅ 生产实测：运行时放 `mysql_password = ...` → pull 被拦且**仓库零落地** |
| 迁移 | ✅ 模板草稿（15 文件，活内容优先）+ 两个项目空间（哈希目录归档，旧位置剩余 0） |
| 发版链路 | ✅ build.sh 打包、install-harness 建目录与首迁、server-upgrade 每次 init（幂等：20 → 20 文件） |
| 回拉仓库 | ✅ 运行时独有文件入库、仓库领先内容保留、push 对齐后 diff 三个目标「一致」 |

### 问题登记

发现日期与最后复查日期均为 **2026-09-16**。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| SY-01 / P2 ✅ 已修 | 同步脚本 | `printf`+`tr` 列表末尾无换行 → `while read` 静默跳过最后一行：`migrate --projects clklogapp,default` 只迁移了 clklogapp（`default` 的旧目录一直留在原位） | 补末尾换行 + `read ... \|\| [ -n "$p" ]` 兜底 |
| SY-02 / P2 ✅ 已修 | 同步脚本 | `cmd_migrate` 的 `local IFS=','` 泄漏到后续 rsync：带逗号的 IFS 让 `$RSYNC_ARGS` 不再按空格拆词，rsync 收到一整串参数 → `syntax or usage error` | 不动全局 IFS，改用 `tr` 转行后逐行读 |
| SY-03 / P2 ✅ 已修 | 同步脚本 | ① macOS 自带 bash 3.2 无 `mapfile`/`xargs -r`/`flock`/`sha256sum`；② `$VAR` 紧跟中文标点被当作变量名（`unbound variable`） | 可移植改写（原子 mkdir 互斥、`shasum` 回退）+ 统一 `${VAR}`；`--self-test` 覆盖 |
| SY-04 / P1 ✅ 已修 | 同步脚本（安全） | ssh 模式下 pre-scan 无法读远端，密钥文件**已被复制进仓库**才被拦下（验收时真的落地过一次） | pull 改为「先入本地暂存区 → 扫描 → 干净才并入」，命中整批删除 + `trap` 清理 |
| SY-05 / 提示 | 模板生效链路 | 运行时草稿与已发布版本 3 逐文件一致（平台自发布后未改），但 git 里含 2026-09-09「提案自动应用」等更新内容 → **git 领先于线上工作区**；push 后草稿已对齐，但工作区仍需「发布新版本」才生效 | 已在 HANDOVER §十八 写明「草稿 ≠ 生效」；建议后续在模板发布流程里加一步「与仓库 diff」提示 |

## 2026-09-16：AI Workspace 项目隔离（app 目录）交付

触发：用户要求「AI workspace 按项目隔离，隔离设计仅增加一个 app 目录；切换项目后 harness 读到的 app 目录不同」，并确认同项目成员共享。门禁文档：`docs/product/prd-clklog-ai-workspace-project-isolation-v1.md` + `docs/architecture/clklog-ai-workspace-design-project-isolation-v1.md`。验收记录：`docs/project/acceptance-clklog-ai-workspace-project-isolation-v1.md`。生产 **17211 → 17213**。

### 本轮关闭

| 项 | 结果 |
|---|---|
| 项目级 app 目录 | ✅ host `workspaces/<项目哈希>/app`，容器内 `/workspace/app`；自动创建 + 种子文件 + 0750 harness:harness |
| 跨项目不可见 | ✅ 线上 A/B 实测：A 内写文件 → B 内看不到；两侧 `project.json` 各自正确 |
| 守门 | ✅ 形状校验（只认本项目哈希 + app）与拒 symlink，broker socket 直接探测三种输入均按预期 |
| 模型侧说明 | AGENTS.md 已加「项目工作目录 app/」；进入工作区需模板发布（当前版本 1/2/3 未含） |
| 测试 | 后端 78 套件 / 529 用例（+6）、broker 9 例（+3）、host 7 例 |

### 问题登记

发现日期与最后复查日期均为 **2026-09-16**。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| AI-01 / P1 ✅ 已修 | 发版路径（harness） | `server-upgrade.sh` 不更新也不重启 harness broker/host；broker 运行 `/opt/clklog/harness/current/...`（由 `install-harness-runtime.sh` 切换）。实测 broker 进程已连跑 5 天（9-11 启动），旧代码会把服务端新参数**静默丢弃**（`validateEnsure` 只挑已知字段）→ 功能「部署了但没效果」 | 已处理：本次改 Harness 后执行 `install-harness-runtime.sh <release-root>` 并重启 broker；写入 `docs/project/legacy-production-handover.md` §十七「改 Harness 的发版要多跑一步」 |
| AI-02 / P2 ✅ 已清 | 凭据卫生（红线 3） | `/etc/supervisord.d/` 残留 11 份 `*.ini.*` 备份，全部含 `MYSQL_PASSWORD=` 明文，其中 `*.ini.rootrot-20260915195034` 与 `*.ini.puppet-bak` 为 **644 全局可读**；install 脚本 `supervisorctl reread` 还报 `duplicate supervisor program: clklog_analytics_server` 导致脚本中断在 broker 重启前 | 已处理：备份移入 `/root/supervisord-ini-backups-20260916/`（600），目录内只留 3 个受管 ini；教训写入 `docs/project/legacy-production-handover.md` §十七 |
| AI-03 / 提示（工具） | 容器内排查 | `podman exec` 在 rootless（无 systemd user session）下报 `crun: write to …/cgroup.procs: Permission denied`，无法进容器取文件 | 取证改 `nsenter -t $(podman inspect -f '{{.State.Pid}}' <c>) -m -- sh -c '…'`；配方写入 `docs/project/legacy-production-handover.md` §十七 |

## 2026-09-16：指标查看与编辑交付（用户反馈「只能删」）

触发：用户反馈「指标只能被删除？没有重新编辑和查看的功能」。核查确认后端 `GET/PUT /sa/api/meta/metrics/:id` 早已存在，缺前端接线；列表只有删除，用户只能删了重建 → 重建换 `metric_id` → 悄悄弄断告警绑定。验收记录：`docs/project/acceptance-clklog-analytics-metric-detail-v1.md`。生产版本 **17199 → 17203 → 17204 → 17205**。

### 本轮关闭

| 项 | 结果 |
|---|---|
| 查看 | 详情抽屉给元信息 + 可读口径（事件/留存），列表新增「口径」列 |
| 编辑 | 可就地改显示名/备注/格式与口径；指标名/类型只读；`metric_id` 不变，不影响引用与告警绑定 |
| 前端契约 | `getSavedMetric` / `updateSavedMetric` 接线；前端回传**完整定义**（未暴露字段原样带回） |
| 后端健壮性 | 两处修复见下表 MD-01 / MD-02 |
| 测试 | 前端新增 `src/features/metrics`（20 例，进 CI 切片）；后端全量 78 套件 / 523 用例 |

### 问题登记

发现日期与最后复查日期均为 **2026-09-16**。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| MD-01 / P1 ✅ 已修复 | 指标定义更新 | 后端 `normalizeDefinition` 按白名单**重建**定义对象：`PUT /sa/api/meta/metrics/:id` 只传 `{analysis,event,prop}` 时，已存 `filters` / `alias` 被**静默清空**。这些字段在界面上看不到 → 数据破坏级（前端回传完整定义所以 UI 不触发，API 直连必踩）。生产实测：修复前 alias/filters 均丢失 | 已修：`src/modules/meta/metric-definition-merge.ts` 在规范化前合并已存定义（`undefined`=保留、`null`=显式清空），留存两侧事件分别合并并兼容驼峰；14 例单测 |
| MD-02 / P2 ✅ 已修复 | 指标校验 | `PUT` 传 `event=""` 被接受并落库；该指标告警侧判「不可告警」、分析查不出数据 → 静默坏资产 | 已修：事件去空白后非空校验（create/update 同路径），400「事件指标缺少事件」；7 例单测 |
| MD-03 / 提示（工具） | 验收取证 | 浏览器自动化点击表格内「查看」时命令层两次 hang（600s 超时），抽屉内视图截图未取到；列表页截图与组件测试已覆盖同一行为 | 取证改用「组件测试 + 线上 API + 列表截图」组合；后续若需抽屉截图，重试或人工截图 |

### 教训

- **「字段没在界面上出现」不等于「改了没影响」**：MD-01 的 filters/alias 恰好是用户看不见的字段，一旦静默清空，分析口径与告警判定都会变，而用户毫无感知。凡是「部分更新」接口，语义必须显式定义（合并 vs 覆盖）并落到测试里。
- **白名单重建式规范化是部分更新的天敌**：只要下游用「按白名单重建」，上游就必须回传完整对象；如果无法保证，就在服务端合并。

## 2026-09-15：告警 v4（指标告警 + 通知模板）与接入指南 v2 交付

触发：用户三项需求——接入指南不再引用示例目录、告警增加可编辑模板、重设计「分析指标告警」（原功能点击即 500）。门禁文档：`docs/product/prd-clklog-analytics-{alerting-v4,onboarding-v2}.md` + `docs/architecture/clklog-analytics-design-{alerting-v4,onboarding-v2}.md`。验收记录：`docs/project/acceptance-clklog-analytics-alerting-v4.md`、`-onboarding-v2.md`。生产版本 **17195 → 17196**（`cd97840` → `754d93e`）。

### 本轮关闭

| 项 | 结果 |
|---|---|
| 卡片告警 500（根因层） | ✅ 重复 `project` 参数经 DTO 规范化取首值 + 前端不再手拼 query；生产用原触发条件复测 200 |
| 卡片告警路径下线 | ✅ 删除 `alert-metric.ts`、`cards` 接口与前端 `AlertCardItem`；`source='card'` 在迁移中停用（生产 0 行） |
| 指标告警端到端 | ✅ 触发 / 持续 / 恢复 / 留存求值 / 自定义模板投递，五条 `alertnotification` 全 `success` |
| 求值口径对拍 | ✅ 事件指标与 CH 直接计数一致；留存 11.8% 与复刻平台队列口径的独立 SQL 完全一致 |
| 模板引擎 | ✅ Go 模板子集（变量 / if-else / eq…contains / 空白裁剪），保存校验 400、预览、恢复默认、审计全部实测 |

### 问题登记

发现日期与最后复查日期均为 **2026-09-15**。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| AL-04 / P2（开放） | 指标告警求值成本 | 留存指标单次求值 **20.3 秒**（31 天窗口 × 两个事件，约 千万级行扫描；同机事件指标 1.3 秒）。60s 轮询下不会叠加（检测器有重入保护），但留存类规则一多，单轮检测会显著拉长，且每条规则每轮都真实跑一次查询 | 留存类规则支持更长的评估间隔（如 30 分钟）；或把 `retentionRange` 的窗口按 `n` 收紧（当前下限 30 天是为队列成熟度留余量）；或对留存求值结果做分钟级缓存 |
| AL-05 / 提示（非缺陷） | 留存口径 | 验收时我先按「当天做过初始事件的人」算基线得 45%，与告警 11.8% 差 4 倍，一度判为缺陷。复刻平台口径（队列 = **用户在窗口内首次触发初始事件的日期**，见 `retention-sql-generator.service.ts` 的 `minIf(...) OVER (PARTITION BY uid)`）后完全一致 | 留存类对拍**必须先确认队列定义**再比较；后续如需给用户展示口径，建议在留存页显式标注「队列=首次触发日」 |
| AL-06 / P1 ✅ 已修复（根因） | 告警 API 参数 | 前端 `getAlertCards` 把 `project` 同时写进 URL 与 axios `params`，拦截器再补一次 → `?project=x&project=x`；Express 解析成数组 → Prisma `Argument project_name: Expected StringFilter or String, provided (String, String)` → **500**。后果：该功能上线以来从未成功建过规则（`source='card'` 计数 0），用户看到的「服务不可用」是持续状态 | 已修：① `dto/alerting.dto.ts` 增 `normalizeProjectParam`（`@Transform`，数组取首值），对整个告警控制器生效；② 前端 `project` 统一走 `params`。回归测试锁死（含 `plainToInstance` 断言） |
| AL-08 / P2 ✅ 已修复（浏览器实测发现） | 通知模板渲染 | 默认模板把单位拼两遍：`{{.value}}` / `{{.threshold}}` 已含单位（`formatMetricValue` 拼好），模板又追加 `{{.unit}}` → 通知与预览出现「1,204次次」「%%」。**只有真实渲染/预览才看得见**，接口层与单测（用不带单位的示例值）都发现不了 | 已修：默认模板（含短信）去掉 value/threshold 后的 unit；示例值带上单位（预览=真实渲染）；新增结构 + 渲染双重断言 |
| AL-07 / P2 ✅ 已修复 | 告警阈值范围 | `POST /ops/alerts/rules` 阈值上限 1e6，而当日事件量已达千万级（`base_performance_httprequest_report` 单日约千万级），「大于阈值」类告警永远命中 → 该用法不可用 | 已修：上限放宽到 **1e12**（前后端同步），补「千万级可用 / 1e12 以上仍拒绝」单测；发版 17196 后按真实 API 复测通过 |

### 临时账号清理提示（验收操作复用）

用临时超管账号验收后，删账号前必须按序清理外键依赖，否则 `DELETE FROM sauser` 会被 `aiworkspace_user_id_fkey` 挡住：

```sql
DELETE FROM aiworkspacesyncitem WHERE workspace_id IN (SELECT id FROM aiworkspace WHERE user_id='<uid>');
DELETE FROM aiworkspace        WHERE user_id='<uid>';   -- 首次登录会自动创建
DELETE FROM saprojectmember    WHERE user_id='<uid>';
DELETE FROM sausertoken        WHERE user_id='<uid>';
DELETE FROM sauser             WHERE id='<uid>';
```

### 教训

- **凡是有「用户可见文本」的功能，最终一定要用眼睛看一遍渲染结果**：AL-08 的单位重复在接口 JSON、单测（示例值不带单位）里都完全正常，只有界面预览与真机通知才暴露。组件/接口测试覆盖不到「内容拼装」，验收必须包含一次真实渲染检查。
- **参数送进存储层之前一定要定型**：Express 对重复 query 参数返回数组，Prisma/TypeORM 这类严格校验的客户端会直接报类型错误并把 500 抛给用户。凡是把 `req.query` 原样转发给存储层的地方，都应在 DTO 层显式规范化。
- **「功能上线」不等于「功能可用」**：该功能有验收记录、有单测、有前端入口，但**首次真实点击就 500**。验收必须包含「按用户路径真实点一次」，而不是只看接口存在与单测通过。
- **对拍前先对齐口径**（AL-05）：算错基线会把正确实现误判为缺陷，浪费排查时间且可能引入错误「修复」。

## 2026-09-15：敏感数据清洗（数据治理）实现与线上验收

触发：用户指定「继续 数据治理·敏感数据清洗」。门禁文档（PRD §5 / 设计 §5）已在库。验收记录见 `docs/project/acceptance-clklog-analytics-v1-data-governance.md`。

### 本轮关闭

| 项 | 结果 |
|---|---|
| G-C1 删除 + 备份 + 审计 | ✅ 3 次 `delete-user --execute` 全成功，备份行数与预演一致，审计 4 条 |
| G-C2 掩码幂等 | ✅ 演练含幂等复跑；线上 `13812345678` → `138****5678`；复检明文归零 |
| G-C3 演练门禁 | ✅ 一次因「覆盖不足」被阻断，零生产变更 |
| G-C4 硬拒绝社区版 | ✅ 三层：目标写死 + `guard_sql()` 白名单（自检 4 拒 3 放）+ 账号级（`clklog` 连 SELECT 都拒） |
| G-S1 独立写账号 | ✅ `sa_cleanup` SQL 精确建权；口令 sha256 入库、明文服务器 600 文件 |

### 本轮登记（含两条已修）

| ID | 级别 | 内容 | 处置 |
|---|---|---|---|
| DG-01 | P1 → 已修 | **掩码覆盖度盲区**：原实现在掩码后用掩码正则自身统计「未掩码行」，格式不匹配的行（如 10 位手机号）保持明文却被判「已覆盖」 | 改为掩码前统计「带键但不匹配格式」的行，默认阻断，需 `--allow-uncovered` 放行 |
| DG-02 | P1 → 已修 | **掩码条件全表扫描**：`properties` 无索引，3 天窗口估值 327s，曾把 CLI 挂死 781s | 所有查询带 `max_execution_time` + curl `--max-time`；掩码默认窗口=当天；超时给出放宽提示 |
| DG-03 | P2 → 已修 | 审计 SQL 经 `mysql -e` 被 JSON 引号截断（且失败时**正确地**阻断了生产执行） | SQL 改走 stdin + 单引号转义 |
| DG-04 | P2 → 已修 | users.d XML 建权被 CH 扩展成含 INSERT/DROP 的宽权限；该文件还有「被还原」历史 | 改由 `migrate-clickhouse.ts` SQL 精确建权（随发版自愈） |
| **DG-05** | **P1（合规，开放）** | **清洗只覆盖旁路库**：社区版 `log_analysis` 内同一份数据清不到（红线 1 禁止改造）。本次测试数据因格式不同未进社区版，故未直接暴露 | **待产品/法务决策**：彻底删除需走社区版官方方式或单独立项 |

## 2026-09-15：运维告警线上验收（触发 / 通知 / 屏蔽 / 恢复）与登记缺陷

触发：用户要求「补一份运维告警的验收报告，把端到端触发、飞书投递、屏蔽抑制、通道未配置拒绝实际跑一遍」。帽子：程序/实现 + 项目（验收记录落 `docs/project/acceptance-clklog-analytics-alerting-v1.md`）。生产版本 **17148**。

### 本轮关闭

| 项 | 做了什么 |
|---|---|
| 验收记录 | 线上实跑完整链路：规则命中 → firing 事件 → 飞书 fire 通知 → 重复通知 → 屏蔽抑制 → 恢复通知，逐条留 DB 证据（验收文档 §3） |
| 通道拒绝 | 未配置 SMTP/短信时 `POST contacts` 返回 400 并给出可读原因（线上实测，非单测） |
| 权限双闸 | 无 token 401、非超管（`analyst1`）403、超管 200；`channels` 返回 `{email:false,sms:false}` |
| 脱敏 | 联系人列表仅返回 `https://open.feishu.cn/open-apis/bot/v2/hook/***cd2f`，webhook 全文不出现在响应 |
| 检测器测试 | 新增 `test/alerting/alert-detector.service.spec.ts`（14 例：fire/repeat/resolve、连续窗口、间隔抑制、屏蔽、观测失败跳过、通知失败落库、定时器启停、卡片缓存过期跳过） |
| 进 CI | `scripts/build.sh` 测试白名单加入 `test/ops/*`（5）+ `test/alerting/*`（3）；本地跑通 19 suites / 122 tests |

### 问题登记

发现日期与最后复查日期均为 **2026-09-15**。AL-01 / AL-02 已于同日修复并线上验证（见下「修复与验证」）；AL-03 仍开放。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| AL-01 / P1 ✅ 已修复 | 慢SQL、慢查询告警时间窗 | `clickhouse.service.ts:58-60` `toClickHouseDateTime()` 用 `value.toISOString()` 生成 **UTC 文本**，CH 服务端时区为 `Asia/Shanghai`，`{since:DateTime}` 按本地解释 → 时间窗整体前移 8 小时。线上实测（14:19）：应用「近 5 分钟」条件命中 **4007** 行，同样条件的 `now() - INTERVAL 5 MINUTE` 只有 **49** 行。影响：① `slow_query_spike` 实际按 8 小时窗口判定，自 2026-09-07 09:35 起持续 firing（`alertevent` id=1，值恒为 LIMIT 上限 1000）；② `query_fail_rate` 同上；③ 慢 SQL 页「近 1/6/24 小时」筛选窗口全部偏大 8 小时 | 已修：改为 epoch 秒 + `toDateTime()`；回归测试 `test/ops/slow-query-clickhouse.spec.ts` 锁死该机制 |
| AL-02 / P2 ✅ 已修复 | 后台定时任务权重 | ingestor 进程复用 `AppModule`（`configuration.ts` 只关掉 Harness），`AlertDetectorService` / `MetricSamplerService` / `LogCleanupService` / `CardCacheWorker` 在 server 与 ingestor **各跑一份**：两进程启动相差 11 秒，`hostmetricsample` 每小时两组相隔 11–12 秒的采样，`ops_action_log` 每小时两条相隔 11 秒的 `log_cleanup`，ingestor 日志有 `[AlertDetectorService] 告警触发` 与 `[CardCacheWorker]`。影响：规则每分钟被检测两次（双倍 `query_log` 扫描）、采样与审计重复、并发 unlink 同一批日志 | 已修：`configuration.ts` 增 `background_workers`（由 `ENABLE_INGESTOR` 派生），四个 worker 的 `onModuleInit` 在非 server 进程直接返回 |
| AL-03 / P1 | 告警可达性（配置缺口） | 验收时线上 `alertcontact` **表为空**、`alertnotification` **0 行**：8 天来的告警事件一个都没外发（`resolveContact` 无默认联系人时直接跳过，不写通知记录，页面也不会提示「没有联系人」）。用户本次提供 webhook 后才首次投递成功 | 产品侧补「无联系人时页面告警」；运维侧确认是否把该飞书机器人设为常驻默认联系人（本次验收为保持原状已删除临时联系人） |
| SEC-01 / P1 | 部署脚本密钥（红线 3） | `scripts/server-upgrade.sh:8` 明文写死 `DATABASE_URL="mysql://root:<password>@<mysql-host>:3306/clklog_sa_meta"`；另发现服务器上 `/etc/supervisord.d/clklog_analytics_{server,ingestor}.ini` 也**明文写入口令且权限 644**（全局可读） | **已做两步**（2026-09-15）：① 脚本改为从进程环境继承；② 用户选定「最小特权」——建 `clklog_sa_app@%` 只授权 `clklog_sa_meta.*`（含 DDL），应用 `DATABASE_URL` 切到它并 `supervisorctl update`（未重启 supervisord 本体）；两个 ini 备份后权限收紧 600。**2026-09-15 19:47 终态**：清单经 `ops1/puppet` 下发后生效——应用连接 = `clklog_sa_app`（`root → clklog_sa_meta` 连接数为 **0**），持久（真相在 Puppet 清单）。**教训（已写入 HANDOVER §13）**：supervisord 配置由 Puppet 生成，手工改必然被 30 分钟一次的 agent 刷回，且回滚静默（应用照常运行、无报错）。历史记录：

**2026-09-15 18:30 更正**：最小特权切换**曾被 Puppet 回滚**（`puppet_auto` 每 30 分钟 `puppet agent -t`，清单 `clklog_manager.pp` 硬编码 root 的 `DATABASE_URL`）→ 应用现用回 root。真实开关在 **ops1/puppet 仓库**（`modules/clklog/manifests/clklog_manager.pp` + `files/clklog_manager/db.conf`），且该仓库当前 HEAD 仍含 MySQL root 与 CH default 明文口令。**已闭环（2026-09-15 19:50）**：脚本去明文 + 最小特权（经 Puppet 持久化）+ **root 口令轮换完成**（旧口令实测已失效；社区版重建容器后恢复正常，我方应用不受影响）。注意两个操作差异：`docker restart` 不重读 `.env`（须 `compose up -d` 重建）、`supervisorctl restart` 不重读 ini（须 `reread && update`）。细节见 `docs/project/legacy-production-handover.md` §13 |

### 修复与验证（AL-01 / AL-02，2026-09-15）

提交 `bbca4e6`，生产版本 **17157**（升级 14:59 完成，Prisma 无待应用迁移、ClickHouse 迁移 noop）。

| 项 | 修复前 | 修复后（线上实测） |
|---|---|---|
| AL-01 观测窗口 | 应用条件命中 4007 行（8 小时窗口），`slow_query_spike` 值恒为 1000 = LIMIT 上限 | 应用算出的观测值 **42** = ClickHouse 直接数 `now() - INTERVAL 5 MINUTE` 的 **42**，两者一致；`querySlowQueries` 改为 `toDateTime({since:UInt32})` + epoch 秒 |
| AL-02 双跑 | `hostmetricsample` 每次采集成两组（相隔 11.3s，如 06:48:21.441 / 06:48:32.519），`ops_action_log` 每小时两条清理审计，ingestor 日志有告警检测与卡片刷新记录 | 重启后采样 **6 行 / 1 组**（07:00:44.836）；ingestor 日志出现四条「未启动（非 server 进程）」，server 侧 0 条 |

**修复未解决的部分（属新发现，需产品/运维决策）**：

- `slow_query_spike` **仍在 firing，且这次是真信号**：真实近 5 分钟 >5s 查询约 **42–49 次**，而阈值是 20。近 24 小时每小时 435–560 次（≈8–9 次/分钟）稳定存在，说明该规则当前配置下**永远无法恢复**，等于常亮。要么把阈值调到基线之上（如 150–250/5min），要么承认这是长期现状并停用该规则——需用户拍板。
- **2026-09-15 处置**：阈值由 20 上调到 **200**（约 4–5× 基线），规则随即恢复正常（历史上它 07:38 恢复、07:39 又触发，说明 20 就在抖动区间内）。
- **F3 / P3（同批修复）**：规则更新传入不存在的 `contact_id` 曾返回 500（外键约束），现由 `AlertingService.resolveContactId()` 提前校验并返回 400「联系人不存在」；`createCardRule` 同样接入。

**验收补测（2026-09-15 晚）**：v3 验收里标「半通过」的展示层由组件测试补上——`apps/analytics-web/src/features/alerting/AlertsWorkbench.spec.tsx`（7 例：三类提示条按需出现、健康时不出提示条、策略 Tab 健康标签、变更记录的「字段：旧 → 新」渲染与空态）；该片已进 CI（`scripts/build.sh` 前端 `vitest run src/features/alerting src/pages/Ops`）。
**遗留**：前端全量套件有 2 个既有超时失败（`src/pages/Report/SqlReportPage.chart-config.spec.tsx`，与本次改动无关），故 CI 暂只跑 ops/alerting 这一片；整片修复后可扩为全量门禁。

**死代码清理（同批）**：删除 5 个零消费者空壳文件——`modules/meta/materialize.service.ts`、`modules/meta/sampling.service.ts`（仅被 `meta.module.ts` 注册，类体为空）、`types/meta.types.ts`（零引用）、前端 `stores/dashboard.store.ts`、`components/SqlEditor.tsx`；`meta.module.ts` 同步摘除两个 provider。
- `card_cache_fail` 触发中（值 4）：其中 3 张卡是本次发版重启造成的 `socket hang up`（`card_fbn9b08Zg2` / `card_NbmKboRlnd` / `card_PB1NIhDZAo`，时间 07:00:30–32 与重启吻合，属预期瞬时失败，退避后会自愈）；**1 张是真故障**：`card_Pcw3tsfkLj`「主界面功能入口渗透率」报 `Limit for rows or bytes to read exceeded, max bytes: 46.57 GiB, current bytes: 46.59 GiB`——该卡 SQL 扫描量贴着 50GB 守卫上限，需要优化 SQL 或缩小范围。

### 验证记录与未验项

- 线上实测证据：`alertevent` id=164（`card_cache_fail` firing）、`alertnotification` id=1（`slow_query_spike` repeat/success）、id=2（`card_cache_fail` fire/success）及后续 repeat/resolve 行；飞书群「数据分析告警」实际收到消息（用户确认）。
- 未验：SMTP / 腾讯云 SMS 实际投递（生产未配置这两条通道，只验了「未配置时的拒绝行为」）；分析指标告警（`source=card`）线上触发未单独造数验证，仅单测覆盖（`alert-detector.service.spec.ts`）。
- 未改动（仅限本次验收）：`modules/alerting/**` 与 `modules/ops/**` 生产代码在验收当天未改。AL-01/AL-02 随后于同日修复并线上验证（见上「修复与验证」，提交 `bbca4e6`，生产 17157）。
- 本轮清点新发现的缺口（**已于 `phase: clklog-analytics-alerting-v3` 修复**，见 PRD/实现方案 `docs/product/prd-clklog-analytics-alerting-v3.md`、`docs/architecture/clklog-analytics-design-alerting-v3.md`）：① 卡片指标规则引用的卡片被删/缓存长期失败时，`evalCardMetric` 返回 null → 规则**静默失效**、不再触发，规则列表与页面无任何提示（`alert-detector.service.ts:287-300`）→ 现由规则健康度（`card_missing`/`cache_unavailable`）+ 概览提示条覆盖；② 规则/联系人/屏蔽的**变更无审计** → 现写 `ops_action_log`（`alert_` 前缀）并在「变更记录」Tab 可查；③ 通知失败**无重试**、失败无人知晓 → 现重试 3 次（退避 1s/2s），概览提示近 24 小时失败数。

## 2026-09-15：v2 跨表维度（JOIN）接通查询

触发：用户确认「展示列单独成行 → 再开工 v2」。帽子：程序/实现（门禁文档已有 `prd-clklog-analytics-datatable-v2` / `clklog-analytics-design-datatable-v2`）。路径 **C**：`JoinRegistry` LEFT JOIN `sa_datatable_rows`。

### 本轮关闭

| 项 | 做了什么 |
|---|---|
| DSL | `validatePropKey` 专用 `@` 分支，不放宽通用正则；注入字符拒绝 |
| Resolver | `{属性}@{字段}` 查生效绑定 → JOIN；失效 **400 可读错误**，禁止回退 `JSONExtract(properties,'a@b')` |
| 选择器 | `GET …/dimension-properties`；事件/漏斗/留存分组与筛选下拉标记「数据表」 |
| JOIN 键 | 主键列走 `alias.pk`；业务键走 `JSONExtractString(alias.values, key_column)`；单查询最多 3 张维表 |
| 用户 SQL | `sa_datatable_rows` **不进** sql-ast-guard 白名单 |

### 仍开放

A1–A8 生产造数对拍与性能基线、A9 卡片复测、A10 删表后卡片报错、用户属性绑定（v2 非目标）。

展示列 UI 单独成行已提交 `9bbbb17`（push 到 master，生产升级可能仍待 CI）。v2 查询接通见本段，发版需另一次提交。

---

## 2026-09-15：写入协议 + 展示列 + 映射接入面

触发：用户确认「按建议顺序」落地（先规格与数据正确性，再展示列，再接入面；不按本节下方 09-15 交接 §9 先铺漏斗）。帽子：产品/架构文档已回写；本轮改 `apps/`。**未提交、未发版。** 发版需隧道 2223 → push master → 等 CI → `server-upgrade.sh`（含 Prisma 迁移 `20260915043000_datatable_lease_and_label`）。

### 本轮关闭

| ID | 做了什么 |
|---|---|
| DT-02 | 租约 CAS：`pending_version` / `import_owner` / `lease_until`；抢不到租约 409 |
| DT-03 | 发布成功后审计失败只打日志，不删生效版本 |
| DT-04 | 更新预览/提交按已保存列名+顺序强校验；主键也做类型校验 |
| DT-14 | 发布后 `RETAIN_MS`（5 分钟）再 `dropOtherVersions`；在途读仍可读刚切走的版本 |
| VM-02 | 绑定显式 `label_field` 落库；关联弹窗「展示列」；查询读绑定字段 |
| VM-03 | 结果表「显示原始值」开关 |
| VM-01 | 漏斗/留存 `attachToColumns`；cache key 含 `datatableRevision`；图表 category 走 `value_map`；筛选下拉「名称（ID）」提交仍是 ID；CSV 同时导出业务名+原始值；发布后使该项目 event/funnel/retention 卡片 `refreshed_at` 过期 |

映射上限改为 **5 万**，超限列带 `value_map_stats.truncated`。

### 仍开放（本轮明确不扩）

A9/A10/A11/A12 造数验收、DT-06 空值语义、DT-08 绑定时类型强制、DT-09 删除影响面、DT-12 前端按 `meta.edit` 藏入口、VM-04 `element_id` id 空间。v2 跨表维度查询侧已接通，对拍与性能见上节。

---

## 2026-09-15：数据表 v2 生产对拍与验收（A1–A11）

触发：用户要求「按顺序实现，且每阶段必须有完整验收」。对拍用生产真实维表 `goods`（9,346 行 / key_column=`goods_id`）+ 2026-09-14 单日事件（16,671 个 goods_id / 504,360 次），基线**完全不经平台代码**。验收记录见 `docs/project/acceptance-clklog-analytics-datatable-v2.md`。

### 本轮关闭

| 项 | 结果 |
|---|---|
| A1 分组对拍 | 平台 4,612 组 = 基线 4,612 组，**差异 0**，总计数 504,360 双向一致 |
| A2 筛选 | `goods_id@goods_name in [...]` → 5,157 = 基线 5,157；生成 SQL 确含 `LEFT JOIN sa_datatable_rows` |
| A6 未命中 | 未命中桶 263,174 = 263,174；不存在的值 0 命中。`not_set` 语义确认为**按维表字段**（= JOIN 后为空），非源属性为空 |
| A7 绑定校验 | **修复**：`DatatableService.assertTargetPropertyType()` 校验属性存在 + 类型同族；线上实测 400（修复前 201） |
| A10 失效 | 删表后卡片刷新 400「属性 … 依赖的数据表已失效」，不落错值 |
| A5 用例 | 补 PRD 要求但**此前不存在**的「漏斗步骤用维度表属性筛选用例」 |
| A8 性能 | 维度分组 vs 同口径普通 JSON 属性分组 = **1.27×**（≤3×），但维表仅 9.3k 行 |
| CI 门禁 | 后端单测白名单 → **全量**（71 suites / 417 tests）；修 4 个 spec 的 configuration 隔离、删 1 个空占位 spec |
| DT-EQ 比较符白名单 | **修复**：`not_regex`（前端两个编辑器都提供、三个生成器都已实现，用户选中必 400）与别名 `eq` 补进 `VALID_FILTER_OPS`；线上复核 `not_regex` = total − regex = 263,174，`eq` 与 `=` 生成 SQL 逐字相同（发版 17177） |
| A3/A4 系统字段绑定 | **补测通过**：`#event_name@owner`（未登记事件回落空值）、`#event_time@campaign` 日粒度（09-14→双十一预热、09-13→日常） |
| A8 20 万行门槛 | **补测通过**：维度分组 P95 **11.1s** vs 普通属性分组 **5.6s** = **1.99× ≤ 3×**（维表 = 5,566 真实 appsflyer_id + 合成补齐 20 万） |
| A9 缓存失效 | **补测通过**：更新数据表替换标签后，卡片刷新读到新值（`A9标签N` → `A9改后N`） |
| A7 校验误伤（新） | **修复**（发版 17182）：`state` 属性在 10 个事件声明 number、12 个声明 string，原 `findFirst` 取任意一条 → 合法绑定被拒。改为取**全部**声明类型，**有一类同类即放行**；纯数值属性仍拒 |

### 仍开放

| ID / 级别 | 内容 |
|---|---|
| A3/A4 / P2 | `#event_name@owner`、`#event_time@粒度` 未线上验证（项目无此类绑定；语法与「未绑定报可读 400」已验） |
| A8 / P2 | 20 万行维表 + 单日事件量的 P95 未压测（当前只有 9.3k 行数据点） |
| A4 规格不符 / P3 | PRD 写「换粒度后属性重命名并需重新绑定（提示）」，实现里维度属性名不含粒度（`#event_time@<字段>`）且**没有绑定更新接口**（`PUT /:id/bindings/:bid` 不存在）→ 换粒度只能删除重建。需产品确认：补更新接口，还是改 PRD |
| `$` 属性不可作维度键 / P3 | `$model`/`$os`/`$app_version` 等内置属性**不能作维度属性**（`DATATABLE_DIMENSION_PROP_PATTERN` 仅允许 `#[a-z]...` 与 `[a-zA-Z_]...`）。这是文档化契约（不放宽通用正则），但常用分组字段多为 `$` 开头 —— 建议产品侧决策是否放开 `$` 前缀 |
| 残留 | 本次验收留下 4 条 `invalid` 绑定墓碑（`scene_id`×3、`goods_num_total`×1）。设计上删除数据表即置 `invalid` 保留墓碑（供同名重建复用），惰性无副作用 |

### 教训

- **裸 curl 的 CH 查询没有护栏**：验收过程中我的一条临时查询在 CH 跑了 31 分钟未退出（平台的查询有 `max_execution_time`，脚本里没有）。**脚本内临时查询必须显式带上 `max_execution_time` 与时间下界**，否则违反红线 4 的精神（查询必须有界），并与真实用户查询争资源。

---

## 2026-09-15：数据管理清理执行流验收（B1–B7）

触发：用户要求「按顺序实现，且每阶段必须有完整验收」。验收记录见 `docs/project/acceptance-clklog-analytics-data-management-v1.md`。

### 本轮关闭（均已发版）

| ID | 问题 | 修复 |
|---|---|---|
| B1 / P1 | **TTL 设置完全不可用**：DDL 生成 `MODIFY TTL col + TO INTERVAL '180' DAY`，CH 23.2 语法错误（数值不能加引号） | 改 `+ INTERVAL ${days} DAY`（天数已校验 1..3650）；发版 17170 |
| B2 / P2 | `parseTtlDays` 解析不出 `toIntervalMonth(18)` → 概览把已有 TTL 显示为「无保留期」 | 兼容 4 种写法（INTERVAL 带/不带引号、toIntervalDay、toIntervalMonth ×30）；现行 `sa_events` 显示 540 天 |
| B3 / P2 | 护栏类错误抛 `Error` → HTTP 500（确认表名不匹配、无可执行分区、TTL 越界、表不在盘点范围） | 改 `BadRequestException`；另 `log-cleanup` 的白名单/天数校验同样 500 → 一并改 400（发版 17173） |
| B4 / P3 | 按日分区的 `log_analysis`（磁盘占用最大）预演恒空且无说明 | 返回 `note` 说明「按日分区不支持月分区清理，请用 TTL」 |
| B7 / P1 | **长 DDL 导致审计丢失**：TTL 变更已生效但审计一行未写（事后补记模式不成立） | `set_ttl` / `drop_partition` 改为**先落 `status='running'` 再执行 DDL**，完成后更新 done/failed；DDL 失败带可读原因（发版 17172） |
| B5 / P1 | **TTL 在亿级表上不是廉价操作**：`materialize_ttl_after_modify` 默认 1 → `MODIFY TTL` 对既有数据执行 MATERIALIZE TTL，`log_analysis`（亿级行）实测调用 >120s 不返回、重写全部 part | **已修**（发版 17175）：显式置 `materialize_ttl_after_modify=0` → 纯元数据操作；临时表实测不再产生 mutation，生产大表实测 **0.11s 返回、0 个新 mutation**、审计留痕；前端文案说明「不会立即释放磁盘」 |

### 仍开放

| ID | 级别 | 内容 |
|---|---|---|
| — | P2 | 真实分区的 `DROP PARTITION` 未执行（破坏性，需授权） |

### 教训（操作层面）

- **KILL MUTATION 必须按 mutation_id 精确定位**：我按 `database+table` 过滤回退 B5 时，连带终止了一个非我发起的 `DELETE WHERE event='' AND distinct_id=''` 清理 mutation。共享实例上任何"按范围"的干预都可能伤及他人。
  - **B6 研究结论（2026-09-15，用户要求彻查）**：① `query_log` 全保留窗口（2026-09-13 00:00 起，2.7 天）内**没有任何**针对 `log_analysis` 的 `DELETE WHERE` 语句 → 该 mutation 创建于窗口之外，是**积压数日的陈欠 mutation**；② 宿主 `crontab` 与 `/etc/cron.d/` 无任何 CH 清理定时任务（仅 0hourly/puppet_auto/sgagenttask/sys_usage_check/yunjing 等系统项）→ 不是周期性作业，也不会被重建；③ 其判据命中的空键行（`event='' AND distinct_id=''`）**全表实测为 0 行** → 目的已达成或无匹配；④ 全实例 `system.mutations` 现无可中断项，全部 `is_done=1`。
  - **判定：无需重跑**，也无需通知外部所有者（无法从 query_log 追溯到发起者，且已无待清理数据）。
  - **附带发现**：该实例存在"陈欠 mutation 长期挂起"的现象（这条至少积压了 3 天以上）；`system.mutations` 里 `sa_user_profiles_old_20260914` 还留着 2026-08-27 的 `DELETE WHERE distinct_id LIKE '__verify%'` 已完成记录。建议：**回退类操作前先看 `system.mutations`（mutation_id / create_time / parts_to_do）再按 id 精确 kill**，并定期巡检是否又出现长期未完成的 mutation。
- 验收脚本内的临时 CH 查询必须带 `max_execution_time`（本次有一条跑了 31 分钟）。

---

## 2026-09-15：数据表值映射 v1 端到端交付与遗留（交接）

触发：用户在生产验收值映射时连续报告四个现象——「两列互相映射」「goods_id 列里出现商品名」「关联元素不显示映射」「想加回 goods_id 却搜不到」。本轮完成定位、修复、发版与复测。生产版本 **17134**（发布链路见 §7）。

### 1. 设计目的（本次交付解决什么）

- **只读展示层替换**：把分析结果里「已绑定数据表的属性」的取值换成维表业务名（`SGD0006830` → `Female new baby face blush 09`），让 ID 可读。被映射值用品牌蓝 `BRAND_PRIMARY` 显示，悬浮 `原始值：…`。
- **不改数据、不造数据**：行里的原始值不变，下钻/联动/导出仍用原始值；**明确不做「缺值反查回填」**——按 goods_name 反查出 goods_id 填进没有 goods_id 的记录，会让无归属记录凭空多出商品，改写聚合计数与对账口径。需要「按名称看商品」时正确做法是按 `goods_name` 分组。
- **口径**：join 键列由绑定指定（方案 B，可任选）；命中即替换、未命中回落原始值（不显示空、不伪造 0）；列头标注「（按X显示）」说明这一列被映射过。
- **展示列（label）规则**（本轮固化，查询与「关联属性」列表共用同一份实现）：优先 `*_name` 文本列 → 任一文本列 → 第一个非 key 列；**ID 型列（主键 / `id` / `*_id`）一律不作为展示列**；表里只剩 ID 型列时**不映射**（回落原始值）。

### 2. 本轮已完成（含线上证据）

| # | 问题/改动 | 提交 | 线上验证（2026-09-15，PROD 17134） |
|---|---|---|---|
| N3 | 展示列退化成 `goods_id`，导致 `goods_name` 属性被换成 ID、两列看起来互换（用户报的正是这条） | `99e9145` | `goods_name` 属性分组不再有 `value_map_title`；绑定接口 `label_title=商品名称` |
| N1 | 未绑定的分组列也被标成「已绑定维表…疑似配错」，每个普通分组列都挂红问号 | `99e9145` | 分组 `goods_name`/`element_id`/指标列均**无** `value_map_title`，`goods_id` 保留 `商品名称`（命中 127/279） |
| N2 | join 键列不是首列时仍把每行自增主键当候选键 → 事件取值恰好等于自增 ID 时被误映射 | `99e9145` | 单测覆盖（`键列不是首列时，事件取值等于自增主键不再被误映射`） |
| N4 | `meta_event_attributes` 列表只按 `updated_at desc` 排序 + skip/take，批量发现导入后大量行时间戳相同 → 翻页**重复+漏项**（实测 459 行只翻到 **260** 个不同属性；`goods_id/element_id/user_id` 全被漏掉）。`GET /meta/events`（`first_seen_at`）同坑 | `93d9a54` | 属性：total 459 / unique **459** / dup **0**；事件：前 4 页 400 条 dup 0（total 438） |
| N5 | 前端「选择属性/分析主体」只取第一页（`pageSize:200` 被服务端 `Math.min(100,…)` 夹紧）→ 第 101 条之后的属性永远选不到 | `efabbea` | UI 实测：配置关联属性 → 属性 → 输入 `goods_id` → 出现 `goods_id(goods_id) 文本` |
| N6 | 「一键关联同名字段」会给 `*_name` 列建绑定（名称列本身可读，映射只会把它换成别的字段——今天这次事故的源头） | `99e9145` | 跳过名称列并在提示里说明 |
| N7 | 新增 spec 经 `datatable-rows.service → clickhouse.service → configuration.ts` 在模块加载期要求 `CLICKHOUSE_PASSWORD`，CI 无 `.env` 时整份套件失败 | `da90975` | 工厂 mock 断链；按 CI 原命令集在「临时移除 .env」下复跑 9 suites / 59 tests 全过 |
| — | 展示列显式暴露：绑定接口/关联属性列表返回 `label_field`/`label_title`，列表渲染「展示列：商品名称」 | `99e9145` | UI 实测 5 条生效绑定各渲染一行；`goods_name` 那条为「已失效」 |
| — | 表头补「（按X显示）」+ 映射值蓝色 | `efabbea`（表头）/`99e9145`（颜色） | 产物 `EventAnalysisPage-Dqj4AIOt.js` 含 `style:{color:Je}` 与 `${title}（按${value_map_title}显示）` |
| — | 回归测试 `datatable-map.service.spec.ts`（5 例）并纳入 CI 用例集（`scripts/build.sh`） | `99e9145`/`1cbe5cf` | jest 332 passed；棘轮 `arch_ratchet.py` → passed |

**其他线上验证证据**：`GET /sa/api/ops/server-status` → `version=17134`；`item_consume`（09-07~09-14，按 goods_id/goods_name/element_id 分组）→ `goods_id` 列 `value_map_title=商品名称`、`value_map_stats={sampled:279,matched:127}`；`clothes_display_trigger` → 921/1000（92%）。

### 3. 关闭的既有问题（对应本文件 2026-09-14 节）

- **DT-01（P1，值映射读写标识不一致）→ 关闭**：`a1ca705` 修复后映射真实生效，本轮又有两处独立命中率证据（127/279、921/1000）。
- **DT-13（P2，映射范围与缓存）→ 部分关闭**：展示列契约固定（含 ID 列护栏）、未绑定列不再误报、补单测；**仍开放**：5000 值上限无提示、整表快照读取、进程内缓存旧版本不回收、卡片缓存失效、三类分析接入。
- **DT-15（P2，结构门禁与测试）→ 部分关闭**：数据表页面已拆分为 6 文件，`python3 scripts/arch_ratchet.py` **passed**；新增值映射单测并入 CI。**仍缺**端到端/并发/故障注入测试。
- **2026-09-14 生产探测节「数据表值映射 / P1（待验证）」→ 已验证并关闭**（见本节 §2 证据）。

### 4. 仍开放的问题（本轮新登记）

| ID / 级别 | 领域 | 证据与影响 | 建议方案 | 状态 | 最后复查 |
|---|---|---|---|---|---|
| VM-01 / P1 | 映射接入范围 | 值映射只接在**事件分析结果表**；漏斗、留存、图表、筛选下拉、CSV 导出、卡片/看板缓存均未接入（PRD v1 §4.5 要求全覆盖） | 按 `docs/architecture/clklog-analytics-design-datatable-v1.md` §7.3 逐处接入，并让卡片缓存随数据表修订戳失效 | **关闭（2026-09-15 本轮）** | 2026-09-15 |
| VM-02 / P2 | 展示列不可选 | 展示列只能自动推导：`user_id / face_id / vip_level / goods_source` 四条绑定都解析成「商品名称」（表里唯一 `*_name`），语义可疑但无法指定 | 绑定里显式选展示列并落库（`label_field`），列表与查询都读它 | **关闭（2026-09-15 本轮）** | 2026-09-15 |
| VM-03 / P2 | 原始值开关 | PRD v1 §4.5 的「显示原始值」开关未实现，目前只能悬浮看单值 | 结果表加列级开关（业务名 ⇄ 原始值），导出列同时输出两者 | **关闭（2026-09-15 本轮）** | 2026-09-15 |
| VM-04 / P2 | 绑定语义与 id 空间 | `element_id` 绑定不可能命中：维表 element_id 全为 `SEL…`（5516 行）、`UEL…` 0 行，事件侧为 `UEL…`；且该绑定 join 键被选成 `scene_id`。系统只给「0 命中」提示，无「属性与维表列不同源」判定 | 增强体检提示；该 `invalid` 绑定待用户决定删除或改键；同类场景需业务先确认 id 空间 | 开放（当前 `element_id/scene_id` = invalid） | 2026-09-15 |
| VM-05 / P2 | 观感与口径说明 | 列名是 `goods_id` 却显示名称，同一行若同时按 `goods_name` 分组会出现两列同值，易被当成「填错值」；已用表头后缀缓解 | 根治靠 VM-02；文档/页面文案说明「蓝色=维表业务名、悬浮=原始值」 | 开放 | 2026-09-15 |

### 5. 未做（能力缺口）

1. ~~显式选展示列（VM-02）~~ **本轮已做**。
2. ~~「显示原始值」开关（VM-03）~~ **本轮已做**。
3. ~~映射接入漏斗/留存/图表/筛选/CSV/卡片（VM-01）~~ **本轮已做**。
4. **v2 跨表维度**（沿用 DT-07）：查询侧已接通 JOIN；生产造数对拍（A1–A8）与删表后卡片报错（A10）未跑。
5. 映射相关的服务端限额未落地：单表 5 绑定 / 项目 50 表 / 500 派生属性（DT-08/DT-13）。

### 6. 未优化

| 项 | 现状 | 影响 |
|---|---|---|
| 映射取值上限 | 只处理结果集前 **5 万** 个取值，超限带 `truncated` 提示 | 更大基数仍会少映射一部分值 |
| 快照读取与缓存 | 每次映射读整表快照（9k 行级可用）；进程内缓存 TTL 命中，但旧版本不回收 | 表变大后退化；多版本残留内存 |
| 分页稳定性 | 本轮只修了 `meta_event_attributes` 与 `events` 两处排序；其他 `orderBy: updated_at` 列表多为单页返回，暂未受影响 | 新增分页接口需按 `prop_key`/`event_key` 兜底排序 |
| 权限体验 | 只读者仍可见编辑入口（DT-12） | 体验与越权观感 |
| 一键关联提示 | 成功提示未说明「已跳过名称列」（仅在全部被跳过时提示） | 用户不清楚为何某属性没被关联 |
| 审计与影响面 | 绑定变更审计、删除影响面统计仍缺（DT-09/DT-12） | 变更不可追溯 |

### 7. 发布路径实测（重要：CI 成功 ≠ 已上线）

1. `git push` → CI（约 2 分钟）构建产物并 rsync 到文件服务器模块，`.version` = `CI_PIPELINE_ID`。
2. **必须再执行** `scripts/server-upgrade.sh`（经 `localhost:2223` 隧道在部署机运行）：同步产物 → `prisma migrate deploy` → ClickHouse 幂等迁移（失败即中止）→ `supervisorctl restart clklog_analytics_server`。
3. 判断是否真的换了版本：`GET /sa/api/ops/server-status` 的 `version` 与 `uptimeSeconds`（重启后归零）；本轮 17118 → 17125 → 17133 → **17134** 都是「CI 已出包、生产未升级」，卡在第 2 步。
4. 风险：`scripts/server-upgrade.sh` 被 `.gitignore` 忽略（脚本改动不共享），且内联 MySQL root 口令（仅存在于部署机/开发机，未入库）——见 2026-09-14 节「密钥治理 / P2」。

### 8. 数据侧事实与风险（判断命中率前先看）

- `goods` 维表约 9.3k 行 × **44** 列（上传时 `##var`/`##` 元数据行已处理；`goods_url / goods_sell_sdate / goods_sell_edate / manual_tags` 4 个全空列被忽略不导）。主键为**首列自增 `id`**，业务键是文本列 `goods_id`。
- 命中率天然受维表覆盖限制，**低命中不等于映射缺陷**：`clothes_display_trigger` 921/1000（92%）；`item_consume` 127/279；场景类 `UGD…` 在表内仅 **35** 行而事件大量出现 → 缺「场景商品」维表。
- **补零位数不统一**：事件侧出现过 `SGD000006830`（`SGD`+9 位），表内为 `SGD`+7 位 → 等值匹配会静默漏行，需业务确认导出格式（同类问题会持续影响所有值映射命中率）。

### 9. 下一步建议优先级

1. 配置与数据治理：`element_id` 绑定去留、SGD 补零位数、场景类维表补录（VM-04）。
2. DT-06/08/09/12：空值语义、绑定时类型强制、删除影响面、只读者藏编辑入口。
3. 沿用 2026-09-14 评审其余项（DT-05 导入保真、DT-07 v2、DT-10 多草稿）。
4. 造数验收 A9–A12；发版后在生产对拍漏斗/留存映射与 CSV。

## 2026-09-14：数据管理「数据表」完整功能评审

触发：用户要求详细调研和评审。基线：本地 HEAD `1d74106`；产品文档与架构文档对照后，切换架构帽完成源码审计。未修改业务代码、未部署、未执行生产写操作。下述复现均为本地真实类/纯函数加内存依赖替身，不代表生产事故已经发生。

**评审结论：暂不通过完整 v1/v2 验收。** 管理入口、导入、版本字段和关联配置已实现，但 v1 核心值映射存在确定性标识错误；v2 仅有绑定派生字段元数据，查询解析尚未接通。并发、失败恢复、输入保真存在高优先级问题，不能根据页面存在或 CSV 单测通过判断可稳定使用。

### 当前能力与边界

| 环节 | 当前实现 | 评审结论 |
|---|---|---|
| 管理入口 | 列表、备注、创建向导、下载、清空、删除、关联弹窗 | 有基本管理骨架；缺搜索、审计查看/导出与真实引用影响 |
| 文件导入 | 前端 CSV/Excel、元数据行、表头归一化；后端 CSV 解析、类型推断、重复键取后行 | 比 PRD 扩展了格式与自动处理，但保真和契约未同步 |
| 更新 | 增量/替换、完整快照、切换 active_version | 缺结构强校验、租约/CAS、可靠失败恢复和在途读保护 |
| v1 结果映射 | 事件查询 enrichValueMaps、列 value_map、DataTable 悬浮原值 | 存储标识不一致导致不命中；只接入事件分析，不能宣称三类分析/图表/筛选/导出全覆盖 |
| v2 跨表维度 | binding.field_mappings 生成 `{属性}@{字段}` | DSL 不接受 @；resolver 不读取维表，不具备分组/筛选/聚合闭环 |
| 权限 | API 类级 meta.view，写接口 meta.edit；读取按当前项目查表 | 有后端权限和项目过滤；前端未隐藏编辑入口，未做真实角色 403 回归 |
| 资源边界 | 文件内容 10MB、20万行、100列；CH 快照有 project/id/version/LIMIT，公共服务带超时 | 项目50表/单表5绑定/500派生属性未见服务端强制；映射读取整表且缓存无回收 |

### 问题登记

所有条目发现日期及最后复查日期均为 **2026-09-14**；状态均为 **开放，待用户授权修复**。行号基于上述 HEAD，修复时重新定位。

| ID / 级别 | 领域 | 证据、触发与影响 | 建议方案 |
|---|---|---|---|
| DT-01 / P1 | v1 值映射 | `datatable.service.ts:221,279` 写 CH 时传内部 id；`datatable-map.service.ts:119` 读取却传 table_key。本地复现：id=dt_proof、table_key=items，读 key=items，map=null。正常建表产生 dt_ 随机 id，绑定后也无法映射业务名 | 统一 CH 标识为内部 id；补上传→绑定→事件分析的集成对拍 |
| DT-02 / P1 | 更新并发 | `datatable.service.ts:253-284` 先读 version_seq 再 +1，更新只按 id，无租约/CAS；schema 无 pending/lease。双请求隔离复现均写 version=2、不同 batch、同一 pk；MergeTree 无唯一约束，可能出现混合快照、重复键及丢更新。清空/删除同样未互斥 | 落实架构 §9 租约、唯一版本分配、CAS 发布、到期恢复，覆盖更新/清空/删除 |
| DT-03 / P1 | 发布后失败恢复 | `datatable.service.ts:279-323` 先更新 active_version，再写成功审计；审计失败进入 catch，执行保留 fromVersion 的清理。本地注入审计故障：activeVersion=3，但 cleanupKeep=2，生效版本会被删；catch 未回退元数据 | 区分发布前/后失败；发布与审计状态建立一致性协议；故障注入覆盖每一步，禁止删除已发布版本 |
| DT-04 / P1 | 更新结构与类型 | `datatable.service.ts:253-256` 更新仅解析请求，不从数据库读取固定 columns 做比较。前端更新也不发送既有类型（DataTablesPage.tsx:1176）。本地用 other,bad 替换 id,item_name 被接受，元数据仍为旧结构；后续下载/映射失真 | 服务端以已保存列名、顺序、类型为准；预览和提交统一校验，禁止重新推断既有类型 |
| DT-05 / P1 | 导入保真 | `DataTablesPage.tsx:234-241,308-311,337-340` 对普通 CSV/Excel 以非ASCII比例猜说明行并移除。本地抽取原函数验证：header=id,name，首行=1,精铁 返回 true；真实业务首条会被当字段名跳过，不计后端丢弃数。虽有 warning，但无保留该行的选项 | 只自动识别明确元数据标记；不明确的行由用户选择，默认保留；预览提供原始/转换后差异 |
| DT-06 / P1 | CSV 类型与空值 | `datatable-csv.ts:218` 从第2列开始校验，首列只校验非空；数值主键 not_a_number 本地被接受。`:136-145` 空数值写0、空布尔写false；datetime 不校验格式，长主键也绕过长度限制 | 主键与普通列共用类型/长度校验；明确空值语义并保持 NULL/空值和0/false区分；新增边界用例 |
| DT-07 / P1 | v2 查询闭环 | `dsl-validator.service.ts:28,178` 正则不允许 @；实际调用 validatePropKey(item_info@quality) 抛“属性名不合法”。`attribute-resolver.service.ts:53-99` 无数据表解析，field_mappings 消费仅限管理侧 | 在完成选择器、DSL、JOIN、失效语义、三类分析对拍前，不将派生字段声明为可用分析属性 |
| DT-08 / P1 | 绑定身份与一致性 | `DataTablesPage.tsx:1304-1324` 混入用户属性但统一 event_property；后端 `datatable.service.ts:399-453` 不检查目标存在、目标类型、同属性跨表冲突和绑定上限。项目多表绑定同一 prop 后 map.findFirst 无选择规则；任选 key_column，但映射仍 snapshot.get(raw) 仅查首列pk | 保留 scope/来源；服务端强制类型和身份约束；明确一属性一映射或消歧；按真实关联键构建有唯一性约束的查找 |
| DT-09 / P1 | 删除/失效影响 | `datatable.service.ts:512` referenced_cards 固定0；页面删除不查询影响面；失效绑定查不到时 map=null，原值静默回退，无依赖已删提示。`:357` 先删CH行再改元数据，失败可能留下active空表且无成功审计 | 实现依赖统计和状态提交协议；删除前备份/审计与影响确认；读取显式返回失效原因 |
| DT-10 / P1 | 多草稿保存 | `DataTablesPage.tsx:1336-1345,1395-1421,1275-1298` 可建多个草稿，但保存当前后服务器detail覆盖整个草稿列表，其他草稿丢失；源码路径确认，未做登录态点击复现 | 明确保存当前/全部，保留其他草稿；关闭/刷新前提示未保存变更 |
| DT-11 / P2 | 更新预览与操作保护 | `DataTablesPage.tsx:1219,1234` 无新增/更新/删除计数，换模式不重算；上传失败仍可保留前一文件预览；底部解绑/彻底删除直接执行而侧栏有确认（1451-1458 vs 1518-1530） | 预览绑定文件和模式，失败失效旧预览；统一确认，展示当前行数和引用影响 |
| DT-12 / P2 | 权限与审计体验 | 页面无 meta.edit 判断，普通只读者仍看编辑按钮；后端确有写权限装饰器，因此不是已证实越权。审计接口仅detail最近20条，页面未提供查看/导出；绑定变更无审计入口调用 | 前后端统一角色体验；提供可分页/导出的审计，纳入关联变更 |
| DT-13 / P2 | 映射范围与缓存 | `datatable-map.service.ts:28,千万级` 自动选 *_name/首文本字段，只处理前5000值，无超限提示，与PRD可选展示字段/5万上限不同。快照整表读取；`:60` 缓存按版本只set不删除，TTL只影响命中不回收旧版本。revision 只接事件查询，未见主动失效卡片缓存 | 固定映射契约；有界按需查值、LRU/容量约束与旧版本回收；三类分析和卡片缓存共同失效 |
| DT-14 / P2 | 在途查询与版本回收 | `datatable.service.ts:299,337` 切换后立即发送其他版本删除；`:readSnapshot` 先取得旧 active_version 的在途读可能在mutation完成后读到空。未见读者保护或安全保留时间 | 明确版本保留/读者协议，后台定向清理已过安全期版本，勿对所有非当前版本即时删 |
| DT-15 / P2 | 结构门禁与测试 | `python3 scripts/arch_ratchet.py` 退出1：DataTablesPage.tsx 1683行超过1200。当前数据表专属测试仅CSV 8例；缺version/lease/map与端到端验证 | 按上传、更新、绑定领域拆组件及解析器；补行为级故障/并发/分析闭环测试，不放宽棘轮 |
| DT-16 / P2 | 规格同步 | v1 PRD仍写“待评审、未进入实现”，v2写依赖v1已交付；CSV限定/50列/首列绑定与当前Excel/100列/任选关联键不一致 | 产品确认实际范围后同步稳定PRD、架构契约与验收清单，规格不代替运行时代码真相 |

### 验证记录与未验项

- `npm test -- --runInBand src/modules/datatable/datatable-csv.spec.ts`：**8/8通过**；只覆盖解析与mergeSnapshot，不能证明上传/绑定/查询闭环通过。
- stdin运行真实TS类、内存替身：确认DT-01、02、03、04；真实纯函数确认DT-05、06；真实DSL校验器确认DT-07。未向数据库写入、未新增永久测试文件。
- 棘轮：**失败**，唯一输出为数据表页面1683行超限。本次仅登记，不修复或更改基线。
- UI采用两个独立评估（A源码交互，B检测器/浏览器）；detector返回`[]`、退出0，不覆盖业务正确性。两者新开本地8180页面均跳转登录，临时页已关闭；未登录，未进行目标页视觉/键盘/角色权限实测，无overlay，未启动新服务。
- 启发式源码评分 **17/40**：状态2、语言2、控制1、一致性2、防错1、识别2、效率2、信息层级2、恢复1、帮助2；不是生产用户测试分数。
- 生产版本、真实ClickHouse插入/故障/性能、真实多角色403、三类分析与导出对拍：**未验证**。历史交接中的生产17114声明不作为本次版本实测。

### 建议修复顺序与完成条件

1. 先修数据正确性：DT-01至06、08、09、14；上传/更新不得静默改行，审计失败不能删除生效数据，并发不能共享版本。
2. 完成v1验收：普通事件、事件名、时间粒度和非主键关联；事件/漏斗/留存、图表、筛选、CSV、卡片缓存；同时补权限、影响面和审计体验。
3. 独立完成v2：派生属性可选可查询，JOIN有界、类型/未命中/失效语义一致，三类分析与原生SQL对拍；通过文档性能门槛。
4. 同步PRD/架构的实际范围，完成组件拆分并让棘轮通过。上述是建议，当前评审不等于授权修复或部署。

## 2026-09-14：数据表 Gate 0 生产探测发现（只读探针，未改码、未发版）

触发：`clklog-analytics-datatable-v1` 实现方案评审要求先验证 ClickHouse 能力，用户已授权在生产跑只读探针。环境：生产主机，ClickHouse `23.2.1.2537`，只读账号 `sa_readonly`；所有探针带项目过滤与行数上限，未执行任何写操作。

| 发现日期 | 领域 / 级别 | 证据与影响 | 建议 / 状态 | 最后复查 |
|---|---|---|---|---|
| 2026-09-14 | 查询引擎 / P1 | **23.2.1 不支持相关子查询**：`SELECT (SELECT max(batch_id) FROM clklog_sa.sa_cohort_members WHERE uid = sa_events.distinct_id) …` → `Code: 47 UNKNOWN_IDENTIFIER Missing columns: 'sa_events.distinct_id'`；最小反例与"列齐备"重测同样报错（与缺列无关） | `attribute-resolver.service.ts:87`（`resolveUserProperty`）与 `subject-expr.ts:32-38`（scope=user 分析主体）生成的正是外列相关引用 → 用户属性筛选/分组与用户属性分析主体在生产会报 missing columns。修法须改 JOIN 或字典取数；未授权前不改码、不发版 | 2026-09-14 |
| 2026-09-14 | 元数据漂移 / P1 | **生产 `sa_user_profiles` 无 `project_name` 列**（`system.columns` 实测仅 `distinct_id,user_key,properties,updated_at`），而 `init-clickhouse.ts`、`attribute-resolver.service.ts:87`、`subject-expr.ts:36` 均按 `project_name = sa_events.project_name` 书写 | 线上表与 init 脚本漂移：直接 `WHERE project_name = 'x'` 查该表同样报缺列。需确认建表入口并补幂等迁移（与下一条同批处理） | 2026-09-14 |
| 2026-09-14 | 发版路径 / P2 | `scripts/` 内无任何 `init-clickhouse` 调用（`grep -rl` 0 命中），`init-clickhouse.ts` 仅能人工执行 | 新增 ClickHouse DDL 不会随升级生效，漂移会持续；新功能统一走幂等迁移入口并接入 `server-upgrade.sh` | 2026-09-14 |
| 2026-09-14 | 既有方案修正 / P1 | `docs/architecture/clklog-analytics-design-user-property-join-v1.md` 把 2026-09-08 的 missing columns 归因为"缺项目条件"，据此加 `project_name` 关联 + `LIMIT 1`；实测表明根因是**相关子查询不被支持**叠加**表缺列**，该修复方向不成立 | 该方案待重开（文档已加修订说明指向本节证据）；Harness `scope=user` 的 fail-closed 保持 | 2026-09-14 |
| 2026-09-14 | 前端门禁 §7 / P2 | 全局扫描「表格数 vs 横向滚动兜底」：`DataTablesPage` 4/4 合规；既有页面仍有缺口 —— `EventAttributesPage` 2/0、`SeriesStatsTable` 1/0、`mute-form` 1/0、`DashboardListPage` 3/2、`UserTagsPage` 2/1、`UserCohortsPage` 2/1、`AiWorkspacePage` 2/1、`DataManagementPage` 4/3（部分小表可能不需要横滚，需逐个判断关键文本列是否有宽度） | 不在本次改动内顺手改（避免扩大范围）；建议按 `docs/architecture/templates/AGENTS_front.md` §7 单独做一次表格合规清查，逐表确认「关键文本列宽度 + 截断 + 操作列固定 + 横滚兜底」 | 2026-09-14 |
| 2026-09-14 | 数据表值映射 / P1（待验证） | **值映射端到端未验证**：后端 `value_map` 已接入事件分析结果、前端已消费（业务名 + 悬浮看原值 + 表头问号），生产 `17114` 已上线，链路代码与产物均已核对；但**未拿到「ID → 业务名」真实生效的证据**。原因：用 `POST /sa/api/query/event` 探了 4 轮（`item_daixin_exchange_success` × {user_id、goods_source、vip_level、user scope vip_level}），该事件在探测时间窗内无数据，分组值全为空 → 无可映射值，故未触发映射（非逻辑报错）。事件列表接口无量级字段，无法自动挑到有量事件。**下一步**：由用户给一个「有数据的事件 + 有值的属性」或自己跑一次事件分析（按 `user_id`/`goods_source` 分组）截图确认 | 2026-09-14 |
| 2026-09-14 | 密钥治理 / P2 | `scripts/server-upgrade.sh` 内联了 MySQL root 口令（`DATABASE_URL="mysql://root:…@…"`）。**复核修正**：该文件被 `.gitignore:46` 忽略，口令未入库，仅存在于部署机/开发机 | 建议改为只引用部署环境注入（supervisord 已提供 `%(ENV_DATABASE_URL)s`）；另因该脚本被忽略导致"发版脚本改动不共享"，建议在 `docs/project/legacy-production-handover.md` 留一份脱敏模板 | 2026-09-14 |

**2026-09-14 更新**：上表前两条 P1（表缺列 + 相关子查询不可用 → 用户属性路径失效）**已立项修复**：`docs/product/prd-clklog-user-property-path-v1.md`、`docs/architecture/clklog-analytics-design-user-property-path-v1.md`（待评审与发版授权，尚未改码）。第三条（发版路径）与第四条（既有方案归因修正）同批纳入。

**2026-09-15 更新**：表中「数据表值映射 / P1（待验证）」**已验证并关闭** —— 生产 `17125`/`17134` 实测映射端到端生效（`goods_id` 列按 `商品名称` 显示，命中 127/279 与 921/1000），并顺带发现并修复了 3 个映射缺陷、2 个列表分页缺陷（根因是列表排序不稳定），详见本文件「2026-09-15：数据表值映射 v1 端到端交付与遗留」节。

写操作说明：只读探针 11 次（`sa_readonly`）；另按用户单独授权执行 1 次临时字典 DDL 探针（`CREATE/DROP DICTIONARY clklog_sa.__probe_dt_dict`，建后即删，复查残留 0）。`OVERRIDE-REASON`（红线⑥无测试库）与复盘见 `docs/project/retrospective-datatable-gate0-2026-09-14.md`。探针命令与结果见 `docs/architecture/clklog-analytics-design-datatable-v1.md` §4.3、`clklog-analytics-design-datatable-v2.md` §4.5。

## 2026-09-08：AI Workspace 本地实现审计

本节是当前进展；下方 2026-09-02 暂停/未授权结论保留作历史。用户已授权本次“先方案，再实现和本地测试”，phase 为 `clklog-ai-workspace-v1`，没有授权生产发布。审计触发：本次代码改动超过 20 个文件。

| 发现日期 | 领域 / 级别 | 证据与影响 | 建议 / 状态 | 最后复查 |
|---|---|---|---|---|
| 2026-09-08 | Harness / P1 | 固定签名超时会让 prompt/cancel/export 401；单纯刷新 iframe 丢失会话内存态 | 宿主认证续签并原位更新前缀；已完成本地测试及真实 opaque iframe 验证，未部署 | 2026-09-08 |
| 2026-09-08 | Page Bridge / P1 | SQL 局部版本与桥接版本分叉，结果更新也会拒绝旧 SQL；确认框过期后可能仍执行 | 单一语义 revision、提案截止、确认前复核；回执失败不冒充执行失败；本地回归通过 | 2026-09-08 |
| 2026-09-08 | 查询隔离 / P1 | Query service 使用 body.project，仅内部 header 不足以绑定；项目 reset 后迟到响应可覆盖结果 | Gateway 强制覆盖请求体项目；三个 Store 代次校验、卸载卡片回调取消；本地回归通过 | 2026-09-08 |
| 2026-09-08 | 用户属性 SQL / P1 | `attribute-resolver.service.ts::resolveUserProperty` 关联标量子查询引用外层 sa_events.distinct_id，缺项目条件；截图 missing columns 与此路径吻合 | 专门方案已补（`docs/architecture/clklog-analytics-design-user-property-join-v1.md`，phase: clklog-user-property-join-v1）并实现：子查询补 `project_name` 关联 + `LIMIT 1`，cohort profile 侧替换同步扩展；本地测试通过（3/3 新增 + 62 回归）。Harness fail-closed 保持；三类线上对拍在发版后执行，通过前不解除保护 | 2026-09-09 |
| 2026-09-08 | 留存语义 / P2 | cohort=all 每主体 minIf 起始日，不是每日重复入组；first_day 取 is_first_day 标记 | 能力说明与案例按现实现明确口径；每日重复入组能力未实现 | 2026-09-08 |
| 2026-09-08 | 模型等待 / P2 | 截图 857 分钟缺原 Session 日志，不能确定整轮状态来源 | 已加单请求绝对截止和提案终态；官方计时、整轮总预算、真实供应商取消仍待日志复核 | 2026-09-08 |
| 2026-09-08 | 发版与模板 / P1 | 本地 ClickHouse 26.9 与 Puppet 23.2.1 不同；已发布模板不会自动读代码种子 | 生产同版本对拍、长稳、管理员模板发布/同步为上线前待验项；本次未部署 | 2026-09-08 |

完整命令、测试计数与限制见 [本地验收](docs/project/validation-clklog-ai-workspace-v1.md)。新增前端包分别归属分析提案和连接生命周期；Query 继续拥有 DSL 校验，Store 继续拥有页面内容版本与查询结果，没有新增持久化实体或双轨实现。既有 Runtime OOM、密钥配置和生产隔离冒烟问题没有被本次本地测试关闭。

## 2026-09-02：AI Harness MVP 发布交接

### 当前停点

- 分支：`master`。生产已切到 CI 包 `16668`。Harness plugin/wrapper 已在 `releases/16668` 上热修（`time_range.additionalProperties` + DSH 退出立即失败），待随后 CI 包固化。不要部署 `16644` / `16590`。
- 2026-09-03：生产 45 张 SQL 卡近 7 天 execute **全部通过**（42 成功 + 3 空结果）。analytics-server 已热补：逻辑表改 `additional_table_filters`、`max_bytes_to_read` 50GB、`timeout_before_checking_execution_speed=100`。待下一 CI 包固化。不要部署 `16644` / `16590`。
- 2026-09-03：ClickHouse cgroup **12G**。对照副本与真实 Puppet 本地均为 `$ck_memory = '12G'`。真实 Puppet **须用户提交** 后 agent 才会稳定留下 12G。
- 2026-09-03 AI 504：不是网关本身挂了。16668 新增 `clklog_execute_sql_card` 的 `time_range` object 未声明 `additionalProperties`，DSH schema 编译失败立刻退出；bootstrap 空等 60s 被 stgw 打成 504。已热修 schema；DSH 能打出 `dsh web: http://127.0.0.1:39200/?token=`。
- 2026-09-02 20:37：**用户暂停 AI 收尾（事件/漏斗写回仍未授权）。** Cursor 仍看不到 sandbox iframe。
- 真实 Puppet：`clklog::clklog_manager` 的 supervisor `command` 仍须保持 Node 24 路径。
- `sql/test/场景/*.sql` 与 `puppet/README.md` 说明同前：不要把对照 README 拷进真实 Puppet 仓库。

### 2026-09-02 评估：功能是否做完、是否生产级

口径：`phase: clklog-ai-analytics-v1` PRD。分析平台 M2/M3/SQL/RBAC 是更早阶段，已验收，不在本评估里重开。

**结论**：本期 MVP **代码面已铺上**；**生产级（多人日常、SLA、安全签字）未达到**。私有单租户、出问题能刷新重连，可作为内部试点。回来后先稳定和验收，不要加功能。

**已交付（对 PRD MVP）**

- 四页共用官方 Harness 面板；多供应商/模型/思考强度；隔离 Runtime + Workspace/管理员模板。
- SQL Page Bridge 完整：快照 → diff → 确认写回 → 再确认执行。
- 事件/漏斗/留存只发快照、不写回表单/DSL：这是 PRD 写明的 MVP 非目标，不是漏做。
- 16660：死 socket 拉起重试，避免 `session/prompt` 直接 502。

**未达生产级的硬缺口**

1. 官方 DSH 仍是 `0.1.2-alpha.3`，升级必须重测。
2. 供应商密钥仍在 `config_server.yaml`（已批准 OVERRIDE，非长期方案）。
3. 生产 `podman inspect` 越界冒烟未做成每次发版固定记录。
4. 无入库的 iframe E2E（Cursor 浏览器看不到 sandbox iframe）。
5. 工具调用未落审计表；供应商不返回 usage 时 token 不可靠。
6. 首屏仍是 DSH 与 ClkLog 两套工作区选择器。
7. 2026-09-02 19:45–20:05 ClickHouse cgroup 反复 OOM（与 AI 502 不同链路，但打主查询）。
8. 16660 只保证容器死后能醒，**未查明 Runtime 为何在对话中途退出**（1g 限制 / DSH 崩溃 / 宿主机压力均可能）。
9. PRD AI-1～AI-20 文档框未勾；AI-20（20 条回归 + 多浏览器）明确未纳入。

**回来后的优先级（未授权前不要做后面的产品项）**

1. SQL 闭环手工跑通到无聊：选工作区 → 说话 → 提案 → 确认写回 → 确认执行。
2. 查清 Runtime 退出原因（容器内 OOM、DSH 退出码、是否与 CK 抢内存）。
3. ClickHouse 内存，避免 MergeMutate 杀进程导致分析/SQL 随机 500。
4. 首屏收口：默认 Workspace / 自动 `startSession`，去掉两套选择器。
5. 发版门禁：`podman inspect` 清单、Playwright（登录 → iframe → 工作区 →「你好」）、密钥迁出 yaml。
6. **之后**才开新 phase：事件/漏斗写回、一键恢复 UI、工具审计表。各要独立产品+架构文档。

### MVP 已交付范围

- 四个分析页共用右侧官方 Harness Web 面板，默认展开、可折叠、桌面端 `360px–50vw` 拖动、窄屏全屏，偏好按用户保存。
- 官方命令、模型/供应商、思考强度、权限预设、会话等能力由固定版本 DSH Profile 提供，不再使用旧版简化聊天接口。
- 小写、多供应商 `config_server.yaml`；每个 provider 优先读取派生或显式 `<PROVIDER>_API_KEY`，为空时回退配置值。
- 配置 Linux 用户、永久/临时 Workspace、管理员初始化模板 draft/预览/发布/版本/同步/重试/遗留初始化、`managed_readonly` 与 `seed_once`。
- rootless Podman 外层容器：无网络、只读 rootfs、drop all capabilities、no-new-privileges、资源限制、窄 mount；供应商密钥只在服务端模型网关。
- SQL Page Bridge：读取受控快照、revision diff 提案、用户确认写回、独立执行确认；登录撤销和用户禁用会关闭/拒绝 Runtime。

### 接手后的最短发布路径

1. 确认最新 `master` pipeline 成功，且新加坡 rsync 模块中 `.version` 已更新；若未更新，先查看 CI 日志，不要手工拿本地 `target/` 绕过 CI。
2. 在仓库根执行现有手动发布脚本：`scripts/server-upgrade.sh`。
3. 在 `生产主机` 执行：`bash /data/project/clklog_manager/production/ops/install-harness-runtime.sh /data/project/clklog_manager/production`。
4. 核对 Node `v24.20.0`、Supervisor 三个进程、nginx 配置、Broker Unix Socket 健康、`harness` 用户/subuid/subgid/linger 和数据库 AI Workspace 表。
5. 启动一个 Runtime 后用 `podman inspect` 核对 `network=none`、只读 rootfs、cap drop、资源限制与 mount 仅包含当前 Workspace/DSH Home/窄网关；任何边界缺失都应停止上线。
6. 浏览器最小验收 `/sa/report/sql`：面板默认展开、拖宽、命令面板、模型与思考强度、真实模型回答、临时/永久 Workspace、SQL 读取→diff→确认写回→独立执行；再抽查事件/漏斗/留存页均有面板。
7. 管理员页面 `/sa/admin/ai/workspace` 新建无害测试文件，预览/发布后只对测试 Workspace 做 scoped sync，验证 `managed_readonly` 不可写且 `seed_once` 不覆盖。

临时明文供应商密钥覆盖及退出条件见 `docs/project/retrospective-clklog-ai-analytics-v1-2026-09-01.md`；不得把该例外扩大到数据库、登录、Kafka、SSH 或其他凭据。MVP 未完成项和残余风险见下表中 2026-09-02 的 AI 条目。

| 发现日期 | 影响领域 | 严重级别 | 问题与证据 | 建议方案 | 状态 | 最后复查 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-01 | ingestor / 数据质量 | 中 | **`sa_events.os` 物理列大小写口径分裂**：同一 JSON `$os` 值存在 `android`（官方 clklog-processing 写入）与 `Android`（分析 ingestor 拷贝 JSON 原值）两种口径，抽样 5000 行中 4564 行不一致。按 `os` 物理列分组会把同一平台拆成两组。证据：`SELECT countIf(os != JSONExtractString(properties,'$os')) ...` 抽样（2026-09-01）。 | 统一写入口径（ingestor 归一化或官方链路映射），或分组查询侧做 `LOWER()` 归一（会损失原始值）。需先定口径再回填，涉及数据改写须按红线 6 演练。 | 待定 | 2026-09-01 |
| 2026-09-01 | ingestor / 数据质量 | 中 | **`base_ui_open_trigger` 等高频事件 `browser` 物理列全空**：该事件近一日 千万级行 browser 均为空串，但 JSON `$browser` 有值；此前抽样 `countIf(browser != JSONExtractString(properties,'$browser'))=0` 系两列同空。按 browser 物理列分组结果只有一组空值。证据：`SELECT browser, count() ... GROUP BY browser`（2026-09-01）。 | 排查 ingestor 预置字段提取逻辑为何对部分事件源未填 browser；必要时回填。属写入侧修复，前端/查询侧不处理。 | 待定 | 2026-09-01 |
| 2026-09-01 | report / 查询性能 | 中 | **JSON 属性分组对超高频事件超时**：`JSONExtractString(properties, ...)` 需读 `properties` 列，`base_ui_open_trigger` 7 天约 千万级行、约 45GB。旧守卫 `SELECT *` 子查询 + 5GB 字节上限 + 10s 预估误杀。 | 2026-09-03：注入改为 `additional_table_filters`；字节 50GB；推迟预估检查；部分 SQL 卡改为单次扫描/`visitParam`。30s/2GB 未放宽。主界面入口卡终验 29.8s。 | 短期已缓解 | 2026-09-03 |
| 2026-09-01 | report / 元数据 | 低 | **`meta_event_property.materialized_column` 全部为空**：schema 接口的 `materialized` 字段无数据可用（查询返回总计 0 条），属性到物化列的映射链路未启用。 | 若启用物化列方案，需先建回填/维护任务写该字段，前端已支持按该字段优化表达式的挂点。 | 待定 | 2026-09-01 |
| 2026-09-02 | AI / Page Bridge | 中 | **MVP 仅完成 SQL 写回 action**：四个分析页都能向 Harness 发布受控快照，SQL 已具备 revision、diff、用户确认写回和独立执行确认；事件、漏斗、留存尚不能由 AI 直接 patch 表单/DSL。 | 后续为三类页面分别定义窄 action schema、冲突检测和组件级 E2E；不得复用任意 JSON patch。 | MVP 后续 | 2026-09-02 |
| 2026-09-02 | AI / Workspace | 中 | **恢复副本暂时没有一键恢复 API/UI**：同步会在 `.clklog/recovery/<job_id>/` 写逐项副本、diff 和失败记录，管理员能查看路径与重试，但人工恢复仍需服务器操作。 | 增加受 RBAC 控制的预览/恢复接口，恢复本身也生成反向恢复点与审计。 | MVP 后续 | 2026-09-02 |
| 2026-09-02 | AI / Workspace | 低 | **同步锁只覆盖单 analytics-server 进程**：当前生产为单实例，进程内按 Workspace 串行并以数据库状态 CAS 防止删除/提升竞态；尚无多实例分布式锁和 draft ETag。 | 扩容 analytics-server 前增加数据库 advisory lock/租约，并为管理员 draft 增加版本冲突提示。 | 扩容前必须处理 | 2026-09-02 |
| 2026-09-02 | AI / 配额 | 中 | **Workspace 配额不是独立文件系统硬配额**：Broker 启动前扫描、运行中每 30 秒扫描，并设置 `fsize`；在扫描间隔内仍可能短暂超限，`fsize` 也不是目录总量限制。 | 若面向不可信租户，改用项目级 volume/XFS quota 或独立 user namespace 存储配额。 | 已知残余风险 | 2026-09-02 |
| 2026-09-02 | AI / 审计 | 中 | **MVP 审计未全部持久化**：Harness 保留会话日志，模型出口写无 prompt/key 的结构化日志；工具调用未单独落审计表，供应商不返回 usage 时不能可靠记录 token。 | 增加 append-only 审计表、保留策略和 usage 适配，管理员页面提供检索。 | MVP 后续 | 2026-09-02 |
| 2026-09-02 | AI / Sandbox | 中 | **Danger 模式仍可破坏自己的数据**：外层容器限制到当前 Workspace 和同用户/项目 DSH Home，但 `Danger Full Access` 可删除 Workspace 可写内容或个人会话历史；这不构成跨用户/宿主机越权。 | UI 在切换 Danger 时明确提示；重要 Workspace 增加快照/备份能力。 | 已知残余风险 | 2026-09-02 |
| 2026-09-02 | AI / Sandbox | 高 | **生产内核/rootless Podman 的实际隔离尚需每次大版本验收**：代码固定 `network=none`、只读 rootfs、drop all caps、no-new-privileges、资源限制和窄 mount，但不能由本地 macOS 单测证明生产内核行为。 | 本次上线做容器 inspect 与越界冒烟；以后升级内核、Podman、Node 镜像或 DSH 时重复。 | 发布门禁 | 2026-09-02 |
| 2026-09-02 | AI / Harness | 中 | **官方 DSH 依赖仍是 `0.1.2-alpha.3`**：MVP 固定版本并保留原生命令/Profile，但上游 alpha 变更和导出包中用户主动输入秘密的风险仍存在。 | 升级必须重新做命令/Profile/Page Bridge/Sandbox 兼容测试；导出前增加用户提示与可选扫描。 | 已知残余风险 | 2026-09-02 |
| 2026-09-02 | AI / 运维 | 低 | **Harness release 目录尚无自动保留策略**：每次 CI 版本安装到 `/opt/clklog/harness/releases/<version>`，当前不会自动删除旧版本。 | 保留当前与最近两个可回滚版本，清理前校验 `current` symlink 且写运维日志。 | MVP 后续 | 2026-09-02 |
| 2026-09-02 | AI / 验收 | 中 | **完整 20 问题分析回归与多浏览器自动化 E2E 不纳入本次 MVP**：核心单测、构建和生产冒烟仍是发布门禁。 | 建立脱敏固定数据集、假模型、Playwright 用例，覆盖多 tab、logout、模型切换和三种权限预设。 | MVP 后续 | 2026-09-02 |
| 2026-09-02 | AI / Harness UX | 中 | **官方 DSH 首屏与 ClkLog Workspace 选择器是两套 UI**。后续又发现：JS `"/api"` 改写导致 `invalid RPC target`；停改写误伤 `/plugins/??`；opaque-origin 的 `Sec-Fetch-Site: cross-site` 让 `/api` 全 403；禁用 host `web` 使 standard preset 的 `tool-web` 无法挂载。 | 16655：shim + 保留 `"/api"` 通道、改写 `/plugins`、剥离 Fetch Metadata、保留 host `web`。Playwright 已能点进 `workspace` 进入聊天。后续可用 Host 插件自动 `startSession`。 | 进行中 | 2026-09-02 |
| 2026-09-02 | AI / Harness 代理 | 高 | **Runtime Unix socket 消失后 `/api/session/prompt` 返回 502**。用户对话中 DSH 容器退出（`--rm`），代理 `connect ENOENT runtime.sock`，DSH 客户端显示 `HTTP 502 (gateway/internal)`。证据：analytics-server.log 20:00:25 起连续 POST prompt ENOENT。 | 同一 runtime_id `broker.ensure` 拉起并重试一次；仍失败 401。已部署 `16660`。根因（容器为何退出）未查清。 | 症状已修 | 2026-09-02 |
| 2026-09-02 | ClickHouse / 内存 | 高 | **宿主机 ClickHouse docker cgroup 反复 OOM**。2026-09-03：1500M 下 MergeMutate 把 `clickhouse-serv` rss~1.5GB 杀掉（exit 137）。限额已改为 **12G**（30G 机器，不把 available 全给 CH）。 | 用户提交真实 Puppet `$ck_memory=12G`；compose 变化走 `up -d --force-recreate --no-deps clickhouse`。 | 生产待 12G 固化 | 2026-09-03 |

## 2026-09-09 ThinkingData 知识迁移

phase: clklog-thinkingdata-migration-v1。模板 v3 与定向项目包已上线，文件哈希通过；详见 [迁移记录](docs/project/migration-thinkingdata-ai-workspace.md)。无新增运行时兼容层，无应用重新部署。发现 workspace.yaml 的初始化版本与已应用版本不同，当前通过管理员状态与实际文件哈希核验；后续如展示该字段，须区分初始化与当前应用版本。历史候选数据不得提升为现网事实。

2026-09-09 线上验收阻塞：应用产物 16923 与独立 Harness current 16668 不一致，实际缺少新增工具；未执行生产更新。完整接续步骤与验收清单见 [交接文档](docs/project/handoff-harness-live-acceptance.md)。

2026-09-09 交接后续接：已按交接授权执行 `install-harness-runtime.sh`（current → `releases/16923`，备份在服务器 `/root/backup-harness-20260909/`），随后在应用内浏览器完成 E/F/R/S 四类纵切线上验收，**全部通过**（逐日/逐步对拍一致；S 含 409 冲突拒绝与重提案恢复两项冲突检查）；prompt/cancel/Session 导出立即成功，历史会话跨页面恢复已证明。长时项（跨签名续签、后台 30 分钟、休眠、撤权分类、多窗口并发）仍未验证，需用户同意另行安排。证据与遗留口径见 [validation 文档](docs/project/validation-clklog-ai-workspace-v1.md)。

| 发现日期 | 领域 / 级别 | 证据与影响 | 建议 / 状态 | 最后复查 |
|---|---|---|---|---|
| 2026-09-09 | Page Bridge 提案 / P3 | propose 等待用户确认超时后模型自动重试，宿主堆叠两个同源确认框（内容相同，标注「上次超时未应用」）；E 验收实测出现，人工接受重试、拒绝原始后无错误写回 | 已按「提案确认唯一性」修复（服务端 superseded 替换 + 前端销毁旧框，commit 16cf666，测试 13/13、6/6）；随下次应用发版生效，生效前线上仍为旧行为 | 2026-09-09 |
