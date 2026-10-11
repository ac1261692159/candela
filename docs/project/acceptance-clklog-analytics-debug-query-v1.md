# 验收记录：Debug 实时查询（口径修正 + 窗口可选 + 查询留档）

> phase: `clklog-analytics-debug-query-v1`
> 验收日期：2026-10-08
> 对应 PRD：`docs/product/prd-clklog-analytics-debug-query-v1.md`
> 对应实现方案：`docs/architecture/clklog-analytics-design-debug-query-v1.md`
> 问题来源：`docs/project/test-report-debug-query-2026-10-08.md`
> 状态：**已发版并在生产环境完成验收**（AC-8 见 §5 未覆盖）

---

## 1. 发版记录

| 版本 | 提交 | 内容 |
|---|---|---|
| 17648 | `8373b6f` | docs：测试报告 + PRD + 实现方案 + INDEX 全量扫描 |
| 17648 | `f5818e6` | 代码：时间/计数口径修正（D1/D2）+ 窗口可选与 stat_date 裁剪（D3）+ 参数校验（D4）+ 查询留档与项目级开关（F1/F2）+ 13 语言文案 + 迁移 `20261008120000_debug_query_record` |
| 17648 | `d64e557` | 顺手修 `test/ops/data-mgmt-actions.spec.ts` 的日期依赖（跨月即红，与本 phase 无关但挡 CI） |
| 17648 | `2313950` | **CI 红过一次并修复**：两个新用例套件在 `env -i` 空环境 import 时拉 `clickhouse.service → configuration`，读 `CLICKHOUSE_PASSWORD` 抛错（本地有 .env 掩盖）。按仓库既有写法补 `jest.mock` appConfig；`env -i` 下 125 套件 / 958 用例连跑 5 次全绿 |

**就绪判据**（按 `AGENTS.md`：不以 `.version` 为准）：模块里出现新文件 `server/dist/src/modules/meta/debug-archive.service.js`（8990B）、`debug.service.js` 命中新符号 `matched_total`（同时用旧符号 `project_name = {project: String}` 自验核验方法可用）、以及新迁移文件 1964B。

**升级后核对**：生产 `.version` 17602 → **17648**；`supervisorctl status` 两个进程 RUNNING；
迁移落库（`_prisma_migrations` 有 `20261008120000_debug_query_record`）；`saproject.debug_archive_enabled` 存在且默认 1；`metadebugrecord` / `metadebugrecordrow` 建表成功；前端新 chunk `DebugPage-DoNOe2Y5.js` 含新文案键。

## 2. 生产实测（2026-10-08，`clklogapp` 项目，浏览器 + 直查对拍）

| 编号 | 判据 | 实测 | 结论 |
|---|---|---|---|
| AC-1 | 时间列不偏 8 小时 | `event=pet_name_change`（7 天）：界面 `2026/10/01 12:13:51`，ClickHouse `log_time = 2026-10-01 12:13:51.790` —— **完全一致**（改动前显示 `20:13:51`） | ✅ |
| AC-2 | 命中总数 ≠ 返回数 | `distinct_id=样例标识`（7 天）界面「命中 24,279 条 · 已显示最近 20 条」；把窗口钉在查询时刻（`since=1790824827`）直查 `count()` = **24,279**（精确一致）；**对照组**（同一窗口不加 `stat_date` 谓词）= 24,279，证明裁剪谓词不改变结果 | ✅ |
| AC-3 | 默认 24h 按设备查询 <3s | 24h + 设备：服务端响应 **2.3s**（界面 3s）；命中 3,136 条 = 该窗口直查 3,136 | ✅ |
| AC-4 | 非法参数 400 且不外泄引擎报错 | `limit=abc` → 400 `meta.debug.invalidLimit`；`window=30d` → 400 `meta.debug.invalidWindow`；`limit=1000` → 200 且收敛为 100；响应体内无 ClickHouse 文本 | ✅ |
| AC-5 | 查询自动留档且持久 | 列表出现每条查询记录（时间/条件/命中·返回/操作人）；**重载页面后仍在**（落 MySQL） | ✅ |
| AC-6 | 回看与当时一致 | 详情弹窗含条件、操作人、命中/返回、耗时；20 行快照与当时返回逐行一致（首行 `2026/10/07 13:04:28 base_ui_open_trigger`） | ✅ |
| AC-7 | 删除 + 审计 + 不动 `sa_events` | UI 二次确认「确定删除这条留档？删除后不可恢复」→ toast「已删除」→ 列表消失；库内记录与子行级联删除（快照行数按 20+20+1+0 关系守恒）；`ops_action_log` 出现 `meta_debug_record_deleted`（含 record_id/条件/命中数）；`auth_` 前缀审计条数未变（151，未被污染）；被删记录对应的 `pet_name_change` 行**仍在 `sa_events`** | ✅ |
| AC-8 | 截断标注 | **未在生产数据上复现**（§5） | ⚠️ 见未覆盖 |
| AC-9 | 权限 | ① `analyst`（无 `meta.view`）对 `/records`、`/query`、`/archive-setting` 三接口**全部 403**；② `analysis_admin`（有 `meta.view`、无 `ops.owner.assign`）`PUT /archive-setting` **403**；③ 删除按「创建者 / 超管 / 持 `meta.edit`」执行 —— 见 §4 观察项 | ✅ |
| AC-11 | 裁剪口径可见 | 说明条固定展示「查询会附带 stat_date ≥ 起始日 - 2 天的下界；设备时钟偏差超过 2 天的行不在结果中」 | ✅ |
| AC-12 | 开关关闭不落档 + 如实提示 | 关：toast「已关闭留档」+ 卡片警示「本项目已关闭留档，本次结果不会保存」，查询照常返回但列表**不新增**；开回：toast「已开启留档」，再查 → 「本次结果已留档」且列表新增 1 条 | ✅ |
| AC-10 | 门禁 | 本地：后端 `nest build` + 958 用例、前端 `tsc && vite build` + 622 用例、`arch_ratchet` passed、`i18n_check`（13 语言 × 16 命名空间 3793 键）、`i18n_scan --check`（基线 1417 → 1420，+3 为 meta 模块 3 行中文**日志**，与仓库日志风格一致，已按规程 `--force --update` 并在提交说明写原因） | ✅ |

