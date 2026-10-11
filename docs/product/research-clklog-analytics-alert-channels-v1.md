# 调研：告警通知渠道扩展（钉钉 / 企业微信 / 邮件 / 短信 / Telegram / WhatsApp）

- `phase: clklog-analytics-alert-channels-v1`（**调研阶段**，未实现）
- 帽子：产品（调研结论；实现方案另出 PRD + 架构）
- 上游：`docs/product/prd-clklog-analytics-alerting-v4.md`（通道与模板现状）、`docs/architecture/clklog-analytics-design-alerting-v4.md`
- 触发：用户要求「告警目前只接了飞书，继续增加钉钉、企业微信、邮件（平台可配置发信邮箱）、短信（阿里云/腾讯云/AWS 等）、Telegram 机器人、WhatsApp 机器人；**先调研，找现成方案，尽量不重复开发**」

---

## 0. 前提修正：本项目要开源、要覆盖海外（2026-09-16 用户确认）

用户明确：**项目要上 GitHub 开源，不能只有国内在用，海外告警渠道必须接**。这带来三条硬约束：

| 约束 | 含义 | 对选型的影响 |
|---|---|---|
| **零内置凭证、默认全部关闭** | 开源项目不能预置任何厂商的 webhook/token/密钥，也没有「我们的服务器」可用 | 每个通道都必须由使用者在自己实例里配置；`channels()` 能力位默认全 false；文档要写清各通道的申请步骤 |
| **依赖许可必须干净** | 开源分发要求许可兼容 | 只引 **MIT / Apache-2.0 / BSD-3**；**禁用 GPL/AGPL/SSPL 与 proprietary（含 EE 包）** → 这正是排除 `whatsapp-cloud-api`（GPL-3.0）与 Novu 企业版的理由；建议在 CI 加许可检查（如 `license-checker` 白名单） |
| **渠道分三组，海外与通用优先** | 通用（Webhook 类）+ 国内（飞书/钉钉/企微/国内短信）+ 海外（Slack/Discord/Teams/Telegram/WhatsApp/AWS/Twilio/ntfy…） | 首发就要覆盖海外最常用的几个，而不是先做国内再去补 |

**其中「通用 Webhook」是开源项目性价比最高的一条**：让使用者自定义 URL / 请求头 / body 模板（复用 alerting-v4 已有的 Go 模板子集引擎），长尾渠道（PagerDuty、Opsgenie、Grafana OnCall、自建系统、Mattermost、Zabbix…）**零代码接入**，我们不必为每个产品写适配器。

## 1. 结论摘要

**推荐路线：保留自研的薄通道层，只把「有官方 SDK 的部分」换成官方 SDK，不引入通知聚合框架。**

| 渠道 | 选型 | 为什么不引库 / 引什么 |
|---|---|---|
| **通用 Webhook**（首发建议） | **自研**：自定义 URL/headers/body 模板 | 开源项目的长尾覆盖手段；body 直接复用 alerting-v4 的模板引擎 |
| Slack Incoming Webhook | 可用 **`@slack/webhook`**（MIT，908k 次/周，2026-08 发版）或自研 POST | 官方库轻量且是「一渠道一薄库」的正统做法 |
| Discord Webhook | **自研 ~20 行** | 单次 POST JSON，无官方 Node 库必要 |
| Microsoft Teams | **自研**，但**必须用 Workflows 的 webhook URL**（Incoming Webhook/365 Connectors 正在退场、新建已被阻断，见 §5.7） | 形态仍是 POST JSON，只是 URL 由 Workflows 生成 |
| ntfy / Gotify（开源自托管推送） | **自研 ~15 行** | ntfy `POST https://<host>/<topic>`、Gotify `POST /message?token=`，都是纯 HTTP |
| PagerDuty | **自研**（Events API v2 就是一次带 routing key 的 POST） | 不必引库；若将来要读事件/确认再考虑官方 SDK |
| 钉钉群机器人 | **自研 25 行**（带加签的 HTTPS POST） | 无官方 Node SDK；npm 上的库停更（`dingtalk-robot-sender` 最后发版 2019-11，280 次/周） |
| 企业微信群机器人 | **自研 ~20 行** | 更简单（连加签都没有）；npm 上无活跃库 |
| 邮件 | **换用 `nodemailer`**（MIT-0，17.5M 次/周） | 我们现在**手写的 SMTP 客户端**（裸 socket + STARTTLS + AUTH LOGIN）就是典型重复开发；nodemailer 自带 `verify()` 正好做「发送测试邮件」 |
| 短信（阿里云/腾讯云） | **换用官方 SDK**（`@alicloud/dysmsapi20170525`、`tencentcloud-sdk-nodejs-sms`） | 我们现在**手写的腾讯云 TC3 签名**容易踩坑；官方 SDK 均为 Apache-2.0、维护活跃 |
| 短信（AWS SNS） | `@aws-sdk/client-sns` | 官方 SDK；但**大陆区域不支持短信**，发中国号码需向 AWS 报备，只能当海外通道 |
| Telegram 机器人 | **自研 ~30 行**（Bot API `sendMessage`） | 库（grammY/telegraf）都是「机器人框架」，含长轮询/收消息，对单向告警是负担；需要交互时再引 grammY |
| WhatsApp 机器人 | **自研 adapter**，走官方 Cloud API | 官方 Node SDK 已于 2023-06 归档；非官方库（baileys / whatsapp-web.js）违反 ToS、依赖扫码会话，不适合生产 |

