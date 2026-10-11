# 实现方案：用户分群体验优化与健壮性

> phase A: `clklog-analytics-user-segment-ux-v1`
> phase B: `clklog-analytics-cohort-robustness-v1`
> 上游 PRD：`docs/product/prd-clklog-analytics-user-segment-ux-v1.md`
> 契约补充：`docs/architecture/clklog-analytics-design-user-segment-v1.md`（成员表 / `definition_json`）、`clklog-analytics-design-user-segment-followups.md`（SQL 分群 / 标签 / 主体）
> 相关：`clklog-analytics-design-i18n-v1.md`（键与资源、错误码契约）

红线：成员/标签值只落 `clklog_sa`；圈人与试跑都有 `project_name` + 时间窗或 LIMIT/超时；试跑只读、不写成员表；不改社区版表；不扩大 `utils/`；新增能力落 `modules/cohort` 与 `features/cohort`，不塞进 `modules/meta`、不新建公共杂项包。

---

## A. 圈人反馈回路与列表可用性

> phase: `clklog-analytics-user-segment-ux-v1`

### A.1 阶段目标与范围

与 PRD A.1 相同。只增加**读取路径**（试跑、成员检索）与**表达层**（列表、入口、内联校验），不改 `definition_json`、成员表结构、条件语义与 `scope=cohort` 分析路径，因此无数据迁移。

### A.2 验收标准

与 PRD UX-1～UX-11 对应。交付前 `python3 scripts/arch_ratchet.py`、`python3 scripts/i18n_check.py`、`python3 scripts/i18n_scan.py --check` 通过。单测至少：试跑 SQL 含 `project_name` 与时间窗且不含 `INSERT`、摘要渲染各条件类型、客户端条件校验逐条报错、成员检索走参数绑定。

### A.3 非目标

与 PRD A.3 相同。

### A.4 试跑与人数预估

新增只读端点（鉴权同控制器默认 `cohort.view`，不要求 `cohort.edit_own`——试跑是查看行为，编辑他人分群前也要能预估）：

```
POST /sa/api/meta/cohorts/preview-condition
body: {
  definition_json: { conditions: [...] },   // 与创建同构，走同一份 validateConditionDefinition
  subject_id?: string,
  limit?: number                            // 示例 ID 条数；默认 20，上限 1000，0 = 只算人数
}
resp: {
  count: number,          // 精确人数（count()，非抽样）
  items: [{ uid: string }],
  limit: number,
  truncated: boolean      // items.length >= limit
}
```

实现：

1. 复用 `validateConditionDefinition` 校验（错误码与创建一致，不新增抛错分支）。
2. 复用 `subjectForbidsNegativeUniverse` + `conditionsUseDidNot` 的「没做过」门禁（与 `CohortService.create` 同一处判断，抽成共用函数，禁止复制两份）。
3. `computeDay` 取项目统计日历（与 `CohortComputeService.compute` 同一取值路径），保证「试跑人数」与「保存后预计算结果」可比。
4. SQL 由 `CohortConditionSqlService.buildPreviewParts()` 产出：**同一次** `buildUidSet` 得到的一条集合 SQL，外包两层——
   - 人数：`SELECT count() AS c FROM (<uidSet>)`，`maxExecutionTime: 30`
   - 样例：`SELECT uid FROM (<uidSet>) ORDER BY uid LIMIT {limit: UInt32}`
   一次调用返回 `{ count, sample }`（`limit=0` 时只返回人数），避免两次主体解析 / JOIN 注册导致人数与样例来自不同查询。不做预估缓存。
5. 编排落新包 `modules/cohort/cohort-preview.service.ts`（注入 `CohortConditionSqlService` + `ClickHouseService` + `SubjectService` + 时区），`CohortComputeService` 不承接读取职责。
6. **不写成员表、不改分群状态**；试跑失败只影响本次响应。

客户端「与当前已保存人数差」由**前端**算：编辑态已有 `member_count`，与 `count` 相减即可，不新增比较接口。

### A.5 成员检索

```
GET /sa/api/meta/cohorts/:id/members?limit=&keyword=
resp: { items: [{ uid }], total: <member_count>, keyword?: string, truncated: boolean }
```

