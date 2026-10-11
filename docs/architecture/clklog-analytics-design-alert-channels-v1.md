# 架构设计：告警通知通道扩展

- `phase: clklog-analytics-alert-channels-v1`
- 帽子：架构
- 配套 PRD：`docs/product/prd-clklog-analytics-alert-channels-v1.md`
- 调研依据：`docs/product/research-clklog-analytics-alert-channels-v1.md`

---

## 1. 现状与改动面

| 现状 | 改动 |
|---|---|
| `alert-notify.service.ts#deliver` 里 `if kind === 'email' / 'sms' / else feishu` 硬编码三分支 | 改为**通道注册表**驱动：`CHANNELS[key].send(ctx)` |
| `alert-channel-email.ts` 手写 SMTP（130 行） | 换 `nodemailer`（`verify()` + `sendMail`） |
| `alert-channel-sms.ts` 手写腾讯云 TC3 签名（100 行） | 换官方 SDK：阿里云 / 腾讯云 / AWS SNS / Twilio |
| `alertcontact`: `kind` ∈ {feishu_webhook, email, sms}，字段 `webhook_url` / `address` | `kind` 扩展；新增 `options_json`（钉钉 secret、通用 webhook 的 headers/body 模板等） |
| `alerttemplate`: 「事件类型 × 通道」3 个通道 | 改「事件类型 × **通道组**」：`chat` / `email` / `sms`（飞书 webhook 迁移到 chat） |
| 凭证只在服务端 env（`ALERT_SMTP_*`、`ALERT_SMS_*`） | 新增 `alertchannelconfig` 表 + 加密存储；env 作为**回退**保留 |
| 无任何限流 | 新增通道层令牌桶 + 发送间隔 + 一轮积压合并 |
| `channels()` 返回 `{email, sms}` | 返回 `Record<channelKey, {available, reason}>` |

## 2. 数据模型

```prisma
/// 通道平台级配置（凭证与默认参数）；secret 单独加密列
model AlertChannelConfig {
  id            String   @id @default(uuid())
  channel       String   @unique   // smtp | sms_aliyun | sms_tencent | sms_aws | sms_twilio
                                   // | telegram | whatsapp | slack? …
  enabled       Boolean  @default(false)
  config_json   String   @db.Text  // 非密字段：host/port/user/from/signName/templateId/region/phone_number_id…
  secret_cipher String?  @db.Text  // AES-256-GCM：key_id:iv:tag:ciphertext（明文永不出库、不回显）
  updated_by    String
  updated_at    DateTime @updatedAt
  @@map("alertchannelconfig")
}
```

`alertcontact` 增列：

```sql
ALTER TABLE alertcontact ADD COLUMN options_json TEXT NULL;   -- 通道专属：{ dingtalk_secret, headers, body_template, provider }
```

> 只有**凭证级**配置进 `alertchannelconfig`（SMTP 账号、短信 AK/SK、bot token、WhatsApp token）；**Webhook 类通道的 URL 本身就是凭证**，沿用 `alertcontact.webhook_url`，避免两处存同一件事。

## 3. 通道注册表（新包 `src/modules/alerting/channels/`）

```
channels/
├── channel-crypto.ts          # AES-256-GCM 加解密 + 掩码
├── channel-registry.ts        # 通道元数据（key/label/group/字段/校验/发送函数绑定/默认限流）
├── channel-rate-limiter.ts    # 令牌桶 + 发送间隔 + 一轮积压合并（内存态）
├── channel-config.service.ts  # 配置 CRUD + 能力位 + 发送测试 + 审计
└── senders/
    ├── sender-chat-webhook.ts # 飞书/钉钉(加签)/企微/Slack/Discord/Teams/通用 Webhook
    ├── sender-ntfy-gotify.ts  # 自托管推送
    ├── sender-telegram.ts     # Bot API
    ├── sender-email.ts        # nodemailer（平台配置，env 回退）
    ├── sender-sms.ts          # 阿里云/腾讯云/AWS SNS/Twilio 适配器
    └── sender-whatsapp.ts     # Cloud API（模板消息）
```

`channel-registry.ts` 的通道描述（驱动后端分派 + 前端表单）：

