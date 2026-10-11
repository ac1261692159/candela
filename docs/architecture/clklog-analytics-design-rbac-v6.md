# 实现方案：授权弹层可用性与成员视角的看板授权（phase: clklog-analytics-rbac-v6）

> phase: clklog-analytics-rbac-v6
> 上游：`docs/product/prd-clklog-analytics-rbac-v6.md`
> 前序：`clklog-analytics-design-rbac-v5.md`（可见性判定与文件夹级授权）。本文只写本次增量。
> 本文是资产授权弹层契约、成员视角授权接口与「edit 蕴含 view」的 SSOT。

---

## 1. 阶段目标与范围

1. `AssetGrantModal`（资产侧）：加标签；每个授权栏换成 `GrantTransfer` 双栏选择器（未添加 / 已添加 + 类别标签页 + 筛选 + 固定高度内部滚动）。
2. 新增 `SubjectDashboardGrantModal`（成员 / 成员组侧）：反向查看并调整某主体对文件夹与看板的 `view` 授权。
3. 可见性判定把 `perm=edit` 也算作可见（列表与详情两处）。

---

## 2. 验收标准（实现层）

- [ ] **RB6-a**：`AssetGrantModal` 两个授权栏均带标签（新键 `report:grant.editors` / 既有 `report:grant.viewers`）；每栏渲染 `GrantTransfer`（左「未添加」/ 右「已添加」，键 `report:grant.notAdded` / `report:grant.added`）；左栏顶部标签页用 `report:grant.groupSection` / `report:grant.memberSection`；两栏各有搜索框（`common:action.search`）与固定 220px 列表区；Modal 固定宽度 760。
- [ ] **RB6-a2**：`GrantTransfer` 的交互为「点左栏加入、点右栏移出」；`props.selected` 为唯一真相，移动即回调 `onChange`。
- [ ] **RB6-b**：`GET /sa/api/iam/dashboard-grants?subject_type=&subject_id=` 返回该主体的直接 ACL 行（`asset_type` / `asset_id` / `perm`），守卫 `asset.grant`；未知主体或跨项目 id 返回空集，不报错。
- [ ] **RB6-c**：`PUT /sa/api/iam/dashboard-grants` 请求体 `{subject_type, subject_id, asset_ids}`：把该主体在 `asset_ids` 上的 `view` 行置为存在，不在集合内的**该主体** `view` 行删除；**其他主体的行与 `edit` 行一律不动**（单测：同资产上另一个组的授权在保存后仍在）。
- [ ] **RB6-d**：只允许 `folder` 与 `dashboard` 两类资产 id 参与；`card` 或其他 id 直接忽略；`asset_ids` 必须属于当前项目。
- [ ] **RB6-e**：`dashboard.service.list` 与 `AssetPolicyService.hasViewGrant` 的 ACL 判定改为 `perm ∈ {view, edit}`；断言「只被授 edit 的分析师在看板列表可见」。
- [ ] **RB6-f**：成员管理 / 成员组行内的「看板授权」按钮仅在 `asset.grant` 时渲染；弹层内被授 `edit` 的资产以只读「可编辑」标记呈现且不参与勾选切换。
- [ ] **RB6-g**：新增文案 13 门语言齐备；`arch_ratchet` / `i18n_check` / `i18n_scan --check` / jest / vitest / 两端 `tsc` 全绿。本次预计上调总量 1354 → 1358（`modules/iam` +4 = 两个接口的 3 条防御性校验错误的**中文兜底原文**，其中 `缺少 subject_id` 在两个 handler 各出现一次），须 `--force --update` 并在提交说明写明原因。

---

## 3. 非目标

与 PRD §4 一致。实现层补充：不新增权限码（复用 `asset.grant`）；不改 `saAssetAcl` 表结构；不做批量接口的并发写锁（单项目内 ACL 行量级小，整表读改写足够）；不改资产侧弹层的保存语义（仍是整资产覆盖）。

---

## 4. 资产侧弹层（AssetGrantModal）

| 项 | 落点 |
|---|---|
| 标签 | 两个授权栏上方各一行说明：`report:grant.editors`、`report:grant.viewers` |
| 结构 | `GrantTransfer` 双栏：左「未添加」（`report:grant.notAdded` + 条数）、右「已添加」（`report:grant.added` + 条数） |
| 类别 | 左栏顶部 `Tabs`：成员组（`report:grant.groupSection`）/ 成员（`report:grant.memberSection`），默认成员组 |
| 筛选 | 两栏各一个 `Input.Search`（占位 `common:action.search`），按 label 本地过滤 |
| 交互 | 点左栏项 → 加入右栏；点右栏项 → 移回左栏；`selected` 由父组件持有 |
| 固定尺寸 | 列表区固定 220px、内部滚动；Modal `width={760}`；两栏等宽 `flex:1 minWidth:0` |

