# 架构：时区系统 v2（用户偏好 / 项目级 / 通知按收件人时区）

> phase: clklog-analytics-timezone-v2
> 帽子：架构（`docs/architecture/`）
> 产品：[PRD](../product/prd-clklog-analytics-timezone-v2.md)
> 依赖：v1 的 `src/modules/time/`（calendar/timezone/time-scope/format）与 TimeScope 双路径（恒等快路 + 宽扫精切）

---

## 1. 目标、范围与验收

v1 契约不动；本期在解析链两级之间插入两层非空可查的时区，并保持「全空 = v1 行为」恒等。验收对齐 PRD SC-1～6。

## 2. 时区解析链（契约）

| 概念 | 解析顺序 | 缺省终值 |
|---|---|---|
| `displayTz`（查询/展示） | `time_range.timezone` → 用户 `SaUser.timezone` → 项目 `SaProject.timezone` → 平台 | 平台 |
| `statTz`（落库日历/扫描基准） | 项目 → 平台 | 平台 |
| 告警求值窗 | 项目 → 平台 | 平台 |
| 通知时区 | 联系人 → 项目 → 平台 | 平台 |

`TimeScope.isPlatformCalendar` 语义精化：恒等条件由 `displayTz === platformTz` 改为 **`displayTz === statTz(project)`**（同一基准日历即可走与历史逐字节一致的快路；v1 无 project 字段时项目为空 → statTz=platform，自动等价）。

## 3. 数据与模型（Prisma 迁移一组）

```sql
ALTER TABLE `SaUser`       ADD COLUMN `timezone` VARCHAR(64) NULL;
ALTER TABLE `SaProject`    ADD COLUMN `timezone` VARCHAR(64) NULL;
ALTER TABLE `AlertContact` ADD COLUMN `timezone` VARCHAR(64) NULL;
```

三列皆可空（= 跟随上级，零变化）。非法值在写入端拒绝（共享 `isValidTimeZoneName`），DB 层不再二次校验。

## 4. TimeModule 扩展

| 新增 | 职责 |
|---|---|
| `project-time-registry.ts`（服务） | `SaProject.timezone` 的**同步语义注册表**：启动时全量加载 + 60s 周期刷新 + 未命中即返平台并触发后台补拉（失败 fail-open 平台）。两大消费者：① TimeScope.statTz（查库日异同判定，必须同步，否则生成器全改 async）；② ingestor 写 `stat_date`（热路径，T＝分钟级漂移接受） |
| `TimezoneService.resolveUserChain(range, {authUserTz, projectName})` | 按 §2 链产出 `{displayTz, statTz}`；校验任何显式/偏好输入 |

`TimeScopeService.materialize(range, options)` 增加 `authUserTz?: string`、`projectName?: string`（两者可选，缺省即 v1）；`isPlatformCalendar` 按新语义判定，SQL 形态与参数不变。

**注意**：registry 不缓存 `SaUser.timezone`（not needed：用户偏好经 `AuthUser.timezone` 直接送达）。

## 5. 各模块改动

### 5.1 认证与偏好

- `AuthUser` 增 `timezone?: string | null`（`toUser`/login/me 带出；`validateToken` 同源）。
- `PUT /auth/preferences` 增 `timezone`（部分更新语义保持；非法值 400 `auth.timezone.invalid`）。
- 修改 `SaUser` 接口与 prisma 用户 select。

### 5.2 查询链路（displayTz 进链）

- 四个查询 controller（event/funnel/retention）与 report controller：`@CurrentUser() user` → service.analyze(..., `authUserTz = user.timezone`)；看板刷新 worker（CardCacheService）无用户 → 按链落项目/平台。
- `dsl-validator.validateTimeRange` → `TimeScopeService.materialize(range, {authUserTz, projectName: query.project})`；快照与校验行为同 v1。

### 5.3 落库（statTz 生效面）

- `SaEventFlattener`：`stat_date = formatChDate(logTime, registry.statTzSync(projectName))`；`log_time`/其它列时区无关（epoch 等价渲染），照旧平台时区格式化（语义不变，只换渲染参数来源——实事上 `formatChDateTimeMs` 对同一 epoch 任何 tz 写出的是同一 instant，保持平台渲染即可：行为不变，不扩散风险）。**唯一改变的是 stat_date 日历**。
- profile writer 同样仅 stat_date 语义位不适用（updated_at 为 instant），保持平台。

