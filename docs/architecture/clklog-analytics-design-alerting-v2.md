# 实现方案：分析指标告警与邮件/短信

> phase: clklog-analytics-alerting-v2
> 状态：实现 · 日期：2026-09-10
> 上游：`docs/product/prd-clklog-analytics-alerting-v2.md`

---

## 1. 阶段目标与范围

卡片缓存指标告警；联系人增加 email / sms；概览快捷屏蔽。不在检测器里跑分析 SQL。密钥只走 `src/config` 读环境变量。

## 2. 包边界

仍在 `modules/alerting/`：

- `alert-metric.ts`：从 `CardCache.result_json` 取最新行数值（纯函数）
- `alert-channel-email.ts`：SMTPS / STARTTLS
- `alert-channel-sms.ts`：腾讯云 SMS API v3
- `alert-notify.service.ts`：按 `AlertContact.kind` 分发
- `alert-detector.service.ts`：内置 6 条之后遍历 `source=card`

前端仍在 `features/alerting/`。`ops/` 不新增文件。

## 3. 数据模型

`AlertRule` 增列：

| 列 | 含义 |
|---|---|
| source | `builtin` / `card`，默认 `builtin` |
| card_id | 可空 |
| metric_key | 缓存结果列名 |
| project_name | 展示用 |

`AlertContact` 增列 `address`（邮件或 11 位手机）；`webhook_url` 允许空串（邮件/短信行）。`kind`：`feishu_webhook` / `email` / `sms`。

分析规则 `code` = `card_` + 12 hex。最多 50 条 `source=card`。

## 4. 检测

卡片观测：缓存无 error、未截断、`refreshed_at` 在 30 分钟内，取 `rows` 最后一行的 `metric_key` 为有限数字；否则本轮 `null`（跳过，不改 streak）。

状态机与 V1 相同。通知按联系人 kind 调用飞书 / 邮件 / 短信。

## 5. 配置

`configuration.ts` 可选读取（空则通道关闭）：

- SMTP：`ALERT_SMTP_HOST` `PORT` `USER` `PASS` `FROM` `SECURE`
- 短信：`ALERT_SMS_SECRET_ID` `SECRET_KEY` `SDK_APP_ID` `SIGN_NAME` `TEMPLATE_ID` `REGION`

`GET /sa/api/ops/alerts/channels` 返回 `{ email, sms }`。新建对应联系人时若通道关闭则 400。

Supervisor 不强制注入这些变量（缺省为空，避免 `%(ENV_*)s` 未 export 导致进程起不来）。运维在 supervisord 环境或 systemd 环境里自行补。

## 6. API 增补

- `GET channels`
- `GET cards?project=` 超管列出可告警卡片及缓存列
- `POST rules` 仅 `source=card`
- `DELETE rules/:code` 仅 `source=card`
- `POST mutes` 增加可选 `duration_hours`（1～720）；有则 `starts_at=now`

## 7. Harness 同期修补（非告警范围，同发版）

- 代理 shim：过滤无 `startTime` 的 PerformanceEntry；`onerror` 吞掉该字段报错；`/plugins/events` 用 fetch 流替代 EventSource，减轻 HTTP/2 RST。
- nginx：`location ~ .../plugins/events` 强制 `Connection ""`、`gzip off`、关缓冲、隐藏 Content-Length。
- Nest 下游：SSE 去掉 `content-length` / `content-encoding`，`Cache-Control: no-cache, no-store, no-transform`。

## 8. 验收 / 非目标

与 PRD AC-1～AC-7、§7 相同。交付前 `python3 scripts/arch_ratchet.py`。
