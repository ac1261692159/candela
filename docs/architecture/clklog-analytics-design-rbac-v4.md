# 实现方案：项目权限全员只读可见（phase: clklog-analytics-rbac-v4）

> phase: clklog-analytics-rbac-v4
> 上游：`docs/product/prd-clklog-analytics-rbac-v4.md`
> 前序：`clklog-analytics-design-rbac-v2.md`（权限码与守卫 SSOT）、`clklog-analytics-design-rbac-v3.md`（选择器/治理分离）。本文只写本次增量。
> 本文是本次改动的守卫落点、只读裁剪与界面契约的 SSOT。

---

## 1. 阶段目标与范围

1. `iam.member.view` 放开到五个项目角色（只读载体重用，不新增权限码）。
2. 把两个「随母码外溢」的管理面收紧：待处理邀请列表、权限审计流水。
3. 四个 IAM 页面在缺少写码时呈现只读态（不是"按钮照点、点了 403"）。
4. 数据权限页新增只读明细视图（现状无查看入口）。

包边界：改动落在既有 `modules/iam/`、`modules/auth/`（守卫）与 `pages/Iam/`（三个页面）、`layouts/`（无需改动）。不新建包，不扩大 `src/common/`。

---

## 2. 验收标准（实现层）

- [ ] **RB4-a**：`codesForRole(r)` 中 `iam.member.view` 对五个角色全为 true；`iam.member.edit` / `iam.role.edit_admin` / `iam.data_policy.manage` 的角色档**不变**。断言落在 `modules/iam/iam.service.spec.ts`。
- [ ] **RB4-b**：`GET /sa/api/iam/invitations` 权限元数据为 `['iam.member.edit']`（不含 `iam.member.view`）；创建/撤销邀请仍是 `iam.member.edit`。断言落在 `modules/iam/iam-readonly-surfaces.spec.ts`。
- [ ] **RB4-c**：`GET /sa/api/auth/audit-logs` 权限元数据为 `['ops.user.manage', 'iam.member.edit']`（不含 `iam.member.view`）。同上一并断言。
- [ ] **RB4-d**：成员页在缺 `iam.member.edit` 时不渲染「添加成员」「邀请」按钮、行内角色选择、移出、续期、邀请区块与审计区块。
- [ ] **RB4-e**：成员组页在缺 `iam.member.edit` 时不渲染新建/编辑/删除。
- [ ] **RB4-f**：数据权限页在缺 `iam.data_policy.manage` 时不渲染新建与删除，仅渲染「查看」；明细视图可读且对 `mode=all` / 白名单 / 行过滤三种形态都有可读呈现。
- [ ] **RB4-g**：角色管理页保持 v2 行为（owner 可编辑分析管理员授权；其他人只读），本次不改。
- [ ] **RB4-h**：新增文案 13 门语言齐备；`arch_ratchet` / `i18n_check` / `i18n_scan --check` / jest / vitest / `tsc` 全绿。

---

## 3. 非目标

与 PRD §4 一致。实现层补充：不动 `SaProjectMember` / `SaMemberGroup` / `SaDataPolicy` 表结构与接口契约形状（只改守卫码与前端呈现）；不新增权限码；不动侧栏结构（`showIam` 仍由 `iam.member.view` 驱动，码放开后菜单自然出现）。

---

## 4. 权限码修正（SSOT 增量）

| code | 功能 | 操作权限 | 功能明细 | owner | analysis_admin | analyst | member | external |
|------|------|----------|----------|:-----:|:--------------:|:-------:|:------:|:--------:|
| `iam.member.view` | 项目权限管理 | 查看 | 查看本项目成员、成员组、角色说明、数据权限策略 | ✓ | ✓ | **✓** | **✓** | **✓** |
| `iam.member.edit` | 项目权限管理 | 编辑 | 添加/移除成员与组；分配非 owner 角色 | ✓ | ✓ | | | |
| `iam.role.edit_admin` | 项目权限管理 | 编辑 | 编辑本项目「分析管理员」授权定义 | ✓ | | | | |
| `iam.data_policy.manage` | 数据权限 | 管理 | 新建、编辑、删除策略并赋给成员或组 | ✓ | ✓ | | | |

语义：`iam.member.view` = 「项目权限域只读」——包含角色说明与策略明细；它不再隐含「邀请队列」与「权限审计流水」两项治理面（见 §5）。

---

## 5. 守卫收紧（两处）

| 接口 | 现守卫 | 新守卫 | 理由 |
|---|---|---|---|
| `GET /sa/api/iam/invitations` | `iam.member.view` | `iam.member.edit` | 返回待入会者邮箱，属邀请治理面；创建/撤销邀请本就是 `iam.member.edit` |
| `GET /sa/api/auth/audit-logs` | `ops.user.manage` \| `iam.member.view` | `ops.user.manage` \| `iam.member.edit` | 权限变更流水属治理面；owner / 分析管理员同时持有 `iam.member.edit`，可读性不回归 |

