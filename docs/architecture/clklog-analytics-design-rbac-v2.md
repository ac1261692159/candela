# 实现方案：项目空间权限（RBAC v2）

> phase: clklog-analytics-rbac-v2
> 上游：`docs/product/prd-clklog-analytics-rbac-v2.md`
> 本文是权限码、数据模型、鉴权算法、API、查询注入的 SSOT。P1 文档 `clklog-analytics-design-user-rbac.md` 只保留登录/token/密码；项目授权以本文为准。

---

## 1. 阶段目标与范围

落地 PRD：平台超管与项目成员拆开；预置五角色 + 权限目录；成员组；数据权限注入全部读路径；角色管理页按目录渲染三列表；看板两层文件夹（顶栏视图切换，无左侧文件夹栏）；资产锁定与编辑授权（互斥）走统一 `AssetPolicy`；超管可登记分析项目并按项目指定 owner。

包边界：新建 `apps/analytics-server/src/modules/iam/`（成员、组、角色授权、数据策略、鉴权求值、AssetPolicy、项目登记）。文件夹 CRUD 可落 `modules/report/` 但 **写权限只问 iam**，禁止 report 自己判断角色。不把逻辑堆进 `modules/auth/`。不扩大 `src/common/`：`rbac.util.ts` 改为调用 iam，或迁入 iam 后留薄封装（只减不增）。Web：`pages/Iam/` + 改造 `DashboardListPage` 为顶栏切换的文件夹/列表视图；设置页「项目设置」。

---

## 2. 验收标准

对应 PRD RB-1～RB-13。实现层补充：

- [ ] 单测：求值（直接角色 + 组并集/数据交集）、每项目至多一个 owner、非超管指定 owner 失败、分析师打埋点写接口 403、数据权限注入事件 SQL 含白名单与行过滤。
- [ ] AssetPolicy：锁定与编辑授权互斥 409；文件夹授权 + 子看板锁定 → 被授权人不能改；分析师删自己未锁定草稿成功、删锁定/他人失败；锁看板不阻止改卡片，除非卡片自身锁定。
- [ ] 文件夹深度 >2 拒绝；删非空文件夹 409；历史看板 `folder_id` null；PATCH 文件夹 `parent_id` 可转移路径（不能移入自己、含子文件夹时不能再嵌一层）。
- [ ] `SaProject` 登记分析空间；`POST /iam/ops/projects` 校验 `project_name` `/^[a-z][a-z0-9_]{1,62}$/`；不写 ClickHouse。选择器 `GET /iam/projects` 只返回当前用户能进的项目（超管全部）。
- [ ] 事件 / 漏斗 / 留存 / SQL 守卫 / 看板 refresh 五条路径都走同一 `DataScope`，禁止各模块自己滤。
- [ ] `python3 scripts/arch_ratchet.py` 通过；`modules/iam` 新包不超过目录上限。
- [ ] 迁移：P1 `admin` → `platform_role=super_admin` + `clklogapp` 的 `project_owner`。

---

## 3. 非目标

与 PRD §3 相同。自定义角色表可建列但不暴露 API。运维台只有权限码占位，无新页面。公开链接不做。

---

## 4. 身份与权限码

### 4.1 平台帽子

`SaUser.platform_role`：`super_admin` | `none`（默认 `none`）。

删除作为授权源的 `SaUser.role`（`admin/analyst/viewer`）。迁移见 §10。`AuthUser` 增加 `platform_role`；项目角色不进 JWT/token 行，每次请求按当前 `project_name` 求值。

### 4.2 项目角色

稳定 key（存库、比较用这个，UI 文案另表）：

| key | 显示名 | 宽度序 |
|-----|--------|--------|
| `project_owner` | 项目 owner | 50 |
| `analysis_admin` | 分析管理员 | 40 |
| `analyst` | 分析师 | 30 |
| `member` | 普通成员 | 20 |
| `external` | 外部人员 | 10 |

宽度序只用于「功能取最宽」。owner 不能由组授予。

### 4.3 权限码

格式 `域.资源.动作`。目录是代码常量（`iam/permission-catalog.ts`），角色管理页的「功能 / 操作权限 / 功能明细」全部由此生成，禁止前端另写一份。