- `keyword` 为空时行为与现状一致（`ORDER BY uid LIMIT n`）。
- 有 `keyword` 时 `positionCaseInsensitive(uid, {keyword: String}) > 0`，仍带 `project_name` + `cohort_id` + `batch_id`，`LIMIT` 上限 1000、`maxExecutionTime: 30`。
- 关键字**只走参数绑定**，不拼字符串；`total` 仍是分群总人数（不做匹配总数二次扫描），`truncated` 表示命中被 LIMIT 截断。

### A.6 列表

纯前端改动，接口不变（仍一次取回项目全部分群，上限 200）：

| 列 | 说明 |
|----|------|
| 显示名 | 第一列；锁定 / 计算中 / 失败态标签仍在；点击进编辑页 |
| 分群名 | 机器名弱化（次要色、可复制） |
| 圈人规则 | 见 A.7；超长省略 + Tooltip |
| 类型 | 沿用 `kind.*` |
| 分析主体 | 由 `useSubjects()` 映射 `subject_id` → 显示名；未命中显示预置用户 |
| 人数 | 可点击打开成员抽屉；可排序 |
| 最后计算时间 | 可排序 |
| 创建人 / 计算方式 | 保留（v1 PRD US-4 要求） |
| 操作 | 固定右侧，内容不变 |

- 筛选：类型 / 状态 / 分析主体（客户端过滤，选项来自当前数据 + 主体清单）。
- 排序：`member_count`、`last_computed_at`（客户端）。
- 分页：默认 20/页，可切 10/20/50。
- 轮询静默化：`load(search, { silent })`；计算中每 3 秒静默刷新——不打开 `loading`、失败不清空 `items`。仅首次加载与手动搜索显示 loading。
- 筛选后为空与项目本身无分群是两种空态：前者给「清除筛选」，后者保留创建 CTA。

### A.7 规则摘要（前端渲染，语言不进载荷）

新增 `features/cohort/cohort-summary.ts`，纯函数 `cohortSummary(definition, kind, t, eventNames)`：

- `condition`：各条件句用「且」连接；`did_event` → 「过去 7 天做过 {{事件}} 的次数 大于 0」；`sequence` → 「过去 7 天依次做过 A → B」；`user_prop` → 「用户属性 {{属性}} 大于等于 3」；`did_not` → 「没做过」。
- `id_upload` → 「CSV 名单匹配的用户」；`sql` → 「自定义 SQL 圈人」；`result` → 「来自{{来源}}分析的人数快照」。
- 事件显示名由列表页一次性 `getEvents()` 建映射；取不到则回落事件 key（用户自己的标识，不翻译）。属性名同理回落 `prop_key`。
- **服务端不下发译好的文案**（`AGENTS.md` G21/G25）：接口只给结构化 `definition_json`，翻译发生在浏览器端。

### A.8 入口类型卡与内联校验

- `features/cohort/CohortTypePicker.tsx`：三张等权卡（图标 + 名称 + 一句话说明 + 典型场景），底部说明「结果分群从事件 / 漏斗 / 留存的人数结果保存」并给一跳转分析的链接；带「取消」。
- `features/cohort/condition-validation.ts`：纯函数 `validateConditions(conditions, t)` → `{ index, message }[]`；编辑页保存与试跑前先跑它，命中则在对应条件行内联提示并中止，后端校验仍是最终权威。校验项：事件未选、序列少于 2 步或有空步骤、用户属性未选属性、比较类算子未填值。

### A.9 结构落点

| 位置 | 职责 |
|------|------|
| `modules/cohort/cohort-preview.service.ts`（新增） | 试跑编排（校验 → 拼 SQL → 执行 → 返回人数与样例） |
| `modules/cohort/cohort-condition-sql.service.ts` | 新增 `buildPreviewParts`（一条集合 SQL + 两种外层包装） |
| `modules/cohort/cohort-definition.ts` | 新增 `assertNegativeUniverseSupported`（创建 / 试跑共用门禁）与 `cohortNotFound()`（8 处重复的 notFound 收敛为一处） |
| `modules/cohort/cohort-members.service.ts` | `preview(..., keyword?)` 支持检索 |
| `modules/cohort/cohort.controller.ts` | 新增 `POST preview-condition`；`GET :id/members` 增 `keyword` |
| `features/cohort/cohort-summary.ts`、`condition-validation.ts`、`CohortTypePicker.tsx`（新增） | 摘要渲染、客户端校验、入口卡 |
| `pages/Analysis/UserCohortsPage.tsx`、`CohortEditPage.tsx` | 列表与编辑页改造 |
| `i18n/locales/<13 语言>/cohort.json` | 新增键齐备（值不得留源语言） |

