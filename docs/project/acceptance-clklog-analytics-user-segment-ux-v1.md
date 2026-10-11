# 验收记录：用户分群体验优化与健壮性

> phase: `clklog-analytics-user-segment-ux-v1`、`clklog-analytics-cohort-robustness-v1`
> 上游：`docs/product/prd-clklog-analytics-user-segment-ux-v1.md`、`docs/architecture/clklog-analytics-design-user-segment-ux-v1.md`
> 对象：release 环境 `当时的线上入口`（project `clklogapp`）
> 执行：2026-09-20 18:0x–18:1x（北京时间）
> 脚本：`scripts/smoke-user-cohort.py`（14 例接口验收，可重复执行，临时资产前缀 `smoke_uc_` 并自动清理）

---

## 1. 发版

| 项 | 值 |
|----|----|
| 代码版本 | `764c64e`（功能）+ `7c5c059`（CI 修复）→ `master` |
| CI | pipeline **17472 红**：新增的 3 个分群 spec 顶层经 clickhouse/redis 引入 `src/config/configuration`，CI 无 APP_CONFIG_PATH 与密钥 → 套件 failed to run。按仓库既有约定加 `jest.mock('../../src/config/configuration')` 隔离后 **17473 绿**（111 suites / 808 tests） |
| 模块版本 | `<artifact-host>::metaverse-clklog_manager/master/.version` = **17473** |
| 生产版本 | `/data/project/clklog_manager/production/.version`：17454 → **17473** |
| 服务 | `supervisorctl status clklog_analytics_server` = RUNNING（重启后 uptime 归零） |
| 迁移 | `prisma migrate deploy`：43 个迁移，无待应用 |
| 前端产物 | 线上 `/sa/assets/` 分片含 `summaryColumn` / `conditionDesc` / `preview-condition`（UC-1 判定依据） |

---

## 2. 接口验收（14 例，脚本：`python3 scripts/smoke-user-cohort.py`）

| ID | 测试目的 | 期望结果 | 实测结果 | 结论 |
|----|----------|----------|----------|------|
| UC-1 | 确认 release 上跑的是本次发版的前端产物（不是旧包） | SPA 分片里出现本次新增的分群文案键与试跑调用 | `summaryColumn`=✓、`conditionDesc`=✓、`preview-condition`=✓ | PASS |
| UC-2 | 列表接口提供前端新列所需字段 | 每条分群都有 `kind`/`definition_json`/`subject_id`/`member_count`/`last_computed_at` | 分群数=1（条件=1、ID=0），缺字段=无 | PASS |
| UC-3 | 保存前能看到圈到多少人、圈到了谁 | 试跑返回精确 count>0 与示例 ID，抽检的示例 ID 确实在分群成员里 | count=18579、样例 5 个、抽检 3 个命中 3 个 | PASS |
| UC-4 | 试跑只读：不改状态、不改成员 | 试跑前后 `status`/`batch_id`/`member_count`/`updated_at` 均不变 | 四项全部不变 | PASS |
| UC-5 | 试跑口径与保存后的预计算口径一致 | 同一份条件：试跑 count == 新建分群计算后的 `member_count` | 试跑 18579 = 预计算 18579（status=ready） | PASS |
| UC-6 | 成员抽屉是服务端检索，不是只在前 1000 行里过滤 | 不存在的前缀返回 0 条；真实成员前缀能命中 | 命中=✓、不存在的前缀=0 条 | PASS |
| UC-7 | 不完整条件必须被后端挡下 | 缺事件的条件下试跑返回 400 + `cohort.condition.eventRequired` | HTTP=400、errorCode 与 messageKey 均正确 | PASS |
| UC-8 | ID 分群名单能整体替换（本次新增） | 重传后新名单 ID 能查到、旧 ID 查不到、`batch_id` 换新 | **HTTP 500**：`Estimated query execution time (150.0s) is too long. Maximum: 30. Estimated rows to process: 1131533837` | **FAIL** |
| UC-9 | 重传只对 ID 分群开放 | 对条件分群重传返回 400 + `cohort.idUpload.onlyIdUpload` | HTTP=400、errorCode 正确 | PASS |
| UC-10 | 分群路由不再用 1MB 上限拒绝请求体 | 1.2MB 请求体被业务校验拒（400）而不是 413 | HTTP=400（分群名校验） | PASS |
| UC-11 | 删除被看板引用的分群必须提示（此前漏看板） | 409 且提示里出现引用它的看板名 | HTTP=409、errorCode=`cohort.cardReferenced`、提示含刚建的看板名 | PASS |
| UC-12 | 语言契约：错误按 messageKey 下发；列表不下发译好的摘要 | 错误带 messageKey；`definition_json` 结构化且不含中文句子 | `cohort:error.condition.required`；列表 definition_json 全结构化无中文 | PASS |
| UC-13 | 没有卡死的「计算中」 | `pending` 且超 5 分钟未更新的分群 = 0 | pending=0、超时未更新=0 | PASS |
| UC-14 | 5 万行（≈1.2MB）CSV 不再被 413 挡住（RB-3/RB-5） | 不被 413 挡住（可为业务/数据侧报错） | HTTP 500「服务暂时不可用」（非 413）——请求体已被受理，卡在下游同一处扫描上 | **FAIL**（体限本身已过，见 D1） |