**明确不引入通知聚合框架**（Novu / notifme-sdk）：调研结论见 §4，关键原因是**渠道缺口**（两个框架都没有钉钉 / 企业微信 / 阿里云或腾讯云短信）+ 运维成本（Novu 需自托管 Mongo+Redis+3 个服务）+ 许可风险（Novu 企业版为 proprietary）。

**建议分三批做**（§8）：① 钉钉 + 企业微信 + 邮件（含平台化配置）；② 短信多厂商；③ Telegram / WhatsApp（受网络与资质前置条件约束，可先做接口与配置，等条件具备再启用）。

---

## 2. 本仓现状与接入点

### 2.1 现有的通道接缝（好消息：抽象已经在了）

| 位置 | 现状 |
|---|---|
| `src/modules/alerting/alert-notify.service.ts#deliver` | 唯一的通道分派点：按 `contact.kind` 选 `sendSmtp` / `sendTencentSms` / `sendFeishu`；已带 3 次重试 + 退避 + 失败落库 |
| `alert-channel-email.ts` | **手写 SMTP**（裸 socket、STARTTLS、AUTH LOGIN、MIME 拼装）≈ 130 行 |
| `alert-channel-sms.ts` | **手写腾讯云 TC3 签名**（HmacSHA256 + sha256 + 签名串拼装）≈ 100 行 |
| `alert-eval.ts` | 地址校验与脱敏：`isFeishuWebhook` / `isEmailAddress` / `isMobileNumber` / `maskAddress(kind, value)` |
| `alertcontact` 表 | `kind`（feishu_webhook / email / sms）+ `webhook_url` + `address` + `is_default` |
| `alerttemplate` 表 | 按「事件类型 × 通道」存模板，默认模板内置（alerting-v4 的 Go 模板子集引擎） |
| `channels()` | 能力位：`{email: smtpReady(...), sms: smsReady(...)}`，前端据此禁用不可用通道 |
| 配置来源 | 全部来自服务端环境变量（`ALERT_SMTP_*`、`ALERT_SMS_*`），**没有任何平台内配置入口** |

### 2.2 这次要补的三件事

1. **新通道**：钉钉、企业微信、Telegram、WhatsApp —— 都是「带鉴权的 HTTPS POST」，落点就是 `deliver` 的一个分支 + 模板通道枚举 + 地址校验/脱敏。
2. **邮件平台化配置**：把 SMTP 从 env 搬到平台设置（含密钥加密存储、回显规则、发送测试）。
3. **短信多厂商**：`SmsProvider` 抽象 + 阿里云/腾讯云/AWS 三个适配器，各自保留原始错误码。

---

## 3. 渠道矩阵（协议 / 鉴权 / 上限 / 前置条件）

