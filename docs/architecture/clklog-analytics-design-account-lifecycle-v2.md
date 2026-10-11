# 实现方案：账号生命周期 v2——邮件通道（phase: clklog-analytics-account-lifecycle-v2）

> 架构帽。PRD：`docs/product/prd-clklog-analytics-account-lifecycle-v2.md`（验收 AM-1～10、非目标）。
> 上游 v1 SSOT：`clklog-analytics-design-account-lifecycle-v1.md`。本文是邮件配置、令牌、邀请、邮件模板的 SSOT。

---

## 1. 邮件通道配置（`AUTH_SMTP_*`）

- `configuration.ts` 增 `AuthMailConfig { host?, port, user?, pass?, from?, secure }`，读取 `AUTH_SMTP_HOST/PORT/USER/PASS/FROM/SECURE`（模式照抄告警 SMTP，configuration.ts:185-203）；`secure` 默认 true，`PORT` 默认 465。
- `authMail.enabled = Boolean(host)`：**未配置时全站降级**（PRD §5.1），发信调用全部短路为「未配置」错误码。
- 与告警 `ALERT_SMTP_*` 完全独立：账号域不读告警配置，告警域行为零变化。
- 传输：`modules/auth/auth-mail.service.ts`，nodemailer（依赖已存在）。`send({to, subject, text})` 单方法；同步发送、无队列（PRD 非目标），失败捕获返回 false 并审计 `auth_mail_failed`。
- **配置注入**：服务经 `AUTH_MAIL_CONFIG` 令牌拿配置（`auth-mail.config.ts`），**不得静态 import `configuration`**——后者在模块加载时解析环境变量，CI 测试进程无 `CLICKHOUSE_PASSWORD` 等会连坐炸掉所有传递导入它的 spec（2026-09-17 CI 红教训，本仓库修复于同一提交链）。装配层（auth.module.ts）用 `useFactory: () => appConfig.authMail` 注入。
- 链接基址：`AUTH_SMTP_BASE_URL` 可选（默认取 `APP_PUBLIC_BASE_URL ?? config.publicBaseUrl` 已有的 `/sa/` 前缀体系——以 configuration 中现有 public base 配置为准，详见 §7 链接拼装）。

## 2. 数据模型（migration `20260918100000_account_lifecycle_v2`）

```prisma
model SaAuthToken {          // 三类一次性令牌（reset/setup/invite 预留）
  id          String    @id @default(uuid())
  user_id     String?
  email       String?        // 未注册邀请目标
  purpose     String         // password_reset | account_setup
  token_hash  String    @unique  // sha256(明文)，明文只存在于邮件
  expires_at  DateTime
  used_at     DateTime?
  created_at  DateTime  @default(now())
  user        SaUser?   @relation(fields: [user_id], references: [id], onDelete: Cascade)
  @@index([email, purpose, created_at])
}

model SaInvitation {
  id           String    @id @default(uuid())
  project_name String
  email        String        // 小写规整
  role_key     String        // analyst | member | external（owner 等禁放）
  token_hash   String    @unique
  invited_by   String        // 操作者 username
  expires_at   DateTime      // 7 天
  accepted_at  DateTime?
  created_at   DateTime  @default(now())
  @@index([project_name, email])
}
```

`SaUser` 增 `authTokens SaAuthToken[]` 关系。
**消费前签发即作废旧令牌**：同 `email+purpose` 未用令牌全部置 `used_at`——天然保证「最新一封才有效」与 60 秒限流的判据（取最近一封 `created_at`）。

## 3. 令牌与限流（PRD §5.2 为本契约实现依据）

- 明文：`randomBytes(32).toString('hex')`；入库 `sha256(token)`；有效期 reset 30min / setup 72h / invite 7d。
- 限流：签发前查同一 `email` 任意未过期令牌的最近 `created_at`，距今 <60s → 429 `auth:mail.tooOften`。
- 消费：校验 `token_hash + purpose + used_at IS NULL + expires_at > now` → 事务内置 `used_at` 并执行副作用。

## 4. API 契约

### 4.1 auth 域（`AuthController`）