```ts
type ChannelKind = 'webhook' | 'chat' | 'push' | 'email' | 'sms';
interface ChannelDescriptor {
  key: string;                 // 'dingtalk'
  label: string;               // '钉钉'
  group: 'chat' | 'email' | 'sms';   // 对应模板组
  kind: ChannelKind;
  /** 联系人侧需要的字段（前端据此渲染表单） */
  contactFields: ('webhook_url' | 'address' | 'secret' | 'headers' | 'body_template')[];
  /** 是否依赖平台级配置（凭证） */
  requiredConfig?: string[];   // ['smtp'] | ['sms_aliyun'] | ['telegram'] …
  /** 官方限流（条/分钟），用于令牌桶默认值 */
  ratePerMinute: number;
  /** 发送实现（由 sender-* 提供） */
  send: (ctx: SendContext) => Promise<void>;
  validateContact?: (contact: ChannelContact) => string | null;
}
```

通道与关键参数：

> ⚠️ **本表为 phase 首发设计**：Slack / Discord / Teams / ntfy / Gotify 已于 2026-10-10 删除，实际通道集见文末「增补 v1.2」。

| key | group | contactFields | requiredConfig | ratePerMinute | 发送实现 |
|---|---|---|---|---|---|
| `feishu_webhook` | chat | webhook_url | — | 60 | `{msg_type:text,content:{text}}` |
| `dingtalk` | chat | webhook_url, secret | — | **20** | msgtype text + 加签（毫秒 ts + `"\n"` + secret → HmacSHA256 → Base64 → urlEncode） |
| `wecom` | chat | webhook_url（key 形态） | — | **20** | `{msgtype:text,text:{content}}` |
| `slack` | chat | webhook_url | — | 60 | `{text}` |
| `discord` | chat | webhook_url | — | 30 | `{content}`（截断 2000 字符） |
| `teams` | chat | webhook_url（Workflows） | — | 60 | Adaptive Card |
| `telegram` | chat | address(chat_id) | `telegram`(bot token) | **20** | `sendMessage` |
| `ntfy` | push | webhook_url | — | 60 | `POST <url>`，Title 头 |
| `gotify` | push | webhook_url（含 token） | — | 60 | `POST /message?token=` |
| `webhook` | chat | webhook_url, headers?, body_template? | — | 60 | 自定义 body 走模板引擎 |
| `email` | email | address(邮箱) | `smtp` | 60 | nodemailer |
| `sms_aliyun` / `sms_tencent` / `sms_aws` / `sms_twilio` | sms | address(手机号) | 各自配置 | 60 | 官方 SDK |
| `whatsapp` | sms?→chat | address(手机号) | `whatsapp` | 60 | Cloud API 模板消息 |

> WhatsApp 归 `chat` 模板组（正文进模板变量），不归 sms。

## 4. 加解密与密钥治理

```ts
// channel-crypto.ts
export function encryptSecret(plain: string, key: Buffer, keyId = 'v1'): string; // key_id:iv:tag:ciphertext（base64 段）
export function decryptSecret(cipher: string, key: Buffer): string;
export function maskSecret(plain: string): string;  // '••••1234'
```

- 主密钥来源：`ALERT_CONFIG_KEY`（32 字节 base64）→ 缺失时报错并提示生成命令；**不落库**。
- 回显规则：`config_json` 明文字段可回显；`secret_cipher` 只回 `{configured: true, hint: '••••1234'}`。
- 审计：`alert_channel_config_update` 记录变更字段名，**不含密钥值**。

## 5. 限流与合并（C-7）

```ts
class ChannelRateLimiter {
  /** 令牌桶 + 最小发送间隔；同一通道串行化 */
  schedule(channelKey: string, job: () => Promise<void>): Promise<void>;
  /** 一轮内积压 > mergeThreshold(默认 3) 时合成一条摘要 */
  drain(channelKey: string): Promise<void>;
}
```

- 每通道令牌桶按 `ratePerMinute` 填充，取不到令牌则排队并退避（钉钉被限流 10 分钟的代价远高于排队）。
- 队列长度上限（默认 50）+ 摘要合并：超过阈值不再逐条发，改为「本轮 N 条告警：…（前 5 条名称 + 超出数量）」。
- 内存态：进程重启丢队列可接受（告警事件与投递记录仍落库，`alertnotification` 可见失败/未投递）。
- 单测覆盖：桶容量、间隔、合并阈值、超长截断。

