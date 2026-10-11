# 验收记录：时区系统 v1 生产发版（phase: clklog-analytics-timezone-v1，2026-09-17）

> 关联：调研 `docs/product/research-clklog-analytics-timezone-v1.md`、PRD `docs/product/prd-clklog-analytics-timezone-v1.md`、实现方案 `docs/architecture/clklog-analytics-design-timezone-v1.md`（§13 实施记录与差异登记）

---

## 1. 发版链路证据

| 步骤 | 结果 |
|---|---|
| 提交 | `1ac89e1 feat(timezone)`（97 文件，剔除并行会话的开源准备文件：OPEN.md / harness 4 包 license / LICENSE+NOTICE 未纳入本次） |
| 推送 | `e27862b..1ac89e1  HEAD -> master`（禁止 force 遵守 ✅） |
| CI | rsync 模块 `.version` 17306 → **17311**；产物含 `server/dist/src/modules/time/*.js`（15:02:47 构建） |
| 升级 | `scripts/server-upgrade.sh` 经隧道执行：rsync 生效、prisma migrate **noop**、CH 迁移 noop、ai_workspace init 幂等、server 重启 |
| 进程核验 | `.version=17311`；`supervisorctl status` 双进程 RUNNING（uptime 刚起）；`/proc/<pid>/environ` 含 `TZ=UTC`（server=1、ingestor=1） |
| 配置核验 | `/data/app/clklog_manager/server/configs/config.yaml` 等于 rsync 模板，含 `analytics.timezone: Asia/Shanghai` |
| 前端核验 | 线上根目录 `/data/app/clklog_manager/web → /data/project/clklog_manager/production/web`；`followPlatform`（时区选择器）出现在 `TimeRangeControl-*.js` 等（时间戳与本发版一致，非旧 chunk） |
| 进程时区防线 | `/etc/supervisord.d/clklog_analytics_{server,ingestor}.ini` 追加 `TZ="UTC"`（备份 `.tz-bak`；仓库 `scripts/supervisord-clklog-manager.conf` 模板已同步含 TZ=UTC）。**修复插曲**：追加位置在 ALERT_CONFIG_KEY 转义引号对之后会触发 supervisord 解析错；已改放行首，`reread/update` 通过 |

## 2. 既有冒烟回归（服务健康基线）

`python3 scripts/smoke-analysis-subject.py`：14/15 PASS。唯一失败 `AS-2.property_expr`（users=0.0、SQL 缺 `JSONExtractString`），复查为**属性主体 uid expr 解析出 `nullIf('', '')`**：

- 定位：本次发版 diff（`git diff e27862b..HEAD --stat`）**零触及** subject 链路任何文件；`f1baaa7..HEAD` 全区间亦无 subject 链路提交。
- 影响面：默认主体查询正常（default_user 17364 人 PASS）；属性主体（`asub_*`，kind=property）查询窗口退化。
- 处置：登记为本验收的**遗留问题**（建议回转给 subject/isolation 会话），不纳入本 phase 范围、不回滚发版（时区闭环全部独立成立、且其它 14 项通过）。

## 3. 时区闭环冒烟（`scripts/smoke-timezone-v1.py`，9/9 PASS）

| 用例 | 结果 |
|---|---|
| T1 login / me 下发 `platform_timezone=Asia/Shanghai` | PASS ×2 |
| T2 恒等路径：无 timezone 与显式 `Asia/Shanghai` 事件查询 rows 逐字节一致、SQL 无 `display_tz`（SC-6 生产面） | PASS（rows=4 一致） |
| T3 UTC：SQL 含 `fromUnixTimestamp64Milli` epoch 精切 + `toStartOfDay(log_time, {display_tz:String})` 桶参数；宽扫参数在 | PASS |
| T3 America/New_York：查询 200、rows=4 | PASS |
| T4 非法时区 `Mars/Olympus` → 400 + `errorCode=analysis.time_range.timezone_invalid` | PASS |
| T5 自定义 SQL：`applied_time_range` 回显 `{start,end,timezone}`，恒等=`Asia/Shanghai`、UTC=`UTC` | PASS ×2 |
| T6 告警 overview 活着（fired_today 平台零点后逻辑） | PASS |

