# 验收：告警通知通道扩展（多通道 + 多联系人 + 保留策略）

- `phase: clklog-analytics-alert-channels-v1`
- 对应 PRD `docs/product/prd-clklog-analytics-alert-channels-v1.md`、设计 `docs/architecture/clklog-analytics-design-alert-channels-v1.md`、指南 `docs/product/guide-clklog-analytics-alert-channels-v1.md`
- 生产版本：**17245**（反馈轮两批：17243 四项界面/数据改动 → 17245 飞书加签 + 通知投递目标标注）

本文件记录该 phase 的验收证据：自动化门禁、生产实测、以及**只能人工确认**的剩余项。

## 1. 交付范围

| 批次 | 内容 |
|---|---|
| 通道层（首发） | 13 个通道注册表驱动（飞书/钉钉/企微/Slack/Discord/Teams/Telegram/WhatsApp/ntfy/Gotify/通用 Webhook/邮件/短信×4 家）、平台凭证加密存储（AES-256-GCM）、发送测试、能力位、令牌桶限流 + 积压合并、模板改「通道组」、许可门禁 `scripts/license-check.mjs` |
| 反馈第一轮 | 触发与恢复模板各一份（默认模板不再共用）；通道配置表单两次重做（横向两列、凭据分组、修浏览器自动填充）；模板预览 400 修复（DTO 通道组白名单） |
| 反馈第二轮（本文件重点） | ① 模板「预览 + 编辑」左右并排；② 删掉「默认联系人」，改联系人「启用」开关 + 规则**多联系人**绑定；③ 联系人「编辑」；④ 历史 / 通知记录 / 变更记录保留时间**分开设置** |

## 2. 自动化门禁（本地全绿，均随 CI 跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 后端单测 | `npm test`（analytics-server） | **81 suites / 571 tests 全绿**（新增 `alert-contact-multi.spec.ts` 6 例、`alert-retention.spec.ts` 7 例、检测器多联系人 2 例） |
| 前端单测 | `npx vitest run src/features/alerting` | **16 用例全绿**（新增 `AlertFeedback.spec.tsx` 7 例：并排预览、启用开关、编辑弹窗不回填脱敏地址、保留策略三范围） |
| 类型检查 | `npx tsc --noEmit`（前后端） | 无错误 |
| 前端构建 | `npx vite build` | 通过 |
| 结构棘轮 | `python3 scripts/arch_ratchet.py` | `architecture ratchet passed` |
| 依赖许可 | `node scripts/license-check.mjs` | 448 依赖：0 个 GPL/AGPL/商业（1 个未知 `buffers@0.1.1`，未阻断） |
| 端到端构建 | `bash scripts/build.sh` | 通过（含上述全部 + harness host/broker 自测） |

关键回归用例（防的是踩过的坑）：

- `PUT /sa/api/ops/alerts/contacts/:id`：把列表里的**掩码地址原样提交**不得写坏真实地址；留空等同不修改；停用写审计 `启用：开 → 关`。
- 规则多联系人：绑定多个 → 先清后建 + 审计 `contact_ids: {from, to}`；绑定不存在的联系人 → 400 且不做半截写入；绑定未变不写审计；**只改联系人**（不动阈值等）也能保存。
- 投递目标：绑定优先，绑定全停用 → 回退全部启用联系人；无启用联系人 → 不投递也不写通知记录。
- 保留策略：默认 365/365/永久；越界与非整数 400；永久范围不删行；无过期数据不写审计；删历史连带删其通知记录。

## 3. 生产实测（版本 17243）

### 3.1 迁移（`20260916170000_alert_contacts_retention`）

`server-upgrade.sh` 输出 `34 migrations found` → `Applying migration 20260916170000_alert_contacts_retention` → `All migrations have been successfully applied.`

库内核对（`clklog_sa_meta`）：

| 检查 | 结果 |
|---|---|
| `SHOW TABLES LIKE 'alertretention'` / `'alertrulecontact'` | 两张表均存在 |
| `SELECT scope, retain_days FROM alertretention` | `events 365` / `notifications 365` / `audits NULL`（与产品口径一致） |
| `alertcontact.enabled` | `tinyint(1) NOT NULL DEFAULT 1`；现有 2 个联系人全部 `enabled=1`（不改变既有行为） |
| `alertrulecontact` 外键 | `..._rule_code_fkey` / `..._contact_id_fkey` 均 `ON DELETE CASCADE` |
| 既有单联系人搬迁 | `alertrule.contact_id IS NOT NULL` 为 0 行，`INSERT IGNORE` 空转（无数据需迁） |

### 3.2 服务与路由

- `supervisorctl status clklog_analytics_server` → `RUNNING`，`/data/project/clklog_manager/production/.version` = **17243**。
- 启动日志路由表（`analytics-server.log`，pid 2109296 / 16:45:30）出现：
  `PUT /sa/api/ops/alerts/contacts/:id`、`GET /sa/api/ops/alerts/retention`、`PUT /sa/api/ops/alerts/retention/:scope`；
  旧路由 `PUT /sa/api/ops/alerts/contacts/:id/default` **已消失**（仅存在于旧构建的日志行）。
