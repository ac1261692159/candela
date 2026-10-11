# 实现方案：运维告警工作台

> phase: clklog-analytics-alerting-v1
> 状态：实现 · 日期：2026-09-10
> 上游：`docs/product/prd-clklog-analytics-alerting-v1.md`

---

## 1. 阶段目标与范围

运维指标告警：规则条件、窗口状态机、飞书 webhook、屏蔽、通知记录、概览。分析指标告警与邮件/短信不做。nginx 不因告警改动。

## 2. 包边界

`apps/analytics-server/src/modules/ops/` 已接近棘轮 80%。新包：

```
modules/alerting/
  alerting.module.ts
  alerting.controller.ts     路径仍为 /sa/api/ops/alerts/*
  alerting.service.ts        规则/事件/联系人/屏蔽/记录/概览
  alert-detector.service.ts  60s 轮询 + 窗口计数
  alert-notify.service.ts    飞书 POST
  alert-eval.ts              比较符与连续命中（纯函数）
  dto/alerting.dto.ts
```

前端：`apps/analytics-web/src/features/alerting/`，`pages/Ops/AlertsPage.tsx` 只挂工作台。

`OpsModule` 不再提供 Alert*；`AppModule` 同时 import `AlertingModule`。

## 3. 数据模型

`AlertRule` 增列（已有 `threshold`/`enabled` 保留）：

| 列 | 含义 |
|---|---|
| severity | critical / warning / info |
| comparator | gt / gte / lt / lte |
| unit | 展示用 |
| window_minutes | 1 / 5 / 15 |
| for_windows | ≥1 |
| repeat_minutes | 触发中重复通知 |
| notify_on_resolve | bool |
| contact_id | 可空，FK AlertContact |

新表：

- `AlertContact`：name、kind=`feishu_webhook`、webhook_url、is_default
- `AlertMute`：rule_code 可空（空=全局）、starts_at、ends_at、reason
- `AlertNotification`：rule_code、event_id 可空、kind=`fire|repeat|resolve`、status=`success|fail`、error 可空、created_at；**不存 webhook 原文**

窗口计数只放检测器内存（进程重启后重新累计，可接受）。

## 4. 检测状态机

轮询 60s。`requiredPolls = window_minutes * for_windows`。

每次：求观测值 → `compare(value, comparator, threshold)` → 命中则 streak++ 否则 streak=0。

- streak 刚达到 required 且无 firing 事件 → 建 firing、通知 fire
- 已 firing 且仍命中 → 更新 last_seen / value；距上次通知 ≥ repeat_minutes → 通知 repeat
- 未命中且有 firing → resolved、按开关通知 resolve

屏蔽：`now` 落在某条 mute 的区间且（全局或匹配 rule_code）则跳过外发。

飞书：`POST` JSON `{ msg_type: "text", content: { text } }`。URL 必须 `https://open.feishu.cn/open-apis/bot/v2/hook/` 或 `https://open.larksuite.com/open-apis/bot/v2/hook/`。失败写入 notification.error，不把 URL 打进日志。

## 5. API

前缀 `/sa/api/ops/alerts`，权限 `ops.runtime.access` + `isAdmin`。

- GET/PUT `rules`、`rules/:code`
- GET `events`
- GET/POST `contacts`、DELETE `contacts/:id`、PUT 设默认
- GET/POST `mutes`、DELETE `mutes/:id`
- GET `notifications`
- GET `overview`

联系人列表 `webhook_url` 脱敏（保留前缀 + 末 4 位）。

## 6. 验收 / 非目标

与 PRD AC-1～AC-8、§7 相同。交付前 `python3 scripts/arch_ratchet.py`。