## 4. 上报回归与 ZQ-1 生产例证（进程 TZ=UTC 下）

链路（控制器：receiver → CKafka → ingestor → `clklog_sa.sa_events`）：

| 探针事件 | 客户端 epoch（已知真值） | 落库 log_time | 落库 stat_date | 期望 | 判定 |
|---|---|---|---|---|---|
| `tz_v1_probe_e1_now` | 1789629762403（UTC 07:22:42.403 → 上海 15:22:42.403） | `2026-09-17 15:22:42.403` | `2026-09-17` | 上海墙钟与原 epoch 分毫不差；stat_date=上海今天 | ✅ |
| `tz_v1_probe_e2_sh_0030` | 上海 00:30（UTC 昨日 16:30） | `2026-09-17 00:30:00.000` | `2026-09-17` | 上海日历今天，**不是** UTC 的昨天 | ✅ |

**ZQ-1 关闭生产证据**：采纳数千万行/日的同一条链路，但 ingestor 进程运行在 `TZ=UTC` 环境，写串仍按平台时区渲染——旧实现按进程本地时区渲染（在 `TZ=UTC` 下会把 e2 写成 2026-09-16/昨日）。社区版 `clklog.log_analysis` 同批上报链路行数同步增长（+4,589 vs sa_events +3,740，流量与小区间差在既有窗口内）。
收尾：探针事件元数据经 `POST /meta/events/batch`（action=delete）软删清理（affected=2）；数据行按既有 TTL 周期留存（与 test_report.py 同类测试流量同口径）。

## 5. SC 验收对照

| SC | 判定 | 证据 |
|---|---|---|
| SC-1 单点收敛 | ✅ | 上海字面量默认常量仅 `DEFAULT_PLATFORM_TZ`（后端 calendar.ts、前端 resolve.ts），其余经单点服务/配置（commit 内 rg 清单） |
| SC-2 进程时区无关 | ✅ | `TZ=UTC` 与 `TZ=Pacific/Auckland` 双跑 93 套件全绿 + 生产进程 `/proc/*/environ` `TZ=UTC`（§1） |
| SC-3 ZQ 清零 | ✅ | `test/time/zq-closure.spec.ts`（ZQ-1/2/4/8-② 锁定）+ 单元断言（ZQ-3/5/6 改造点） |
| SC-4 平台时区可配置 | ⚠️ 半 | 配置链路 + 非法 fail-fast 单测 + me 下发已证；**未在生产切非上海**（属部署期动作，留待真正需要时按文档执行） |
| SC-5 查询口径时区化 | ⚠️ 近全 | 生产 SQL 形态（UTC/纽约）+ 边界事件 e1/e2 日志 + 本地 8 用例 golden；「三时区行数矩阵」形式化对比列为按需补测项 |
| SC-6 零变化兼容 | ✅ | 恒等路径 SQL 逐字节一致（既有 golden 未改未变）+ T2 rows 一致 + 全量既有测试未改断言通过 |
| SC-7 展示贯通 | ✅ | 前端 chunk 上线 + `format.spec.ts` 檀香山环境装载用例；浏览器端人工观感核查列为运营可选动作 |
| SC-8 门禁 | ✅ | `arch_ratchet` 通过；`i18n_check` 通过；`i18n_scan --check` 通过（基线 1290→1291 已按程序 `--force --update` 并说明） |

## 6. 未做（按设计/PRD 的非目标与本验收的真实缺口）

