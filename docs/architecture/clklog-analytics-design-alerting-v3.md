# 实现方案：告警可运维性

> phase: clklog-analytics-alerting-v3
> 状态：实现 · 日期：2026-09-15
> 上游：`docs/product/prd-clklog-analytics-alerting-v3.md`

---

## 1. 阶段目标与范围

给已上线的告警补四件「可运维」能力：规则健康度 + 页面提示、配置变更审计、通知重试与投递可见、磁盘预测线告警。**不新增通知通道、不改状态机语义、不新建表。**

## 2. 包边界

| 位置 | 内容 |
|---|---|
| `apps/analytics-server/src/modules/alerting/` | 健康度计算、审计写入、重试、新规则 eval（沿用既有 10 文件，新增 ≤1） |
| `apps/analytics-server/src/modules/ops/disk-forecast.ts`（新增） | 磁盘用尽外推**纯函数**（可单测、无 IO）；`ops/` 当前 13 文件，上限 30 |
| `apps/analytics-web/src/features/alerting/` | 健康提示条、规则健康标签、变更记录 Tab |

## 3. 数据模型

**不新增表**。审计复用 `ops_action_log`（`schema.prisma` 既有模型）：

| 列 | 告警审计取值 |
|---|---|
| `action` | `alert_rule_update` / `alert_rule_create` / `alert_rule_delete` / `alert_contact_create` / `alert_contact_delete` / `alert_contact_default` / `alert_mute_create` / `alert_mute_delete` |
| `target_table` | `alertrule` / `alertcontact` / `alertmute` |
| `detail` | 事件内容；规则更新为 `{ code, name, changes: { field: { from, to } } }` |
| `status` | 固定 `done`（审计失败不影响业务结果，只记日志） |
| `operator` | 当前登录用户名（`AuthUser.username`） |

- **密钥红线**：联系人审计只写 `maskAddress()` 结果，绝不写 webhook / 邮箱 / 手机号明文。
- 数据运维页 `listActions` 的**无过滤查询**需排除 `alert_` 前缀，避免两个域的审计互相污染。

**迁移**（`prisma/migrations/<ts>_alerting_v3/`）：仅种子第 7 条内置规则，幂等。

```sql
INSERT IGNORE INTO alertrule (code, name, threshold, enabled, updated_at)
  VALUES ('disk_forecast_full', '磁盘预计用尽', 30, 1, NOW(3));
UPDATE alertrule SET comparator='lt', unit='天', severity='warning', enabled=1
  WHERE code='disk_forecast_full';
```

## 4. API 增补

| 接口 | 变更 |
|---|---|
| `GET rules` | 每项增 `health`（`ok` / `card_missing` / `cache_unavailable` / `no_contact`）与 `health_detail` |
| `GET overview` | 增 `health: { contacts, has_default_contact, broken_rules, no_contact_rules, notify_fail_24h }` |
| `GET audits?limit=` | 新增：`ops_action_log` 中 `action LIKE 'alert_%'` 的最近记录 |

健康度判定优先级（后端 `AlertingService.listRules`）：

1. `source=card` 且卡片不存在 → `card_missing`
2. `source=card` 且（无缓存 / 缓存 error / `refreshed_at` 超 30 分钟）→ `cache_unavailable`
3. `contact_id` 为空且系统无默认联系人 → `no_contact`
4. 其余 → `ok`

判定用一次批量查询（卡片按 `card_id in (...)`、默认联系人一次），不逐条查库。

## 5. 通知重试与防重入

- `AlertNotifyService.send()` 外层新增重试封装：**最多 3 次尝试**，失败间隔 1s / 2s；每次失败记 `logger.warn`（规则码 + 第几次 + 原因），**不在日志里打 URL**。
- 最终结果只落一条 `alertnotification`：成功 `success`；三次全失败 `fail`，`error` 为最后一次原因（截断 500）。
- `AlertDetectorService.detect()` 增加**重入保护**（`private running = false`，进入置真、`finally` 复位）：重试会把单轮耗时拉长，必须防止 `setInterval` 叠加执行导致重复建事件、重复通知。

## 6. 磁盘用尽外推（后端）

