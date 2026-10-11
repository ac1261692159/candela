# 验收记录：运维告警（phase: clklog-analytics-alerting-v1 + v2）

- 日期：2026-09-15
- 帽子：项目（`docs/project/`）
- 环境：**生产** 生产主机，应用版本 **17148**，`clklog_analytics_server` 与 `clklog_analytics_ingestor` 均 RUNNING
- 上游：PRD `docs/product/prd-clklog-analytics-alerting-v1.md`、`docs/product/prd-clklog-analytics-alerting-v2.md`
- 实现方案：`docs/architecture/clklog-analytics-design-alerting-v1.md`、`docs/architecture/clklog-analytics-design-alerting-v2.md`
- 关联：运维面板 PRD/方案 `clklog-analytics-ops-console-v1`（告警页宿主）、`CODE_HANDOVER.md` 2026-09-15 节（缺陷登记）

---

## 1. 结论

**核心链路可用，但有两项必须修的缺陷，本 phase 判定为「有条件通过」。**

一次完整的真实链路已在生产跑通：规则命中 → 写入 firing 事件 → 飞书收到触发消息 → 按 `repeat_minutes` 发送重复通知 → 屏蔽期内停止外发 → 解除后恢复通知。权限双闸、通知记录、脱敏、通道未配置拒绝均实测通过。

同时验收暴露两项此前未知的缺陷（详见 §6 与 `CODE_HANDOVER.md`）：

1. **AL-01（P1）**：慢查询相关时间窗整体偏 8 小时（`toClickHouseDateTime` 用 UTC 文本、ClickHouse 按 `Asia/Shanghai` 解释），导致「慢查询次数突增」规则实际按 8 小时窗口判定，**自 2026-09-07 09:35 起持续误报 8 天**（`alertevent` id=1，值恒为 LIMIT 上限 1000）。受影响的还有查询失败率规则与慢 SQL 页的全部时间档筛选。
2. **AL-02（P2）**：ingestor 进程复用 `AppModule`，`AlertDetectorService` / `MetricSamplerService` / `LogCleanupService` 在 server 与 ingestor **各跑一份**（每小时重复采样、重复清理审计、规则每分钟被检测两次）。

另有一项**配置缺口（AL-03，P1）**：验收前生产 `alertcontact` 表为空、`alertnotification` 0 行——告警 8 天来一直在触发，但**一个联系人都没配**，通知全部静默丢弃，且页面对此没有任何提示。

## 2. 验收方法

| 手段 | 说明 |
|---|---|
| 线上真实 API | 用超管会话 token 直连 `http://127.0.0.1:3100/sa/api/ops/alerts/*`，走真实 HTTP + 鉴权 + 校验链路（非 mock） |
| 线上数据库证据 | MySQL `clklog_sa_meta` 读 `alertrule` / `alertevent` / `alertnotification` / `alertmute`；ClickHouse 读 `system.query_log` 交叉验证 |
| 飞书实际接收 | 机器人 webhook 由用户提供；用户确认群「数据分析告警」收到消息（见 §3 步骤 8） |
| 单元测试 | `test/alerting/alert-detector.service.spec.ts`（本轮新增 14 例）+ 既有 7 个 spec |
| 静态与门禁 | `python3 scripts/arch_ratchet.py`；`scripts/build.sh` 测试白名单实跑 |

**临时凭据与临时配置**：为做本验收，① 用 SQL 铸造了两枚 2 小时有效的会话 token（超管 / 非超管各一；值由固定短语 SHA-256 派生、全程不在会话中回显，结束后从 `sausertoken` 删除）；② 建了一个临时飞书联系人并设为默认；③ 临时改了 `card_cache_fail` 的阈值与重复间隔。**以上均在 §7 回滚**。

## 3. 端到端实测（时间均为服务器本地时间 UTC+8）

