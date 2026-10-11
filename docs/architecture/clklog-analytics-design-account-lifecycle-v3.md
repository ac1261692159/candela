# 实现方案：账号生命周期 v3（phase: clklog-analytics-account-lifecycle-v3）

> 架构帽。PRD：`prd-clklog-analytics-account-lifecycle-v3.md`。本文是有效期语义、会话端点、接口契约的 SSOT。

---

## 1. 数据模型（migration `20260918120000_account_lifecycle_v3`）

`SaProjectMember` 追加一列：`expires_at DateTime?`（NULL = 永久）。无其他表变更。

## 2. 有效期生效点（权限解析过滤）

既有读取 `saProjectMember` 的**授权路径**统一追加活着的过滤：
`AND: { OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] }`

落点（`iam.service.ts`/`asset-policy.service.ts`）：
- 构建用户-项目上下文（`me()`/guard 成员判定）；
- 有效角色并集计算（`maxRole` 的 membership 来源）；
- owner 判定（owner 本来不可设期，但过滤一致无害）；
- AssetPolicy 成员资格判定。
**`listMembers` 不过滤**：管理视图需要看到已到期行（前端标「已到期」并给续约/删除）；返回值增 `expires_at` 与 `expired` 布尔。
**组关系不过期**：`SaMemberGroupUser` 不设字段，直接随行删除（PRD §4 非目标）。

## 3. API 契约

### 3.1 成员有效期（`IamController`）

| 端点 | 权限 | 语义 |
|---|---|---|
| `PATCH /iam/members/:id` 增参 `expires_at?: string \| null` | `iam.member.edit` | 设置/改/清（null=永久）；目标行 role=project_owner → 400 `iam:member.expiryOwnerForbidden`；审计 `auth_member_expiry` |
| `POST /iam/members` 增参 `expires_at?: string` | `iam.member.edit` | 带期添加（v2 既有字段不变） |
| `POST /iam/invitations` 增参 `member_expires_at?: string` | `iam.member.edit` | 邀请接受/注册落地时写入成员行；直连分支立即写入；审计 detail 增 `member_expires_at` |
| 接受邀请链路 | — | register/accept 建成员时写入 `invite.member_expires_at`（`SaInvitation` 加同名列，同批 migration） |

### 3.2 会话管理（`AuthController`）

| 端点 | 权限 | 语义 |
|---|---|---|
| `GET /auth/sessions` | 登录 | 本人会话列表 `[{id, created_at, expires_at, current}]`，按创建时间倒序 |
| `DELETE /auth/sessions/:id` | 登录 | 吊销本人指定会话；不可吊销当前会话 → 409 `auth:session.revokeCurrent` |
| `DELETE /auth/sessions` | 登录 | 吊销除当前外全部会话（同改密副作用）|
| `GET /auth/users/:id/sessions` | `ops.user.manage` | 管理员看任意用户会话（无 current 标记） |
| `DELETE /auth/users/:id/sessions/:sid` | `ops.user.manage` | 吊销；目标即操作者当前会话 → 409；审计 `auth_session_revoke`（detail 只含 token 哈希前缀） |

### 3.3 休眠口径（产品 §5.3）

`listUsers` 返回值增 `last_login_at`（v1 已有）+ 前端按口径打标，**后端不加字段**（口径是展示逻辑，SSOT 留在 PRD）。

## 4. 前端

| 改动 | 位置 |
|---|---|
| 成员页 | 列表加「有效期」列（永久/N 天后到期/已到期 tag）；添加成员与角色下拉同行增 DatePicker（可清除）；到期行操作加「续约」（弹日期）与移除；邀请表单同加 |
| 用户管理 | 「会话」按钮（行内抽屉：管理员视角列表+吊销/全部登出）；休眠 Tag |
| 个人设置 | 「登录设备」卡：本设备置顶 Tag、逐条登出、退出全部其他设备 |

i18n：`auth:users.sessions*`、`auth:users.dormant`、`auth:error.session.*`、`auth:error.member.*`、`iam:member.expiry*`/`iam:invite.expiryLabel`，13 门全量。

