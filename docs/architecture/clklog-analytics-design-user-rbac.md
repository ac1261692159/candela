# 实现方案：用户 / 用户组 / 权限体系（RBAC）— P1

> phase: clklog-analytics-user-rbac
> 版本：v1.0（2026-08-28）｜ 上游：`docs/product/prd-clklog-analytics-user-rbac-v1.md`
> 本文档是认证/鉴权/资产归属的**实现层**权威：数据模型、认证流程、鉴权、API 契约。
>
> **后继**：项目成员、权限码、数据权限注入以 `clklog-analytics-design-rbac-v2.md` 为 SSOT。本文登录 / token / 密码仍然有效。

---

## 1. 阶段目标与范围（门禁要素①）

P1：建立用户体系 + 登录认证（DB token）+ 三角色 + 资产 owner 改造 + 鉴权。用户组/移交/交接为 P2/P3。

## 2. 验收标准（门禁要素②）

以 PRD §2 为准，实现层补充：
- [ ] `SaUser`/`SaUserToken` 模型 + migration 落地。
- [ ] `AuthGuard` 从 `Authorization: Bearer <token>` 解析用户，注入 `CurrentUser`。
- [ ] `DashboardRepository`/`CardRepository`/`SqlReportService` 的查询/写操作增加 `owner_id` 过滤（admin 豁免）。
- [x] 密码用 Node 内置 crypto `scrypt`（salt:hash，timingSafeEqual 校验，`password.util.ts`）哈希，token 用 `crypto.randomBytes` 生成，存库可撤销。（2026-09-17 回写：实现一直是 scrypt，此处此前误写 bcrypt）
- [ ] 默认 admin 初始化（脚本 `init-admin`）。

## 3. 非目标（门禁要素③）

用户组、资产移交、禁用交接、SSO、找回密码、project 维度隔离改造（P3）。

---

## 4. 数据模型

```prisma
enum Role { admin analyst viewer }

model SaUser {
  id            String    @id @default(uuid())
  username      String    @unique
  password_hash String
  display_name  String?
  role          Role      @default(viewer)
  status        String    @default("active")   // active / disabled
  created_at    DateTime  @default(now())
  updated_at    DateTime  @updatedAt

  tokens SaUserToken[]
}

model SaUserToken {
  id         String   @id @default(uuid())
  user_id    String
  token      String   @unique
  expires_at DateTime?
  created_at DateTime @default(now())

  user SaUser @relation(fields: [user_id], references: [id])

  @@index([user_id])
}
```

> migration：`prisma migrate dev --name add_sa_user`。

---

## 5. 认证流程

```
POST /sa/api/auth/login  { username, password }
  → 查 SaUser（status=active）
  → verifyPassword(password, password_hash)（scrypt + timingSafeEqual）
  → 生成 token = crypto.randomBytes(32).toString('hex')
  → 存 SaUserToken（expires_at = now + 7d）
  → 返回 { token, user: { id, username, display_name, role } }
```

- token 放 `Authorization: Bearer <token>` header。
- 登出：删除对应 SaUserToken（可撤销）。
- P1 不做刷新机制，token 有效期 7 天，过期需重新登录。

---

## 6. 鉴权

### 6.1 AuthGuard（全局或按需）

- 从 header 解析 token → 查 SaUserToken（含 user）→ 校验未过期 → 注入 `req.user`。
- 未认证 → 401。

### 6.2 CurrentUser 装饰器

- `@CurrentUser()` 返回 `{ id, username, role }`（与现有 `@CurrentProject()` 并行）。

### 6.3 资产归属校验（核心）

- 资产查询：`where: { owner: { in: [userId, ...] } }`（admin 不加过滤）。
- 资产写操作：先查资产 `owner == userId`，否则 403。
- 现有 `owner` 字段（Dashboard.owner/SqlReport.owner）语义从「project 名」改为「用户 id」。

> 注意：P1 中 `owner` 字段直接复用，不新增 `owner_type`（P2 加用户组时再引入 owner_type）。

---

## 7. 资产接口改造点（P1 范围）

| 模块 | 接口 | 改造 |
|------|------|------|
| Dashboard | list/create/update/delete/detail | list 按 owner 过滤；写操作校验 owner |
| Card | list/create/update/delete/reorder/refresh | 经 Dashboard owner 校验（卡片归属看板） |
| SqlReport | save/list/get/remove | list 按 owner 过滤；写操作校验 owner |
| 埋点/事件分析/漏斗/数据质量 | 查询类 | 三角色均可（鉴权后统一走 AuthGuard） |
| 保存卡片（一键存） | createCard | analyst+ 才能写 |

---

## 8. API 契约

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/sa/api/auth/login` | 登录，返回 token + user |
| POST | `/sa/api/auth/logout` | 登出（撤销 token） |
| GET | `/sa/api/auth/me` | 当前用户信息 |
| GET | `/sa/api/users` | 用户列表（admin） |
| POST | `/sa/api/users` | 创建用户（admin） |
| PUT | `/sa/api/users/:id` | 更新用户（admin） |
| POST | `/sa/api/users/:id/disable` | 禁用用户（admin） |

响应统一 `{ code, message, data }`。

---

## 9. 前端改造

- 新增 `LoginPage`（登录页）+ 路由 `/login`。
- `api.ts` 请求拦截器：从 `authStore` 取 token，加 `Authorization: Bearer`。
- 响应拦截器：401 → 清 token → 跳 `/login`。
- 新增 `auth.store.ts`（token + user 持久化 localStorage）。
- 资产列表显示「归属人」（list 接口返回 owner 信息）。
- 路由守卫：未登录访问受保护路由 → 跳登录。

---

## 10. 初始 admin 引导

- 脚本 `src/scripts/init-admin.ts`：无用户时创建 `admin`（密码从环境变量 `ADMIN_INIT_PASSWORD` 读，scrypt 哈希）。
- 部署时执行一次。
- 历史资产回填脚本 `src/scripts/backfill-asset-owner.ts`：把改造前 `owner=project 名` 的看板/报表回填为 admin 用户 id（**必须执行**，否则历史资产因 owner 不匹配任何用户 id 而无法查询）。部署顺序：migrate → init-admin → backfill-asset-owner。

---

## 11. 风险与回归

- **鉴权接入范围大**：所有现有接口需接入 AuthGuard，否则 401 导致功能不可用。分步接入：先全局 AuthGuard 豁免 `/auth/*`，再逐模块接入 owner 校验。
- **迁移成本**：现有资产 `owner` 是 project 名（`clklogapp`），改造后需把历史资产的 `owner` 回填为默认 admin 用户 id（数据迁移）。
- **社区版隔离**：不改 `clklog`（社区版）用户体系，独立建 `sa_user`。

---

## 12. 实施顺序

1. SaUser/SaUserToken 模型 + migration + init-admin 脚本。
2. AuthModule（login/logout/me + AuthGuard + CurrentUser）。
3. 资产接口接入 owner 校验（dashboard/card/sql）。
4. 历史资产 owner 回填迁移。
5. 前端登录页 + token 拦截器 + 路由守卫 + 归属展示。
6. 单测 + 文档 + 部署验证。