| 方法与路径 | 权限 | 说明 |
|---|---|---|
| `GET /auth/mail-status` | `ops.user.manage` | `{smtp_configured}`，供建号弹窗决定显隐 |
| `POST /auth/forgot-password` `{identifier}` | **Public** | 命中 username 或 email 且用户有邮箱 → 签发+发信；**统一返回 `{ok:true}`**（不区分命中）。审计 `auth_reset_request`（detail 只记 `identifier_hash`） |
| `POST /auth/reset-password` `{token, new_password}` | **Public** | §3 校验 → 密码策略（v1 §2）→ 写 hash、`must_change_password=false`、清锁定、吊销全部 token、消费令牌；审计 `auth_reset_complete`。失效/过期/已用 → 400 `auth:token.invalid` |
| `POST /auth/users` 增参 `{send_setup_email?, email?}` | `ops.user.manage` | `send_setup_email=true`：免密码，随机 40 位内部口令占位 hash，email 必填；签发 setup 令牌发信；返回 `{...user, setup_email_sent:true}`，审计 `auth_setup_send`。SMTP 未配置 → 400 `auth:mail.notConfigured` |
| `POST /auth/accept-setup` `{token, new_password}` | **Public** | 与 reset-password 同路径（purpose 区分），设密后可直接登录 |

### 4.2 邀请域（`IamController` 挂载，`iam.member.edit`；接受链路 Public）

| 方法与路径 | 权限 | 说明 |
|---|---|---|
| `POST /sa/api/iam/invitations` `{email, role_key}` | `iam.member.edit` | 邮箱已有账号 → 直接建成员（复用 addMember 校验：`project_owner` 仍禁放）+ 通知邮件，返回 `{added:true}`；邮箱未注册 → 限流校验、签发邀请+邮件，返回 `{invited:true}`；已是成员 → 409 `iam:invite.alreadyMember`；SMTP 未配置且未注册 → 400 `auth:mail.notConfigured` |
| `GET /sa/api/iam/invitations` | `iam.member.view` | 当前项目未接受邀请列表（email/role/expires_at/invited_by） |
| `DELETE /sa/api/iam/invitations/:id` | `iam.member.edit` | 撤销（未接受才允许）→ 审计 `auth_invite_revoke` |
| `GET /auth/invite/:token` | **Public** | 返回 `{email, project_name, role_key, expires_at}`（渲染接受页；不消费）；无效 → 404 `auth:token.invalid` |
| `POST /auth/invite/:token/register` `{username, display_name?, password}` | **Public** | 建号（email 绑定邀请信箱、策略校验、created_by=邀请人）+ 建成员（邀请角色）+ 消费；返回 `{ok:true}` 让前端跳登录 |
| `POST /auth/invite/:token/accept` | 登录 | 要求 `user.email === invite.email`（不匹配 403 `iam:invite.emailMismatch`）→ 建成员 + 消费 |

审计：`auth_invite_create` / `auth_invite_accept` / `auth_invite_revoke`（沿用 v1 `AuthAuditService`）。

## 5. 邮件模板（服务端产出内容 → `src/i18n/messages/<语言>.json` 新增 `mail` 命名空间，13 门全量）

| 键 | 插值 | 时机 |
|---|---|---|
| `mail.reset.subject` / `mail.reset.body` | `{{link}}` `{{minutes}}` | 忘记密码 |
| `mail.setup.subject` / `mail.setup.body` | `{{link}}` `{{hours}}` | 管理员建号设密 |
| `mail.invite.subject` / `mail.invite.body` | `{{project}}` `{{role}}` `{{link}}` `{{days}}` `{{inviter}}` | 邀请未注册邮箱 |
| `mail.inviteNotify.subject` / `mail.inviteNotify.body` | `{{project}}` `{{role}}` `{{inviter}}` | 已注册直接入会通知 |

- 渲染：`serverT(recipientLocale, key, params)`，收件人 locale 取 `SaUser.locale`，未注册邀请用平台默认 `zh-CN`。
- 纯文本 body（PRD 非目标：不做 HTML 模板）；角色名走前端式展示键？——邮件属服务端产出，`role` 参数直接传**角色中文键的本地化值**（mail 命名空间内 `mail.roles.<role_key>`）。

## 6. 前端

