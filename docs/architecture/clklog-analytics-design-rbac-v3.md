# 实现方案：项目权限口径修正 v3（选择器与治理分离 / 指标归属）

> phase: clklog-analytics-rbac-v3
> 上游：`docs/product/prd-clklog-analytics-rbac-v3.md`
> 前序：`docs/architecture/clklog-analytics-design-rbac-v2.md`（五角色、权限目录、AssetPolicy、DataScope 的 SSOT）。本文只修正其中**两处口径**与**一处守卫落点**，其余沿用 v2，不重复搬运。
> 本文是本次改动的权限码、守卫落点、接口行为与验收方式的 SSOT。

---

## 1. 阶段目标与范围

1. **选择器与治理分离**：新增只读权限码 `meta.picker.view`，覆盖分析师可达页面运行时真正调用的元数据读接口；分析师的 `meta.view` 收回（治理面回到 owner / 分析管理员档）。
2. **指标写入口归属判定**：`metric.edit_own` 从「可写全部指标」修正为「可写自己的指标」，`metric.edit_others` 成为真正被消费的码。
3. **侧栏「数据管理」分组按子项裁剪**：分组内五项各按自己的码显示，分组本身要求至少一项可见。

包边界：改动落在既有 `modules/iam/`（目录）、`modules/meta/`（守卫与写判定）、`modules/datatable/`（守卫）、`layouts/`（侧栏）。不新建包，不扩大 `src/common/`。

---

## 2. 验收标准（实现层）

- [ ] **RB3-a**：`codesForRole('analyst')` 含 `meta.picker.view`、不含 `meta.view`；`codesForRole('project_owner')` / `codesForRole('analysis_admin')` 两者都含；`member` / `external` 两者都不含。断言落在 `modules/iam/iam.service.spec.ts`（替换 v3.2 写下的 `meta.view === true` 断言）。
- [ ] **RB3-b**：§5 清单 8 条 handler 的权限元数据为 `['meta.view', 'meta.picker.view']`；清单外元数据/数据表 handler 的权限元数据仍为 `meta.view`（或 `meta.edit`），不得出现 `meta.picker.view`。以单测读取 `RequirePermission` 元数据断言，防止清单漂移。
- [ ] **RB3-c**：`PUT /sa/api/meta/metrics/:id` 与 `DELETE /sa/api/meta/metrics/:id` 注入当前用户与 IAM 上下文；非归属且无 `metric.edit_others` 时抛 403，`code = meta.metric.notOwner`、`messageKey = meta:error.metric.notOwner`；归属人或持有 `metric.edit_others` 时 200。
- [ ] **RB3-d**：指标 create / update / delete 的审计记录 `operator` 为真实用户 id（现状为 `system`）。
- [ ] **RB3-e**：`filterMenuByPermissions` 新增 `showData`（= `meta.view` 或 `metric.view`）；分析师（`metric.view` + `meta.picker.view`）`showMeta === false`、`showData === true`；owner `showMeta === true`、`showData === true`。断言落在 `layouts/shell-menu.spec.ts`。
- [ ] **RB3-f**：新权限码在角色目录中可见（`catalogForUi()` 多一行；`catalogForUi()` 不返回 `meta.picker.view` 之外的实现细节），前端 `iam.json` 的 `permission.detail.metaPickerView` 在 13 门语言齐备。
- [ ] **RB3-g**：`python3 scripts/arch_ratchet.py` 通过（`modules/meta` 不超上限）；`python3 scripts/i18n_check.py` 通过；`python3 scripts/i18n_scan.py --check` 通过——本次预计上调总量 1350 → 1354（`modules/iam` +3 = 新增目录行的 `feature` / `op` / `detail` 中文原值，`modules/meta` +1 = 归属 403 的兜底文案），须 `--force --update` 并在提交说明写明原因；除此之外不得放宽任何目录。
- [ ] **RB3-h**：后端 jest、前端 vitest、两端 `tsc --noEmit` 全绿。

---

## 3. 非目标

与 PRD §4 一致。补充实现层：不新增 AssetPolicy 资产类型（指标不走锁定/授权，不做 `loadMetric`）；不改 DataScope 注入路径（Debug 旁路只登记不修）；不改 `meta.edit` 的任何守卫；不动 `member` / `external` 的码集合。

---

## 4. 权限码修正（SSOT 增量）

格式 `域.资源.动作`。下表只列**本次发生变化的行**，其余行以 v2 文档为准。

