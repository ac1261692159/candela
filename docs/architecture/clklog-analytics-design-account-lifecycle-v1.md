# 实现方案：账号生命周期 v1（phase: clklog-analytics-account-lifecycle-v1）

> 架构帽。PRD：`docs/product/prd-clklog-analytics-account-lifecycle-v1.md`；调研：`docs/product/research-clklog-analytics-member-lifecycle.md`。
> 本文是账号字段、API 契约、锁定算法、审计动作、i18n 键的 **SSOT**；引用处不另起定义。

---

## 1. 数据模型变更（migration `20260917220000_account_lifecycle_v1`）

`SaUser` 追加 6 列（全部可空/有默认，存量行无感）：

| 列 | 类型 | 说明 |
|----|------|------|
| `email` | `VARCHAR(191) NULL UNIQUE` | 可空唯一；MySQL 多 NULL 不冲突；比较忽略大小写（写入前 `trim().toLowerCase()`） |
| `created_by` | `VARCHAR(64) NULL` | 创建人 username；init-admin/demo-seed 记 `system` |
| `must_change_password` | `BOOLEAN NOT NULL DEFAULT false` | 管理员代设密码置 true；本人改密成功置 false |
| `failed_login_count` | `INT NOT NULL DEFAULT 0` | 连续密码错误计数（内部字段，不进 API） |
| `locked_until` | `DATETIME NULL` | 锁定截止（内部字段） |
| `last_login_at` | `DATETIME NULL` | 最近一次登录成功 |

**不加**重置令牌表：无邮件阶段用「临时密码 + 强制改密」即可满足 PRD §5.4，邮件 phase 再评估令牌表。

实体-资产阻塞关系（删除用户时检查归属为该用户的行数）：`Dashboard.owner`、`Card.owner`、`MetaSavedMetric.owner`、`MetaUserCohort.owner`、`MetaUserTag.owner`、`MetaFunnelTemplate.owner`、`AiWorkspace.user_id`（`SaDashboardFolder` 无 owner 字段，不参与）。级联清理（事务内）：`SaProjectMember`、`SaMemberGroupUser`、`SaUserToken`、`SaAssetAcl (subject_type='user')`。

## 2. 密码策略（`apps/analytics-server/src/modules/auth/password-policy.ts`）

```
assertPasswordPolicy(password, username)  →  违规则 badRequest
```

- `password.length >= 8` → `auth:error.password.tooShort`（params `{min:8}`）
- lowercase 命中 `WEAK_PASSWORDS` 黑名单（模块内常量数组，约 40 条常见口令）→ `auth:error.password.weak`
- lowercase 包含 username → `auth:error.password.containsUsername`

应用点：`createUser`、`changePassword`（含强制改密路径，强制改密复用同一 `PUT /auth/password`）。旧接口语义变更：`{min:6}` → `{min:8}`，前端表单校验同步。

## 3. 登录锁定（`AuthService.login` 改写）

参数：`LOGIN_MAX_ATTEMPTS = 5`、`LOGIN_LOCK_MINUTES = 15`（模块级常量）。

```
user = findByUsername(username)
if (!user || user.status !== 'active')      → 401 invalidCredentials（不计数，防探测）
if (user.locked_until > now)                 → 401 auth.login.locked（params {minutes}），审计 auth_login_locked
if (!verifyPassword(...))                    → 计数+1；达 5 次置 locked_until=now+15min、计数清零；
                                               审计 auth_login_failed（fail_count）；401 invalidCredentials
成功：failed_login_count=0、locked_until=null、last_login_at=now；审计 auth_login_success；签发 token（行为不变）
```

锁定信息对攻击者可观察（账号可探测）是**知情取舍**：本系统为内部平台，账号名录可通过成员目录获得，枚举防护收益低；锁定的爆破阻断收益高。PRD §5.3 为产品权威。

### 客户端 401 语义（2026-09-20 修正）

前端 axios 拦截器只把**带登录态**（请求带 `Authorization`）的 401 当作「会话过期」——清登录态并跳登录页；
登录页自身调 `/auth/login` 得到的 401（凭据错误 / 账号锁定 / 账号禁用）走**普通错误提示**，把服务端
`messageKey`（如 `auth:error.login.locked` 带 `{{minutes}}`）渲染成 toast。判据实现见
`apps/analytics-web/src/services/login-path.ts` 的 `isSessionExpired401`。

修正前的缺陷：所有 401 一律按会话过期处理并 `return`，跳过了提示分支——而登录页的 `catch` 注释写着
「错误已由拦截器提示」，于是**登录失败完全没有任何反馈**（账号被锁也无法察觉）。

## 4. API 契约（全部挂 `AuthController`，基路径 `/sa/api/auth`）