| 改动 | 位置 |
|---|---|
| 忘记密码页 | `pages/Auth/ForgotPasswordPage.tsx`（公开路由 `/sa/forgot-password`）：单输入框 + 统一提示 |
| 重置/设密页 | `pages/Auth/ResetPasswordPage.tsx`（公开路由 `/sa/reset-password?token=`）：读 token → 新密码表单（≥8）→ 成功跳登录。setup 与 reset 共用（后端 purpose 区分，前端无感） |
| 邀请接受页 | `pages/Auth/InviteAcceptPage.tsx`（公开路由 `/sa/invite/:token`）：三态（未登录注册表单 / 已登录匹配→接受按钮 / 已登录不匹配→提示），PRD §5.5 |
| 登录页 | `LoginPage.tsx` 加「忘记密码」链接（提交未配置时也展示，页内给降级提示） |
| 建号弹窗 | `UsersPage.tsx`：`mail-status` 可用时增加方式单选（发邮件/代设），代设沿用 v1 |
| 成员页邀请 | `pages/Iam/MembersPage.tsx`：添加成员输入框支持邮箱（有 @ 走邀请 API，否则走 v1 下拉语义），加「待接受邀请」表 + 撤销 |
| 服务层 | `auth.service.ts`（forgot/reset/mailStatus/invite 族）、`iam.service.ts`（invitations CRUD） |

前端 i18n：`auth:forgot.*`、`auth:reset.*`、`auth:invite.*`、`auth:users` 增补、`iam:invite.*`，13 门全量。

## 7. 链接拼装

`<base>/sa/reset-password?token=<t>`、`<base>/sa/invite/<token>`。base 取 configuration 现有对外基址（`APP_PUBLIC_BASE_URL` 或同义项，与前端「/sa/ - did you mean」页用的 public base 同一来源）；本地 dev 用 `http://localhost:8181`。

## 8. 兼容与安全

- 令牌永不进日志与审计明文；审计 detail 只存 sha256 前缀。
- `reset/forgot` 恒定响应（先查库再统一返回，时序差不作为防枚举目标；PRD 以文案一致为准）。
- 未配置 SMTP：除 `GET /auth/mail-status` 与降级提示外，其余链路全部前置返回 `auth:mail.notConfigured`，不会产生半吊子令牌。
- 回滚 = 停用 `AUTH_SMTP_*`（降级到 v1）或反向 migration 删两表（不影响存量账号数据）。

## 9. 测试锚点（验收映射）

- `auth-token.service.spec.ts`：签发作废旧令牌、双次消费拒绝、过期拒绝、错误 purpose 拒绝、60s 限流。
- `auth-forgot.spec.ts`：命中用户名/邮箱两路、未命中恒定返回、`identifier_hash` 审计不含明文、SMTP 失败路径（mail service mock）。
- `iam-invite.spec.ts`：已注册直连成员（幂等 409）、未注册签发、撤销后接受 404、邮箱不匹配 403、register 建号即入会、owner 角色禁放。
- 模板：抽测 zh-CN/en-US 渲染含 `{{link}}` 替换。
- mock 边界：PrismaService 全 mock；AuthMailService mock 断言 `to/subject/body`。

---

## 增补 v1.1（2026-09-18）：网页配置存储与生效链路

**模型**（migration `20260918110000_auth_mail_config`）：`SaAuthMailConfig` 单行（`id='singleton'`）：`enabled/host/port/secure/user/from` + `secret_cipher`（仅 SMTP 密码，AES-256-GCM，格式同告警 `channel-crypto`：keyId:iv:tag:ciphertext）+ `updated_by/updated_at`。主密钥复用 `appConfig.alerting.configKey`（`ALERT_CONFIG_KEY`），引入与轮换策略跟告警通道一致。

**配置解析链**：`AuthMailService.effectiveConfig()` → 60 秒内存缓存读 DB → `db.enabled` 用库值（pass 解密；解密失败视为配置损坏并按未配置处理+告警日志）→ 否则回落注入的 env 快照。注入载荷在装配层组装为 `{ env, configKey }`（`auth.module.ts`），服务文件仍不 import configuration（CI 测试环境约束不变）。

**API（`AuthController`，全部 `ops.user.manage`）**：
| `GET /auth/mail-config` | `{enabled, source: db|env|none, host, port, secure, user, from, has_password, updated_by, updated_at}`，永不返回明文密码 |
| `PUT /auth/mail-config` | 全字段；`pass` 不传/空 = 保留；传值时主密钥缺失 → 400 `auth:mail.configKeyMissing`；审计 `auth_mail_config`（仅字段清单） |
| `POST /auth/mail-config/test` `{to}` | 以生效配置发 `mail.test.*` 模板（收件人 locale）→ `{sent}`；失败 502 摘要不含密钥；审计 `auth_mail_test` |

**UI**：UsersPage「邮件通道」卡（状态 Tag + 配置弹窗 + 测试按钮）。`GET /auth/mail-status` 语义不变（按 effectiveConfig）——建号/邀请的显隐自动跟随库内配置。

**i18n**：`auth:mailConfig.*`；服务端 `mail.test.subject/body`（13 门）。
