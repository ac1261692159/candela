# 验收记录：告警邮件复用平台邮件通道（phase `clklog-analytics-account-lifecycle-v3` 增补 v3.2 修订）

> 日期：2026-10-09 ｜ 验收人：Agent（浏览器实测 + 生产只读核对）
> 关联：[PRD 增补 v3.2 修订](../product/prd-clklog-analytics-account-lifecycle-v3.md)（验收项 UX-7R-1~6）、
> [设计文档增补 v3.2 修订](../architecture/clklog-analytics-design-account-lifecycle-v3.md)、
> 契约 [alert-channels §7.1](../architecture/clklog-analytics-design-alert-channels-v1.md)
> 缺陷登记：[CODE_HANDOVER.md](../../CODE_HANDOVER.md) 2026-10-09 / AL-09

## 1. 为什么做

用户在生产上已按 UX-7 在「设置 → 用户管理 → 邮件通道」配好 SMTP（`smtp.163.com`），但
「运维 → 监控告警 → 通道配置」的「邮件（SMTP）」显示「未启用」，联系人里也选不到邮件通道
（下拉项 disabled，绕过界面直接调接口被 400 `alerting.channel.unavailable` 拒绝）。
根因：v3.2 只改了**发送侧**的三级回落，**可用性判定**（`capabilities()`）与通道列表（`list()`）
仍只看告警侧自身配置——发送链路是通的，用户被界面与后端校验挡在门外。

## 2. 交付与发版

| 提交 | 内容 | 产物版本 |
|---|---|---|
| `5ce23bb` | 可用性判定与通道列表纳入平台邮件回落（`platform_fallback` 加法式字段）；通道徽标与联系人表单说明；13 门语言文案 | 17716 |
| `fcb389c` | **AL-09 修复**：`import type { AuthMailService }` → 值导入（DI 元数据退化，v3.2 的平台回落在生产从未生效） | 17717 |

两次均按「release 快速发版」流程：隧道检查 → push → 等 CI（判据 = `.version` 更新 **且** 本次新符号出现在模块产物）→
`server-upgrade.sh`（无待执行迁移）。

## 3. 验收结果（PRD UX-7R-1~6）

| 验收项 | 结果 | 证据 |
|---|---|---|
| UX-7R-1 仅配平台邮件时 `email.available = true` 且 `platform_fallback = true` | ✅ | 已登录页内带会话查询 `GET /sa/api/ops/alerts/channels`：`{"email":{"available":true,"platform_fallback":true,"reason":null}}`；`channel-configs` 的 smtp 项 `{enabled:false, env_fallback:false, platform_fallback:true}` |
| UX-7R-2 可新建邮件联系人（修订前 400） | ✅ | 界面新建成功；审计「新建联系人 / alertcontact / id=9，类型=email，名称=胡正坤，地址=hu***@gmail.com，启用=开」（22:04:07） |
| UX-7R-3 通道徽标显示「平台邮件通道」而非「未启用」+ 展开区说明 | ✅ | 页面实测：折叠头 `邮件（SMTP）` + 蓝色 Tag「平台邮件通道」（Telegram/WhatsApp/四家短信仍为「未启用」，未被牵连）；展开区蓝色提示「邮件将由「设置 → 用户管理 → 邮件通道」的 SMTP 账号发送，此处无需重复填写。」 |
| UX-7R-4 平台邮件不可用时回落为不可用（原因不变） | ✅ | 后端用例：`enabled=false` / 缺 `host` / 缺 `from` 三种降级均回到 `alerting:channel.configMissing`；平台服务未注入、读取抛错两种形态也不可用且不抛错 |
| UX-7R-5 告警侧自发配置优先 | ✅ | 后端用例：库内行 `enabled=true` → `available=true, platform_fallback=false`；库内行 `enabled=false` → 仍走平台回落 |
| UX-7R-6 门禁 | ✅ | `i18n_check`（13 语言 × 16 命名空间 / 4175 键）、`i18n_scan --check`（1502 = 基线）、`arch_ratchet`、`npm run build` 全绿；后端 136 套 / 1110 例、前端 121 套 / 652 例全绿（本次新增 14 例：9 后端 + 5 前端，其中 2 条为真实 Nest DI 装配用例） |

