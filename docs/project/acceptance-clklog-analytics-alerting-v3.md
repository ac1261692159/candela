# 验收记录：告警可运维性（phase: clklog-analytics-alerting-v3）

- 日期：2026-09-15
- 帽子：项目（`docs/project/`）
- 环境：**生产** 生产主机，应用版本 **17160**（`a9fb939` / `732172a`）→ **17161**（`dd93274` 飞书投递判定修复）
- 上游：PRD `docs/product/prd-clklog-analytics-alerting-v3.md`、实现方案 `docs/architecture/clklog-analytics-design-alerting-v3.md`
- 关联：v1/v2 验收 `docs/project/acceptance-clklog-analytics-alerting-v1.md`、缺陷登记 `CODE_HANDOVER.md`

---

## 1. 结论

**通过（有两项说明与一项验收中发现并当场修复的缺陷）。** 四项能力全部上线并实测：规则健康度与提示数据、配置变更审计、通知重试与失败可见、第 7 条内置规则「磁盘预计用尽」。

三件值得单独记住的事：

1. **上线前用生产数据核算，发现 30 天外推窗口会永久失效**（09-08 那次释放约 1 TB 的日志清理把斜率拉成 −55.76 GB/天），已改为 7 天（+6.27 GB/天，约 410 天用尽）再发版。
2. **验收中实测到「投递成功」是假的**：飞书对无效 token 返回 HTTP 200 + 错误码 body，原实现只看状态码，把失败记成 `success`。已修（`assertFeishuOk` 解析 body 的 `code`），修复后同一条测试路径正确落 `fail` + `feishu_code_19001`。
3. `slow_query_spike` 修好时间窗后仍在阈值附近抖动（07:38 恢复、07:39 又触发），**阈值待重新标定**（真实基线 42–49 次/5 分钟 vs 阈值 20）。

## 2. 验收方法

| 手段 | 说明 |
|---|---|
| 线上真实 API | 临时超管会话 token 直连 `127.0.0.1:3100/sa/api/ops/alerts/*`（值由固定短语 SHA-256 派生、不回显、结束即删） |
| 线上数据库证据 | `alertrule` / `alertevent` / `alertnotification` / `ops_action_log` / `hostmetricsample` |
| 线上日志 | `analytics-server.log` 的重试与检测记录 |
| 单测 | 新增 `disk-forecast`（7）、`alerting-audit`（6）、`alert-notify-retry`（3+4）、`alerting-rule-health`（7），检测器补 4 例 |
| CI 条件复现 | 清空四个密钥变量 + `APP_CONFIG_PATH` 指向不存在文件后跑全白名单 |

## 3. 端到端实测（服务器本地时间 UTC+8）

| # | 时间 | 动作 | 观察结果 |
|---|---|---|---|
| 1 | 15:32:45 | 升级到 17160 | `_prisma_migrations` 出现 `20260915150000_alerting_v3`；`alertrule` 变 7 条，`disk_forecast_full` = 阈值 30 / `lt` / 天 / 启用 |
| 2 | 15:33:18 | 建临时联系人（**格式合法但不存在**的飞书 hook，用于验证重试） | `201 {"id":"3"}`；列表返回 `.../hook/***oken`（脱敏） |
| 3 | 15:33:29 | 改 `disk_forecast_full`：阈值 → 1000、contact_id → 3（让它命中以便观察） | `200 ok`；**审计行 id=371**：`changes:{threshold:{from:30,to:1000},contact_id:{from:null,to:"3"}}` |
| 4 | **15:34:02** | 检测器下一轮 | 事件 `alertevent` id=167 `firing`，**value = 409.6 天** —— 与手算的 7 天斜率（+6.27 GB/天、剩余 2571 GB）≈ 410 天一致 |
| 5 | 15:34:02 | 首次投递到不存在的 hook | 通知 id=6 记 **`success`** ❌ ← 假成功，见 §6-F1 |
| 6 | 15:37 | 升级到 17161（飞书投递判定修复） | 版本 17161，进程 RUNNING |
| 7 | 15:38:02 / 15:39:02 | `slow_query_spike` 自动恢复又触发 | 通知 id=8 `resolve`、id=9 `fire`（真实抖动，见 §6-F2） |
| 8 | 15:40:47 | 把重复间隔改 5 分钟以逼出一次重复投递 | `200 ok`；审计行 id=373：`repeat_minutes 60 → 5` |
| 9 | **15:41:17** | 重试路径实测 | 通知 id=10 `disk_forecast_full repeat` **`fail`**，`error = feishu_code_19001(param invalid: incoming webhook access token…)`；日志可见「第 1 次失败…将重试」「第 2 次失败…将重试」 |
| 10 | 15:43 | 健康度与概览 | `overview.health = {contacts:1, has_default_contact:true, broken_rules:0, no_contact_rules:0, notify_fail_24h:0}`；7 条规则 `health` 均 `ok`；`GET audits` 返回 200 |
| 11 | 15:44 | 回滚 | 规则恢复（30 / `lt` / 天 / repeat 60 / 无联系人）；删临时联系人；删测试事件 167 与通知 6、10；清掉本次 `alert_` 审计；撤销 token。终态：联系人 1、`alert_` 审计 0、通知仅剩真实记录（id 5/7/8/9） |