- 无 token 探测（`127.0.0.1:3100`）：`GET retention` / `PUT retention/events` / `PUT contacts/1` 均 **401**（路由存在、鉴权拦截），
  `GET /sa/api/ops/alerts/nope` **404**（对照）。
- 探测用的临时 API Key 用完即删（`SELECT COUNT(*) ... = 0`）；ops 面板要求超管登录 token，非 API Key 可访问（`isAdmin()` 兜底）。

### 3.3 前端产物

当前构建的 `web/sa/assets/AlertsPage-5uwgqEwK.js`（按 mtime 取最新）包含新界面文案：
`数据保留策略`、`全部启用联系人`、`刷新预览`、`启用 ${name}`；
`设为默认` / `默认联系人` 仅剩一处，来自审计动作标签 `设为默认联系人（历史）`（历史记录展示用）。

> 注意：`server-upgrade.sh` 的 rsync 不带 `--delete`，`web/sa/assets/` 会累积历史 chunk（本次实测 63 个旧 chunk 仍含旧文案）。
> 判断「线上是哪版」要看 `index.html` 引用的入口与最新 mtime 的 chunk，不要直接 grep 整个 assets 目录。

## 4. CI 记录（含一次失败复盘）

| 流水线 | 结果 |
|---|---|
| 第一次（commit `e96ed8c`） | ❌ `exit status 1`：新增用例 `AlertFeedback.spec.tsx > 编辑弹窗回填名称…` 在 runner 上 **5s 超时**（本地 ~3s，CI ~6s），产物未发布（模块版本仍停在上一版 17240） |
| 修复（commit `b8015cb`） | 给 5 条整页渲染用例显式 20s 超时（jsdom 重渲染 + userEvent 开销），本地复跑全绿 |
| 第二次 | ✅ 产出 17243，且 `server/prisma/migrations/` 含新迁移目录（以产物为准，而非「版本号变大」——17240 是推之前的旧构建） |

**教训**：CI runner 比本地慢约 2 倍，整页渲染（antd Table + Modal + userEvent）类用例必须显式放宽超时；
判断 CI 是否跑完要看**产物内容特征**（新迁移目录 / 新 chunk 文案），不能只看版本号变化。

## 4.1 线上日志驱动的两处补强（第二批，17245）

17:46（本地 16:46）`card_cache_fail` 触发时，两条通知行一成功一失败：
`feishu_code_19021(sign match fail or timestamp is not with)`。根因与处理：

| 现象 | 根因 | 处理 |
|---|---|---|
| 同一规则扇出到两个飞书机器人时，其中一个总失败（19021） | 该机器人开了「签名校验」，而飞书通道只支持「无签名」机器人 | 按官方算法补加签：key = `timestamp + "\n" + secret`（**秒**）、对**空串** HmacSHA256、Base64，`timestamp`/`sign` 放请求体；联系人字段加 `secret`（未填则维持原样）。注意与钉钉互为**镜像**（key/msg 互换），用例 `飞书加签（与钉钉互为镜像）` 3 例锁住，期望值由 Python `hmac` 独立算出 |
| 多联系人后同一事件写多行通知，但记录里看不出是**哪条通道**失败 | `alertnotification` 只有 rule/kind/status/error | 增加 `contact_id` + `contact_name`（**快照、无外键**：联系人删除或改名后历史仍可读）；检测器成功/失败两路都写；「通知记录」新增「联系人」列 |

**跑完一轮后的实测（17245 上线 5 分钟内，`card_cache_fail` 自动触发）**：

| 通知行 | 结果 | 联系人（新增列） | 错误 |
|---|---|---|---|
| 16:56:48 fire | success | 飞书机器人 | — |
| 16:56:53 fire | fail | **飞书机器人2** | `feishu_code_19021(sign match fail or timestamp is not with)` |

即：开启签名校验的是「飞书机器人2」，需要在联系人编辑里补签名密钥（或停用它）；历史行（48–51）联系人列为空属预期。

迁移 `20260916190000_alert_notification_contact` 已在生产应用：
`SHOW COLUMNS FROM alertnotification LIKE 'contact%'` → `contact_id bigint NULL` / `contact_name varchar(191) NULL`（历史行留空，可解释）。

> 实际投递效果仍需用户侧确认：给开启签名校验的机器人**填上签名密钥**（联系人 → 编辑 → 密钥）后点「发送测试」；
> 或直接用新的「启用」开关把它停用。两条路都不需要再发版。

## 5. 只能人工确认的部分（交给用户）

按 `docs/product/guide-clklog-analytics-alert-channels-v1.md` §4 清单（13 项）逐条过页面：

- 各通道真实投递（需厂商账号/审批）：飞书（**含签名校验机器人**）、钉钉（含加签）、企微、Slack、Discord、Teams、Telegram、WhatsApp、邮件、短信、ntfy/Gotify、通用 Webhook；
- 限流与合并（≥3 条积压合并成摘要）；
- 新增四项的界面观感：模板左右并排、联系人启用开关/编辑、规则多选联系人、保留策略卡片位置。

自动化不能覆盖的原因：真实厂商端到端需账号与审批；超管登录态无法在 CI 中构造（生产 ops 面板仅超管可见）。
