# 实现方案：看板默认可见范围与成员组授权（phase: clklog-analytics-rbac-v5）

> phase: clklog-analytics-rbac-v5
> 上游：`docs/product/prd-clklog-analytics-rbac-v5.md`
> 前序：`clklog-analytics-design-rbac-v2.md`（资产可见性 §7 / AssetPolicy §6）、`-v3`（选择器与指标）、`-v4`（项目权限只读）。本文只写本次增量。
> 本文是看板可见性判定、授权校验与授权弹层契约的 SSOT。

---

## 1. 阶段目标与范围

1. `dashboard.view_all` 收回分析师 / 普通成员（只留 owner 与分析管理员）。
2. 可见性判定加两条：创建者始终可见自己的；文件夹级 `view` 授权覆盖其内全部看板（含子文件夹、含之后新建的）。
3. 放开文件夹的 `view` 授权校验（现在只允许看板）。
4. 授权弹层的「可查看」候选放开到全部成员组与全部成员。
5. 看板页分群筛选器按 `cohort.view` 裁剪，消除普通成员的 403。

---

## 2. 验收标准（实现层）

- [ ] **RB5-a**：`codesForRole` 中 `dashboard.view_all` 对 project_owner / analysis_admin 为真，对 analyst / member / external 为假；`dashboard.view` / `dashboard.filter` / `dashboard.edit` 的角色档不变。断言落在 `modules/iam/iam.service.spec.ts`。
- [ ] **RB5-b**：`DashboardService.list` 的可见集合 = `view_all` ∨ 创建者是本人 ∨ 看板 ACL(view) ∨ 所在文件夹（含父文件夹）ACL(view)；被拒者不出现在列表。断言落在 `test/report/dashboard-visible.spec.ts`（新增，纯函数化判定）。
- [ ] **RB5-c**：`AssetPolicyService.replaceAcl` 允许 `perm=view` 挂在 `dashboard` 与 `folder`；`edit` 仍只允许分析师；`view` 挂到 card 仍拒绝。
- [ ] **RB5-d**：授权弹层的「可查看」候选＝全部成员组 + 全部成员；「可编辑」候选＝分析师（个人与组）不变；文件夹授权弹层出现「可查看」区块。
- [ ] **RB5-e**：无 `cohort.view` 的角色进入看板详情，不再发出 `GET /meta/cohorts`；分群筛选器不渲染；有 `cohort.view` 的角色行为不变。
- [ ] **RB5-f**：新增文案 13 门语言齐备；`arch_ratchet` / `i18n_check` / `i18n_scan --check` / jest / vitest / `tsc` 全绿。

---

## 3. 非目标

与 PRD §4 一致。实现层补充：不动 `SaAssetAcl` 表结构；不改 `dashboard.controller` 的守卫码；不给卡片加 `view` 授权；不改文件夹列表接口的返回（文件夹名仍可见）；不做历史可见性批量迁移脚本。

---

## 4. 可见性判定（SSOT）

```
可见 ⇔ view_all
      ∨ 看板.owner == 当前用户
      ∨ ∃ ACL(asset=dashboard, id=看板, perm=view, subject ∈ {我} ∪ 我的组)
      ∨ ∃ ACL(asset=folder, id=看板所在文件夹或其父文件夹, perm=view, subject ∈ {我} ∪ 我的组)
```

- `view_all` 只由 `dashboard.view_all` 决定（owner / 分析管理员）。
- 文件夹层级最多两层（v2 §8.1），因此「父文件夹授权」只需向上取一级；实现上把已授权的文件夹集合向下一级展开即可覆盖子文件夹内的看板。
- 创建者例外不看锁定状态：锁定影响的是「能不能改」，不是「能不能看」。

实现落点：`modules/report/dashboard.service.ts` 的 `list()`；判定抽成纯函数（`dashboard-visibility.ts`）以便单测直接覆盖四种组合。

---

## 5. 授权校验（AssetPolicy）