## 6. 模板分组迁移（C-6）

```sql
-- alerttemplate.channel: 旧值 → 通道组
UPDATE alerttemplate SET channel = 'chat'  WHERE channel = 'feishu_webhook';
-- email / sms 保持不变；application 层把 group 名用于渲染
```

- `AlertChannel` 类型改为 `'chat' | 'email' | 'sms'`；默认模板三份（chat 通用文本、email 同 chat 文本、sms 短文本）。
- 发送时按通道 `descriptor.group` 取模板；WhatsApp 用 chat 模板渲染后把变量填入 Meta 模板参数。
- 前端模板页签从 3 通道变为 3 组（语义更清晰，也避免 14×2 组合爆炸）。

## 7. API 契约（`/sa/api/ops/alerts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `channels` | `{items:[{key,label,group,kind,available,reason,contact_fields,configured}]}`（替代原 `{email,sms}` 布尔） |
| GET | `channel-configs` | 各通道配置（密钥脱敏） |
| PUT | `channel-configs/:channel` | 保存配置（`{enabled, config, secret?}`），校验 + 审计 |
| POST | `channel-configs/:channel/test` | 发送测试：`{address?, webhook_url?, chat_id?}` → 成功或**原始错误码** |
| POST | `contacts` | 扩字段：`kind` 全量 + `options_json`（`{secret, headers, body_template, provider}`） |
| GET/PUT | `templates` | 通道改为通道组（`chat/email/sms`） |

### 7.1 追加（2026-10-09，phase `clklog-analytics-account-lifecycle-v3` 增补 v3.2 修订）

`channels` 与 `channel-configs` 的返回项各增 `platform_fallback: boolean`（**加法式**，老前端忽略）：

- 语义：该通道的邮件由**平台邮件通道**（`SaAuthMailConfig` / `AUTH_SMTP_*`，即「设置 → 用户管理 → 邮件通道」）的账号发送。
- 取值：仅 `smtp` / `email` 可能为 `true`；条件为「告警侧 `smtp` 未启用 **且** 平台邮件通道可用（`enabled && host && from`）」。
- `enabled` 语义不变（告警侧自身配置是否启用），两者互不覆盖；判定实现见 `alerting/channels/channel-config.service.ts`。

### 7.2 追加（2026-10-09）：通道配置 schema 增 `help` / `help_key`

`GET channel-configs` 返回的每个 schema 可带 `help: string` + `help_key: string`（加法式）：

- 语义：该通道的**逐步配置方法**（多行文本，前端按 `pre-line` 原样换行渲染），点在表头右侧的「?」上弹出。
- 取舍：**写「要准备什么 / 要填什么 / 怎么验证」三件事**，不写未经核实的控制台操作路径与错误码清单
  （把猜测写成产品文案比不写更糟）。截至增补 v1.1，全部凭证级通道都写了；`hint` 仍是展开区里的常驻说明。
- 成对约定：`help`（中文兜底，契约要求保留）与 `help_key`（13 门语言资源键）**必须成对**——
  单测 `test/alerting/alert-channels.spec.ts` 的「通道配置帮助」断言任何通道不得只有其一。
- 交互约定：表头右侧的「?」与启用开关同处一个容器，**点击整块都 `stopPropagation`**——
  点「?」只开说明，不连带折叠/展开卡片。

## 8. 依赖与许可（C-9）

| 依赖 | 用途 | 许可 |
|---|---|---|
| `nodemailer` | SMTP | MIT-0 |
| `@alicloud/dysmsapi20170525` | 阿里云短信 | Apache-2.0 |
| `tencentcloud-sdk-nodejs-sms` | 腾讯云短信 | Apache-2.0 |
| `@aws-sdk/client-sns` | AWS 短信 | Apache-2.0 |
| `twilio` | Twilio 短信/语音 | MIT |
| ~~`@slack/webhook`~~ | ~~Slack（可选）~~ 已随增补 v1.2 删除 | ~~MIT~~ |

