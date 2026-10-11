# 验收记录：AI 模型供应商网页设置（model-providers）

- `phase: clklog-ai-model-providers-v1`
- 帽子：程序 / 实现（验收留证）
- 门禁文档：`docs/product/prd-clklog-ai-model-providers-v1.md`、`docs/architecture/clklog-ai-analytics-design-model-providers-v1.md`
- 发版：v1.0 → **17525**（16:08）；v1.1 → **17529**（17:17）；v1.2 → **17535**（18:02），服务器 生产主机
- 提交：`095f2ab`（v1.0）、`cf5e2a0 feat(ai)!: 模型供应商不再依赖环境变量与配置文件，新增图片输入能力`（v1.1）

---

## 1. 已上线内容

「设置 → AI Workspace 管理」新增第 4 个 Tab **模型供应商**。供应商与默认模型入库
（`saaimodelprovider` / `saaimodelsettings`），密钥 AES-256-GCM 密文存储；配置生效规则、
校验规则与测试覆盖见实现方案 §4–§8。

同时上线：`dsh-home/settings.yaml` 改为读-合并-原子写（默认模型改动对老用户生效）、
清空 `config_server.yaml` 的两个明文 `api_key`、supervisord 模板补 `ALERT_CONFIG_KEY`。

## 2. 自动化门禁

| 项 | 命令 | 结果 |
|---|---|---|
| 架构棘轮 | `python3 scripts/arch_ratchet.py` | passed（无新增 env 读取、无超标目录） |
| i18n 资源一致性 | `python3 scripts/i18n_check.py` | 通过：13 语言 × 16 命名空间 / 3734 键（新增 75 键） |
| i18n 硬编码棘轮 | `python3 scripts/i18n_scan.py --check` | 通过：1389 → 1389（新增错误只给 `code`+`messageKey`+`params`） |
| 后端单测 | `npx jest --runInBand` | 117 套件 / 862 用例通过 |
| 前端单测（新增） | `npx vitest run src/features/ai-model-providers` | 5 用例通过 |
| 两端构建 | `npm run build`（web / server） | 通过 |
| 明文密钥残留 | `rg "sk-tp-\|sk-ddd" apps/analytics-server/config_server.yaml` | 无命中 |

## 3. 生产部署证据（版本 17525）

| 检查 | 命令 | 结果 |
|---|---|---|
| 版本一致 | 对比 rsync 模块与生产 `.version` | 模块 17525 = 生产 17525（CI 产出后拉取） |
| 迁移 | `server-upgrade.sh` 输出 | `Applying migration 20260922120000_ai_model_providers` → 已成功应用 |
| 建表 | `SHOW TABLES LIKE "saaimodel%"` | `saaimodelprovider`、`saaimodelsettings` 存在；`saaimodelprovider` 行数 = 0（符合预期：尚未导入） |
| 服务状态 | `supervisorctl status clklog_analytics_server` | RUNNING（重启后新 pid） |
| 启动日志 | Nest 启动日志 | `Nest application successfully started`；无模型供应商加载告警 |
| 新接口挂载 | 未登录 `GET /sa/api/admin/ai/model-providers` | 401（路由已注册、鉴权生效） |
| 前端资源 | `curl` 线上 `/sa/index.html` 与 `ai-Cko8Uwv1.js` | 200；该 chunk 含新增面板文案「供应商清单仍由配置文件提供」 |
| 登录页 | `curl` 线上 `/sa/login` | 200 |

**未做**：`install-harness-runtime.sh` 未执行——本次未改 `apps/analytics-harness-host/` 与
`apps/analytics-harness-broker/` 源码，容器运行时无需重装（符合发版规则）。

## 4. 上线后待办（人工）

### 4.1 平台配置（用户手动，2026-09-22 起）

**v1.1 起没有「从配置文件导入」了**：供应商只在网页维护，初始为空，也没有环境变量来源。

当前平台上的两行供应商（Tencent TokenHub、DeepSeek Official）是 v1.0 时导入的，按用户要求保留；
它们的密钥都是「未配置」——AI 助手在有密钥之前不可用。用户已确认「现在没人用 AI 分析，不可用就不可用」，
按下面步骤补：