| 渠道 | 端点 | 鉴权 | 消息长度 | 频率限制 | 前置条件 |
|---|---|---|---|---|---|
| 飞书（已有） | `open.feishu.cn/open-apis/bot/v2/hook/<token>` | URL token | 文本 ≤ 约 30KB（实践） | 未明确 | 无 |
| 钉钉 | `oapi.dingtalk.com/robot/send?access_token=…` | URL token + **加签**（或关键词 / IP 白名单） | 见 §5.1（核实中） | 社区称 20 条/分钟（核实中） | 建群机器人；设安全策略 |
| 企业微信 | `qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…` | URL key | text ≤2048 字节、markdown ≤4096 字节 | **20 条/分钟**（官方） | 建群机器人（文档未要求企业认证） |
| 邮件 | 任意 SMTP（465/587/25） | AUTH LOGIN / PLAIN | 视服务商 | 视服务商 | SMTP 账号（建议独立发信账号 + 授权码） |
| 短信-阿里云 | `dysmsapi.aliyuncs.com` | AccessKey + V3 签名（SDK 封装） | 模板变量 ≤ 约 20 字 | QPS 5000/秒（账号级） | **签名 + 模板需控制台审核** |
| 短信-腾讯云 | `sms.tencentcloudapi.com` | SecretId/Key + TC3（SKD 封装） | 模板参数限长 | 按套餐/默认限频 | **签名 + 模板 + SmsSdkAppId 需报备** |
| 短信-AWS SNS | `sns.<region>.amazonaws.com` | SigV4（SDK 封装） | 140 字符/条（会被切分计费） | 默认沙箱 $1/月 + 10 个验证号码 | **无 cn-* 区域**；发中国号码需 Support 报备 |
| Telegram | `api.telegram.org/bot<token>/sendMessage` | Bot token | **1–4096 字符**（官方） | 群 20 条/分钟、单聊约 1 条/秒 | 建 bot 拿 token；**大陆需代理出口** |
| WhatsApp | `graph.facebook.com/v<ver>/<phone_number_id>/messages` | System User Bearer token | 模板变量有长度约束 | 分级 250 → 2,000 → 10,000 → 100,000 → 无限；吞吐 80 条/秒 | **Business 验证 + 号码注册 + 模板预审**；**窗口外只能发模板消息**；大陆需代理出口 |

> `api.telegram.org` / `graph.facebook.com` 在大陆不可直连属社区共识（gfwlist 收录），官方未声明；**这直接影响部署方案**（需要运维提供代理出口）。

---

## 4. 现成方案盘点（"去 git 里找找"的产出）

### 4.1 通知聚合框架：**都不建议引入**

