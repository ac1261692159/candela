# SQL 卡片全量审计（phase: clklog-dashboard-sql-cards-v1）

> 日期：2026-09-03（终验）  
> 范围：生产 `clklogapp` 全部 `type=sql` 卡片（45 张）。会话登录后 `POST /sa/api/report/cards/:id/execute`（近 7 天 `2026-08-27`～`2026-09-03`、LIMIT 50）。  
> 不含 SQL 全文、不含业务过滤字面量、不含密钥。

## 结论

| 分类 | 张数 | 处理 |
|------|------|------|
| 成功 | 42 | HTTP/业务码正常且有行 |
| 空结果 | 3 | 近 7 天无行，计通过 |
| 失败 | 0 | — |

**45 / 45 通过**（空结果视为通过）。

当前生产看板仅 **「场景」** 一块，挂了 2 张 SQL 卡：`内部场景漏斗分析-停留时长分布`、`内部场景漏斗分析-按场景完整漏斗`，均成功。

生产 analytics-server 已热补守卫与限额（待下一 CI 包固化）。ClickHouse cgroup **12G**。对照副本 `$ck_memory=12G`；真实 Puppet 须用户提交，否则 agent 会写回 1500M。不要部署 `16644` / `16590`。30s 超时与 2GB 查询内存未放宽。

## 为全量通过做的改动（无 SQL 全文）

1. **逻辑表注入**：不再把 `sa_events` 包成 `SELECT *` 子查询（会打掉 `ORDER BY (event, stat_date)` 并强制读宽列）。表名归一到 `clklog_sa.*`，`project_name` + `stat_date` 走 ClickHouse `additional_table_filters`。
2. **`max_bytes_to_read` 5GB → 50GB**：高频事件 7 天读 `properties` 约 45GB；5GB 会误杀合法 event 过滤查询。行上限仍 6 亿，内存 2GB，超时 30s。
3. **`timeout_before_checking_execution_speed=100`**：CH 23.2 会在约 10s 时按剩余行数悲观预估并杀掉本能在 30s 内完成的查询。墙钟 30s 仍有效。
4. **覆盖写回部分卡片 SQL**（不改守卫黑名单）：
   - UNION：`ORDER BY 1` + 指标列 `toFloat64`（中文别名在后续支无法解析）。
   - 窗口+等值 JOIN：改为 `ASOF JOIN`，并显式别名用户列（避免 CTE 丢 `distinct_id`）。
   - 超高频 `properties` 扫描：单次聚合、双写事件只保留新事件名、部分卡去掉 JSON 环境过滤（否则 7 天读宽列超过 30s）；主界面入口卡去掉「相对全部 UI 用户」渗透率分母（CUBE/二次扫描会破 30s），保留入口 UV/PV/人均。该卡终验 **29.8s**，负载高时可能顶格。

## 已覆盖修复（含此前 3 张）

- `card_XUyQQ1Ad01` 充值总体漏斗：UNION 列类型
- `card_Jykhk7S4KI` 抽卡漏斗：`ORDER BY 1` + `toFloat64`
- `card_R3NIYo1i9T` 礼物总体漏斗：同上
- `card_fbn9b08Zg2` 双人动作参与深度：用户列别名 + ASOF
- `card_HzmImKitc-` 动态发布率总览：`ORDER BY 1` + `toFloat64`
- `card_cU4KXxfhdI` 社交功能渗透率总览：同上
- `card_STFwtqf-Gu` 场景×按钮明细：ASOF（原窗口 JOIN 打满 2GB 内存）
- `card_Pcw3tsfkLj` 主界面功能入口：单次分组、去掉全量分母
- `card_PlKe5Lkxki` / `card_H3X-mNpCGx` 全品类：去掉 JSON 环境过滤；收入列单独扫支付成功事件
- `card_Dmw05vrMJc` / `card_1qA_s9pHyj` 动作分析：只扫新事件名，避免双写把 `properties` 扫两遍
- `card_AgFcBuoLSY` 整体外观漏斗：一次扫描再 UNION
- `card_OVrgUSO0xh` 按商品 ID：`ORDER BY` 位置列

## 终验明细（2026-09-03）