- 钉钉/企微/Telegram/WhatsApp/通用 Webhook：**自研 POST**（调研结论：库普遍停更或只是框架）。
  （Discord/Teams/ntfy/Gotify 亦曾是自研 POST，随增补 v1.2 删除。）
- 新增脚本 `scripts/license-check.mjs`：扫描生产依赖的 license 字段，白名单外即失败；接入 `build.sh`。

## 9. 测试策略（本期按最小必要）

| 层 | 覆盖 |
|---|---|
| 单测 | payload 组装（钉钉加签、企微、Telegram、WhatsApp 模板变量）、通用 Webhook 模板渲染、限流（桶/间隔/合并）、加解密与掩码、配置 CRUD 校验 |
| 契约 | 通道注册表完整性（每个 descriptor 有 send、group 合法、限流为正、contactFields 与前端一致） |
| 手工 | 交付附**手动测试清单**：逐通道配置 → 发送测试 → 建联系人 → 建规则触发（无凭证环境无法自动化的部分） |
| 不做 | 真实厂商端到端（需账号与审批）、负载与限流压测、WhatsApp 模板审核链路 |

## 10. 实施顺序

1. Prisma 模型 + 迁移（`alertchannelconfig`、`alertcontact.options_json`、模板 channel → 组）。
2. `channels/` 包：crypto → registry → rate limiter → senders（先 chat/webhook 组，再 email/sms/telegram/whatsapp）。
3. `alert-notify.service` 改为注册表驱动 + 限流；删除手写 SMTP/TC3（保留文件删除或替换为薄封装）。
4. `channel-config.service` + 控制器接口 + 审计 + 发送测试。
5. 前端：通道配置页签、联系人表单按通道字段、模板页签改组。
6. `scripts/license-check.mjs` + `build.sh` 接入。
7. 文档：通道配置指南、HANDOVER、CODE_HANDOVER、INDEX/README、验收（实现记录 + 手动测试清单）。

## 11. 追加变更（2026-09-16 反馈四项）

产品反馈：模板编辑与预览要并排看；「默认联系人」概念不直观，改成每个联系人自己的启用开关，
并要支持一条规则发多个渠道；联系人要能改；历史/通知/变更记录的保存时间要能分开设。

| 项 | 决定 | 落点 |
|---|---|---|
| 模板编辑/预览并排 | 左编辑（Card「编辑」）、右预览（Card「预览」），编辑停顿 500ms 自动重渲染，可手动「刷新预览」；预览失败只在预览区报错 | `TemplateEditor.tsx`（后端接口不变） |
| 删掉「默认联系人」 | `alertcontact.is_default` 保留列但不再读写；新增 `enabled`（默认 true）。投递目标改为：规则绑定的**启用中**联系人；都没绑（或都被停用）→ 全部启用联系人。停用联系人不产生任何投递 | `AlertContact.enabled`、`resolveContacts()` |
| 规则多联系人 | 新表 `alertrulecontact(rule_code, contact_id)`，`@@unique([rule_code, contact_id])`，双 FK `ON DELETE CASCADE`；接口 `contact_ids: string[]`（空数组 = 清空绑定，缺省 = 不改动）；绑定变更写审计 `contact_ids: {from, to}` | 迁移 `20260916170000`、`bindContacts()` |
| 联系人可编辑 | `PUT /ops/api/ops/alerts/contacts/:id`（改名/通道/地址/密钥/启用）；**列表返回的是脱敏地址，编辑框不回填**，服务端再把「空值或等于掩码」视为未修改，双保险防止把掩码写进库 | `updateContact()` |
| 保留时间分设 | 新表 `alertretention(scope unique, retain_days, updated_by)`，scope ∈ `events`/`notifications`/`audits`；默认 `365/365/null`（永久）；批删 2000 行 × 50 批，跨 0 行不写审计，删事件连带删其通知记录 | `AlertRetentionService`、`GET/PUT /ops/alerts/retention/:scope` |

### 11.1 追加两处（同日晚，由线上日志驱动）