| # | 时间 | 动作 | 观察结果 | 证据 |
|---|---|---|---|---|
| 1 | 14:19:43 | 无 token 调 `GET rules` | `401` | — |
| 2 | 14:19:43 | 非超管 `analyst1` 调 `GET rules` | `403 {"code":403,"message":"无权访问该资源"}` | AC-7 |
| 3 | 14:19:50 | 超管 `GET channels` | `{"email":false,"sms":false}`（生产未配 SMTP / 短信） | AC-3/AC-4 前置 |
| 4 | 14:19:50 | `POST contacts` kind=email | `400 未配置 SMTP，无法添加邮件联系人` | AC-3 负向 |
| 5 | 14:19:50 | `POST contacts` kind=sms | `400 未配置短信通道，无法添加短信联系人`（非法号码同样先报通道） | AC-4 负向 |
| 6 | 14:19:50 | `POST contacts` kind=feishu_webhook（默认） | `201 {"id":"1"}`；列表返回 `.../hook/***cd2f` | AC-5 脱敏 |
| 7 | 14:19:50 | `PUT rules/card_cache_fail` `{threshold:0, repeat_minutes:5}` | `200 {"ok":true}` | AC-1 |
| 8 | **14:20:13** | 检测器下一轮：观测值 1 ≥ 0 命中 | 新建 `alertevent` id=164 `firing`；写 `alertnotification` id=2 `fire/success` | **飞书群收到「【警告】告警触发 卡片缓存刷新连续失败 当前值 1次（条件 >= 0次）检测周期 60 秒」**（用户确认） |
| 9 | 14:20:23 | 后续轮次 | id=164 `last_seen_at` 持续刷新，不重复建事件 | 同一 firing 周期不重复建事件 |
| 10 | 14:23:55 | 概览与列表一致性 | `overview`：`fired_today=3`、`unresolved=2`、`notify_fail_today=0`、`top_rules=card_cache_fail×3`；与当时 `events?status=firing`（2 条）和 `notifications`（2 条，均 success）逐项对齐 | AC-6 |
| 11 | **14:25:14** | 距上次通知满 5 分钟 | 写 `alertnotification` id=3 `repeat/success`（与 fire 相隔 **5 分 01 秒**） | 重复间隔按配置生效 |
| 12 | 14:25:27 | `POST mutes` `{rule_code:card_cache_fail, duration_hours:1}` | `201 {"id":"1"}`，屏蔽至 15:25:27 | AC-4 / v2 AC-5 |
| 13 | 14:32:02 | 屏蔽期内跨越应发窗口（14:30:14） | **无新增通知记录**（仍为 id≤3）；事件仍在 firing（`last_seen_at` 14:31:23 刷新） | 屏蔽抑制生效 |
| 14 | 14:32:08 → 14:32:13 | `DELETE mutes/1` + `PUT rules/card_cache_fail {threshold:3}` | 下一轮不再命中 → 事件转 `resolved`，写 `alertnotification` id=4 `resolve/success` | 恢复通知 |

> 步骤 8 的观测值 1 为真实数据（当时确有 1 张卡片缓存处于 error 状态）；步骤 7 把阈值降到 0 只是让规则在我可控的时间窗内命中，不制造虚假业务状态。

## 4. 验收标准逐条判定

### 4.1 `clklog-analytics-alerting-v1`

| AC | 判定 | 依据 |
|---|---|---|
| AC-1 策略列出 6 条内置规则；编辑抽屉可改级别/比较/阈值/粒度/持续/重复间隔/恢复通知/联系人；保存后检测按新条件 | ✅ 通过 | 线上 `GET rules` 返回 6 条内置规则；`PUT rules/:code` 改阈值与重复间隔后，检测行为立即按新条件执行（§3 步骤 7–10） |
| AC-2 粒度×持续 = 连续 N 次 60s 检测均越线才触发；未满 N 次不发飞书 | ✅ 通过（单测） | `alert-detector.service.spec.ts`「连续窗口未满不触发」「未命中归零重新累计」；线上以 `for_windows=1` 规则验证 |
| AC-3 配置默认飞书联系人后，触发写入通知记录且飞书收到文本 | ✅ 通过 | §3 步骤 8；消息格式为 级别 + 规则 + 当前值 + 阈值 + 检测周期 |
| AC-4 屏蔽生效期内不发飞书；解除后恢复通知策略 | ✅ 通过 | §3 步骤 11–13（线上跨窗口无外发）+ 单测「屏蔽生效期内不外发，但事件仍保持 firing」 |
| AC-5 通知记录可看时间/规则/类型/成功失败；webhook 全文不出现在 UI | ✅ 通过 | `GET notifications` 返回 `kind=fire/repeat/resolve`、`status=success`、无任何 URL 字段；`GET contacts` 仅 `***cd2f` |
| AC-6 概览数字与历史/通知记录一致 | ✅ 通过 | §3 步骤 14 |
| AC-7 非超管无菜单、直访 `/ops/alerts` 无权限；接口拒绝 | ✅ 通过 | §3 步骤 1–2（401 / 403）；前端菜单按 `ops.runtime.access` 过滤（`shell-menu.ts:36`、`MainLayout.tsx:127`） |
| AC-8 `arch_ratchet.py` 通过；告警代码在 `modules/alerting/` 与 `features/alerting/` | ✅ 通过 | 棘轮 exit 0；代码位置符合 |

