# 架构设计：AI 模型供应商网页设置（model-providers）

- `phase: clklog-ai-model-providers-v1`
- 帽子：架构
- 配套 PRD：`docs/product/prd-clklog-ai-model-providers-v1.md`
- 上游：`docs/architecture/clklog-ai-analytics-design.md`（§5 密钥边界、§6 供应商 schema）
- 关联：`docs/architecture/clklog-analytics-design-alert-channels-v1.md`（凭证加密先例）、`docs/architecture/clklog-analytics-design-account-lifecycle-v2.md`（库优先先例）
- 修订：**v1.2（2026-09-22，同日）**——只有「有密钥 + 测试通过」的模型才进入有效配置（见 §14）
- 修订：**v1.1（2026-09-22，同日）**——删除环境变量密钥机制与配置文件的供应商来源，供应商完全由网页维护且初始为空；模型新增「支持图片输入」能力。**§2、§3、§4、§6、§8、§9、§12 以 v1.1 修订后的内容为准**（下文中标注「v1.1 删除」的段落是历史决策记录）

---

## 1. 现状与问题

| 事项 | 现状 | 问题 |
|---|---|---|
| 供应商定义（`display_name`/`base_url`/`protocol`/`models`） | `apps/analytics-server/config_server.yaml` 的 `deepseek_harness.providers.*`，由 `scripts/build.sh` 原样打进发布产物 | 改一个模型名要改配置、提交、发版、重启 |
| 供应商密钥 | 同上（`providers.*.api_key`，明文入库）或进程环境变量 `api_key_env` | 明文密钥进 Git（`OPEN.md` 记录的开源阻断项，红线 3 的临时覆盖） |
| 默认模型 | `deepseek_harness.defaults.{provider,model,reasoning_effort}` | 同上 |
| 读取方 | `WorkspacePathsService.harnessConfig()`（启动时解析一次的静态快照） | 无法热更新；`resolved_api_key` 是启动期快照 |

本期把**供应商清单 + 默认模型**改为「库优先」，密钥以 AES-256-GCM 密文落库，仍在 YAML 的只剩部署容量与安全预设。

## 2. 归属边界（写死，防止范围蔓延）

| 配置 | 归属 | 理由 |
|---|---|---|
| `providers.*`（含密钥） | **DB（唯一来源，v1.1）** | 业务配置，改一次不该发版；**配置文件与环境变量都不再提供供应商** |
| `defaults.{provider,model,reasoning_effort}` | **DB（唯一来源，v1.1）** | 与供应商清单强耦合，必须同组校验 |
| `enabled` | YAML | 决定是否安装/启动整套运行时，属部署决策 |
| `runtime.*` | YAML | `linux_user`/`home_subdir`/`container_image` 被 Puppet 与 `install-harness-runtime.sh` 共用；`max_runtimes`/`max_tokens` 是容量与成本护栏 |
| `workspace.*` | YAML | 磁盘配额与保留期，属容量决策 |
| `defaults.permission_preset` | YAML | 安全预设（`danger_full_access` 是容器内最高权限档），不接受网页随手改 |

## 3. 数据模型

迁移：`apps/analytics-server/prisma/migrations/<YYYYMMDDHHMMSS>_ai_model_providers/migration.sql`（MySQL，`utf8mb4_unicode_ci`，与 `20260916140000_alert_channels` 同风格）。

```prisma
/// AI 模型供应商（phase: clklog-ai-model-providers-v1）
model SaAiModelProvider {
  id             String   @id @default(uuid())
  provider_id    String   @unique          // ^[a-z0-9_-]+$
  display_name   String
  adapter        String                    // openai_compatible | deepseek
  protocol       String                    // openai-completions | openai-responses | anthropic-messages
  base_url       String
  api_key_cipher String?  @db.Text         // keyId:iv:tag:ciphertext（AES-256-GCM）
  models_json    String   @db.Text         // DeepseekHarnessModelConfig[]（含 supports_image）
  verified_json  String   @db.Text         // 连接测试通过的模型 ID（v1.2；配置改写即清空）
  last_test_at   DateTime?
  last_test_by   String?
  updated_by     String
  updated_at     DateTime @updatedAt
  @@map("saaimodelprovider")
}

/// AI 模型默认选择（单行 id='singleton'）
model SaAiModelSettings {
  id                       String   @id @default("singleton")
  default_provider         String
  default_model            String
  default_reasoning_effort String
  /// 每次保存 +1；运行时按它判断"手里这个 Runtime 是否还是当前配置"
  revision                 Int      @default(1)
  updated_by               String
  updated_at               DateTime @updatedAt
  @@map("saaimodelsettings")
}
```