`modules/ops/disk-forecast.ts`（纯函数，与前端 `features/visualization/adapters/trend-forecast.ts` 同一算法：一元线性回归最小二乘 + 阈值交汇）：

```ts
export const MIN_FORECAST_POINTS = 3;
export const NO_GROWTH_DAYS = 3650; // 无增长：视为「不会用尽」，用有限值表达便于比较与展示
export function forecastDiskFull(samples, totalBytes, now): {
  daysToFull: number | null;   // null = 数据不足（本轮跳过）
  bytesPerDay: number; pointCount: number;
  reason: 'ok' | 'insufficient_samples' | 'no_growth' | 'crossed';
}
```

语义映射（对应 PRD D4，也是与前端展示语义的**唯一差异点**）：

| 情形 | 返回值 | 检测器行为 |
|---|---|---|
| 采样点 < 3 / 读取失败 | `null` | 本轮跳过，不改状态（与既有「观测失败」一致） |
| 斜率 ≤ 0（无增长） | `NO_GROWTH_DAYS` | 不命中 → 已 firing 的事件被解除 |
| 交汇点在最后一个采样点之前（已越过总量） | `0` | 命中（0 < 阈值） |
| 正常外推 | 天数（保留 1 位小数） | 按 `< 阈值` 判定 |

> ⚠️ 前端 `disk-trend-chart.ts` 仍算自己的预测用于画图与文案；两处算法同源但**不共享代码**（前后端不同包）。后端这版是**告警口径的唯一真相**；改动任一处须同步另一处，并在 PR 说明。前端「无增长」文案与后端「视为不会用尽」语义一致。

检测器新增 `evalDiskForecast()`：读 `hostmetricsample` 中 `metric_key='disk_used:/data'` 近 **7 天**采样（上限 2000 点）+ `diskUsage('/data')` 的总量，调用上述纯函数。

> **窗口为什么是 7 天**：本机容量被主动治理（日志清理每小时执行），一次性清理会主导长窗口拟合。2026-09-15 实测：30 天窗口斜率 **−55.76 GB/天**（被 09-08 释放约 1 TB 的清理拉负）→ 规则会永远判「无增长」而静默失效；同期 7 天窗口 **+6.27 GB/天**、3 天 +6.88 GB/天。取 7 天兼顾「平滑小时锯齿」与「不被单次清理带偏」。
>
> **口径提示**：外推用的总量取 `fs.statfs` 的 `blocks*bsize`（含 root 保留块），而采样值 = 总量 − `bavail`（即可用之外的占用），与前端趋势图同口径；因此天数偏乐观约 5%（保留块）。

## 7. 前端信息架构

仍单页工作台，Tab 由 6 个增至 7 个：

| Tab | 变更 |
|---|---|
| 概览 | 顶部按需出现三类提示条（无联系人 / N 条规则无效 / 近 24h 通知失败）；数字来自 `overview.health` |
| 策略 | 规则行增健康标签（颜色：失效=红、缓存不可用=橙、无联系人=橙、正常=不显示），悬停看 `health_detail` |
| 变更记录（新增） | 时间 / 操作者 / 动作 / 对象 / 变更内容（`changes` 渲染为「字段：旧 → 新」） |
| 历史 / 屏蔽 / 通知记录 / 联系人 | 不变 |

## 8. 验收与非目标

与 PRD §4（AC-1～AC-10）、§5（非目标）一致。交付前运行 `python3 scripts/arch_ratchet.py` 并把新增测试加入 `scripts/build.sh` 白名单。

## 9. 红线声明

| 红线 | 本方案处理 |
|---|---|
| 1 不侵入社区版 | 只读 `system.*` 与自有 MySQL 表，不碰社区版表结构 |
| 2 不破坏数据链路 | 全部只读 + 告警不自动处置；检测器加锁仅影响自身周期 |
| 3 密钥不入库 | 审计只写脱敏地址；重试日志不打 URL |
| 4 查询必须有界 | 采样查询带时间范围与 take 上限；沿用只读通道 |
| 6 数据变更有审计 | 告警配置变更首次纳入审计，与数据管理共用 `ops_action_log` |