**接口侧结论：12/14 通过。** 2 个 FAIL 同一根因（D1），与本次代码改动无关。

---

## 3. 浏览器实测（6 例，release 真机）

登录态经 `/tmp/clklog-smoke-auth.json` 注入 localStorage（口令不落对话），窗口 1440×900。

| ID | 测试目的 | 期望结果 | 实测结果 | 结论 |
|----|----------|----------|----------|------|
| B-1 | 列表重做后能读懂、能定位 | 显示名第一列；圈人规则列渲染成一句人话；分析主体列；人数可点；类型/状态/主体筛选 | 列序为 显示名→分群名→圈人规则→类型→分析主体→人数→最后计算时间→创建人→计算方式→操作；摘要读作 `过去 7 天 做过 登录触发 的次数 大于 1`；DOM 量得 10 列、总宽 1720px（横向滚动，操作列固定右侧） | PASS |
| B-2 | 创建入口讲清楚三种类型 | 三张等权类型卡（图标+一句话+典型场景）+ 结果分群来源说明 + 取消 | 三张卡渲染正确，底部 `There is also a result cohort: … Entry point: Event analysis`，有 Cancel | PASS |
| B-3 | 保存前给出预估人数（新建态） | 点试跑后给出人数与示例 ID | `Estimated 50700 users` + 20 个示例 ID + 「仅显示前 20 个」+ 只读提示；耗时约 10s（按钮 loading） | PASS |
| B-3b | 编辑态给出与已保存人数的差值 | 显示当前已保存人数与增减方向 | `Estimated 20922 users` / `Currently saved: 17452 users · 3470 more than saved` | PASS |
| B-4 | 条件不完整时内联标红并拦下 | 条件行标红 + 行内提示，不弹后端下标式文案 | 条件行红框 + 行内 `Select an event` + 顶部提示 `Conditions are incomplete—please fix the highlighted items`，请求未发出 | PASS |
| B-5 | 成员抽屉可按 ID 检索 | 不存在的 ID 提示无匹配；真实 ID 命中 | 不存在 → `No matching user ID`；真实 ID → 命中并显示 `1 matched` | PASS |
| B-6 | 语言切换后关键页正确且无源语言残留 | `<html lang>` 与页面标题随语言变化；列表文案全中文 | 切 `简体中文` 后 `lang=zh-CN`、`title=ClkLog 分析平台`，列名/按钮/筛选/分页全中文；切 `English` 时整页英文（摘要句 `Did 登录触发 greater than 1 times in the last 7 days` 里只有事件名是用户数据） | PASS |

**浏览器侧结论：6/6 通过。**

---

## 4. 缺陷

### D1（P0，预存在）ID 分群创建 / 重传名单在生产数据量下必然 500

- **现象**：`POST /sa/api/meta/cohorts`（`kind=id_upload`）与 `POST /:id/members`（重传）返回 500，
  ClickHouse 原文：`Estimated query execution time (111–150s) is too long. Maximum: 30. Estimated rows to process: 1131—1131.5M`。