## 3. 上线前抓到并修掉的真 bug（记录在案）

`stat_date` 下界最初写成「今天 − 2 天」，**丢掉了窗口长度**：7 天窗被悄悄截成 2 天。
生产复核证据：单设备命中 27492 → **8102**、`fish_open` 4 条 → **0 条**；改为「窗口起点 − 2 天」后与老形状逐值一致。
单测只断言 SQL 形状，是拿生产数据复核才暴露；已补回归用例（`debug.service.spec.ts`「stat_date 下界从窗口起点算」）并把陷阱写进实现方案 §1.3。

## 4. 观察项

1. **删除权限面在当前权限目录下等价于「所有能看该页的角色都可删」**：`meta.view` 只授给 `project_owner` / `analysis_admin`，而这两个角色**同时**持有 `meta.edit`（`analyst` / `member` / `external` 连页面都看不到）。所以 PRD 里「创建者 / 超管 / 持 `meta.edit`」三档实际退化为「能看即可删」；「仅创建者」一档目前不可达（逻辑已由单测覆盖：他人且无 `meta.edit` 也不是超管 → 403）。若要真正收紧，需为 Debug 留档引入独立权限码，属产品后续决策。
2. **空结果也会留档**（有意为之）：验收中一次误操作（窗口选错）产生了「命中 0 条」的留档，列表里如实呈现 —— 符合 PRD「查过但当时没有数据也是排查信息」。
3. **验收动作留下的审计**：`ops_action_log` 现有 `meta_debug_record_deleted` × 7、`meta_debug_archive_toggled` × 2（开关关→开各一次）。审计不清除（红线 6 的留痕要求），如需归档由运维另处理。
4. 验收期间服务器上正跑着应用自带的对拍查询（亿级行），AC-2/AC-3 的耗时数字是在该负载下取得的。

## 5. 未覆盖 / 遗留

| 项 | 状态 | 说明 |
|---|---|---|
| AC-8 截断标注 | 未在生产复现 | 需构造超过 32KB properties 的行（属写 `sa_events`，红线内不做）。抽样证据：验收产生的 48 行快照最长 1646 字符、`properties_truncated` 全为 0。截断逻辑由单测覆盖（32KB 单行截断不切断多字节字符、1MB 单条按 seq 丢弃剩余行并置 `truncated`），界面「本次记录不完整（已超限截断）」文案与渲染由前端用例覆盖 |
| 其它语言界面 | 未逐个实机点开 | 键集/占位符由 `i18n_check` 保证一致，仅 zh-CN 做了界面实测 |
| 并发多用户 | 未测 | 单用户顺序操作 |
| 跳数索引 / 异步查询 | 未做（按决议） | `bloom_filter` 索引需先在 `clklog_sa_staging` 演练；异步任务队列为后续 phase |
| 模块版本领先生产 | 已知 | 本次验收后仅提交文档，CI 会把模块 `.version` 推高而生产保持 17648（文档不影响产物，无需重新发版） |

## 6. 清理（已完成）

| 项 | 处置 |
|---|---|
| 临时会话 token | 管理员 token 已从 `sausertoken` 删除 |
| 临时账号 | `zz_debug_verify`（analysis_admin，验收中途降为 analyst 验权限）：token / 成员关系 / 账号全部删除，`sausertoken` 与 `sauser` 无 `zz_` 残留 |
| 验收留档 | 5 条测试留档（4 条管理员 + 1 条临时账号）已通过接口删除，`metadebugrecord` / `metadebugrecordrow` 归零 |
| 项目开关 | `debug_archive_enabled` 已回到默认 `true`（`clklogapp` / `default` 两项目均已核对） |
| 业务数据 | 只读对拍，未写入/删除 `sa_events` 任何行 |