## 5. 兼容与回滚

- 增量可空列，无存量影响；回滚 = 反向 migration 删列（不影响其他字段）。
- 过期语义只在权限读取点生效，不影响列表能力与既有 API 形状（新增可选参数）。

## 6. 测试锚点

- `iam-expiry.spec.ts`：到期行不计入 maxRole/member 判定、owner 禁设、续约可恢复、邀请带期落地、直连分支写期。
- `auth-sessions.spec.ts`：本人不可吊销当前、管理员吊销越权拒绝（非超管）、批量吊销留当前、审计 detail 无 token 明文。


---

## 增补 v3.1（2026-09-18）：UX 缝合的接口与归属

- `GET /sa/api/iam/users/:id/footprint`（`ops.user.manage`，IamController）→ `{memberships:[{project_name, role_key, expires_at, expired}], groups:[{project_name, group_name, role_key}]}`。审计表与权限模型不变。
- `GET /sa/api/auth/audit-logs` 增 `project` 参数：权限改为 `ops.user.manage` **或** `iam.member.view`；服务端查近 200 条后按 `detail.project` 过滤（JSON 字段不入 SQL 条件）。
- 建号并入会 = **前端顺序两调**（createLoginUser → addMember），不单开事务端点：保持 auth 域不读 iam 表（C.10），失败语义在 PRD UX-2。
- demo 填充仅前端搬家：后端 `POST /iam/demo-seed` 不动。


---

## 增补 v3.2（2026-09-18）：契约细节

- assign 角色集合以 `PRD` 为准；前端 bug 根因：`UsersPage` 硬编码了三角色数组。
- 邀请式建号 = 复用 `POST /iam/invitations`（带 `member_expires_at` 亦可）；`username`/`password` 前端字段在 invite 模式不参与提交（服务端无此两字段概念，受邀人自选）。
- 告警回落实现点：`alerting/channels/registry/channel-registry.ts` 的 email settings 组装多处共用一处 resolver——整合为 `resolveEmailSettings(smtpSettings)`，递归降级按 §增补顺序；平台来源经 `AuthMailService.effectiveConfig()`（AlertingModule 引入 AuthModule，DI 单向不环）。

---

## 增补 v3.2 修订（2026-10-09）：平台邮件通道进入可用性判定

v3.2 的回落只覆盖**发送侧**（`buildEmailFallback` 第三级），可用性判定与通道列表未同步，导致「能发但建不出联系人」。本次把手否合一。

- **单一判定源**：`AlertChannelConfigService` 新增私有 `platformSmtp(): Promise<SmtpSettings | null>`（读 `AuthMailService.effectiveConfig()`，命中条件 `enabled && host && from`，失败/抛错一律 `null`）。它同时供两处使用：① 构造时 `bindPlatformSmtpResolver(() => this.platformSmtp())`（发送侧回落，行为不变）；② `capabilities()` 与 `list()` 的 email/smtp 判定。
- `capabilities()`：`email`（`requiredConfig: ['smtp']`）在告警侧 `readConfig('smtp')` 未启用时再问一次平台邮件通道；命中则 `available = true`、`reason = null`，并下发 `platform_fallback = true`。其他通道（短信等）不参与此回落。
- `list()`：`smtp` 项在告警侧未启用（无库内行且无 `ALERT_SMTP_*`，或库内行 `enabled = false`）但平台可用时下发 `platform_fallback = true`。**`enabled` 语义不变**——仍表示「告警侧自身配置是否启用」，开关状态与库内行不被本次改动影响。
- **契约（加法式，老前端忽略新字段）**：`ChannelCapability` 与 `ChannelConfigItem` 各增 `platform_fallback: boolean`；判定条件与发送侧回落的 `smtpReady` 口径一致，禁止出现「显示可用却发不出去」。
- 前端：通道配置页用蓝色 Tag「平台邮件通道」替代该场景下的「未启用」，展开区与联系人表单各给一处说明（文案键 `alerting:channel.platformFallbackTag` / `alerting:channel.platformFallbackNote`）。