### 4.2 `clklog-analytics-alerting-v2`

| AC | 判定 | 依据 |
|---|---|---|
| AC-1 可新建分析指标告警（选项目/卡片/数值列/阈值/通知），可删除；内置规则无删除 | ⚠️ 未线上验证 | 本轮未在线造数触发 `source=card` 规则；代码路径与上限（50 条）由 `createCardRule` + `alert-detector.service.spec.ts`「卡片指标规则：缓存新鲜时取值触发，缓存过期或失败时跳过」覆盖 |
| AC-2 卡片缓存最新值越线且连续窗口满足后触发；缓存过期/失败本轮不触发 | ✅ 通过（单测） | 同上单测（含 40 分钟陈旧缓存跳过） |
| AC-3 配置 SMTP 后邮件联系人能收到；未配置时无法新建 | ⚠️ 半通过 | 负向线上实测通过（§3 步骤 4）；正向未验（生产未配置 SMTP，本轮不引入新密钥） |
| AC-4 配置腾讯云短信后能收到；未配置时无法新建 | ⚠️ 半通过 | 负向线上实测通过（§3 步骤 5）；正向未验（同上） |
| AC-5 概览对触发中规则可快捷屏蔽 1 小时～7 天；屏蔽期内各通道不外发 | ✅ 通过 | §3 步骤 11–12；快捷时长解析由 `alert-eval.spec.ts`「快捷屏蔽小时数」覆盖 |
| AC-6 通知记录不出现 webhook / SMTP 密码 / 短信密钥原文 | ✅ 通过 | §3 步骤 13 与 `GET notifications` 全字段检查 |
| AC-7 `arch_ratchet.py` 通过；代码仍在 `modules/alerting/` 与 `features/alerting/` | ✅ 通过 | 棘轮 exit 0 |

## 5. 自动化测试与 CI

| 项 | 结果 |
|---|---|
| `npx jest test/ops test/alerting --runInBand` | **7 suites / 29 tests 通过**（本轮前既有） |
| `npx jest test/alerting/alert-detector.service.spec.ts`（新增） | **1 suite / 14 tests 通过** |
| `npx vitest run src/pages/Ops/disk-trend-chart.spec.ts` | 6 tests 通过 |
| `npm test -- --runInBand <CI 白名单>` | **19 suites / 124 tests 通过**（加入 ops/alerting 8 个 spec 后） |
| CI 条件复现（清空 `CLICKHOUSE_PASSWORD`/`READONLY_CH_PASSWORD`/`MYSQL_PASSWORD`/`DATABASE_URL`，并把 `APP_CONFIG_PATH` 指向不存在的文件） | **19 suites / 124 tests 通过** |
| `python3 scripts/arch_ratchet.py` | `architecture ratchet passed`（exit 0） |

> **测试基建坑（本次踩到并已修）**：`clickhouse.service` / `alert-notify.service` 在模块顶层加载 YAML 配置，需要 `APP_CONFIG_PATH` 与真实密钥，CI 里都没有。本地 ts-jest 会把「只当类型用」的 import 消除掉，于是新 spec 不 mock 也能本地通过；CI 不消除，直接 `环境变量未设置: CLICKHOUSE_PASSWORD` 失败（首次推送 CI job 就是这样挂的）。因此**凡导入 `modules/ops/**` 或 `modules/alerting/**` 的 spec，必须显式 `jest.mock('../../src/config/configuration', ...)`**（既有 `test/ops/slow-query.*.spec.ts` 已是此写法）。本次给 `alert-detector.service.spec.ts` 与 `data-mgmt.service.spec.ts` 补上，并各加一条「配置模块已隔离」断言，防止后续被误删。

新增的 `test/alerting/alert-detector.service.spec.ts` 覆盖本轮之前完全空白的状态机链路：firing / resolved 迁移、连续窗口累计与归零、重复通知间隔、屏蔽抑制、无联系人不外发、观测失败跳过本轮、通知失败落库并截断 500 字符、规则读取失败整轮跳过、卡片缓存新鲜/过期取值、定时器随模块启停。