其余 `iam.*` 接口守卫不变（成员增删改= `iam.member.edit`；策略增删改= `iam.data_policy.manage`；角色定义= `iam.role.edit_admin`）。

---

## 6. 前端只读态

统一取码方式：`useIamStore((s) => s.has('<code>'))`（与 `RolesPage` 既有写法一致）。

| 页面 | 元素 | 依据 |
|---|---|---|
| `MembersPage` | 「添加成员」按钮、行内角色 `Select`、移出、续期、邀请按钮 + 待处理邀请区块、审计区块 | `iam.member.edit` |
| `GroupsPage` | 新建组、行内编辑/删除 | `iam.member.edit` |
| `RolesPage` | 编辑角色定义 | `iam.role.edit_admin`（既有，不改） |
| `DataPoliciesPage` | 新建策略、删除 | `iam.data_policy.manage` |
| `DataPoliciesPage` | 「查看」明细（所有可见者） | `iam.member.view`（路由门已保证，无需再判） |

**只读明细视图**：把 `definition_json` 解析为四行描述，语言无关的取值直接展示（事件键、属性键、运算符、值均属用户数据，按 i18n 规范不翻译），仅标签与「不限制」「且」这类平台文案走文案键：

| 行 | `mode=all` | `mode=allow` |
|---|---|---|
| 可见事件 | 不限制 | 具体事件键列表 |
| 可见事件属性 | 不限制 | 具体属性键列表 |
| 可见用户属性 | 不限制 | 具体属性键列表 |
| 行过滤条件 | 无 | `属性 运算符 值` 逐条列出，多条以「且」连接 |

新增文案键（`iam` 命名空间）：`dataPolicy.detail`、`dataPolicy.scopeEvents`、`dataPolicy.scopeEventProperties`、`dataPolicy.scopeUserProperties`、`dataPolicy.scopeRowFilter`、`dataPolicy.scopeAll`、`dataPolicy.rowFilterNone`、`dataPolicy.rowFilterAnd`、`dataPolicy.rowFilterItem`。复用既有 `common:action.view`。

---

## 7. 契约与兼容

| 变更 | 影响 | 兼容性 |
|---|---|---|
| `iam.member.view` 放开到五角色 | 侧栏「项目权限」对全员出现；角色管理页对全员可读 | 无 DB 变更；每次请求实时求值，无需重新登录 |
| 邀请列表 / 审计流水守卫收紧 | 持 `iam.member.view` 但无 `iam.member.edit` 者失去读取 | 现网该组合不存在（`iam.member.view` 此前只与编辑码同时持有），无实际用户受影响 |
| 数据权限页新增只读明细 | 新增只读入口，不改接口 | 接口返回的 `definition_json` 本就在列表响应里，无契约变更 |

无 Prisma 变更、无迁移、无 ClickHouse 变更、无新环境变量。

---

## 8. 测试

1. `modules/iam/iam.service.spec.ts`：五角色 `iam.member.view` 全真 + 写码角色档不变（RB4-a）。
2. `modules/iam/iam-readonly-surfaces.spec.ts`（新增）：读控制器权限元数据断言邀请与审计的守卫（RB4-b/c）。
3. `pages/Iam/*.spec.tsx`（新增，jsdom）：非管理员渲染时无写按钮；有写码时按钮齐全；策略明细对三种形态的渲染（RB4-d/e/f）。
4. 门禁：`arch_ratchet.py`、`i18n_check.py`、`i18n_scan.py --check`、后端 `jest --runInBand`（含 `env -i` 复跑）、前端 `vitest run`、两端 `tsc --noEmit`。

人工验收：用分析师 / 普通成员 / 外部人员账号各走一遍 RB4-1～RB4-7；用 owner 账号复核写操作与审计/邀请仍在。

---

## 9. 风险与回滚

- **只读态漏了某个按钮** → 点了才发现 403。对策：RB4-2 与页面用例逐个元素断言；发版后按角色实点一遍。
- **外部人员看到成员名单**（产品已确认接受）：若后续要收，改 `permission-catalog.ts` 一行 `external: false` 即可，页面与接口无需改动。
- **审计/邀请收紧误伤管理员**：owner / 分析管理员同时持有 `iam.member.edit`，断言已覆盖；如发现自定义 overlay 的项目把 `iam.member.edit` 去掉过，则该项目的管理员会失去邀请与审计读取——属该项目的授权配置结果，需要时由 owner 补勾。
- **回滚**：改动集中在 1 个目录常量、2 个控制器守卫、3 个页面组件与文案资源；`git revert` 即可，无数据状态需回退。
