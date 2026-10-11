# 验收记录：ClkLog 分析平台 v1 阶段 1（P0 数据补齐）

> phase: clklog-analytics-v1
> 验收时间：2026-07-28
> 验收人：Agent（程序实现）
> 上游：`docs/product/prd-clklog-analytics-v1.md` §5.1、`docs/architecture/clklog-analytics-design.md` §5/§6

---

## 1. 验收项与结果

| 编号 | 验收项 | 判定标准 | 结果 | 证据 |
|------|--------|---------|------|------|
| A1 | `sa_events` 与 `log_analysis` 行数一致 | 同一时段 track 事件误差 < 0.1% | ✅ 通过 | `sa_events` 65 行 = `log_analysis` track 事件 65 行 |
| A2 | 自定义属性完整入库 | `JSONExtractString(properties,'product_id')='P1'` 可命中 | ✅ 通过 | 7 条 `SdkSpecTest` 事件命中 `product_id='P1001'` |
| A3 | `user_set` 写入用户画像 | `sa_user_profiles` 可按 distinct_id 查到属性 | ✅ 通过 | 11 行 profile，`register_channel='app_store'`、`vip_level=3` 可査 |
| A4 | ingestor 续传/回灌不丢数据 | 重启后从位点续传；`INGESTOR_REPLAY=true` 可从头回灌 | ✅ 通过 | replay 后行数与 `log_analysis` 一致；代码已加 `commitOffsetsIfNecessary` |

---

## 2. 关键环境信息

- 服务器：`生产主机`（<ssh-hop>）
- 部署目录：`/opt/clklog-analytics-server/`
- ClickHouse：`127.0.0.1:8123`，库 `clklog_sa`
- MySQL：`<mysql-host>:3306`，库 `clklog_sa_meta`
- Kafka：`<kafka-host>:9092`（CKafka PLAINTEXT 内网接入点），topic `clklog`
- Consumer group：`clklog-sa-ingestor`

---

## 3. 复现命令

### 3.1 启动 ingestor（服务器端）

```bash
ssh -p 2223 root@localhost
cd /opt/clklog-analytics-server
CLICKHOUSE_PASSWORD="<CK密码>" \
MYSQL_PASSWORD="<MySQL密码>" \
DATABASE_URL="mysql://root:<MySQL密码>@<mysql-host>:3306/clklog_sa_meta" \
APP_CONFIG_PATH="/opt/clklog-analytics-server/config_server.yaml" \
ENABLE_INGESTOR=true \
npx ts-node src/scripts/run-ingestor.ts
```

### 3.2 历史回灌（一次性）

在上述命令基础上增加 `INGESTOR_REPLAY=true`，会从 topic 最早位点消费一次：

```bash
INGESTOR_REPLAY=true npx ts-node src/scripts/run-ingestor.ts
```

### 3.3 数据一致性校验

```sql
-- sa_events 行数与 CRC 唯一性
SELECT count(), count(DISTINCT crc) FROM clklog_sa.sa_events;

-- log_analysis 非空 event 行数（即 track 事件）
SELECT count() FROM clklog.log_analysis WHERE event != '';

-- 自定义属性校验
SELECT count() FROM clklog_sa.sa_events
WHERE JSONExtractString(properties, 'product_id') = 'P1001';

-- 用户画像校验
SELECT distinct_id,
       JSONExtractString(properties, 'register_channel') AS channel,
       JSONExtractInt(properties, 'vip_level') AS vip
FROM clklog_sa.sa_user_profiles
LIMIT 5;
```

### 3.4 测试上报

服务器上已放置 `/tmp/test_report.py`，执行：

```bash
python3 /tmp/test_report.py
```

---

## 4. 关键修复记录

| 问题 | 原因 | 修复 |
|------|------|------|
| Kafka 连接 timeout | 误用 CKafka SASL_SSL 端口 9093，且自定义 socketFactory 未调用 `onConnect`、未设置 keep-alive | 切换为 PLAINTEXT 端口 9092；`kafka-socket.factory.ts` 传入 `onConnect` 并调用 `socket.setKeepAlive(true, 60000)` |
| ClickHouse 写入失败 `expected '"' before '.913'` | `ingest_time` 列类型为 `DateTime`，但传入了带毫秒的字符串 | 新增 `formatDateTimeSeconds()`，秒级精度写入 `ingest_time` |
| 消息解析失败进入 DLQ | ClkLog receiver 写入 Kafka 的格式为 `CSV 头部 + JSON 数组` | `sa-event-parser.service.ts` 支持 CSV 头部分离、从 `identities.user_key` 取 `user_key`、时间戳支持 number/string |
| `sa_events` 出现重复 CRC | CRC 基于 `distinct_id + time`，同一用户同一毫秒多事件冲突 | CRC 改为基于整条 Kafka 消息原文 + 数组下标 `rawPayload + '#' + index` |
| offset 未提交导致续传风险 | KafkaJS `eachBatch` 默认不自动提交 | 在 `eachBatch` 末尾调用 `commitOffsetsIfNecessary()` |

---

## 5. 遗留 TODO

- [ ] 将服务器启动命令固化为 systemd 服务或 Puppet 管理容器，不再依赖 `npx ts-node` 手动运行。
- [ ] 本地开发 `.env` 已提供示例，用户需复制为 `apps/analytics-server/.env` 并填入真实值。
- [ ] 后续 phase 需补充 `sa_readonly` 只读账号、nginx `/sa/` 路径配置。