`scripts/build.sh` 的后端测试白名单已加入 `test/ops/*`（5）与 `test/alerting/*`（3）——此前这些用例只在开发者本地跑过，CI 不回归。

## 6. 缺陷与未验项

| ID / 级别 | 现象与证据 | 建议 |
|---|---|---|
| AL-01 / P1 | 「慢查询次数突增」自 2026-09-07 09:35 起持续 firing（`alertevent` id=1，值恒为 1000 = LIMIT 上限）。根因：`clickhouse.service.ts:58-60` 的 `toClickHouseDateTime` 用 `toISOString()` 生成 UTC 文本，ClickHouse（`Asia/Shanghai`）按本地解释参数 → 时间窗前移 8 小时。同条件对照：`{since}` 绑定命中 **4007** 行，真实「近 5 分钟」只有 **49** 行 | 修正 `toClickHouseDateTime`（只影响 `querySlowQueries` 两个调用点），复测慢 SQL 页各时间档，并重置该规则的 firing 事件 |
| AL-02 / P2 | ingestor 进程也在跑后台任务：`analytics-ingestor.log` 出现 `[AlertDetectorService] 告警触发 [card_cache_fail]`；`hostmetricsample` 每小时两组相隔 11–12 秒的采样；`ops_action_log` 每小时两条相隔 11 秒的 `log_cleanup`（id 359/360、361/362、363/364，实测 04:28:10 与 04:28:22） | 按 `ENABLE_INGESTOR` 同一模式在 ingestor 侧关停 `AlertDetectorService` / `MetricSamplerService` / `LogCleanupService` |
| AL-03 / P1 | 验收前 `alertcontact` 为空、`alertnotification` 0 行：8 天来的告警事件无一外发，且页面无「没有联系人」提示（`resolveContact` 无默认联系人时静默跳过） | 产品侧补空联系人的页面告警；运维侧确认是否把该飞书机器人设为常驻默认联系人 |
| 权限码不一致 / P3 | `DataMgmtController` 用 `@RequirePermission('meta.view')`，其余 ops 控制器用 `ops.runtime.access`（真实闸门是 `isAdmin()`，功能不受影响） | 统一为 `ops.runtime.access`，避免后续误判 |
| 未验项 | ① SMTP / 短信正向投递（生产未配置，本轮不引入密钥）；② `source=card` 分析指标规则线上触发（未造数，仅单测）；③ 企微/电话等非目标通道（本就不做） | 配置通道后补一次定向验证 |

## 7. 回滚与残留

| 项 | 处理 |
|---|---|
| 临时会话 token（超管 / 非超管各一枚） | 验收结束即 `DELETE FROM sausertoken`，不留残余 |
| 临时飞书联系人（id=1，默认） | 删除，恢复「生产无联系人」原状——**是否常驻由用户决定**（见 AL-03） |
| `card_cache_fail` 规则字段 | 阈值恢复 3、`repeat_minutes` 恢复 60（与备份一致） |
| 屏蔽记录 | 已删除 |
| 测试产生的 `alertevent` id=164 与 `alertnotification` id=1/2/3/4 | 删除（`alertnotification` id=1 是 `slow_query_spike` 的补发，同样只因本次临时联系人存在才产生）。删除前落两份备份：`/tmp/alert-e2e-20260915/backup.sql`（验收前全量快照）、`post-test.sql`（删除前快照） |
| 终态核对（2026-09-15 14:35） | `alertcontact`=0 行、`alertmute`=0 行、`alertnotification`=0 行、`alertevent` 最大 id=163（与验收前一致）；6 条内置规则字段全部回到原值（`card_cache_fail`：threshold=3、repeat_minutes=60） |
| 生产代码 | **一行未改**；本 phase 只补测试、CI 白名单与文档 |
| 发版 | 2026-09-15 14:48 发版到生产：**17148 → 17155**（`scripts/server-upgrade.sh`，Prisma 无待应用迁移、ClickHouse 迁移 noop）。新版首次进入 CI 白名单的 ops/alerting 测试在 build-main 里跑通（首推 `407995a` 因 spec 未隔离 configuration 失败，修于 `6a23f77`）。重启会中断在跑的事件分析查询（日志 `socket hang up`），属预期代价 |

> 备份文件保留在服务器 `/tmp/alert-e2e-20260915/`，确认无需追溯后可自行删除。