设计取舍：

- **不存密钥 hint 列**。列表视图每次解密后 `maskSecret()`（`••••末4位`）。存 hint 会在主密钥轮换后给出「看起来正常、其实解不开」的假象。
- **模型清单用 JSON 列**而不是子表。模型总是随供应商整体编辑、整体校验，不单独引用；与 `AlertChannelConfig.config_json` 同思路，省一次 join 与一套联动 CRUD。
- **不落 `enabled=false` 的语义分歧**：`enabled` 仅表示「这一行参与配置」（导入后想临时下线某供应商时用），网关对无密钥的供应商本来就返回 503。
- `adapter` 目前**只参与校验、无行为分支**（全仓仅 `deepseek-harness-config.ts` 引用），字段保留为契约占位，表单用下拉但文档标注现状。

## 4. 配置合成契约（生效顺序）

新增 `ModelProviderRegistryService`，把「YAML 基线 ⊕ DB 覆盖 ⊕ env」合成为**一份有效配置快照**。

### 4.1 供应商清单（v1.1：只有库）

供应商**只来自数据库**：`saaimodelprovider` 有几行就是几个供应商，没有任何配置文件或环境变量来源。
库里一行都没有时，清单为空——页面显示空状态，用户开助手会被明确拒绝（见 §8），不会启动一个没有模型的会话。

（历史决策记录：v1.0 曾设计「库有行则以库为准、否则取配置文件」，并用「从配置文件导入」做一次性接管；
v1.1 按用户决策连同 `api_key_env` 一起删除，避免两套来源并存。）

### 4.2 密钥来源（v1.1：只有密文）

```
DB api_key_cipher 解密值   →   没有就是「未配置」
```

没有环境变量覆盖，也没有 YAML 兜底。密文解不开（主密钥被换）时按「未配置」处理并显式标红，
**不静默降级**。

### 4.3 供应商密钥状态

对外只给两个布尔量：`key.configured`（是否已配置）与 `key.unreadable`（密文是否不可解密）。
v1.0 的 `configured_by: environment | database | config` 三值枚举随环境变量机制一并删除。

### 4.4 整组校验（写库前，失败即 400 且不落库）

复用 `deepseek-harness-config.ts` 现有规则，抽成可复用纯函数，对**候选整组配置**（把本次改动应用到当前全量后）校验：

| 规则 | 来源 |
|---|---|
| provider ID 匹配 `^[a-z0-9_-]+$` | 原 `parseProvider` |
| ≥1 个供应商 | 原 `:275-277` |
| 模型 ID 非空、组内不重复 | 原 `:214-222` |
| `reasoning_efforts` 非空、不重复 | 原 `parseModel` |
| `default_reasoning_effort` ∈ 该模型 `reasoning_efforts` | 原 `:192-194` |
| `supports_image` 必须是布尔值（缺失按 `false` 兼容既有行） | v1.1 新增 |
| `base_url` 必须 https（`127.0.0.1`/`localhost`/`::1` 例外），禁止带认证信息 | 原 `providerUrlAt` |
| 默认供应商存在、默认模型存在于该供应商、默认思考强度受该模型支持 | 原 `:302-310` |

校验在**事务内**、写入前执行；`revision` 在同一事务里 `+1`。**不做**「先写再自愈」——半截配置会让网关拿到不一致的 allowlist。

## 5. 缓存、失效与多进程

| 机制 | 说明 |
|---|---|
| 内存快照 | registry 持有 `{ effective, revision, loadedAt }`；`snapshot()` 同步读（网关热路径每请求一次，不能 async） |
| 预热 | `OnModuleInit` 加载一次；失败不阻塞启动（记 error，首次 `snapshot()` 时重试） |
| 主动失效 | 保存/删除/导入/改默认模型后 `invalidate()` → 下次 `snapshot()` 重新加载 |
| TTL 兜底 | 30 秒（与 `AlertChannelConfig` 一致），覆盖「有人直接改库」与多进程 |
| ingestor 进程 | `configuration.ts:186-188` 对 ingestor 角色强制 `enabled=false`，网关不启动，registry 不参与；无需跨进程通知 |