> **口径修订（phase: clklog-analytics-rbac-v3）**：`meta.view` 收回分析师档（治理面归 owner / 分析管理员），新增只读码 `meta.picker.view` 供分析选择器使用；`metric.edit_own` 的归属判定见该文档 §6。本表已按修订后的结果同步，修订理由与验收标准见 `clklog-analytics-design-rbac-v3.md`。
>
> **口径修订（phase: clklog-analytics-rbac-v4）**：`iam.member.view` 放开到五个项目角色（项目权限域只读，含角色说明与数据权限策略明细）；邀请队列与权限审计流水收紧到 `iam.member.edit`。见 `clklog-analytics-design-rbac-v4.md`。

| code | 功能（表头） | 操作权限 | 功能明细（PRD §6 句子） | 默认 owner | 默认 analysis_admin | 默认 analyst | 默认 member | 默认 external |
|------|-------------|----------|-------------------------|:----------:|:-------------------:|:------------:|:-----------:|:-------------:|
| `iam.member.view` | 项目权限管理 | 查看 | 查看本项目成员、成员组、角色说明、数据权限策略 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `iam.member.edit` | 项目权限管理 | 编辑 | 添加/移除成员与组；分配非 owner 角色 | ✓ | ✓ | | | |
| `iam.role.edit_admin` | 项目权限管理 | 编辑 | 编辑本项目「分析管理员」授权定义 | ✓ | | | | |
| `iam.data_policy.manage` | 数据权限 | 管理 | 新建、编辑、删除策略并赋给成员或组 | ✓ | ✓ | | | |
| `ops.user.manage` | 运维 · 账号 | 管理 | 新建、禁用、启用登录账号 | 超管 | | | | |
| `ops.owner.assign` | 运维 · 项目 owner | 管理 | 指定或替换项目唯一 owner | 超管 | | | | |
| `ops.apikey.manage` | 运维 · API Key | 管理 | 查看、创建、撤销 Key | 超管 | | | | |
| `ops.ai_workspace.manage` | 运维 · AI Workspace | 管理 | 模板与同步 | 超管 | | | | |
| `ops.runtime.access` | 运维 · 后续运维管理 | 管理 | 占位，本期无路由 | 超管 | | | | |
| `subject.view` | 分析主体 | 查看 | 在分析中切换已有主体 | ✓ | ✓ | ✓ | | |
| `subject.edit` | 分析主体 | 功能使用 | 查看并编辑本项目分析主体 | ✓ | ✓ | | | |
| `cohort.view` | 用户分群管理 | 查看 | 查看分群列表与成员预览 | ✓ | ✓ | ✓ | | |
| `cohort.edit_own` | 用户分群管理 | 编辑 | 新增、编辑、删除自己的分群 | ✓ | ✓ | ✓ | | |
| `cohort.edit_others` | 用户分群管理 | 编辑 | 编辑、删除他人的分群 | ✓ | ✓ | | | |
| `tag.view` | 用户标签管理 | 查看 | 查看标签列表与成员预览 | ✓ | ✓ | ✓ | | |
| `tag.edit_own` | 用户标签管理 | 编辑 | 新增、编辑、删除自己的标签 | ✓ | ✓ | ✓ | | |
| `tag.edit_others` | 用户标签管理 | 编辑 | 编辑、删除他人的标签 | ✓ | ✓ | | | |
| `meta.view` | 埋点 / 元数据 | 查看 | 查看事件、属性、虚拟对象、指标、Debug、数据质量 | ✓ | ✓ | | | |
| `meta.picker.view` | 埋点 / 元数据 | 查看 | 分析选择器读取已启用的事件、属性与维度表字段（只读） | ✓ | ✓ | ✓ | | |
| `meta.edit` | 埋点 / 元数据 | 编辑 | 编辑定义、确认/隐藏、Debug | ✓ | ✓ | | | |
| `model.query` | 模型使用 | 功能使用 | 事件 / 漏斗 / 留存查询 | ✓ | ✓ | ✓ | | |
| `model.sql` | 模型使用 | 功能使用 | 自定义 SQL | ✓ | ✓ | ✓ | | |
| `model.card_save` | 模型使用 | 功能使用 | 保存卡片 | ✓ | ✓ | ✓ | | |
| `model.export` | 模型使用 | 功能使用 | 导出已呈现的查询或看板数据 | ✓ | ✓ | ✓ | | ✓ |
| `dashboard.view` | 看板使用 | 查看 | 查看可访问看板及设置 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `dashboard.view_all` | 看板使用 | 查看 | 查看本项目全部看板 | ✓ | ✓ | ✓ | ✓ | |
| `dashboard.edit` | 看板使用 | 编辑 | 新建看板；尝试编辑（最终以 AssetPolicy 为准） | ✓ | ✓ | ✓ | | |
| `dashboard.filter` | 看板使用 | 查看 | 临时调整看板筛选 | ✓ | ✓ | ✓ | ✓ | |
| `dashboard.folder.manage` | 看板使用 | 编辑 | 新建/重命名/删除文件夹 | ✓ | ✓ | | | |
| `asset.lock` | 看板使用 | 编辑 | 锁定/解锁文件夹、看板、卡片、分群、标签 | ✓ | ✓ | | | |
| `asset.grant` | 看板使用 | 编辑 | 授予或撤回看板/卡片/文件夹的编辑权与外部查看 | ✓ | ✓ | | | |
| `metric.view` | 指标管理 | 查看 | 查看已保存指标 | ✓ | ✓ | ✓ | | |
| `metric.edit_own` | 指标管理 | 编辑 | 新建、编辑、删除自己的指标 | ✓ | ✓ | ✓ | | |
| `metric.edit_others` | 指标管理 | 编辑 | 编辑、删除他人的指标 | ✓ | ✓ | | | |