| code | 功能 | 操作权限 | 功能明细 | owner | analysis_admin | analyst | member | external |
|------|------|----------|----------|:-----:|:--------------:|:-------:|:------:|:--------:|
| `meta.view` | 埋点 / 元数据 | 查看 | 查看事件、属性、虚拟对象、指标、Debug、数据质量 | ✓ | ✓ | **✗（本次收回）** | | |
| `meta.picker.view` | 埋点 / 元数据 | 查看 | 分析选择器读取已启用的事件、属性与维度表字段（只读） | ✓ | ✓ | ✓ | | |
| `metric.edit_own` | 指标管理 | 编辑 | 新建、编辑、删除**自己的**指标 | ✓ | ✓ | ✓ | | |
| `metric.edit_others` | 指标管理 | 编辑 | 编辑、删除**他人的**指标 | ✓ | ✓ | | | |

文案键：`meta.picker.view` 复用 `iam:permission.feature.meta` 与 `iam:permission.op.view`，明细新增 `iam:permission.detail.metaPickerView`（不新增 feature / op 键）。

口径说明：

- `meta.picker.view` 只表示**读**：它出现在 §5 清单的 8 条只读 handler 上，**不得**出现在任何写接口上；`meta.edit` 与 `meta.view` 的关系不变（写接口继续要求 `meta.edit`）。
- `meta.view` 从本次起表示**治理面**：元事件/属性/虚拟对象的管理页读接口、Debug、数据质量与对拍、数据表管理、属性详情。分析师不再持有。
- `metric.edit_own` 与 `metric.edit_others` 的分工由 §6 的写判定实现（此前只有前者被当作路由守卫使用，后者是死码）。

---

## 5. 选择器读接口清单（8 条）

判定规则：**清单 = 分析师可达页面在运行时实际调用的元数据/维度表读接口**。清单外新增调用方，须在本表登记后才能挂 `meta.picker.view`；不得按「读接口一律放开」批量处理。

| # | 方法 路径 | 控制器 | 现守卫 | 新守卫 | 调用方（分析师可达） |
|---|---|---|---|---|---|
| 1 | `GET /sa/api/meta/events` | `meta-event.controller.ts` | `meta.view` | `meta.view` \| `meta.picker.view` | 事件分析 / 漏斗 / 留存的事件下拉、指标定义 |
| 2 | `GET /sa/api/meta/events/:eventKey/properties` | `meta-property.controller.ts` | `meta.view` | 同上 | 上述页面的属性下拉 |
| 3 | `GET /sa/api/meta/user-properties` | `meta-property.controller.ts` | `meta.view` | 同上 | 分群 / 标签 / 主体 / 分析筛选 |
| 4 | `GET /sa/api/meta/virtual-events` | `meta-virtual-event.controller.ts` | `meta.view` | 同上 | `EventSelect` 合并虚拟事件 |
| 5 | `GET /sa/api/meta/virtual-properties` | `meta-virtual-property.controller.ts` | `meta.view` | 同上 | 分析分组/筛选的虚拟属性 |
| 6 | `GET /sa/api/meta/event-attributes` | `meta-event-attribute.controller.ts` | `meta.view` | 同上 | 分析主体页属性清单（翻页取全） |
| 7 | `GET /sa/api/meta/datatables/dimension-properties` | `datatable.controller.ts` | `meta.view` | 同上 | 分析页维度表属性（`useDatatableDimensions`） |
| 8 | `GET /sa/api/meta/datatables/labels` | `datatable.controller.ts` | `meta.view` | 同上 | 分析筛选值标签（`loadValueLabels`） |

实现方式：控制器类级保留 `@RequirePermission('meta.view')`，在清单内 handler 上加 `@RequirePermission('meta.view', 'meta.picker.view')`。守卫语义为「任一码即可」（`require-permission.ts:8`），handler 级元数据覆盖类级（`iam.guard.ts` 的 `getAllAndOverride`）。这样 owner / 分析管理员（持 `meta.view`）与分析师（持 `meta.picker.view`）都通过，且**不需要**改动任何其他文件的守卫。

未列入清单、保持 `meta.view` 的接口（示例，非穷举）：`meta/event-attributes/:propKey`（属性详情）、`meta/events` 的写与 `batch` / `refresh-stats`、`meta/quality/*`（含对拍）、`meta/debug/recent`、`meta/datatables` 的列表/详情/下载/使用与一切写接口。

---

## 6. 指标写入口归属判定

**判定位置**：`meta-saved-metric.service.ts`（单一写入口，HTTP 与后续 CLI/定时任务共用），不在控制器里判、不在前端判。

**判定规则**（`update` 与 `delete` 共用）：

```
放行 ⇔ 指标.owner === 当前用户 id
      ∨ IAM 上下文含 metric.edit_others
否则 403：code = meta.metric.notOwner，messageKey = meta:error.metric.notOwner
```