1. 超管登录 → 设置 → **AI Workspace 管理** → 第 4 个 Tab **模型供应商**（现在表格里是上面那两行）。
2. 逐行「编辑」→ 填「密钥」→ 保存。密钥原值可从历史提交取：
   `git show 54fc421:apps/analytics-server/config_server.yaml`
   （`providers.tencent.api_key` 与 `providers.deepseek_official.api_key`）。
3. 需要新增供应商就点「新增供应商」；模型可按需勾「支持图片输入」。
4. 每行点「测试连接」；成功会显示耗时，失败会显示厂商原始错误。
5. 「立即应用并重建 (N)」用于让运行中的会话立刻换配置（会中断这些会话，对话内容不丢）。

### 4.2 未完成的验证项

| 项 | 说明 |
|---|---|
| 浏览器多语言实测 | 需要超管登录，本次未做。建议在 4.1 的页面上顺带切换一次语言，确认 Tab 与表单文案随语言变化、无中文残留 |
| 真实模型对话回归 | 需 4.1 配好密钥后进行；网关审计行 `harness_model_call` 会记录 provider / model / 状态 / 耗时（无 prompt 与密钥） |
| 密钥轮换 + Git 历史重写 | `OPEN.md` §1.1 / §1.8；本次只清空了 HEAD，历史里仍有明文 |
| MP-01 跨模块 import | `CODE_HANDOVER.md`；`model-provider` 直接 import 告警域 `channel-crypto`，待抽窄包 |

---

## 5. v1.1 修订（2026-09-22，同日）

用户决策：删掉环境变量那一套、删掉配置文件的供应商来源（设计上供应商初始为空，超管自己添加、
自己填密钥），并新增「模型是否支持图片输入」。

| 项 | 结果 |
|---|---|
| 环境变量密钥机制 | ✅ 全删：`api_key_env` 列（迁移 `20260922180000_drop_provider_api_key_env`）、`harnessEnvKey()`、`providerApiKeyEnv()`、页面字段、`.env.example` 与 README 里的 `DEEPSEEK_API_KEY` / `AI_HARNESS_*` 说明 |
| 配置文件的供应商来源 | ✅ 全删：`deepseek_harness.providers` 与 `defaults.{provider,model,reasoning_effort}` 从 schema 与两份 YAML 移除；配置文件里再写 `providers` 会被当作未知字段拒绝（有回归用例） |
| 初始为空 | ✅ 库为空即「未配置」：页面显示空状态与「新增供应商」；用户开助手得到 503「尚未配置模型供应商」，不启动没有模型的会话（`issueHostTicket` 与 `prepare()` 各一道守卫） |
| 保留既有数据 | ✅ 平台已导入的两行供应商未删除、未改动 |
| 图片输入能力 | ✅ 每个模型一个开关（`supports_image`），落库后进入会话生成器的模型画像 `input: ['text','image']`（未勾选为 `['text']`），对应 DSH `llm-pi-ai` 的 `PiAiModelProfile.input`。表格里图片模型带相机图标与提示 |
| 表格列宽 | ✅ 修掉 v1.0 的「接口地址」被压成一个字（列宽全部显式给定、`scroll.x` = 各列之和） |
| 删默认供应商 | ✅ 改为拒绝并说明原因（v1.0 的改动曾让它静默把默认值挪到别的供应商，等于悄悄换掉所有人的默认模型） |
| 服务器主密钥 | ✅ 修掉 ini 里 `ALERT_CONFIG_KEY=\"…\"` 的转义引号问题（进程此前只拿到 1 个字符，页面一直报未注入）。修后进程拿到 44 字符有效密钥，**既有邮件密码密文仍能解密**，备份 `*.ini.keyquote-bak` |

门禁：后端 117 套件 / 867 用例通过；`arch_ratchet` 通过；`i18n_check` 通过（13 语言 × 3724 键）；
`i18n_scan --check` 通过（1389 → 1387，只减不增）；两端构建通过；新增/更新前端 5 用例通过。

### 5.1 v1.1 生产部署证据（版本 17529）