超管列不进项目角色表；`ops.*` 只看 `platform_role`。`dashboard.view_all` 给普通成员是为了 PRD §7「项目内已开放看板」的私有化默认；外部人员没有此码，只靠 `SaAssetAcl.perm=view`。

`dashboard.edit` 对分析师只表示「可以创建、可以进入写接口」；**改谁的、能不能删**由 §6.1 AssetPolicy 决定，禁止再用 `isAdmin()` 或「有 dashboard.edit 就能改所有看板」。

分析管理员默认码 = owner 的项目码减去 `iam.role.edit_admin`。owner 可在本项目覆盖分析管理员集合（只减不增：不能把 `ops.*` 或 `iam.role.edit_admin` 授给管理员）。

---

## 5. 数据模型

```prisma
model SaUser {
  id              String   @id @default(uuid())
  username        String   @unique
  password_hash   String
  display_name    String?
  platform_role   String   @default("none") // super_admin | none
  status          String   @default("active")
  default_project String?
  created_at      DateTime @default(now())
  updated_at      DateTime @updatedAt
  tokens          SaUserToken[]
  memberships     SaProjectMember[]
  group_users     SaMemberGroupUser[]
}

model SaProject {
  name         String   @id @db.VarChar(64) // 即 project_name，/^[a-z][a-z0-9_]{1,62}$/
  display_name String
  created_at   DateTime @default(now())
  updated_at   DateTime @updatedAt
}

model SaProjectMember {
  id             String   @id @default(uuid())
  project_name   String
  user_id        String
  role_key       String   // 见 §4.2
  data_policy_id String?
  created_at     DateTime @default(now())
  updated_at     DateTime @updatedAt
  user           SaUser   @relation(fields: [user_id], references: [id])
  data_policy    SaDataPolicy? @relation(fields: [data_policy_id], references: [id])

  @@unique([project_name, user_id])
  @@index([project_name, role_key])
}

model SaMemberGroup {
  id             String   @id @default(uuid())
  project_name   String
  name           String
  role_key       String   // 禁止 project_owner
  data_policy_id String?
  created_at     DateTime @default(now())
  updated_at     DateTime @updatedAt
  users          SaMemberGroupUser[]
  data_policy    SaDataPolicy? @relation(fields: [data_policy_id], references: [id])

  @@unique([project_name, name])
}

model SaMemberGroupUser {
  group_id String
  user_id  String
  group    SaMemberGroup @relation(fields: [group_id], references: [id], onDelete: Cascade)
  user     SaUser        @relation(fields: [user_id], references: [id])
  @@id([group_id, user_id])
}

model SaRoleGrant {
  id           String @id @default(uuid())
  project_name String
  role_key     String // 本期仅允许 analysis_admin
  grants_json  String @db.Text // string[] 权限码，必须 ⊆ owner 项目码且不含 ops.* / iam.role.edit_admin
  updated_by   String
  updated_at   DateTime @updatedAt
  @@unique([project_name, role_key])
}

model SaDataPolicy {
  id           String @id @default(uuid())
  project_name String
  name         String
  definition_json String @db.Text
  created_at   DateTime @default(now())
  updated_at   DateTime @updatedAt
  members      SaProjectMember[]
  groups       SaMemberGroup[]
  @@unique([project_name, name])
}

model SaAssetAcl {
  id           String @id @default(uuid())
  project_name String
  asset_type   String // folder | dashboard | card
  asset_id     String
  subject_type String // user | group
  subject_id   String
  perm         String // view | edit
  created_at   DateTime @default(now())

  @@unique([asset_type, asset_id, subject_type, subject_id, perm])
  @@index([project_name, asset_type, asset_id])
}

model SaDashboardFolder {
  folder_id    String  @id // fold_ + nanoid(10)
  project_name String
  name         String
  parent_id    String? // 仅允许一层子文件夹；parent 的 parent_id 必须为 null
  locked       Boolean @default(false)
  sort_order   Int     @default(0)
  created_at   DateTime @default(now())
  updated_at   DateTime @updatedAt
  parent       SaDashboardFolder?  @relation("FolderTree", fields: [parent_id], references: [folder_id])
  children     SaDashboardFolder[] @relation("FolderTree")
  dashboards   Dashboard[]

  @@index([project_name, parent_id])
  @@unique([project_name, parent_id, name])
}
```