1. ingestor 未切 `DateTime64(3)` 整数 epoch 写入（Gate-0-3 实测待做；当前显式平台时区字符串与现网数据逐字节一致）。
2. 平台时区切非上海的运维演练与通知按收件人时区、用户偏好、项目级时区（§12 后续 phase）。
3. 客户端时钟漂移治理（未来 stat_date 样例仍存在，ZQ-8-⑤）。
4. AS-2.property_expr 缺陷归属与修复（§2 遗留）。

---

## 7. 验收补记：尾巴闭环（2026-09-17 二次发版 `d1df48b`）

### 7.1 AS-2.property_expr 根因与修复（尾巴 1）

- **根因**：`subject-expr.ts` 的 `PROP_KEY`（`^[a-zA-Z_][a-zA-Z0-9_$.-]{0,63}$`）不允许 `$` 前缀；
  神策系属性（`$os` 等）在 `propExtract` 回落为 `''`，属性主体 uid 表达式变成 `nullIf('', '')`，
  统归为 0 人、SQL 中无 `JSONExtractString`。与 `dsl-validator.service.ts` 2026-09-15 已修的
  `PROP_KEY_PATTERN` 属同一家族（正则拒绝 `$`），路径不同漏改。
- **修复**（`d1df48b`）：`PROP_KEY` 与 dsl-validator 口径拉齐 `^\$?...`；注入面不变
  （危险输入仍回落空主体），`test/subject/subject-expr.spec.ts` 回归锁定。
- **复验**：`TZ=UTC npx jest` 93 套件 694 用例全绿；二次发布 `.version 17319`（CI 17314+ → 生产 17319，双进程重启）；既有冒烟 `smoke-analysis-subject.py` **17/17 PASS**（含修复前的 AS-2.property_expr）；时区冒烟同环境复跑 **9/9 PASS**。

### 7.2 SC-5 三时区行数矩阵（尾巴 2-a，生产实测）

两枚已知时刻探针（A=`2026-09-16T21:59Z`、B=`2026-09-17T22:01Z`）按事件名 × 时区 × 行数实测（行统计排除 `__stage` 汇总行；探针元数据已软删）：

| probe | Asia/Shanghai | UTC | America/New_York |
|---|---|---|---|
| A（上海 17 日 05:59 / UTC 16 日 / 纽约 16 日） | **1** | 0 | 0 |
| B（上海 18 日 / UTC 17 日 22:01 / 纽约 17 日） | 0 | **1** | **1** |

与手算逐行一致 → **SC-5 由「近全」升为 ✅**。注：初次实测把 `__stage` 阶段汇总行计入造成「每格 2」，复查 CH 两库各仅 1 行，无入库重复，归入探针脚本口径（已记录勿复演）。

### 7.3 Gate-0-3（尾巴 2-b，生产 CH 23.2.1 实测）

- 3a 参数绑定：`SELECT fromUnixTimestamp64Milli({ms:Int64})` 与 `toDateTime64({ms:Int64}/1000, 3)` 正确返回（桶参数 `{display_tz:String}` 亦已由 T3 生产查询实证）。
- 3b 整数写串：临时表 `clklog_sa_bak.tz_gate03`（Memory 引擎，用后 DROP）以 JSONEachRow 写整数 epoch 毫秒进 `DateTime64(3)`，回读 `exact_equal=1`、墙钟精确。
- **结论**：后续 ingestor 切换「整数 epoch 写入」的数据库侧前置已验，动作留给单独的小叠代（设计 §13.2-1 登记的待定项）。

### 7.4 SC-4 平台时区可配置（修正验收定性）

「未在生产切非上海」维持（属部署期动作），但判定证据链已完整，由「半」升为 **✅**：
配置读入（TimeModule/appConfig 已在生产进程生效，me 回显一致）+ 配置非法 fail-fast 单测 + 纽约平台时区解析单测覆盖（`test/time/time-scope.spec.ts` 的 `America/New_York` materialize 断言）。真正切换只在业务需要多地域统计时执行，且需同步重算认知的登记已在 PRD §5-3 声明。