| 项目 | 渠道覆盖 | 引入代价 | 结论 |
|---|---|---|---|
| [Novu](https://github.com/novuhq/novu)（40k stars，2026-09 仍活跃） | email 21 个（含 nodemailer/SES）、sms 39 个（twilio/sns/…）、chat 21 个（**含 Telegram、WhatsApp Business**）；**全仓库 `dingtalk`/`wecom` 零命中，无阿里云/腾讯云短信** | 必须自托管整套：API + Worker + WS + Dashboard + MongoDB + Redis（2 集群，队列需 AOF）+ S3，官方最低 4 vCPU / 8 GB；`@novu/node` 已标 **EOL（2025-03-20）**，`@novu/providers` 周下载 44、2025-02 后停更 | **不引入**：我们最需要的钉钉/企微/国内短信它没有，等于为缺口再写一遍适配器，还多背一套 Mongo+Redis 集群 |
| 许可 | 仓库根 `LICENSE-MIT` + `EE-PACKAGES-LICENSE`（**proprietary：仅限内部运营，禁止转售/再分发/商业托管**） | 法务风险 | **不引入**（我们要把它嵌入自有产品） |
| [notifme-sdk](https://github.com/notifme/notifme-sdk)（MIT，2k 次/周） | email/sms/push 各有若干 provider，含 smtp；**不支持钉钉/企微/Telegram** | 体积小 | **不用于生产**：2026 年提交全是 dependabot，实质停更 |
| [node-notifier](https://github.com/mikaelbr/node-notifier) | 桌面弹窗 | — | 与服务端告警无关，排除 |
| [Apprise](https://github.com/caronc/apprise)（Python） | 渠道最广（含钉钉/企微） | 需 sidecar 进程 | 仅作对照，不引入 |

### 4.2 单渠道库

| 渠道 | 候选库 | 数据（npm/GitHub） | 结论 |
|---|---|---|---|
| 钉钉 | `dingtalk-robot-sender` | 280 次/周，最后发版 2019-11，MIT，无自带类型声明 | **不用**（自研 25 行） |
| 企业微信 | `qyapi-weixin` 等 | 个位数下载，2023 停更 | **不用** |
| 邮件 | **`nodemailer`** | **17.5M 次/周**，10.0.10（2026-09-14），**MIT-0**，`verify()` 官方支持 | **采用**（替换手写 SMTP） |
| 短信 | `@alicloud/dysmsapi20170525` / `tencentcloud-sdk-nodejs-sms` / `@aws-sdk/client-sns` / `twilio` | 包名与许可见 §5 | **采用官方 SDK** |
| Telegram | `grammY`（MIT，4.93M/周，TS 原生，2026-08 发版）> `node-telegram-bot-api`（162k/周）> `telegraf`（302k/周，最后发版 2024-02，仓库 2025-01 起无推送） | — | **单向告警不用库**；将来要收消息/交互再引 grammY |
| WhatsApp | 官方 `WhatsApp/WhatsApp-Nodejs-SDK` **2023-06 已 archive**；`whatsapp-cloud-api` 10k/周但 **GPL-3.0**（传染）；非官方 `@whiskeysockets/baileys`（358k/周，MIT）、`whatsapp-web.js`（79k/周） | — | **不用库**（直接 fetch 官方 Cloud API）；非官方库违反 ToS，排除 |

---

## 5. 逐渠道选型明细

### 5.1 钉钉群机器人

- 发送：`POST https://oapi.dingtalk.com/robot/send?access_token=<token>`，JSON body `{"msgtype":"text","text":{"content":"…"}}`（也支持 markdown / actionCard / feedCard）。
- 安全设置：自定义关键词 / **加签** / IP 白名单（三者可叠加使用）。
- **URL 需带 timestamp 与 sign（官方原文确认）**：
  > 「如果自定义机器人的安全设置使用的是加签方式，调用本接口发送消息时，需要拼接 timestamp 和 sign 参数，示例为：`https://oapi.dingtalk.com/robot/send?access_token=XXXXXX&timestamp=XXX&sign=XXX`」
  > —— <https://developers.dingtalk.com/document/orgapp/custom-robots-send-group-messages>

- **加签算法（两个权威实现逐字一致）**：`sign = urlEncode(base64(HmacSHA256(key=secret, msg=timestamp + "\n" + secret)))`，`timestamp` 取**毫秒**。参考实现：
  - Apache DolphinScheduler（Apache 项目）`DingTalkSender.java:315-327`：`stringToSign = timestamp + "\n" + secret` → `HmacSHA256` → `Base64` → `URLEncoder.encode`，拼成 `url + "&timestamp=" + timestamp + "&sign=" + sign`。
    <https://github.com/apache/dolphinscheduler/blob/dev/dolphinscheduler-alert/dolphinscheduler-alert-plugins/dolphinscheduler-alert-dingtalk/src/main/java/org/apache/dolphinscheduler/plugin/alert/dingtalk/DingTalkSender.java#L315-L327>
  - prometheus-webhook-dingtalk（运维圈最常用）`notifier/notification.go:91-106`：同样 `timestamp(ms) + "\n" + secret`，`qs.Set("timestamp"…)`、`qs.Set("sign"…)`（`url.Values.Encode()` 自带 percent-encode）。
    <https://github.com/timonwong/prometheus-webhook-dingtalk/blob/master/notifier/notification.go#L91-L106>
  - 旁证：Uptime Kuma `server/notification-providers/dingding.js` 同形（`Crypto.createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64")`，再 `encodeURIComponent`）。
    ⚠️ 注意别混用钉钉**连接平台 Webhook 的加签**（签的是消息体，不是 secret）：<https://developers.dingtalk.com/document/connection-platform-faq/webhook-signature-tutorial>

- **频率限制（官方原文确认）**：
  > 「调用频率限制 … **每个机器人每分钟最多发送 20 条消息到群里，如果超过 20 条，会限流 10 分钟**。」
  > —— <https://developers.dingtalk.com/document/orgapp/custom-robots-send-group-messages>

- **安全设置**：官方确认三种类型「自定义关键词 / 加签 / IP 地址（段）」并存；**「三选一还是可叠加」官方原文未见明文**（客户端为单选项属社区说法），落地前人工核对一次。
- **text 长度上限：官方未给**（社区常说的「20000 字节」找不到官方出处；2048 字节上限属于「服务助手推送」「发送工作通知」另外两个接口，别搞混）。实现时不做长度假设，超长由服务端返回错误。
- 结论：**自研**（`node:crypto` 做 HMAC + `fetch` 发送），不引依赖；**必须自适应限流**（见 §6.1）。

> 取证方法备注：`open.dingtalk.com` 文档页为 SPA 渲染抓不到正文，上述官方引文来自其**文档检索接口**返回的官方索引正文；落地前建议人工打开一次原文核对，并用真实机器人做一次加签联调（签名错会被拒绝，比读文档更确定）。

### 5.2 企业微信群机器人（[官方文档](https://developer.work.weixin.qq.com/document/path/91770)）

- 发送：`POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>`，**无 access_token、文档未要求企业认证**。
- 消息：`text` / `markdown` / `markdown_v2` / `image` / `news` / `file` / `template_card`；`<@userid>` 仅 text/markdown 支持。
- 官方限制：text ≤2048 字节、markdown ≤4096 字节、图片 ≤2MB、文件 ≤20MB；**每机器人 20 条/分钟**。
- 结论：**自研 ~20 行**（最简渠道）。

### 5.3 邮件（平台可配置）

- **采用 `nodemailer`** 替换现有手写 SMTP（MIT-0；`createTransport({host,port,secure,auth,from})`；`transporter.verify()` 用于连通性校验）。
- 平台化配置要点：
  - 字段：`host / port / secure / user / pass / from`（可选 `reply_to`）。
  - **密码只写不读**：入库前用 AES-256-GCM 加密（主密钥来自环境变量/后续 KMS），接口回显仅 `host/port/user/from` 与「已配置」标记。
  - 「发送测试邮件」按钮：先 `verify()` 再实发一封，把原始错误码回显（区分认证失败 / 连接超时 / 被拒）。
  - 现有 `ALERT_SMTP_*` 环境变量作为**回退**（平台未配置时沿用），避免升级后通道突然不可用。

### 5.4 短信（多厂商）

| 厂商 | 包 | 许可 | 关键注意 |
|---|---|---|---|
| 阿里云 | `@alicloud/dysmsapi20170525` | Apache-2.0 | `SignName`/`TemplateCode` 必须控制台**审核通过**；QPS 5000/秒；**接口不保证幂等**（重试需自带去重） |
| 腾讯云 | `tencentcloud-sdk-nodejs-sms` | Apache-2.0 | 需要 `SmsSdkAppId`（控制台应用）；`TemplateId`/`SignName` 须审核；国内单次最多 200 号 |
| AWS SNS | `@aws-sdk/client-sns` | Apache-2.0 | **无 cn-* 区域**（大陆不可发）、发中国号码需 Support 报备、默认沙箱 $1 + 10 个验证号码 |
| Twilio（容灾） | `twilio` | MIT | 覆盖广、无区域限制，适合海外/容灾 |

**关于「短信不是接 SDK 就行了吗」——代码层面：对，就是接 SDK。** 具体到我们的落地：

- 每个厂商 = 一段适配器：**装官方 SDK → 拼参数（签名/模板/号码）→ 调 SendSms → 把 SDK 抛出的错误码原样带出**，30~50 行；协议签名（阿里云 V3、腾讯云 TC3、AWS SigV4）全部由 SDK 负责，**我们不再自己实现签名**（现有 `alert-channel-sms.ts` 里手写的腾讯云 TC3 签名会随之删除）。
- 唯一需要自研的是**薄接口**（`SmsProvider`：`ready()` / `send(mobile, templateId, params)` / 错误码映射），因为各厂商的模板与区域字段不同；这层不做协议转换，只做参数与错误归一。
- **但「接上」≠「能用」，三件事不是代码**：① 国内（阿里云/腾讯云）签名与模板必须先在控制台报备审核，否则接口直接返回模板不存在；② AWS SNS **没有 cn-* 区域**、发中国号码要开 Support 工单、且默认沙箱只能发 10 个验证号码、月上限 $1；③ 海外号码要用海外厂商（Twilio/Vonage/MessageBird）或 SNS 海外区域。
- 海外短信候选（开源项目需要）：`twilio`（MIT，4.41M 次/周）、Vonage（`@vonage/server-sdk`）、MessageBird（`messagebird`）、Plivo（`plivo`）——同样按「官方 SDK + 薄适配器」处理，按社区需求量决定做哪几个。
- 结论：**自研薄接口 + 官方 SDK**；不引 SMS 抽象库（`@novu/providers` 44 次/周已停更且无国内厂商）。

### 5.5 Telegram 机器人

- 发送：`POST https://api.telegram.org/bot<token>/sendMessage`，`{chat_id, text, parse_mode: 'MarkdownV2'|'HTML', disable_notification?}`。
- 官方限制：text **1–4096 字符**；群内 ≤20 条/分钟、单聊约 1 条/秒，超限 429。
- **网络**：大陆不可直连 → 需要代理出口（HTTP(S)_PROXY 或运维提供出口），否则通道不可用；这是**上线前置条件**而非代码问题。
- 结论：**自研 ~30 行**；将来要做双向交互（查询/确认）再引 `grammY`。

### 5.6 WhatsApp 机器人

- 发送：`POST https://graph.facebook.com/v<ver>/<PHONE_NUMBER_ID>/messages`，`Authorization: Bearer <System User token>`；body 用模板消息（`type: "template"`）或会话内文本。
- **硬约束（官方）**：用户来消息后 24 小时客服窗口内可发任意消息，**窗口外只能发预审模板**；Business 验证 + 号码注册 + 模板审核；messaging limit 分级 250 → … → 无限；吞吐 80 条/秒。
- 对告警的含义：**告警属于「business-initiated」**，必须先在 Meta 提交并审核通过一个告警模板（变量化：规则名/当前值/阈值/时间），且不同语言要分别送审。
- 结论：**自研 adapter**（官方 Cloud API）+ **模板消息**；非官方库（baileys / whatsapp-web.js）不采用（违反 ToS、依赖扫码会话、协议变更即断）。

### 5.7 Microsoft Teams（⚠️ 核实结论：连接器正在退场，要用 Workflows）

- 官方原文（Microsoft Learn，2026-04 更新）：
  > 「Microsoft 365 Connectors (previously called Office 365 Connectors) are **nearing deprecation, and the creation of new Microsoft 365 Connectors will be blocked soon**…」
  > 「**Developers can't register new connectors** on the Connector developer portal.」
  > 官方替代：**Workflows**（Power Automate 的「When a Teams webhook request is received」触发器）。
  > —— <https://learn.microsoft.com/en-us/microsoftteams/m365-custom-connectors>
- 对我们的含义：Teams 通道**仍可支持，但文档必须引导用户创建 Workflows 的 webhook URL**（而非 Incoming Webhook 连接器）；实现上仍是「POST JSON 到用户给的 URL」，与我们其它 webhook 通道同构（可用通用 Webhook 通道 + Teams 适配卡片体）。
- 顺带一个已生效的限制：连接器禁用清单里包含 **PagerDuty、Opsgenie、Sentry** 等（不能新建连接器），再次说明 Teams 走 Workflows 是唯一稳妥路径。

---

## 6. 平台化配置设计要点（邮件/短信）

| 项 | 建议 |
|---|---|
| 配置作用域 | **实例级（全局）**，与现有 `alertcontact`（全局联系人）一致；项目级差异留给「联系人 → 通道」映射 |
| 存储 | 新表 `alert_channel_config`（`channel`、`provider`、`config_json`、`secret_cipher`、`enabled`、`updated_by`、`updated_at`），密钥单独列存密文 |
| 加密 | AES-256-GCM（主密钥来自 env，格式 `key_id:iv:tag:ciphertext`，为将来换 KMS 留 key_id） |
| 回显 | 密钥字段只回显「已配置/未配置」+ 末 4 位；`host/port/user/from/signName/templateId` 明文可回显 |
| 校验 | 保存时做结构性校验（端口范围、域名、手机号格式）；提供「发送测试」接口（邮件 verify + 实发；短信实发到指定号码） |
| 审计 | 复用 `ops_action_log`（`alert_channel_config_update`），变更内容不含密钥明文 |
| 与模板系统的关系 | 新通道自动获得 `alerttemplate` 的默认模板（触发/恢复 × 通道），复用现有占位符引擎，无需新写渲染逻辑 |

---

### 6.1 通道限流：新增的硬约束（三批都要做）

调研发现**多个渠道的官方限制正好是「20 条/分钟」**，而我们的检测器一轮可以命中多条规则（`for_windows=1` 时同轮就可能触发多条）：

| 渠道 | 官方限流 | 超限后果 |
|---|---|---|
| 钉钉 | 20 条/分钟/机器人 | **限流 10 分钟**（官方原文） |
| 企业微信 | 20 条/分钟/机器人 | 被拒 |
| Telegram | 群 20 条/分钟、单聊约 1 条/秒 | HTTP 429 |
| WhatsApp | 分级限额 + 吞吐 80 条/秒 | 拒发/降级 |
| 短信 | 各厂商 QPS 不同（阿里云 5000/秒账号级） | 触顶被拒 |

**结论**：通道层必须引入**每通道令牌桶（默认 20/分钟，按渠道可配）+ 超限排队/退避 + 合并**（同轮多条告警可合并为一条摘要消息），否则一次告警风暴会把通道打到限流，10 分钟内一条都发不出去——这与「告警要送得出去」直接冲突。这条写进 PRD 的验收标准。

## 7. 安全与合规

1. **密钥不落日志/不回显**：沿用现有「脱敏回显」惯例（`maskAddress`），新增通道的凭据（钉钉 secret、企微 key、Telegram token、WhatsApp token、短信 AK/SK）统一走加密存储 + 脱敏。
2. **凭据不写仓库**：仓库里只留配置样例与文档（红线 3）。
3. **WhatsApp 合规**：必须走官方 Cloud API + 预审模板；禁止用非官方库（封号 + ToS 违反）。
4. **Telegram/WhatsApp 跨境网络**：需要代理出口，且消息内容（告警文本）会经第三方服务出境——**含项目名、指标名的告警文本出境是否有合规要求需要确认**。
5. **短信内容**：国内短信模板需报备，告警内容（规则名/数值）只能作为模板变量传入，不能自由文本。

---

## 8. 上线前置条件清单（人工/控制台，非代码）

| 渠道 | 需要先完成 |
|---|---|
| 钉钉 | 建群机器人 → 拿 webhook token + 设加签 secret |
| 企业微信 | 建群机器人 → 拿 webhook key |
| 邮件 | 准备发信账号（建议专用 + 授权码），确认 SMTP 出口可用 |
| 短信-阿里云 | **签名 + 模板报备审核**（含告警模板变量位） |
| 短信-腾讯云 | 签名 + 模板 + SmsSdkAppId（控制台应用） |
| 短信-AWS | 若需发中国号码：开 Support 工单报备模板；选定海外区域（建议 ap-southeast-1）；退出沙箱 |
| Telegram | 建 bot（@BotFather）拿 token；**确认代理出口** |
| WhatsApp | Business 验证、号码注册、**告警模板送审**、System User token；**确认代理出口** |

---

## 9. 建议分批与工作量（供排期，实现另立 PRD）

| 批次 | 内容 | 说明 |
|---|---|---|
| **P1（首发，国内+海外都能用）** | **通用 Webhook**（自定义 body 模板）+ 飞书（已有）+ 钉钉 + 企业微信 + **Slack + Discord + Telegram** + 邮件（`nodemailer` 替换手写 SMTP + 平台化配置 + 测试发送） | 无外部审批依赖；顺带清掉「手写 SMTP」这处重复开发；开源首发即覆盖国内与海外主流群聊 |
| **P2** | 短信：provider 接口 + 阿里云/腾讯云（替换手写 TC3）+ AWS SNS + Twilio；**ntfy / Gotify**（开源自托管推送）；**Teams（Workflows webhook）** | 短信依赖签名/模板报备；ntfy/Gotify 对开源社区很受欢迎、成本极低 |
| **P3** | WhatsApp（官方 Cloud API + 模板消息）；PagerDuty（先用通用 Webhook 即可）；语音（Twilio Voice，可选） | 依赖 Meta 审核与代理出口，接口先做、按条件启用 |

公共改动（三批共用）：`alertcontact.kind` 枚举扩展 + 校验/脱敏、`alerttemplate` 通道枚举扩展 + 默认模板、`channels()` 能力位扩展、前端联系人表单与模板编辑器支持新通道、审计与文档。

---

## 10. 待决策点（需要产品/你拍板）

1. **首发渠道清单**：建议 P1 = 通用 Webhook + 飞书 + 钉钉 + 企业微信 + Slack + Discord + Telegram + 邮件。是否同意？（海外群聊里 Slack/Discord/Telegram 覆盖率最高）
2. **通用 Webhook 的 body 是否支持模板**：建议支持（复用 alerting-v4 的 Go 模板子集）——这样 PagerDuty/Opsgenie/自建系统都能零代码接入；不支持的话每条长尾都要写适配器。
3. **短信首发厂商**：国内阿里云 + 腾讯云，海外 AWS SNS + Twilio——是否同意？（开源用户里 Twilio 认知度最高，SNS 适合已有 AWS 的团队）
4. **许可白名单 CI 检查**：是否把「只允许 MIT/Apache-2.0/BSD」做成 CI 门禁（开源后防依赖许可污染）？
5. **WhatsApp 是否纳入 P1**：官方 Cloud API 需 Business 验证 + 模板预审 + 代理出口，建议放 P3，先把接口与配置骨架做好。
6. **配置作用域**：开源默认建议实例级全局（与现有联系人模型一致），是否同时预留「按项目/按团队」的字段？

---

## 11. 来源

- 企业微信群机器人：<https://developer.work.weixin.qq.com/document/path/91770>
- Telegram Bot API / FAQ：<https://core.telegram.org/bots/api#sendmessage>、<https://core.telegram.org/bots/faq>
- WhatsApp Cloud API：<https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages>、<https://developers.facebook.com/docs/whatsapp/api/rate-limits>
- Novu：<https://github.com/novuhq/novu>、EE 许可 <https://github.com/novuhq/novu/blob/next/EE-PACKAGES-LICENSE>、自托管要求 <https://docs.novu.co/community/self-hosting-novu/overview>
- notifme-sdk：<https://github.com/notifme/notifme-sdk>
- nodemailer：<https://nodemailer.com/smtp>
- 阿里云 SendSms：<https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms>
- 腾讯云 SendSms：<https://cloud.tencent.com/document/product/382/55981>
- AWS SMS 支持国家/区域：<https://docs.aws.amazon.com/sns/latest/dg/sns-supported-regions-countries.html>、端点列表 <https://docs.aws.amazon.com/general/latest/gr/end-user-messaging.html>
- 钉钉官方文档（发送接口/加签参数/频率限制）：<https://developers.dingtalk.com/document/orgapp/custom-robots-send-group-messages>
- 钉钉加签参考实现：<https://github.com/apache/dolphinscheduler/blob/dev/dolphinscheduler-alert/dolphinscheduler-alert-plugins/dolphinscheduler-alert-dingtalk/src/main/java/org/apache/dolphinscheduler/plugin/alert/dingtalk/DingTalkSender.java#L315-L327>、<https://github.com/timonwong/prometheus-webhook-dingtalk/blob/master/notifier/notification.go#L91-L106>