对现有表加列（migration，不改社区版）：

- `Dashboard.folder_id` 可空（null = 未分组）；`Dashboard.locked Boolean @default(false)`；`Dashboard.visibility`：`project` | `restricted`（外部人员永远只看 acl view）。
- `Card.locked Boolean @default(false)`。
- `MetaUserCohort.locked`、`MetaUserTag.locked` 同样默认 false。

**不要**再建 `SaDashboardShare`。外部查看 = `SaAssetAcl` 且 `perm=view`（`asset_type=dashboard`）。编辑授权 = 同表 `perm=edit`。

**项目登记**：分析空间名存在 `SaProject`，与 ClkLog 社区版项目表、ClickHouse 库无关。创建项目 = 插入登记行 + 指定 owner（写 `SaProjectMember`）。查询仍按 `project_name` 过滤已有事件；没有数据就是空报表，不建 CK 库。

**每项目一个 owner**：不靠部分唯一索引（MySQL 对 `role_key='project_owner'` 部分唯一不友好）。在 `IamService.assignOwner` 事务里：先把该项目旧 owner 降为 `analysis_admin`（若存在），再 upsert 新 owner。并发用项目行锁或 `SELECT … FOR UPDATE` 成员表该项目 owner 行。

`SaDataPolicy.definition_json`：

```json
{
  "events": { "mode": "all" | "allow", "keys": ["AppLaunch"] },
  "event_properties": { "mode": "all" | "allow", "keys": ["$country"] },
  "user_properties": { "mode": "all" | "allow", "keys": ["channel"] },
  "row_filter": { "rel": "and", "children": [ { "prop": "channel", "op": "=", "value": "app" } ] }
}
```

`row_filter` 复用现有用户属性 Filter 节点，只允许 `prop` 来自用户属性。虚拟事件在 `events.keys` 里用 `ve_id`。

MySQL 对 `parent_id` 为 null 的 UNIQUE 不保证根文件夹名唯一：根节点把 `parent_id` 存空字符串 `''`，或应用层在写入前查重。深度校验：创建/移动时若 `parent.parent_id` 非空则 400。

---

## 6. 求值