运行时**不缓存**的是 `runtime.max_tokens` 这类 YAML 值（仍走 `paths.harnessConfig()`），保持不变。

## 6. API 契约

控制器 `ModelProviderAdminController`，类级 `@Controller('sa/api/admin/ai')` + `@RequirePermission('ops.ai_workspace.manage')`（与 `workspace-admin.controller.ts:23-25` 完全同款式——该权限已覆盖「AI Workspace 管理」页面，本期**不新增权限码**）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `model-providers` | 视图：`{ revision, defaults, providers[], readonly{}, applyable_runtimes, key_master_missing }`（v1.1 去掉 `source` 与 `config_file`） |
| POST | `model-providers` | 新增供应商（`provider_id` 已存在则 409） |
| PUT | `model-providers/:providerId` | 编辑；`api_key` 缺省或空串 = 不修改 |
| DELETE | `model-providers/:providerId` | 删除；整组校验不通过（如默认供应商）则 400 |
| PUT | `model-defaults` | 默认供应商/模型/思考强度 |
| POST | `model-providers/:providerId/test` | 测试连接 |
| POST | `model-providers/apply` | 立即应用：回收运行中的 Runtime，返回 `{ recycled }` |

视图字段说明：

- `providers[].key`：`{ configured, hint, unreadable }`。**永不含明文密钥**。
- `applyable_runtimes`：当前运行中的 Runtime 数（`HarnessRuntimeManagerService.countRuntimes()`），供前端决定「立即应用」按钮的可用性与文案。
- `key_master_missing`：`appConfig.alerting.configKey` 为空时为 `true`，前端提前提示「保存密钥会失败」，避免用户填完才报错。

### 6.1 测试连接

镜像 `harness-gateway.service.ts:411-431` 的请求构造（同一份 `base_url.pathname + path + search` 拼接与认证头），路径取自网关的 `MODEL_PATHS = ['/chat/completions','/responses','/messages']`：

| 协议 | 路径 | 请求体 | 认证头 |
|---|---|---|---|
| `openai-completions` | `/chat/completions` | `{ model, messages:[{role:'user',content:'ping'}], max_tokens:16, stream:false }` | `Authorization: Bearer <key>` |
| `openai-responses` | `/responses` | `{ model, input:'ping', max_output_tokens:16 }` | `Authorization: Bearer <key>` |
| `anthropic-messages` | `/messages` | `{ model, max_tokens:16, messages:[{role:'user',content:'ping'}] }` | `x-api-key` + `anthropic-version: 2023-06-01` |

- 复用 `alerting/channels/http.ts` 的 `postJson` / `describeError`，超时 10 秒。
- 返回 `{ ok, status, elapsed_ms, error_code, error_key, error_params, detail }`，**上游失败不抛异常**（沿用 `AlertChannelConfigService.test()` 先例，让页面能看到厂商原始错误）；`detail` 截断到 500 字符。
- 探测用模型：请求体可带 `model`，缺省取该供应商的第一个模型。
- **脱敏**：`detail` 里若回显请求头需剔除 `authorization` / `x-api-key`；实现上只回显响应体，不回显请求体/请求头。

## 7. 密钥加密、轮换与故障语义

- 算法与格式复用 `alerting/channels/channel-crypto.ts`（`<keyId>:<iv>:<tag>:<ciphertext>`，AES-256-GCM），主密钥 `appConfig.alerting.configKey`（env `ALERT_CONFIG_KEY`，由 `src/config` 读取，满足「非配置目录不得读 env」门禁）。
- 缺失主密钥时保存**拒绝**（400 `ai.error.provider.masterKeyMissing`），明文不落库。
- **解密失败不回退 YAML**：该供应商标记 `key.unreadable=true` + `available=false`，网关返回 503。理由：静默回退会让「主密钥被换」这种需要立刻处置的故障隐身。
- 轮换策略本期不做自动化，仍与告警/邮件通道一致：换主密钥 → 页面会红字提示 → 重新填写各供应商密钥。