| 项 | 背景 | 实现 |
|---|---|---|
| 飞书加签 | 线上首次投递两行：一条成功、一条 `feishu_code_19021(sign match fail or timestamp is not with)`（用户其中一个机器人开了「签名校验」） | `feishu_webhook` 的 `contactFields` 增加 `secret`；`feishuSignature(secret, tsSec)` 按官方算法（key = `timestamp + "\n" + secret`、对**空串**做 HmacSHA256、Base64、**秒**），`timestamp`/`sign` 放**请求体**。⚠️ 与钉钉互为镜像，别抄错 |
| 通知记录标注投递目标 | 多联系人后同一事件多行，出问题时看不出是哪条通道失败（线上排查时只能靠代码推断） | `alertnotification` 增加 `contact_id` + `contact_name`（**快照、无外键**：联系人删除/改名后历史仍可读）；检测器成功与失败两路都写；「通知记录」新增「联系人」列 |

界面位置：保留策略卡片放在「监控告警 → 概览」顶部；联系人的「启用」开关在列表内直接切换（不弹窗），
「编辑」在操作列弹 Modal；规则的联系人字段改为多选（`mode="multiple"`，展示名带「（已停用）」后缀）。

默认值口径（与产品确认）：历史 365 天、通知记录 365 天、变更记录**永久**。

### 7.3 追加（2026-10-09，增补 v1.1）：通道暂停投递 `muted`

与 `enabled` **正交**的两个概念，别合并：`enabled` = 「本通道自己的凭证是否启用」；
`muted` = 「这个通道现在发不发」。平台邮件兜底让前者为假时仍在发信，只有后者能真正停发。

- **持久化**：`AlertChannelConfig.muted Boolean @default(false)`（migration `20261009230000_alert_channel_muted`）。
- **投递守卫（单一位置）**：`AlertNotifyService.sendWithRetry()` 进重试循环**之前**做一次
  `isMutedForKind(kind)` 判定；命中直接抛 `channel_muted`，**不进重试**（确定性失败，重试 3 次只是浪费与噪音）。
  判定口径 = 该 kind 的 `requiredConfig` 是否**全部** muted；无凭证要求的群机器人通道（feishu/dingtalk/…）恒不 muted。
- **可用性**：`capabilities()` 命中暂停 → `available = false` + `reason_key = alerting:channel.muted`，
  直接复用既有的联系人门禁（置灰 + 原因），不新增第二套判断。
- **短信多厂商**：`requiredConfig` 是多厂商时「全部暂停」才判定 muted；厂商自动挑选（联系人未指定 `options.provider`）
  跳过被暂停者，其余厂商不受影响。
- **接口**：`PUT channel-configs/:channel` 接受 `muted?: boolean`（加法式，与 `enabled` 同一次保存）；
  `channels` 与 `channel-configs` 的返回项各带 `muted: boolean`。
- **前端**：表头在该场景显示橙色「已暂停」（优先级高于「已启用」）；展开区提供「暂停投递」开关与说明，
  避免在表头塞第二个开关。


### 增补 v1.2（2026-10-10，PRD 增补 v1.2）：通道集收敛

删除 **Slack / Discord / Microsoft Teams / ntfy / Gotify**：无可用账号或服务可验证（Teams 需 Power Automate Workflows + M365、
Gotify 需自建服务），生产台账无联系人使用，为收敛维护面与下拉噪音。

- `channel-registry.ts`：删 5 个 `CHANNELS` 条目与其 import；通道数 13 → **8**。
- `senders/sender-chat-webhook.ts`：删 `sendSlack/sendDiscord/sendTeams` 与 `validateSlack/validateDiscord/validateTeams`
  及 `buildChatPayload` 的对应分支（飞书/钉钉/企微原样保留）。
- `senders/sender-push.ts`：**整文件删除**（仅含 ntfy + gotify）。
- `alert-eval.ts` 的 `URL_KINDS`：脱敏白名单去掉这 5 个。
- i18n：`messages/*.json` 的 `alert.channelName.*` 与 web 侧 `alerting:channel.*` 各 13 门语言同步删除。
- 存量行兼容：`alertcontact.kind` 若仍是被删通道，投递走 `unknown_channel_<kind>` 记为失败并在「通知记录」可见——
  **不静默丢**。生产核对：无此类联系人（仅 feishu_webhook ×2 / email / telegram）。