请求进入业务前：`AuthGuard` 先注入用户，再跑 `IamGuard`（三个 `APP_GUARD` 只登记在 `app.module.ts`，禁止放进会被 Query/Report 先 import 的 `IamModule`，否则 `CurrentIam` 为空、卡片等接口 500）。`IamGuard` / `ProjectInterceptor` 读 `x-project-name`（其次 `?project=` / body.project；值为数组时取第一项）；缺省项目名为 `clklogapp`（不要落到无成员的 `default`）。`IamService.evaluate(userId, projectName)` 返回：

```ts
type IamContext = {
  platform_role: 'super_admin' | 'none';
  member: boolean;
  role_key: 'project_owner' | 'analysis_admin' | 'analyst' | 'member' | 'external' | null;
  permissions: Set<string>;
  data_scope: DataScope; // events/props 白名单；row_filter AST；unrestricted: boolean
};
```

算法：

1. 读 `platform_role`。`ops.*` 仅 `super_admin` 拥有，与项目无关。
2. 读直接成员。无成员且非超管 → `member=false`，`permissions` 仅可能含 `ops.*`；业务接口 403。
3. 超管无成员：`permissions = ops.*`，`data_scope.unrestricted=false` 且不允许分析查询。
4. 直接 `role_key` 的默认码 ∪ 其作为组员的各组 `role_key` 默认码（组禁止 owner）。取宽度序最大者作为展示角色；权限集合取并。
5. 若最大角色是 `analysis_admin` 且存在 `SaRoleGrant`：用 grant 集合替换默认管理员码（仍校验 ⊆ 允许集）。
6. owner 或超管且 `role_key=project_owner`：`data_scope.unrestricted=true`。
7. 否则收集直接策略 + 各组策略。`mode=all` 与 `allow` 交集：`all ∩ allow = allow`；`allow ∩ allow = keys 交集`；任一侧空 allow 列表 = 无事件可读。`row_filter` 全部 AND。无策略 = 全可见（仍有 project_name）。

`RequirePermission('meta.edit')` Guard：不在 set 则 403。看板/卡片/分群/标签的写删除 **禁止** 只看 `edit_own`/`edit_others`，一律走 §6.1。

菜单：前端 `GET /sa/api/iam/me?project=` 返回 `permissions[]` + `role_key` + `platform_role`；菜单配置声明所需码，缺码则不渲染。

### 6.1 AssetPolicy（写路径唯一入口）

`AssetPolicy.assert(user, action, asset)`。`action` = `update` | `delete` | `lock` | `grant`。`asset` 含 type、id、owner_id、locked、folder 链（看板才有）。

`isProjectAdmin` = `role_key` 为 `project_owner` 或 `analysis_admin`。

**有效锁定** `effectivelyLocked`：

- 卡片 / 分群 / 标签：自身 `locked`。
- 看板：自身 `locked` **或** 所在文件夹 `locked` **或** 父文件夹 `locked`。
- 文件夹：自身或父文件夹 `locked`。
- 未分组看板：只看看板自身 `locked`。

**有效编辑授权** `hasEditGrant`（仅 folder/dashboard/card）：

- 直接 `SaAssetAcl` `perm=edit` 命中当前用户或其所在组。
- 看板额外继承：所在文件夹及其父文件夹的 `perm=edit`。
- **不**继承到卡片。分群/标签无授权。
- 授权对象写入时校验：目标用户本项目 `role_key=analyst`，或组的 `role_key=analyst`。其它角色 400。

求值：

1. `lock` / `grant`：无 `asset.lock` / `asset.grant` 则 403。另：
   - 加锁：若本对象或其子孙（文件夹）仍有 `perm=edit` 的 acl → **409**「先撤回编辑授权再锁定」。
   - 授权 edit：若 `effectivelyLocked` → **409**「先解锁再授权」。
2. `update`：`isProjectAdmin` → 允许（不被锁挡住）。否则若 `effectivelyLocked` → 403。否则：创建人，或 `hasEditGrant`（且资产类型支持授权）→ 允许。否则 403。
3. `delete`：`isProjectAdmin` → 允许（锁定也允许，产品层二次确认）。否则仅当创建人且 **未** `effectivelyLocked` 且不是「仅靠授权」→ 允许。有授权无创建人身份 → 403。
4. 子看板 `locked=true` 时，即使父文件夹有 edit grant，第 2 步 `effectivelyLocked` 为真，被授权人不能改。