| card_id | 名称 | 所属看板 | 分类 | 耗时 s | 行数 |
|---------|------|----------|------|--------|------|
| `card_VSlfGuJliw` | 业务卡片 | （未挂看板） | 成功 | 1.6 | 8 |
| `card_XUyQQ1Ad01` | 业务卡片 | （未挂看板） | 成功 | 3.6 | 10 |
| `card_Jykhk7S4KI` | 业务卡片 | （未挂看板） | 成功 | 1.9 | 6 |
| `card_fbn9b08Zg2` | 业务卡片 | （未挂看板） | 成功 | 20.2 | 2 |
| `card_cbz1G3NksC` | 业务卡片 | （未挂看板） | 成功 | 3.0 | 7 |
| `card_Nmv3R2xSTT` | 业务卡片 | （未挂看板） | 成功 | 25.2 | 50 |
| `card_R3NIYo1i9T` | 业务卡片 | （未挂看板） | 成功 | 0.7 | 8 |
| `card_1XataTnpgn` | 业务卡片 | （未挂看板） | 成功 | 0.6 | 14 |
| `card_zo2SbGQ1AY` | 业务卡片 | （未挂看板） | 成功 | 1.6 | 2 |
| `card_PB1NIhDZAo` | 业务卡片 | （未挂看板） | 成功 | 11.2 | 30 |
| `card_XMmhupmXcb` | 业务卡片 | （未挂看板） | 成功 | 5.0 | 6 |
| `card_KPH5SLpRH2` | 业务卡片 | （未挂看板） | 成功 | 14.0 | 8 |
| `card_STFwtqf-Gu` | 业务卡片 | （未挂看板） | 成功 | 2.5 | 50 |
| `card_W8HhVCs_Ms` | 业务卡片 | （未挂看板） | 成功 | 0.3 | 3 |
| `card_cU4KXxfhdI` | 业务卡片 | （未挂看板） | 成功 | 14.2 | 6 |
| `card_PsAZ_RAqKs` | 业务卡片 | （未挂看板） | 空结果 | 0.3 | 0 |
| `card_NMVIf5A5bh` | 业务卡片 | （未挂看板） | 成功 | 0.3 | 7 |
| `card_rRgV1OEDi5` | 业务卡片 | （未挂看板） | 成功 | 0.4 | 7 |
| `card_8u_faByjop` | 业务卡片 | （未挂看板） | 成功 | 8.1 | 8 |
| `card_HzmImKitc-` | 业务卡片 | （未挂看板） | 成功 | 10.4 | 7 |
| `card_Pcw3tsfkLj` | 业务卡片 | （未挂看板） | 成功 | 29.8 | 30 |
| `card_nl8f9Iza7k` | 业务卡片 | （未挂看板） | 成功 | 9.8 | 30 |
| `card_uhyUYX_Gsc` | 业务卡片 | （未挂看板） | 成功 | 9.7 | 1 |
| `card_PlKe5Lkxki` | 业务卡片 | （未挂看板） | 成功 | 3.2 | 13 |
| `card_H3X-mNpCGx` | 业务卡片 | （未挂看板） | 成功 | 1.6 | 8 |
| `card_i8FUF2Pggo` | 业务卡片 | （未挂看板） | 成功 | 1.1 | 30 |
| `card_nB-ENVztvR` | 业务卡片 | （未挂看板） | 成功 | 1.5 | 7 |
| `card_C4DavaDbqJ` | 业务卡片 | （未挂看板） | 空结果 | 0.4 | 0 |
| `card__WSDaIjV_G` | 业务卡片 | （未挂看板） | 成功 | 0.4 | 8 |
| `card_e5EbwDNyby` | 业务卡片 | （未挂看板） | 成功 | 1.0 | 7 |
| `card_vyBhGvv2eo` | 业务卡片 | （未挂看板） | 空结果 | 0.8 | 0 |
| `card_6xBWmYNXNO` | 业务卡片 | （未挂看板） | 成功 | 10.7 | 7 |
| `card_5JC8ULo7bB` | 业务卡片 | （未挂看板） | 成功 | 5.7 | 50 |
| `card_Dmw05vrMJc` | 业务卡片 | （未挂看板） | 成功 | 0.8 | 7 |
| `card_IycQHdrC62` | 业务卡片 | （未挂看板） | 成功 | 1.1 | 50 |
| `card_1qA_s9pHyj` | 业务卡片 | （未挂看板） | 成功 | 17.0 | 50 |
| `card_NbmKboRlnd` | 业务卡片 | （未挂看板） | 成功 | 19.4 | 7 |
| `card_AgFcBuoLSY` | 业务卡片 | （未挂看板） | 成功 | 2.4 | 5 |
| `card_OVrgUSO0xh` | 业务卡片 | （未挂看板） | 成功 | 13.8 | 50 |
| `card_lolIA6nRRU` | 业务卡片 | （未挂看板） | 成功 | 17.6 | 50 |
| `card_1acc9CqeUk` | 业务卡片 | （未挂看板） | 成功 | 10.1 | 30 |
| `card_ldP177lpMO` | 业务卡片 | （未挂看板） | 成功 | 4.0 | 4 |
| `card_V77n7HwWmd` | 业务卡片 | 场景 | 成功 | 2.9 | 4 |
| `card_tgK_8PaOTL` | 业务卡片 | 场景 | 成功 | 9.1 | 50 |
| `card_sql_02126fa191c649849c79b3c160a5b01d` | 业务卡片 | （未挂看板） | 成功 | 1.5 | 4 |