| 方法与路径 | 权限 | 入参 | 行为与返回 |
|---|---|---|---|
| `POST /login` | Public | username, password | §3；user 载荷增加 `email`、`must_change_password` |
| `GET /me` | 登录 | — | 同 login 用户载荷 |
| `PUT /profile` | 登录 | `{display_name?, email?}` | 至少传一字段；email 格式+唯一校验 → 更新本人；返回更新后字段。新错误：`auth:email.invalid`、`auth:email.exists`、`auth:profile.empty` |
| `PUT /password` | 登录 | old_password, new_password | 既有 + 应用 §2 策略 + 成功后 `must_change_password=false`、清计数/锁定 |
| `GET /users` | `ops.user.manage` | — | 增加 `email`/`platform_role`/`status`/`last_login_at`/`created_at`/`created_by` |
| `POST /users` | `ops.user.manage` | username, password, display_name?, email? | §2 策略 + email 校验；写 `created_by=操作者`、`must_change_password=true`；审计 `auth_user_create` |
| `PUT /users/:id` | `ops.user.manage` | `{display_name?, email?, platform_role?}`（至少一项） | 编辑；改自己 `platform_role` → 409 `auth:self.forbidden`；审计 `auth_user_update`（changed_fields） |
| `PUT /users/:id/status` | `ops.user.manage` | status | 既有 + 自我禁用 409 + 审计 `auth_user_status` |
| `POST /users/:id/unlock` | `ops.user.manage` | — | 清计数与锁定 → `{ok:true}`；审计 `auth_user_unlock`；幂等 |
| `POST /users/:id/reset-password` | `ops.user.manage` | — | 自我重置 409；生成临时密码（§5）置 hash + `must_change_password=true`，吊销该用户全部 token；**返回 `{temporary_password}` 仅一次**；审计 `auth_password_reset` |
| `DELETE /users/:id` | `ops.user.manage` | — | 自我删除 409；§1 资产非空 → 409 `auth:user.hasAssets`（detail 返回各类资产计数）；否则事务级联删除；审计 `auth_user_delete` |
| `GET /audit-logs?limit=100` | `ops.user.manage` | — | `ops_action_log` 中 `action LIKE 'auth_%'` 倒序前 N 条（N≤200） |

`AuthUser` 类型扩展：`email: string | null`、`must_change_password: boolean`（token 校验路径从 `saUserToken.include.user` 读出，与既有字段同链路，无额外查询）。

## 5. 临时密码生成

`randomBytes(9)` → base32 风格无歧义字母表（去 `0/o/1/l/i`）取 12 位。只写 hash 入库；明文仅存在于当次响应。管理员经页面弹窗人工转交（PRD：无邮件降级方案）。

## 6. 审计（`modules/auth/auth-audit.service.ts`）

- `record(action, operator, targetUserId?, detail?)` → `opsActionLog.create({action, target_table:'sauser', detail, status:'done', operator})`；失败仅告警日志不阻断主流程（与 `alert-audit.service.ts` 同策略）。
- 动作枚举以 PRD §6 表为权威（`auth_` 前缀）。
- **读取方同步**：`ops/data-mgmt.service.ts` 审计列表过滤由「排除 `alert_` 前缀」改为「排除 `alert_`/`auth_` 前缀」。

## 7. 前端

| 改动 | 位置 |
|---|---|
| 新建「用户管理」页 | `pages/Settings/UsersPage.tsx`：用户表（含搜索）、创建/编辑弹窗、重置密码结果弹窗（临时密码展示一次 + 复制）、禁用/启用、解锁、删除（409 时展示资产计数说明）、审计区（时间倒序表格，可刷新） |
| 路由 + 菜单 | `routes.tsx` 增 `/settings/users`（`page('ops.user.manage', …)`）；`shell-menu.ts` 增 `showUsers = hasPerm(...,'ops.user.manage')`，设置菜单插在 projectOwners 前 |
| 个人设置 | `ProfilePage.tsx` 增「基本资料」卡（显示名 + 邮箱，调 `PUT /auth/profile`）；密码卡提示与校验 ≥8 |
| 强制改密门禁 | `MainLayout` 渲染分支：`user.must_change_password` 时内容区替换为 `ForcedPasswordChange`（复用改密 API；成功 `setUser({...user, must_change_password:false})`），仅保留退出登录；登录页无需改动 |
| store/类型 | `AuthUser` 增 `email`、`must_change_password`（persist version +1，旧缓存补默认值） |
| 服务层 | `services/auth.service.ts` 增 `updateProfile/updateUser/resetUserPassword/unlockUser/deleteUser/listAuditLogs` |

「项目设置 → 项目接入」页既有建号表单保留不删（后端策略升级自动生效），本 phase 不做页面合并。

## 8. i18n 键（新增，13 门语言全量补齐）

命名空间复用 `auth`（不新增命名空间）：

- `auth:users.*`（页面标题、列名、按钮、弹窗、确认、审计列名等约 30 键）
- `auth:profile.basic`（基本资料卡标题/字段/保存反馈）
- `auth:forceChange.*`（标题、说明、提交）
- `auth:error.*` 新增：`email.invalid`、`email.exists`、`profile.empty`、`password.weak`、`password.containsUsername`、`login.locked`（`{{minutes}}`）、`self.forbidden`、`user.hasAssets`、`user.notFound`
- 既有 `profile.newPasswordMin` 文案值由「至少 6 位」改「至少 8 位」（13 语言同步改值）

服务端 `messages/*.json` 本 phase 不动（无服务端产出内容）。

## 9. 兼容 / 回滚 / 迁移

- 迁移全为可空或带默认列，向前兼容；回滚 = 反向 migration 删列（不回滚已写审计行）。
- `init-admin.ts`、demo-seed 增加 `created_by: 'system'`，行为不变。
- 存量前端缓存：auth store persist version 2→3，迁移补 `must_change_password:false`、`email:null`。
- 顺带回写：`docs/architecture/clklog-analytics-design-user-rbac.md` 密码算法 bcrypt → scrypt（消除已登记漂移）。

## 10. 测试锚点（验收映射）

- `password-policy.spec.ts`：长度 / 黑名单 / 含用户名 / 边界（恰 8 位、大小写）。
- `auth-lockout.spec.ts`（mock PrismaService）：5 次失败触发锁定、锁定期内拒绝、到期放行、成功清零、不存在用户不计数。
- `auth-users.spec.ts`：createUser 写入 must_change_password/created_by；reset 流程吊销 token 且标记；自我保护 409；资产阻塞 409；级联删除事务。
- 审计写入：断言 `opsActionLog.create` 的 action 前缀与必传 detail 字段。