可编辑 / 可查看的候选集合不变（可编辑＝分析师个人与分析师组；可查看＝全部组与全部成员）。

---

## 5. 成员视角授权

### 5.1 接口（守卫 `asset.grant`）

| 方法 路径 | 请求 | 返回 |
|---|---|---|
| `GET /sa/api/iam/dashboard-grants` | `subject_type=user\|group`、`subject_id` | `[{asset_type:'folder'\|'dashboard', asset_id, perm:'view'\|'edit'}]` |
| `PUT /sa/api/iam/dashboard-grants` | `{subject_type, subject_id, asset_ids: string[]}` | `{ok:true}` |

实现落在 `AssetPolicyService`（ACL 的既有归属地）：

- `listSubjectGrants(project, subjectType, subjectId)`：查 `saAssetAcl`（project + subject），只返回 `asset_type ∈ {folder, dashboard}` 的行。
- `replaceSubjectViewGrants(project, subjectType, subjectId, assetIds)`：
  1. 取本项目全部 `folder_id` 与 `db_id` 作为**允许集合**（过滤掉跨项目/非法 id）；
  2. 取该主体现有行；计算 `view` 行的增删集合；
  3. `$transaction`：删除要移除的 `view` 行、插入新增的 `view` 行；
  4. **不触碰**其他主体的行，也不触碰该主体的 `edit` 行。
- 「被授 edit 的资产」由前端置为强制选中（保持其已有 `view` 行不被误删），后端不做特殊处理。

### 5.2 界面（`SubjectDashboardGrantModal`）

- 数据：`listDashboards()` + 文件夹列表（report.service 既有）+ `listSubjectGrants`。
- 结构：`Modal width={640}` → `Input.Search`（本地筛选）→ 固定高度（360）滚动区：
  - 分区一「文件夹」：每行一个复选框 + 名称 + 其中看板数；
  - 分区二「看板」：每行一个复选框 + 名称 + 所属文件夹名；`未分组`单独标注。
  - 被授 `edit` 的行：复选框选中且 `disabled` + 「可编辑」标记。
- 保存：`PUT` 后关闭并提示成功；失败提示由统一错误处理负责。

---

## 6. edit 蕴含可见

| 位置 | 现在 | 改为 |
|---|---|---|
| `AssetPolicyService.hasViewGrant` | `perm: 'view'` | `perm: { in: ['view','edit'] }` |
| `DashboardService.list` | 只收集 `perm='view'` 的 ACL | 收集 `perm ∈ {view, edit}`（文件夹同理） |
| `iam-visibility` 纯函数 | —— | 不变（输入仍是「命中授权的 id 集合」） |

理由：v5 收回分析师的 `view_all` 后，「被授编辑权」的分析师在看板列表里不可见（列表只认 `view` 行），出现「能改却看不到」的矛盾。约定 **edit ⇒ view**。

---

## 7. 契约与兼容

| 变更 | 影响 | 兼容性 |
|---|---|---|
| 新增两个 `/iam/dashboard-grants` 接口 | 新能力；不改既有接口 | 老客户端不受影响 |
| 可见性判定纳入 `edit` 行 | 被授编辑权的分析师会多看到这些看板 | 只增不减；与「能改就能看」一致 |
| 弹层结构变化 | 纯前端 | 无契约影响 |

无 Prisma 变更、无迁移、无 ClickHouse 变更、无新环境变量。

---

## 8. 测试

1. `test/iam/asset-policy-dashboard-grants.spec.ts`（新增）：`replaceSubjectViewGrants` 只增删本主体的 `view` 行、保留他人 `edit` 行、忽略非法/跨项目 id；`listSubjectGrants` 过滤资产类型。
2. `test/report/dashboard.service.spec.ts`（既有）：补「只授 edit 也可见」用例。
3. `src/modules/iam/asset-policy.service` 的 `hasViewGrant` 纳入 edit（由 2 覆盖）。
4. 前端：`grant-view-options.spec.tsx`（既有）扩充分组/复选框断言；新增成员视角弹层用例（勾选保存的请求体、编辑行只读）。
5. 门禁：`arch_ratchet.py`、`i18n_check.py`、`i18n_scan.py --check`、后端 `jest --runInBand`（含 `env -i`）、前端 `vitest run`、两端 `tsc --noEmit`。

---

## 9. 风险与回滚

- **整表覆盖误删他人授权**：已在 §5.1 明确「只动本主体的 `view` 行」，并用单测锁死（RB6-7）。
- **成员视角与资产视角不一致**：两侧写的是同一张表，成员视角只写 `view`；被授 `edit` 的资产在成员视角只读，避免语义冲突。
- **回滚**：改动集中在 1 个服务 + 1 个控制器 + 3 个前端文件与文案资源；`git revert` 即可，ACL 数据无需回退。