## 8. 生效与回收语义

### 8.1 模型能力 → DSH 模型画像

DSH 的 `llm-pi-ai` 适配器支持按模型声明**请求模态**（`PiAiModelProfile.input`，取值 `text` / `image`，
见 `node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/types/catalog.d.ts`），这正是「模型是否支持图片输入」的落点：

| 设置页 | 生成的模型画像 |
|---|---|
| 勾选「支持图片输入」 | `input: ['text', 'image']` |
| 未勾选 | `input: ['text']` |

DSH 文档明确：手写声明的视觉模型必须显式写 `image` 才可用，而只声明 `text` 也能纠正「网关其实不服务图片」的
目录模型。这是一个**声明**而非探测：声明了但网关不支持时，由供应商在回合中途拒绝。

### 8.2 未配置供应商时的守卫

供应商清单为空时：

- `issueHostTicket` 直接返回 503（`ai:error.provider.noneConfigured`，文案指向「AI Workspace 管理 → 模型供应商」），
  用户看到明确原因，而不是打开一个没有模型的会话；
- `HarnessSettingsService.prepare()` 同样拒绝（最后一道防线，防止写出没有任何 provider 的 `cordis.patch.yml`）。

### 8.3 其他

`cordis.patch.yml` 本来在每次 `prepare()`（每次创建 Runtime）重写，所以**新建会话天然拿到最新配置**，无需额外机制。需要处理的是两处：

1. **运行中的 Runtime**：`HarnessRuntimeContext` 增加 `configRevision`（创建时的 snapshot revision）。`ensureTicketRuntime` 复用前比较当前 revision，不一致则先 `closeRuntime` 再 `createRuntime` → 用户「下次打开助手」自动切换到新配置，**不打断正在进行的对话**。
2. **`settings.yaml` 的默认模型**：原实现用 `flag:'wx'` 只写一次，导致默认模型改动对老用户永远不生效。改为**读-合并-原子写**：
   - 读现有 YAML（不存在则空对象；解析失败**不覆盖**，记 error 返回，避免把用户数据写坏）；
   - 仅当 `agent-default-model` 与期望值不同才写；**保留文件内其他键**（DSH 可能写入别的偏好）；
   - 临时文件 + `rename` 原子替换，保持 `0600` 与 harness 属主。

「立即应用」按钮 → `POST model-providers/apply` → `HarnessRuntimeManagerService.recycleAll()`（遍历 `runtimes` 逐个 `closeRuntime`，逐个容错），返回回收数量；同时刷新 registry 快照。

## 9. 前端设计

- **入口**：`apps/analytics-web/src/pages/Admin/AiWorkspacePage.tsx` 的 `Tabs` 增加第 4 项 `{ key: 'providers', label: t('ai:provider.tabLabel'), children: <ModelProviderPanel /> }`。**不动路由、菜单、权限**。
- **新包** `apps/analytics-web/src/features/ai-model-providers/`：
  - `ModelProviderPanel.tsx`：横幅（来源 / 密文不可解密 / env 覆盖 / 主密钥缺失 / AI 未启用）、供应商表格、默认模型卡片、只读边界说明。
  - `ProviderFormModal.tsx`：新增/编辑表单（antd `Form`，模型清单用 `Form.List`）。
  - `useModelProviders.ts`：加载/保存/删除/测试/导入/应用 的调用与本地状态。
- 请求走 `services/api.ts` 的 `get/post/put/del`（自动带 `x-project-name`/`x-locale`/`Bearer`，错误由拦截器按 `messageKey` 提示），函数集中在 `services/ai.service.ts`，类型集中在 `types/ai.types.ts`。
- 交互要点：
  - `api_key` 输入框 `placeholder` 明确「留空表示不修改已保存的密钥」，编辑时**不回填**。
  - 模型清单行内联校验：思考强度非空、默认思考强度 ∈ 支持集合。
  - 保存成功后按 `applyable_runtimes` 决定提示文案：>0 时提示「N 个运行中的会话仍用旧配置」并给出「立即应用并重建 (N)」（`Modal.confirm`，文案说明会中断会话、对话内容不丢）。
  - 供应商为空时表格区显示空状态与「新增供应商」主按钮（v1.1）。
  - 列宽全部显式给定、`scroll.x` 等于各列之和：v1.0 把 `base_url` 留成弹性列，实际渲染被压到只剩一个字（表头显示为「接」），v1.1 修掉。