- 不引入锁定/授权：指标按 PRD §4 非目标「不走锁定」，故不复用 `AssetPolicyService`（它带 lock/grant 语义且无 metric 资产类型）。
- 分析管理员档由 `metric.edit_others` 表达（目录默认已勾），因此判定不必读 `role_key`，与目录保持单一真相。
- `create` 不变（`metric.edit_own` 即可），但同样补记真实 operator。
- 控制器签名改为传入 `@CurrentUser() user` 与 `@CurrentIam() iam`；service 的 `operator` 参数由默认 `'system'` 改为必传真实用户 id。
- 前端**不复刻**归属规则（与分群/标签列表一致：按钮照常渲染，403 由服务端裁决并回可读提示）；抽屉里已展示创建人，提示文案点名原因。

---

## 7. 侧栏与路由裁剪

- `filterMenuByPermissions` 新增 `showData = hasPerm('meta.view') || hasPerm('metric.view')`；`showMeta` 语义不变（仍 = `meta.view`）。
- `MainLayout.buildMenuItems`：「埋点管理」分组继续由 `showMeta` 控制；「数据管理」分组改由 `showData` 控制，且五个子项各按自己的码生成——接入指南 `meta.view`、指标 `metric.view`、Debug `meta.view`、数据质量 `meta.view`、数据表 `meta.view`。分组的子项为空时不渲染分组。
- 路由门不变（`routes.tsx` 已按各自码：`meta/metrics` = `metric.view`，其余 `meta/*` = `meta.view`），因此直链行为与侧栏一致。
- 分析师最终可见：「数据管理 → 指标」；不可见：埋点管理整组、接入指南、Debug、数据质量、数据表。

---

## 8. 契约与兼容

| 变更 | 影响 | 兼容性 |
|---|---|---|
| 新增权限码 `meta.picker.view` | 角色管理页多一行；`codesForRole` 返回值变化 | 无 DB 变更；旧 token 无角色快照（每次请求实时求值），无需重新登录 |
| `PUT` / `DELETE /sa/api/meta/metrics/:id` 对非归属非管理员返回 403 | 此前返回 200（缺陷）；新的机器码 `meta.metric.notOwner` | 破坏性修复，发布说明写明 |
| 8 条选择器读接口对分析师 200 | v3.2 之前 403、v3.2 之后 200，本次回到 200（用更窄的码） | 分析能力不回退 |
| 其余元数据读接口对分析师回到 403 | v3.2 引入的越权被收回 | 发布说明写明；需要者改授分析管理员 |
| 指标审计 operator 由 `system` 变为真实用户 | 审计更可追溯 | 历史记录不改写 |

无 Prisma schema 变更、无迁移脚本、无 ClickHouse 变更、无新环境变量。

**已自定义「分析管理员」授权的项目**：`SaRoleGrant.grants_json` 是覆盖集（有 overlay 时不再叠加 `codesForRole`）。改动前存下的 overlay 含 `meta.view` 而不含 `meta.picker.view`——管理员照旧通过 `meta.view` 走完 §5 清单，功能不受影响；角色管理页会在新增行显示未勾选（该角色带「已调整」角标），需要时由 owner 补勾。

---

## 9. 测试与验证

自动化：

1. `apps/analytics-server`：`npx jest modules/iam modules/meta`（新增/替换断言见 RB3-a/b/c/d）。
2. `apps/analytics-web`：`npx vitest run src/layouts/shell-menu.spec.ts`（RB3-e）。
3. `python3 scripts/arch_ratchet.py`、`python3 scripts/i18n_check.py`、`python3 scripts/i18n_scan.py --check`。
4. 两端类型检查：`npx tsc --noEmit`。

人工（发布后，用邀请注册的**分析师**账号）：

1. 事件分析 / 漏斗 / 留存各跑一次查询：选择器能出事件与属性，无 403。
2. 分群、标签、主体、指标各建一条：成功。
3. 指标删除：删自己刚建的 → 成功；删管理员的 → 提示「只能修改或删除自己的指标」。
4. 侧栏：无「埋点管理」；「数据管理」下只有「指标」；手输 `/meta/quality` 被路由门拦下。
5. 用 owner 账号复核：侧栏与改动前一致，能删任意指标，能进数据质量与对拍。
6. 切换语言复核新增文案（角色管理页新行 + 指标 403 提示）。

---

## 10. 风险与回滚

- **清单漂移**（分析页新增元数据读接口未登记 → 分析师再遇 403）：由 RB3-b 的元数据断言与 §5 登记规则约束。
- **收口过猛**（AI 助手、看板卡片间接依赖被收回的接口）：验收按 PRD RB3-1 走全流程；若发现漏登记的调用方，按 §5 补登记（补一行 handler 元数据），不新开口子。
- **回滚**：改动集中在 4 个源文件的守卫/判定 + 1 个分类常量 + 文案资源。回滚即 `git revert` 本次提交；无数据状态需要回退（无 DDL、无迁移）。
- **既有缺口登记**：Debug 未接 DataScope（PRD §1 现象 2）记入 `CODE_HANDOVER.md`，本期不修。