加锁/授权的写操作本身也走本函数，避免绕过。

列表印记字段由 list API 计算：`locked`、`grant_count`（仅 admin）、`can_edit`（当前用户 update 是否通过、且非 admin 时用于「可编辑」印记）。

---

## 7. 数据权限注入

唯一入口：`DataScopeService.applyToEventsQuery(scope, { project })`。

- 事件白名单：DSL 所选事件必须 ⊆ allow；SQL 生成在事件条件下加 `event IN (...)`。虚拟事件先展开再检查。
- 属性白名单：选择器 API 过滤；SQL SELECT/WHERE 引用未授权属性 → 拒绝。
- 行过滤：转成与全局用户属性筛选相同的谓词，AND 进查询。ClickHouse 有界：已有 `project_name` + 时间 + LIMIT/超时不变。
- SQL 卡：走现有 `additional_table_filters`，追加 scope 谓词，不包 `SELECT *`。
- `unrestricted` 跳过注入。
- 分群物化：compute worker 传入创建者 `userId` 求值后的 scope。

禁止在 `event-sql-generator` 里复制一份白名单逻辑。

---

## 8. API

前缀 `/sa/api/iam`。除标注外需项目成员 + 对码。响应 `{ code, message, data }`。

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/me` | 登录 | 当前项目求值结果（给菜单） |
| GET | `/catalog` | `iam.member.view` | 权限目录 + 预置角色默认表 + 本项目管理员覆盖 |
| GET | `/members` | `iam.member.view` | 成员列表 |
| POST | `/members` | `iam.member.edit` | `{ user_id, role_key, data_policy_id? }`；`role_key≠project_owner` |
| PATCH | `/members/:id` | `iam.member.edit` | 改角色/策略；不能把别人改成 owner |
| DELETE | `/members/:id` | `iam.member.edit` | 不能删唯一 owner |
| GET | `/groups` | `iam.member.view` | |
| POST | `/groups` | `iam.member.edit` | |
| PATCH | `/groups/:id` | `iam.member.edit` | |
| POST | `/groups/:id/users` | `iam.member.edit` | 用户必须已是项目成员 |
| DELETE | `/groups/:id/users/:userId` | `iam.member.edit` | |
| PUT | `/roles/analysis_admin` | `iam.role.edit_admin` | `{ grants: string[] }` |
| GET | `/data-policies` | `iam.member.view` | |
| POST | `/data-policies` | `iam.data_policy.manage` | |
| PATCH | `/data-policies/:id` | `iam.data_policy.manage` | |
| DELETE | `/data-policies/:id` | `iam.data_policy.manage` | 仍被引用则 409 |
| PUT | `/ops/owners/:project` | `ops.owner.assign` | `{ user_id }` 超管；可把超管自己设为 owner |
| GET | `/projects` | 登录 | 当前用户能进的项目（超管全部）；给选择器 |
| GET | `/ops/projects` | `ops.owner.assign` | 全部登记项目 + 各项目 owner |
| POST | `/ops/projects` | `ops.owner.assign` | `{ name, display_name, owner_user_id }` 新建并指定 owner |
| POST | `/sa/api/auth/users` 等 | `ops.user.manage` | 原 admin 用户 API 改绑此码 |
| GET/POST API Key | 现路径 | `ops.apikey.manage` | |
| `/sa/api/admin/ai/*` | 现路径 | `ops.ai_workspace.manage` | |

看板与文件夹（前缀 `/sa/api/report`，写操作先 `AssetPolicy`）：

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/folders` | `dashboard.view` | 树（含未分组虚拟节点的看板计数） |
| POST | `/folders` | `dashboard.folder.manage` | `{ name, parent_id? }` 深度校验 |
| PATCH | `/folders/:id` | `dashboard.folder.manage` | 改名/移动/排序 |
| DELETE | `/folders/:id` | `dashboard.folder.manage` | 非空 409 |
| POST | `/folders/:id/lock` | `asset.lock` | `{ locked }`；与授权互斥 |
| PUT | `/folders/:id/acl` | `asset.grant` | `{ grants: [{subject_type, subject_id, perm}] }` |
| PATCH | `/dashboards/:id` | `dashboard.edit` + Policy | 可改 `folder_id`、布局；Policy `update` |
| DELETE | `/dashboards/:id` | Policy `delete` | |
| POST | `/dashboards/:id/lock` | `asset.lock` | `{ locked, lock_cards?: boolean }` |
| PUT | `/dashboards/:id/acl` | `asset.grant` | 含 `perm=view`（外部人员）与 `edit` |
| POST | `/cards/:id/lock` | `asset.lock` | 锁前返回 `ref_count`（被几块看板引用）；确认由 query `confirm=1` 或 body |
| PUT | `/cards/:id/acl` | `asset.grant` | 仅 `perm=edit` |
| POST | `/meta/cohorts/:id/lock` | `asset.lock` | 无 acl |
| POST | `/meta/tags/:id/lock` | `asset.lock` | 无 acl |

现有业务控制器写操作加 `@RequirePermission` 后必须再调 `AssetPolicy`。不要再调用 `isAdmin()` 判断分析能力。列表返回 `locked` / `grant_count` / `can_edit` / `ref_count`（卡片）。

---

## 9. 前端

- 路由：`/iam/members` `/iam/groups` `/iam/roles` `/iam/data-policies`；超管 `/settings/project-owners`（菜单文案「项目设置」）。
- `MainLayout`：`buildMenuItems(permissions)`，删除 `user?.role === 'admin'`。
- 角色页：左列表右表；表数据只用 `/catalog`。说明条、预置标签按 PRD §10.2。按钮「编辑角色定义」不要写成「授权」。
- `/report/dashboards`：顶栏「文件夹显示 / 列表显示」+ 新建文件夹；无左侧文件夹栏。看板与文件夹行均可转移路径。看板设置可改 `folder_id`。印记按 PRD §8.5 / §10.6。
- 直链无码：统一无权限页，不闪现内容。

---

## 10. 迁移

1. `SaUser.role` → `platform_role`：`admin` → `super_admin`，其余 → `none`。
2. 每个 `super_admin`：若无 `clklogapp` 成员，插入 `role_key=project_owner`。多个 admin 时**仅最早创建的用户**当 owner，其余给 `analysis_admin`（满足「每项目 1 owner」）。
3. 旧 `analyst` → 其 `default_project` 或 `clklogapp` 的 `analyst` 成员。
4. 旧 `viewer` → 同项目 `member`。
5. `init-admin.ts`：创建超管并确保 `clklogapp` owner。
6. 历史看板 `owner` 用户 id 保留；`folder_id` 空（未分组）；`locked=false`。可见性改走角色 + AssetPolicy，不再用 `ownerFilter` 挡分析师**观看**。写路径删除 `ownerFilter`，改 `AssetPolicy`。
7. 历史看板 `owner` 用户 id 保留；`folder_id` 空（未分组）；`locked=false`。可见性改走角色 + AssetPolicy，不再用 `ownerFilter` 挡分析师**观看**。写路径删除 `ownerFilter`，改 `AssetPolicy`。
8. 若曾设计 `SaDashboardShare` 草稿，不要落地；用 `SaAssetAcl`。
9. `SaProject`：迁移写入已有 `clklogapp` / `default` 及成员表里出现过的 `project_name`。之后新建项目只走登记 API。

API Key 目录合成「admin 身份」改为合成 `dashboard.view_all` + 对应项目 DataScope 全开，不再伪造 `role=admin`。

---

## 11. 风险与红线

- 数据权限漏挂等于越权读数。PR 必须声明五条读路径已接 `DataScope`，或「门禁未自动检：数据权限注入」。
- 看板/卡片写路径漏接 AssetPolicy 等于分析师能改官方资产。PR 声明「门禁未自动检：AssetPolicy」或附单测名。
- 自定义 SQL 注入过滤不得绕过只读账号与词法黑名单。
- 不把密钥写入成员/策略表。
- 不 ALTER 社区版表。