### 9.1 i18n 键表（`ai` 命名空间，全部 13 种语言必须齐全）

键路径均 ≤4 段、每段 lowerCamelCase；**不新增命名空间**（`ai` 已注册）。

| 分组 | 键 |
|---|---|
| 入口 | `provider.tabLabel`、`provider.intro` |
| 空状态 | `provider.empty.title`、`provider.empty.body` |
| 列 | `provider.column.provider`、`provider.column.protocol`、`provider.column.baseUrl`、`provider.column.key`、`provider.column.models` |
| 密钥态 | `provider.key.configured`、`provider.key.missing`、`provider.key.unreadable`、`provider.key.keepHint`、`provider.key.alertTitle`、`provider.key.alertBody` |
| 动作 | `provider.action.add`、`provider.action.apply` |
| 应用 | `provider.apply.title`、`provider.apply.confirm`、`provider.apply.done` |
| 保存 | `provider.saved.pending`、`provider.saved.done` |
| 默认模型 | `provider.defaults.title`、`provider.defaults.provider`、`provider.defaults.model`、`provider.defaults.reasoningEffort` |
| 表单 | `provider.form.providerId`、`provider.form.providerIdLocked`、`provider.form.providerIdRule`、`provider.form.baseUrlHttps`、`provider.form.displayName`、`provider.form.adapter`、`provider.form.protocol`、`provider.form.baseUrl`、`provider.form.apiKey`、`provider.form.models`、`provider.form.addModel`、`provider.form.modelId`、`provider.form.modelName`、`provider.form.reasoningEfforts`、`provider.form.defaultEffort`、`provider.form.required` |
| 测试 | `provider.test.ok`、`provider.test.failed` |
| 模型能力 | `provider.form.supportsImage`（表单开关 + 表格标签共用） |
| 边界提示 | `provider.readonly.title`、`provider.readonly.body`、`provider.disabled.title`、`provider.disabled.body` |
| 删除 | `provider.delete.confirm` |
| 错误码（`messageKey`） | `error.provider.invalid`、`error.provider.empty`、`error.provider.notFound`、`error.provider.idInvalid`、`error.provider.noneConfigured`、`error.provider.modelDuplicate`、`error.provider.effortRequired`、`error.provider.defaultEffortInvalid`、`error.provider.baseUrlInvalid`、`error.provider.defaultProviderMissing`、`error.provider.defaultModelMissing`、`error.provider.masterKeyMissing`、`error.provider.keyUnreadable`、`error.provider.testModelMissing` |

复用既有键以减少新增：`common:label.actions`、`common:action.edit/delete/save/cancel/apply/testConnection`、`common:state.enabled/disabled`、`common:unit.ms`（测试耗时用 `provider.test.ok` 自带 `{{ms}}`，不再叠加）。

新增错误**只给 `code` + `messageKey` + `params`，不写中文兜底**：`domain-error.ts` 的契约里 `message` 是可选的，
而中文兜底会推高 `scripts/i18n_scan.py` 的目录硬编码计数（新目录从 0 起算，只减不增）。前端按
`messageKey` + `params` 用查看者语言渲染，老客户端与 API Key 调用方走 `errors` 命名空间的通用文案。

## 10. 与既有设计的差异声明

- `clklog-ai-analytics-design.md:214-216` 写「UI 模型目录、`/model` 命令和 Runtime Provider Settings 均由同一个已验证目录生成；provider/model 配置为**运维只读**，不开放普通用户修改接口」。本期把「运维只读」**放开为超管可写**：普通用户仍只读且看不到该页面，改动仅限持有 `ops.ai_workspace.manage` 的超管，且每次都留审计。`:461`「普通用户的 provider settings 页面只读或隐藏新增/删除操作」**继续成立**。
- `clklog-ai-analytics-design.md:685` 要求「真实模型验收后应轮换密钥，并使用已实现的 `<PROVIDER>_API_KEY` 覆盖路径」。本期完成「密钥出配置文件入密文库」，**密钥轮换仍需另行安排**（Git 历史里的旧值不会因此消失）。
- 红线 3（密钥不写入仓库）通过清空 `config_server.yaml` 的 `api_key` 回归；本期新增的「密钥入加密库」与告警通道、账号邮件通道同策略，属已批准先例的延续。