---

## B. 过程健壮性

> phase: `clklog-analytics-cohort-robustness-v1`

### B.1 阶段目标与范围

与 PRD B.1 相同。全部为 `modules/cohort` 内的行为修正 + 一处 web 文案，不引入队列中间件、不改成员表结构。

### B.2 验收标准

与 PRD RB-1～RB-6 对应。交付前三项检查脚本通过。单测至少：未知 kind 拒绝重传、pending 回收只取 `pending`、看板引用计入删除确认。

### B.3 非目标

与 PRD B.3 相同。

### B.4 ID 分群重传名单

```
POST /sa/api/meta/cohorts/:id/members
权限：@RequirePermission('cohort.edit_own') + AssetPolicy assert(update)（与 PUT /:id 同一道）
body: { csv_text: string }
resp: 更新后的分群（同 PUT /:id 的返回）
```

- 仅 `kind === 'id_upload'` 允许；其他类型抛错（复用既有 `cohort.manualRefreshUnsupported` 语义不合适，新增错误码 `cohort.idUpload.onlyIdUpload`，文案走 `messageKey`，**不新增长中文兜底字面量**以保持 i18n 覆盖率棘轮只减不增）。
- 复用 `parseCsvUids` 与 `computeIdUpload`：新 `batch_id` → 写新批 → 切 MySQL → 删旧批（与现有流程一致）。
- 失败语义（RB-2）：解析/写入失败时**不动** `batch_id` 与 `member_count`，也不把状态改成 `failed`（重传是一次用户动作，失败应保留上一批成员）。与 `compute()` 的 `failed` 语义区分开。

### B.5 请求体上限

`apps/analytics-server/src/main.ts` 在全局 `json({ limit: '1mb' })` **之前**加路由级上限（与 `datatables` 现有做法一致）：

```ts
app.use('/sa/api/meta/cohorts', json({ limit: '32mb' }));
```

依据：单次最多 100 万行 ID，普通 `distinct_id` ≈ 24 字节/行（含换行）→ 约 24MB，32MB 留余量。仍超限时按 B.7 给可读文案。

### B.6 删除引用检查覆盖看板

- `CohortRepository` 新增 `findDashboardsReferencing(project, cohortId)`（`dashboard.cohort_filter_json` contains `cohort_id`，带 `project_name`，`take: 20`）。
- `CohortService.remove` 把卡片名与看板名合并进既有的 `cohort.cardReferenced` 错误参数与 `names` 兜底串（保持原模板字面量不变，仅扩展取值）。命中任一即需要 `force=1`。
- `force` 语义不变：仍可在二次确认后删除，查询侧失效分群当空集。

### B.7 超大请求体文案

`apps/analytics-web/src/services/api-error.ts` 增加 `413` 分支 → 新键 `errors:status413`（13 语言齐备），文案表达「上传内容过大」，不再落到「服务暂时不可用」。

### B.8 计算中状态回收

- `CohortRepository.listPending(limit)`：`status='pending'`，`orderBy updated_at asc`，`take: limit`。
- `CohortComputeService implements OnModuleInit`：启动后 `recoverPending()`——取最多 50 条，按 1s 间隔错峰 `enqueue`，日志打印回收条数。
- **不设年龄阈值**：进程重启时本进程没有在跑的计算，阈值只会漏掉「刚创建就重启」的正是要救的那批。回收上限 50 与错峰用于防启动风暴；若将来部署成多实例，需要加租约列（写进非目标，不在本期）。
- `running` 集合仍防同进程重复计算；某条分群计算真失败会被置 `failed`，不会每次启动都被反复重试。

### B.9 结构一览

| phase | 新包 / 扩展 | 不放哪里 |
|-------|-------------|----------|
| A | `modules/cohort/cohort-preview.service.ts`、`features/cohort/{cohort-summary,condition-validation,CohortTypePicker}` | 不把试行逻辑塞进 `cohort-compute.service`，不在服务端渲染摘要文案 |
| B | `main.ts` 路由级 body 上限、`cohort.repository`、`cohort-compute.service` 启动回收 | 不引入作业队列、不改成员表结构、不做名单追加 |