### 5.4 预计算与告警

- `cohort/tag compute`：`computeDay(await registry.statTzFor(project_name))`（async 路径 apology 无变）。
- 告警指标窗：`AlertMetricEvalService` 窗口 today = stat tz of `rule.project_name`；trigger overview（fired_today）保持平台口径（PRD §3 表格未含）。
- 通知渲染：detector 的 per-contact 渲染循环中 `time: formatInTz(new Date(), contact.timezone ?? registry.syncTz(rule.project_name) ?? platform)`；模板预览等服务端渲染同口径补正（若含联系人覆盖）。
- 质量对拍、慢查询、Grafana：保持平台（PRD 非目标 3）。

### 5.5 项目管理 API

- `PUT sa/api/iam/ops/projects/:name/timezone`，`@RequirePermission('ops.owner.assign')`；body `{timezone: string | null}`；非法 400（`iam.project.timezoneInvalid`）；写后使 registry 立即失效该项（下次读回源）。
- 项目列表 `GET sa/api/iam/projects` 返回项附 `timezone`（前端选择器/调试可见）。

### 5.6 联系人

- prisma/服务层：`AlertContact.timezone` 透传；DTO（Create/UpdateContactDto）加 `timezone?: string | null`（正则+Intl 双重校验，失败 400）。
- 通道 sender 模板渲染已在 detector 循环内 —— §5.4 一点生效即全链路生效。

## 6. 前端

| 落点 | 内容 |
|---|---|
| `features/time-range/TimeZoneSelect.tsx`（新小组件） | 从 TimeRangePanel 内联抽出 IANA 选择器（showSearch + 偏移），供面板/Profile/联系人复用；禁止放 components/ 杂物层，留 time-range feature |
| `resolve.ts` | `displayTz` 链前端镜像：`range.timezone` → `userTimeZone`（auth.user.timezone）→ `projectTimeZone` → 平台；`setUserTimeZone/setProjectTimeZone` 两 setter + `getPlatformTimeZone` 不变 |
| LoginPage/MainLayout | login 后 `setUserTimeZone(res.user.timezone)`；MainLayout 引导 me() 同款；项目切换（`ProjectSelector` onChange）触一次项目列表查 tz → `setProjectTimeZone` |
| ProfilePage | 「显示时区」卡片（TimeZoneSelect，默认跟随）；保存 `updatePreferences({timezone})` |
| `iam.service`（web）projects 类型 | 返回加 `timezone` |
| 联系人面板 | 时区字段（TimeZoneSelect，默认跟随项目/平台） |
| Me 同步 | `api auth` 类型加 `timezone`、`platform_timezone`（已有）区分注释 |

## 7. 测试

| 层 | 用例 |
|---|---|
| registry | 加载/刷新/失败 fail-open/显式项失效自己解决（jest timer） |
| TimeScope 链 | 四级优先级矩阵 + statTz≠platform 时恒等判定（display==stat 走快路） |
| auth | preferences timezone 写入/非法 400/部分更新不清其他字段 |
| ingest | flattener stat_date 随项目 tz（mock registry）：纽约项目 00:30 上海事件落纽约前日 |
| alert | detector rendering：两联系人（UTC / 未设）通知 time 文本相差 8h，语言不受影响；窗口今日口径随项目 |
| controller | 项目时区管理端点：写、非法 400、权限拒绝 |
| 前端 | resolve 链优先矩阵、Profile 保存调用参数、TimeZoneSelect 复用渲染 |

## 8. 兼容、回滚与风险

- 全列可空 → v1 行为零变化（恒等路径 golden 原样过）。
- 一次迁移：本期只上「时区随人走」一个风险轴；graphql 结构与 DSL 不变（参数只加字段）。
- 风险：项目 stat_date 切日跨日界后数据归属「时钟跳变」且不回溯——PRD §4-1 声明 + 操作入口藏在超管权限后；分群首日重算边界声明确认（PRD §4-2）。
- registry 热-path 风险：仅 60s TTL 与单表小读，fail-open 设计不允许故障放大（单测模拟 prisma throw）。
- 回滚：代码回退即可（表列残留为空无害）；不需要反向迁移。

## 9. 非目标（同 PRD §5）

+ 质量对拍按项目日历重做；distinct 用户列表的时区二次对齐；界面化项目设置页；多时区对比视图。