## 11. 风险与门禁例外

| # | 风险 | 处理 |
|---|---|---|
| R1 | **跨模块直接 import**：`channel-crypto.ts` 未通过 `AlertingModule` 导出，`auth-mail.service.ts:8` 已有先例 | 沿用先例并在 PR 声明「门禁未自动检：跨模块直接 import」；在 `CODE_HANDOVER.md` 登记「待提取 credential-crypto 窄包」的整改建议，本期不重构（避免一次改两个风险轴） |
| R2 | 主密钥丢失/轮换后密文不可解密 | 显式红字 + `available=false`，不静默回退；保存时若主密钥缺失直接拒绝 |
| R3 | 同 `dsh-home` 可能有另一个 Tab 的存活容器在写 `settings.yaml` | 仅在期望值不同时合并写 + 原子 rename；解析失败则不写 |
| R4 | 模型清单由超管随手改会直接改变网关 allowlist | 整组校验 + 每次写入审计 + 测试连接；网关侧 `validateModelRequest` 不变 |
| R5 | `ALERT_CONFIG_KEY` 目前只在服务器 supervisord ini（仓库模板 `scripts/supervisord-clklog-manager.conf` 缺该变量） | 本期补进仓库模板，消除配置漂移（红线 7） |
| R6 | 「立即应用」会中断用户会话 | 二次确认弹窗明示；默认仍是惰性生效，不点就不打断 |

## 12. 测试与验收

单测（`apps/analytics-server/src/modules/ai-assistant/model-provider/*.spec.ts`）：

| 用例 | 断言 |
|---|---|
| store：非法 provider ID | 抛 400、库内无变化、无审计写入 |
| store：`api_key_env` 冲突 / 默认供应商不存在 / 默认模型不在清单 | 同上 |
| store：`api_key` 留空 | 保留原密文；`key_updated=false` 入审计 |
| store：保存成功 | 事务提交、`revision` 递增、审计 `detail` 不含密钥明文 |
| store：主密钥缺失 | 拒绝保存并给出 `masterKeyMissing` |
| registry：空库 | 供应商清单为空、不放行会话（v1.1） |
| registry：密钥 | 只有库密文一个来源；密文不可解密 → `unreadable` 且 `configured=false` |
| settings：图片能力 | `supports_image=true` → `input: ['text','image']`；否则 `['text']` |
| probe：三种协议 | 请求 URL/体/头与网关一致（含 `base_url` 带 path 与前缀 query 的情况） |
| probe：上游 4xx | 返回 `ok=false` + 状态码与响应片段，不抛异常，且不含密钥 |
| settings：`settings.yaml` | 值相同不写；值不同合并写且保留其他键；解析失败不覆盖 |
| runtime-manager：revision | revision 变化时复用路径触发重建；`recycleAll` 返回回收数 |

前端：`ModelProviderPanel` 交互 spec（来源横幅分支、密钥留空提交体不含 `api_key`、保存后按 `applyable_runtimes` 显示提示）。

验收标准以 PRD §3 的 `MP-1` ~ `MP-9` 为准；上线顺序（先导入、后清 YAML 明文）见 PRD §1 与本文 §10。

---

## 13. v1.1 修订清单（2026-09-22）