- **根因**：`CohortConditionSqlService.buildIdUploadInsert` 的「名单里的 ID 是否出现过」检查是对
  `sa_events` 的**全历史扫描**，过滤条件写在 `if(user_key != '', user_key, distinct_id) IN {uids}` 上，
  走不了主键/跳数索引；表已 亿级行，CH 在执行前的估算就直接拒绝（连 2 个 ID 的名单也一样）。
- **归属**：`buildIdUploadInsert` 本次未改动（`git diff dea732f..HEAD` 该文件仅新增 37 行试跑代码），
  是**预存在缺陷**；本次新增的重传功能继承了同一路径，因此 UC-8/UC-14 无法在真实数据量下通过。
  项目当前也**没有任何 ID 分群**（UC-2 实测 ID=0），与该路径长期不可用一致。
- **影响**：ID 分群（上传名单圈人）与本次新增的「重传名单」在生产上不可用；前端会看到 500「服务暂时不可用」。
- **建议**（三选一，需产品/架构帽确认，不在本次改动内）：
  1. 把存在性校验的宇宙从 `sa_events` 换成 `sa_user_profiles`（一人一行，量级小两三个数量级），
     语义从「事件里出现过」改为「画像里出现过」——需更新 v1 设计文档 §6；
  2. 保留双表校验但对 ID 上传单独放宽 `max_execution_time`（如 300s）并接受一次重扫；
     代价是一次全表扫描，需评估对生产 CH 的压力；
  3. 给 `sa_events` 的主体表达式加跳数索引（`ngrambf_v1`/`tokenbf_v1`）或物化列，
     走分析域 DDL 演练流程；一次到位但改动最大。

### D2（P1，预存在）创建失败的 ID 分群会留下永久 `pending` 行

- **现象**：D1 的 500 发生在 `repository.create` 之后、`computeIdUpload` 之中，行已落库且 `status=pending`，
  列表会显示「计算中」并每 3 秒轮询；只有重启（回收逻辑把 `id_upload` 判为不支持 → `failed`）才会自愈。
- **证据**：本轮 UC-14/UC-8 各留 1 条 `smoke_uc_*` pending 行，脚本清理阶段按前缀扫出并删除（`清理：临时分群 3/3`）。
- **建议**：`create` 里把「先落库再计算」改成 ID 分群先解析校验、失败即回滚删除该行（或统一置 `failed` 并写 `compute_error`）。

### D3（P2，本次引入）英文界面下「类型」标签溢出列宽

- **现象**：`Conditional cohort` 标签宽约 130px，类型列宽 110px，溢出后与「分析主体」列内容贴在一起无间隙；
  中文 `条件分群` 正常。
- **建议**：类型列 `width: 110 → 150`（一行改动），或英文标签改短词（`Condition`）。

### D4（P2，观察）列表横向宽度 1720px，人数/最后计算时间需横向滚动才可见

- 1440 视口下内容区约 1198px，10 列必然横向滚动（旧版 8 列 1290px 同样要滚）。
- **建议**：把「创建人 / 计算方式」并成一列或折叠进「更多」，或让摘要列可收起；不改也能用（操作列已固定）。

### D5（预存在，i18n 边界）分析主体列在英文界面显示库里存的「用户」

- 预置主体在库里的 `display_name` 就是「用户」，属**服务端下发的展示名**，按 i18n 规范应由服务端只下发 key、
  前端在渲染边界翻译（`AGENTS.md` G21/G25）。现有 `SubjectSelect` 与本次新增的「分析主体」列都直接显示原值。
- **建议**：单开 phase 修 subject 模块的展示名下发布（连同分析表单一起），不在本次范围。

---

## 5. 结论

- 本次发版的**体验与健壮性目标**（试跑预估、列表重做、成员检索、类型卡、内联校验、看板引用检查、请求体上限、pending 回收、13 语言文案）在 release 上**逐条实测通过**：接口 12/14，浏览器 6/6。
- 未通过的 2 例集中在 **ID 分群名单路径（D1）**，是预存在缺陷、被本次验收首次打出，需按 §4 的建议先定方案再改。
- 临时资产已清理（脚本按 `smoke_uc_` 前缀兜底扫描删除）；未改动任何现网分群与看板数据。
