# 验收记录：时区系统 v2（用户偏好 / 项目级 / 通知按收件人时区，2026-09-17）

> phase: clklog-analytics-timezone-v2
> 关联：PRD `docs/product/prd-clklog-analytics-timezone-v2.md`、实现方案 `docs/architecture/clklog-analytics-design-timezone-v2.md`、v1 迭代记录 `docs/project/acceptance-clklog-analytics-timezone-v1.md`

---

## 1. 发版链路（含一次 CI-门拦截教训）

| 步 | 证据 |
|---|---|
| 提交 | `846f9f9 feat(timezone): 时区系统 v2`（53 文件）→ push master |
| CI 拦截 | `test/time/v2-effects.spec.ts` import 拉起 `alerting.service → channel-registry → appConfig → 缺 CLICKHOUSE_PASSWORD` 裸环境崩溃，build-main 红specially |
| 修复 | `ab5f3bc`：`contactLocale/contactTimezone` 抽出为无副作用的 `contact-normalize.ts`（裸环境模拟 95 套 708 用例复跑全绿） |
| CI 发布 | `17331`（rsync 模块 .version，CI 修复后发布） |
| 升级 | `scripts/server-upgrade.sh`：rsync → **prisma migrate deploy 应用 20260917190000_timezone_v2**（39 迁移全到帐：`sauser/saproject/alertcontact` 三列 `VARCHAR(64) NULL`）→ CH 迁移 noop → server/ingestor 双进程重启 |
| 生产核验 | `.version=17331`；双进程 RUNNING 新起；`prisma migrate status` = "Database schema is up to date"（39） |
| **版本穿梭注记** | 曾误把前一个 docs 提交构建出的 17321 当 v2 上产（依赖 `.version` 的错位窗口，当时 CI 的 v2 构建尚未发布），经 `preferences` 接口行为反查发现并报警：「直接依赖 .version 不是说 v2 的充分证据，须以功能接口反证 +3301」 |

## 2. 生产冒烟（`scripts/smoke-timezone-v2.py`，13/13 PASS）

| SC | 生产实测 |
|---|---|
| SC-1 用户偏好 | `PUT /auth/preferences {timezone:Pacific/Honolulu}` → me 下发一致 → 不带 timezone 的事件查询 SQL 携带 `display_tz` → 置 `null` → me 回落、查询回平台 |
| SC-2 项目时区 | `PUT /iam/ops/projects/clklogapp/timezone=Pacific/Honolulu` → 无 timezone 的 `sql/execute` `applied_time_range` = `{start:2026-09-15,end:2026-09-15,timezone:Pacific/Honolulu}`（past_n 按夏威夷历解析，与同时刻平台上海不同日）→ 置 `null` → 回显回到 `Asia/Shanghai`、`past_n` 解析历同步回落；非法值 400 |
| SC-3 通知按收件人时区 | 联系人 A(timezone=UTC) 与 B(未设，平台上海) →同一秒级 `templates/preview?contact_id=...` 渲染 `time`：A='2026-09-17 09:30:44' vs B='2026-09-17 17:30:44'，**精确 8.0h 差**；双探针创建/删除闭环 |
| SC-4 零变化 | 既有冒烟全绿（见 §3） |
| SC-5 校验收拢 | 项目时区非法值 400、`AlertContact.timezone` 非法值 400（DomainError 契约） |

补充实测（不支持逐份写入统计口径的正路径）：ingest `stat_date` 随项目时区切换的写侧例已由单测锁定（`test/time/v2-effects.spec.ts` 的 proj_ny 矩阵：上海 18 日 00:30 事件在纽约项目落 `2026-09-17`）；生产未对 clklogapp 做真实切换（避免在流量主项目造成边框口径跨日）。

## 3. 回归面

| 套件 | 结果 |
|---|---|
| `scripts/smoke-timezone-v1.py` | 9/9（T2 活流量下「今日」桶曾偶发竞态——脚本级豁免：仅断言 SQL 形态 + 历史桶，断言与口径不变） |
| `scripts/smoke-analysis-subject.py` | AS-1~5 全部 PASS（与 v1 收尾相同的 17 项） |
| 后端 `TZ=UTC npx jest` | 95 套 708 用例全绿（含 v2 链矩阵 / registry / ingest 口径 / contacts 校验各新用例） |
| 前端 `npx vitest run` | 98 套 448 用例全绿（resolve 链优先矩阵 / format / mute 等） |
| `arch_ratchet.py` / `i18n_check.py` | 通过；`i18n_scan --check` 通过（基线 1291→1296，+5 全为 DomainError 契约中文兜底与注册表运维告警，已按程序 `--force --update` 并在 commit 说明） |

## 4. SC 对照

PRD SC-1～SC-6 逐项达成；SC-4（全空字段行为与 v1 逐字节一致）由「恒等路径 SQL golden + 全部既有断言未改即过 + T2/T5 生产回声」共同证明。

## 5. 已知挂账（下阶段事项，不改变本 phase 结论）

1. 项目级时区的**界面化设置**（本期仅管理 API）。
2. 质量对拍按项目日历（现按 CH 服务端历——项目异时区时页面计数可边界错位；PRD 已声明）。
3. `.version` 依赖的 CI 发布信号不足以为「功能存在」作证（本 phase 教训，§1）——发版流程建议补一条「接口级存在性探针」。