| 层 | 变更 |
|---|---|
| 配置 schema | `deepseek_harness` 只剩 `enabled` / `runtime` / `workspace` / `defaults.permission_preset`；删除 `providers` 与 `defaults.{provider,model,reasoning_effort}`；删除 `providerApiKeyEnv()` 与 `harnessEnvKey()` |
| 数据模型 | `saaimodelprovider` 删列 `api_key_env`（迁移 `20260922180000_drop_provider_api_key_env`）；`models_json` 每项新增 `supports_image` |
| 供应商形状 | `HarnessProviderShape` 去掉 `api_key_env`；`DeepseekHarnessProviderConfig` 的 `configured_by` 枚举换成 `configured: boolean` |
| 写入口 | 删除 `importFromConfig()`、`assertEditable()`、`yamlProviders()` 与 `error.provider.notImported` |
| 会话生成器 | 模型画像新增 `input` 模态；供应商为空时拒绝 |
| 控制器 | 删除 `POST model-providers/import`；视图去掉 `source`、`config_file` |
| 页面 | 删除导入横幅/来源列/环境变量字段；新增空状态与「支持图片输入」开关；修复表格列宽 |
| i18n | 删除 `provider.source.*`、`provider.locked.*`、`provider.import*`、`provider.column.origin`、`provider.key.fromEnv`、`provider.key.envHint`、`provider.form.apiKeyEnv`、`provider.form.apiKeyEnvRule`、`error.provider.notImported`；新增 `provider.empty.*`、`provider.form.supportsImage`、`error.provider.noneConfigured` |

---

## 14. v1.2 修订：可用模型才有资格被选择（2026-09-22）

**问题**：v1.1 的有效配置里，一个供应商的全部模型都会进 `cordis.patch.yml`，助手的模型选择器就把
「没配密钥」和「没测过」的模型一并列出来了。用户选了必然失败——不该把不可用的选项给用户。

### 14.1 可用性判定（唯一口径）

```
模型可用 = 供应商密钥可用（密文解得出） AND 该模型在 verified_json 里
供应商进有效配置 = 它至少有一个可用模型（空 models 的路由 DSH 会拒绝解析）
```

- `verified_json` 由「测试连接」写入：测试通过 → 加入；失败 → 移除；供应商任一字段（地址/协议/密钥/模型清单）
  被编辑 → 整列清空（避免「改了地址但验证还是旧的」）。
- 快照（§4）里的 `providers[*].models` 只含可用模型；`configured` 的含义随之收紧为「至少一个可用模型」。

### 14.2 测试改为逐模型批量

`POST model-providers/:providerId/test`（body 可选 `model`）：

- 带 `model` → 只测该模型；不带 → 测该供应商下**全部**模型；
- 统一返回 `{ results: ModelProviderProbeResult[] }`，每个元素含 `model` / `ok` / `status` / `elapsed_ms` / `detail`；
- 结果逐个落 `verified_json` 并各自写审计（`ai_model_provider_test`），随后刷新注册表，使模型列表立即变化。

**鸡生蛋问题**：探测不能再从快照取供应商（未验证的供应商已被快照过滤掉，会 404）。探测改从
`store.loadDatabase()` 读**全量**库行与解密后的密钥，快照则只服务「下发给 DSH 的有效配置」。

### 14.3 默认模型

`saveDefaults` 只接受可用模型（否则 400 `ai:error.provider.defaultUnavailable`）；
`pickDefaults` 只在可用模型里挑，存量默认失效时自动退到第一个可用模型，绝不写出指向不可用模型的会话配置。

### 14.4 未配置/不可用时的用户可见行为

`issueHostTicket` 与 `prepare()` 的守卫条件由「有供应商」改为「有可用模型」，文案更新为
「尚未有可用模型：请在 AI Workspace 管理 → 模型供应商 配置密钥并点测试连接」。

### 14.5 前端

- 模型列每个模型一枚状态标签：通过（绿）/ 未验证（灰）/ 无密钥（红）；
- 行内「测试连接」改为批量测试并弹出逐模型结果（成功数 + 失败项原文）；
- 「默认模型」两个下拉只列可用模型与含可用模型的供应商。

### 14.6 测试表补充

| 用例 | 断言 |
|---|---|
| 有密钥但未验证 | 该模型不进快照（`providers[p].models` 不含它）；供应商若无其他可用模型则整条路由消失 |
| 验证后 | 测试通过 → 进入快照；失败 → 不在快照且从 `verified_json` 移除 |
| 改写供应商 | 地址/密钥/模型清单任一变化 → `verified_json` 清空 |
| 默认模型 | 指向未验证模型被 400 拒绝；存量默认不可用时 `defaults` 退到第一个可用模型 |
| 探测 | 未验证供应商仍可被测试（从库行读取，不依赖快照） |