| 检查 | 结果 |
|---|---|
| 迁移 | `Applying migration 20260922180000_drop_provider_api_key_env` → 已成功应用（共 45 个迁移） |
| 列已删除 | `information_schema` 中 `saaimodelprovider.api_key_env` 计数 = 0 |
| 既有数据保留 | 两行供应商原样保留：`deepseek_official`（DeepSeek Official / openai-completions / api.deepseek.com / 2 模型）、`tencent`（Tencent TokenHub / tokenhub.tencentmaas.com/plan/v3 / 2 模型），均为「无密钥」待填；`saaimodelsettings` 仍是 `tencent / deepseek/deepseek-v4-flash / high` |
| 服务 | `clklog_analytics_server` RUNNING（重启后新 pid）；启动日志除本次探测产生的 404/401 外无异常 |
| 已删接口 | `POST /sa/api/admin/ai/model-providers/import` → **404**；`GET /sa/api/admin/ai/model-providers` → 401（路由保留、鉴权生效） |
| 前端 | 当前入口 `index-CNSRuqte.js` 引用新语言包 `ai-BiEJHGDX.js`（含「还没有模型供应商」「支持图片输入」，不含「从配置文件导入」）；上一版 chunk 已成孤儿（仅被旧入口引用，不会被加载） |

---

## 6. v1.2 修订（2026-09-22）：可用模型才出现在助手里

用户反馈：「没有配置秘钥和没有测试成功的模型，不应该在 harness 里可被选择」。实测截图里助手的模型选择器
把两个供应商的 4 个模型全列了出来——`DeepSeek Official` 连密钥都没配、`Tencent TokenHub` 也没测过。

| 项 | 结果 |
|---|---|
| 可用定义 | ✅ `可用模型 = 有可用密钥 且 已通过连接测试`；逐模型记录在 `verified_json` |
| 只下发可用模型 | ✅ 会话生成器只写可用模型；供应商一个可用模型都没有时整条路由不下发（DSH 侧连组名都不出现）；网关 allowlist 同源 |
| 测试改为批量 | ✅ 不带 `model` 时逐个测试全部模型，返回 `{results}` 并逐个落库 + 审计；界面汇总「n/m 可用」并列出失败项原文 |
| 防死循环 | ✅ 探测改从库行读取（未验证的供应商在有效快照里是被过滤掉的，否则「要先测通才能测」） |
| 配置改写即失效 | ✅ 地址/协议/密钥/模型清单任一变化 → `verified_json` 清空，必须重测 |
| 默认模型 | ✅ 只能选可用模型（400 `defaultUnavailable`）；存量默认不可用时自动退到第一个可用模型 |
| 会话守卫 | ✅ 由「有供应商」收紧为「有可用模型」，文案改为「尚未有可用模型：请配置密钥并点测试连接」 |

门禁：后端 117 套件 / 876 用例、前端 6 用例、`arch_ratchet`、`i18n_check`（3731 键）、
`i18n_scan`（1387）、两端构建全部通过。

### 6.1 生产部署证据（版本 17535）

| 检查 | 结果 |
|---|---|
| 迁移 | `Applying migration 20260922190000_provider_verified_models` → 已应用 |
| 新列 | 两行供应商均 `verified_json = []`、`last_test_at = NULL`（尚未测试，符合预期） |
| 数据保留 | `deepseek_official`（无密钥）与 `tencent`（有密文）两行、各 2 个模型未动 |
| 服务 | `clklog_analytics_server` RUNNING；日志除重启时一个在途会话的 runtime 回收与本次探测的 401 外无异常 |
| 接口 | `GET …/model-providers` 与 `POST …/:providerId/test` 均 401（路由在、鉴权生效） |

### 6.2 行为变化（需要知道）

升级后**没有任何模型通过测试**，所以：助手的模型列表是空的，用户点开助手会看到「尚未有可用模型」。
这是本次要的效果（宁可说清楚也不给不可用的选项）。恢复使用只需两步：

1. 编辑供应商 → 填密钥 → 保存（保存会清空验证状态，属正常）；
2. 点行内「测试连接」→ 通过的模型立刻出现在助手的模型列表里；失败的模型不出现在列表里，界面会给出厂商原始错误。