| perm | 允许的资产类型 | 允许的对象 |
|---|---|---|
| `view` | `dashboard`、`folder`（本次放开 folder） | 任意 `user` / `group`（沿用既有校验） |
| `edit` | `dashboard`、`folder`、`card` | 仅分析师个人或角色=分析师的成员组（`assertEditGrantTarget` 不变） |

`view` 挂到 `card` 仍返回既有 `iam.asset.viewGrantDashboardOnly`（文案改为「仅看板与文件夹可授予查看」）。

---

## 6. 前端

| 位置 | 变更 |
|---|---|
| `AssetGrantModal` | 「可查看」候选改为 `listMembers()` + `listGroups()` 全量（组在前、成员在后）；「可编辑」仍只取 `role_key === 'analyst'` |
| `DashboardListPage` | 文件夹的授权弹层也开放「可查看」区块（`allowView` 不再只对看板为真）；列表空态展示「暂无可见看板，请联系管理员授权」 |
| `use-ready-cohorts` | 内部按 `useIamStore.has('cohort.view')` 裁剪：无权限直接返回空数组且不发请求 |
| `DashboardPage` | 分群筛选器仅在 `cohort.view` 时渲染（避免空下拉） |

新增文案键（`report` 命名空间）：`dashboard.emptyNoGrant`、`grant.viewHint`（说明「文件夹授权覆盖其内全部看板」）。

---

## 7. 契约与兼容

| 变更 | 影响 | 兼容性 |
|---|---|---|
| `dashboard.view_all` 收回三档 | 分析师 / 普通成员 / 外部人员默认看不到看板 | 无 DB 变更；实时求值，无需重新登录 |
| 文件夹可授 `view` | 新能力，不改既有 ACL 行 | 老数据（仅 dashboard 行）行为不变 |
| 可见集新增「创建者例外」 | 创建者一定看得见自己的 | 只增不减，不会让既有可见者变不可见 |
| `cohorts?status=ready` 不再被无权限角色调用 | 客户端行为变更 | 接口守卫不变（仍是 `cohort.view`） |

无 Prisma 变更、无迁移、无 ClickHouse 变更、无新环境变量。

---

## 8. 测试

1. `modules/iam/iam.service.spec.ts`：五角色的 `dashboard.view_all` 断言（RB5-a）。
2. `test/report/dashboard-visible.spec.ts`（新增）：纯函数四组合——view_all / 创建者 / 看板授权 / 文件夹授权（含父文件夹与子文件夹）与「全无」。
3. `test/report/dashboard.service.spec.ts`（既有）：补 `list()` 用 ACL 过滤的用例。
4. `test/iam/asset-policy`（既有，如有）：补 `view` 挂 folder 通过、挂 card 拒绝。
5. 前端：`AssetGrantModal` 候选集用例；`use-ready-cohorts` 无权限不发请求用例（mock service 断言未调用）。
6. 门禁：`arch_ratchet.py`、`i18n_check.py`、`i18n_scan.py --check`、后端 `jest --runInBand`（加 `env -i` 复跑）、前端 `vitest run`、两端 `tsc --noEmit`。

人工验收：分析师 / 普通成员 / 外部人员三个账号走 RB5-1～RB5-7；owner 复核 RB5-2 与授权流程。

---

## 9. 风险与回滚

- **上线即失明**（见 PRD §6）：这是产品选择的直接后果。发布说明与给管理员的操作建议（先按文件夹授权）必须随版本发出。
- **文件夹授权过宽**：一个文件夹授权覆盖其内全部看板；弹层文案写明。若后续要更细，可加「仅看板」开关，不需要改数据结构。
- **可见性判定写错会放大暴露面**：判定抽成纯函数并用四组合用例锁死；`view_all` 的收回有角色断言。
- **回滚**：改动集中在 1 个目录常量、1 个可见性判定 + 1 处授权校验、2 个前端组件与 1 个 hook；`git revert` 即可，ACL 数据无需回退（新写入的 folder 行在旧代码下只是不被读取）。