## 4. 生产实测：真的发出去了

用户要求「向 `huzhengkun97@gmail.com` 发告警邮件」，在已登录的生产页面完成：

1. **新建联系人**：联系人页签本来只有两条飞书机器人 → 新建「胡正坤 / 邮件 / huzhengkun97@gmail.com」成功
   （列表显示 `hu***@gmail.com`，地址按既有规则脱敏）。
2. **真实告警邮件**：通知记录显示 `2026-10-09 22:04:31 ｜ card_cache_fail ｜ 胡正坤 ｜ 触发 ｜ 成功 ｜ -`
   ——规则 `card_cache_fail`（卡片缓存刷新连续失败）当轮触发时，邮件联系人被纳入投递并成功
   （同轮 22:04:30 飞书机器人也成功，多通道并行投递符合预期）。
3. **通道连通性测试**：通道配置 → 邮件（SMTP）→ 测试收件邮箱填 `huzhengkun97@gmail.com` → 「发送测试」
   返回绿色「测试通过 ｜ 已发出测试消息」；审计 `alert_channel_test / alertchannelconfig / ok=开，通道=smtp`（22:04:40）。

> 说明：「测试通过」表示平台侧 SMTP（`smtp.163.com`，平台邮件通道的账号）已接受该邮件；
> **最终进入 Gmail 收件箱需人工确认**（163 → Gmail 的中转不在平台可控范围，Agent 无法读取收件箱）。

## 5. 过程中发现并修复的缺陷（AL-09）

第一次发版（17716）后，接口里 `platform_fallback` 字段存在但值为 `false`，而用**同一份部署产物 + 同一份生产数据**
直接调用服务却得到 `true`。对比编译产物定位：`channel-config.service.js` 的
`__metadata("design:paramtypes", [PrismaService, AlertAuditService, Function])` 第三项是 `Function`、
且文件内无 `auth-mail.service` 的 require。根因是 `import type { AuthMailService }`——
`emitDecoratorMetadata` 退化成 `Function`，Nest 解析不到 provider，`@Optional()` **静默**注入 `undefined`。
即 v3.2（PRD UX-7）上线以来，**发送侧**的平台回落也一直拿到 `null`，只有告警侧自发配置或 `ALERT_SMTP_*` 时才发信。

- 修复：改为值导入（`fcb389c`）；全仓扫描「`import type` + 构造器注入类型」组合，仅此一处。
- 防回归：新增两条走**真实 Nest DI 装配**（`@nestjs/testing`）的用例；把导入改回 `import type` 时这两条必失败
  （已实测 2 failed / 9 passed）——手工 `new` 的单测永远发现不了这类元数据退化。
- 详见 `CODE_HANDOVER.md` 2026-10-09 条目。

## 6. 遗留与建议

- 收件箱到信需用户确认（见 §4 说明）。
- 本次未改发送侧回落顺序、未加「显式选用平台邮件通道」开关、未做短信的平台级复用——与 PRD 非目标一致。
- 「通道配置」页开关仍为关、且单开它会要求先填本地配置：这是有意保留的语义（`enabled` = 告警侧自身配置是否启用），
  与「可用」（`available`）分离，不要合并成同一个概念。

## 7. 同日后续修订（用户反馈「我怎么知道已启用」）

验收时的界面是「蓝色 Tag『平台邮件通道』+ 开关为关」——用户读成「没启用」。**状态与来源是两件事**，
只显示来源不够，因此当天做了两处 UI 修订（契约与 `enabled` 语义均未变，仅展示层）：

- 状态与来源拆成两个标签：绿色「已启用」（`common:state.enabled`）+ 蓝色「平台邮件通道」（悬停显示回落的完整说明）；
  「未启用」只在两者都不成立时出现。
- 开关改为呈现**实效状态**（`enabled || platform_fallback`）并在平台回落时**置灰** + Tooltip 说明：
  此时它确实在发信，off 位不代表停发（要停发得先删掉平台邮件通道的配置）；
  告警侧自己配好后开关恢复可点，行为与过去一致。
- 单测锁死三种形态（回落可用 / 都不可用 / 告警侧自配）的状态标签与开关 `aria-checked`、`ant-switch-disabled`。