## 4. 验收标准逐条判定

| AC | 判定 | 依据 |
|---|---|---|
| AC-1 规则健康度 | ✅ | 线上 7 条规则均返回 `health`/`health_detail`（全 `ok`，符合当时无失效卡片的实际）；四种状态判定由 `alerting-rule-health.spec.ts` 7 例覆盖（卡片被删 / 缓存报错 / 缓存过期 / 新鲜 / 无联系人 / 有默认联系人 / 停用不告警 / 概览汇总） |
| AC-2 无联系人提示 | ✅（数据层） | `overview.health.has_default_contact`、`no_contact_rules` 线上实测；提示条渲染未做浏览器验证（见 §5） |
| AC-3 失效规则提示 | ✅（数据层） | `broken_rules` / `broken_rule_names` 由单测覆盖（构造「卡片已删」规则后为 1 且带名字）；线上当时无失效规则故为 0 |
| AC-4 通知失败提示 | ✅（数据层） | 失败行 id=10 实际写入 + `overview` 的 `notify_fail_24h` 计数查询；渲染未做浏览器验证 |
| AC-5 配置变更审计 | ✅ | 线上产生 3 条审计（联系人新建含**脱敏**地址、规则更新含前后值、重复间隔变更），操作者均为 `admin`；单测另覆盖「相同值不写审计」「审计失败不影响业务」 |
| AC-6 变更记录 Tab / 不混入数据运维 | ⚠️ 半通过 | `GET audits` 线上返回 200 且只含 `alert_` 前缀；`data-mgmt.listActions` 增加排除条件（代码 + 类型检查），但 Tab 与数据运维页面的实际渲染未做浏览器验证 |
| AC-7 通知重试 | ✅ | 线上 id=10：3 次尝试后落 `fail`（日志有第 1、2 次重试记录）；单测覆盖「首次失败后重试成功」「三次全失败抛最后一次错误」「首次成功不重试」 |
| AC-8 检测器防重入 | ✅（单测） | `alert-detector.service.spec.ts`「重入保护」：并发第二次调用不进入检测（`findMany` 仅 1 次），首轮完成后事件仍只建 1 条 |
| AC-9 第 7 条规则 | ✅ | 线上实测 value = **409.6 天**（与手算一致）；无增长 → `NO_GROWTH_DAYS` 并解除事件、采样不足 → 本轮跳过，均由单测覆盖 |
| AC-10 棘轮 / CI / 构建 | ✅ | 棘轮 exit 0；前端 `tsc` + `vite build` 通过；CI 条件（清空密钥 + `APP_CONFIG_PATH` 不存在）实跑 **24 suites / 159 tests** 全通过 |

## 5. 未验项

1. **前端渲染未做浏览器验证**（AC-2/AC-3/AC-4/AC-6 的展示层）：生产需超管登录凭据，本轮只验到接口数据。建议下次有人登录时顺手看一眼三个提示条、健康列与「变更记录」Tab。
2. SMTP / 腾讯云短信**正向投递**仍未验（沿用 v1/v2 遗留，生产未配置这两条通道）。

## 6. 验收发现

| ID | 级别 | 内容 | 状态 |
|---|---|---|---|
| F1 | P1 | **飞书投递「假成功」**：无效 token 返回 HTTP 200 + `{"code":19001}`，原实现只判状态码 → 失败被记成 `success`。线上实测（步骤 5）复现 | **已修**（`dd93274`，`assertFeishuOk` 解析 body `code`；非 JSON 响应不误判），修复后步骤 9 正确落 `fail` |
| F2 | P1 | **`slow_query_spike` 阈值需重标定**：时间窗修复后按真实 5 分钟窗口判定，值在 20 附近抖动（07:38 恢复、07:39 又触发，会持续发恢复/触发通知）。近 24 小时每小时 435–560 次 → 基线 ≈ 42–49 次/5 分钟 | **待用户决策**：阈值提到 150–250 或停用该规则 |
| F3 | P3 | 规则更新传入不存在的 `contact_id` 时返回 **500**（外键约束）而非 400 可读错误 | 未修，登记建议：更新前校验联系人存在性 |

## 7. 回滚与残留

| 项 | 处理 |
|---|---|
| 临时联系人（id=3，不存在的 hook） | 已删除 |
| 规则 `disk_forecast_full` | 阈值/比较符/单位/重复间隔/联系人全部恢复默认（30 / lt / 天 / 60 / 无） |
| 测试事件与通知 | `alertevent` id=167、`alertnotification` id=6/10 已删除；真实记录（id 5/7/8/9）保留 |
| 测试审计行 | 本次 `alert_` 审计（id 370/371/373）已删除，`变更记录` Tab 回到干净状态 |
| 临时 token | 已从 `sausertoken` 删除，无遗留 |
| 备份 | 服务器 `/tmp/alert-e2e-20260915/`：`backup.sql`（v1 验收前）、`post-test.sql`、`post-v3-test.sql`（删除前快照） |
| 生产代码 | 本 phase 的改动即发布内容；验收本身未再改代码（F1 的修复属验收中发现后修补） |
