# 验收记录：后台调度单写者与非生产环境不调度

> phase: `clklog-analytics-worker-singleton-v1`
> 验收日期：2026-09-24
> 对应 PRD：`docs/product/prd-clklog-analytics-worker-singleton-v1.md`
> 对应架构设计：`docs/architecture/clklog-analytics-design-worker-singleton-v1.md`
> 状态：**已发版并在生产环境完成验收**

---

## 1. 事故与清理

| 时间 | 事项 |
|---|---|
| 2026-09-24 12:33 | 一个本机 `nest start --watch`（起于 09-22 20:23）崩在 Prisma 连接池超时（`P2024`）。日志显示它此前**在生产库上跑了整整两天后台调度**：卡片缓存刷新、ClickHouse 查询、告警检测、指标采样、时区注册表刷新；12:23 刷卡片时 ClickHouse `socket hang up` |
| 2026-09-24 14:20 | 又查出**6 个更早的残留**（09-17–09-18 起的 `nest start --watch`）：子进程已死、无任何 TCP 连接，但 `--watch` 会在文件变动时重启应用 —— 隐患 |
| 2026-09-24 14:22 | 6 个全部 `SIGTERM` 终止，复查剩余 0、本机到 3306/8123/9000 的连接 0 |

**副作用核查**：事故实例的日志里没有清理删除或告警落库成功的痕迹；它的 ClickHouse 查询走分析链路（有界 + 只读）。结论是「重复写者」而非「数据损坏」。

## 2. 发版记录

| 版本 | 提交 | 内容 |
|---|---|---|
| 17582 | `e699c0f` | 判据收紧 + 三个 `@Cron` 补守卫 + 启动摘要 + `scripts/dev-cleanup.sh` + HANDOVER 第二十七节 |

`clklog_analytics_server` / `clklog_analytics_ingestor` 均 RUNNING（14:34 重启）。

## 3. 生产实测证据

### 3.1 启动摘要（`analytics-server.log`，14:34:31）

```
后台调度：已启用（NODE_ENV=production）｜角色=server
｜配置=/data/app/clklog_manager/server/configs/config.yaml
｜MySQL=<mysql-host>:3306｜ClickHouse=127.0.0.1:8123
```

生产 server 的调度**照旧开着**（SC-3）：判据收窄后 `NODE_ENV=production` 依然为真，行为与改动前一致；这一行里没有任何用户名或口令。

### 3.2 启动摘要（`analytics-ingestor.log`，14:34:42）

```
后台调度：未启用（ingestor 只做消费与写入）｜角色=ingestor
｜配置=/data/app/clklog_manager/ingestor/configs/config.yaml
｜MySQL=<mysql-host>:3306｜ClickHouse=127.0.0.1:8123
｜跳过=卡片缓存刷新/告警检测/告警保留期清理/日志清理/指标采样/分群重算/埋点元数据统计/标签重算
```

这就是**修掉的那个重复写者**：改动前 ingestor 虽然在五处 setInterval 型任务上被挡，但三个 `@Cron` 任务完全没有守卫，
每天 01:00/02:00/02:30 与 server 各跑一遍；现在它一行都不跑。核查日志：ingestor 侧 `每日分群重算 / 每日标签重算 / 每日元事件统计刷新` 无记录，而 `SaEventWriter` 正常写入（消费链路未受影响）。

### 3.3 server 侧调度仍在工作

重启前的同一份日志（`pid 1675518`）里有 `CardCacheWorker` 的周期活动记录。重启后新进程（`pid 1725507`）的摘要行已确认开关为真；
这三个后台服务在健康时不打日志（只在失败时打），因此「没有新日志」属正常，不以它作为开关证据。

## 4. 覆盖对照

| PRD 验收项 | 结果 |
|---|---|
| SC-1 非生产不调度 | ✅ 单测环境矩阵（production/development/未设置/ingestor/显式覆盖） |
| SC-2 三个 Cron 受控 | ✅ 三个任务各一条守卫用例（断言零查询）；生产 ingestor 侧日志无这三个任务的执行记录 |
| SC-3 生产不受影响 | ✅ 生产 server 摘要为「已启用」，与改动前判据等价（`NODE_ENV=production` 已由 supervisor 设置） |
| SC-4 可发现 | ✅ 两个进程各打印一行，含角色/判据/配置路径/两个库主机，无凭据（用例 §3.1 已核对不含 `mysql://`） |
| SC-5 可覆盖 | ✅ `CLKLOG_BACKGROUND_WORKERS=true/false` 用例 |
| SC-6 自查工具 | ✅ `scripts/dev-cleanup.sh` 用桩进程实测「识别 → 列出（PID/启动时间/cwd）→ 终止 → 复查」；默认只列不杀 |
| SC-7 门禁 | ✅ `arch_ratchet` 通过；`i18n_check` 通过；`i18n_scan --check` 持平（启动摘要中文按 i18n §24 属日志原文不翻译，已按规则 `--force --update` 上调 1403→1412 并在提交说明注明）；服务端 122 套 / 924 用例通过 |

## 5. 一并记录的风险（未在本期改动）

1. **supervisor ini 里是明文口令**：`/etc/supervisord.d/clklog_analytics_server.ini` 的 `environment=` 一行含 `CLICKHOUSE_PASSWORD` / `MYSQL_PASSWORD` / `DATABASE_URL` / `ALERT_CONFIG_KEY` 明文，且该 ini 不在 Puppet 托管清单内（既有漂移风险）。排查时贴日志或截图前必须滤掉这一行。已写入 HANDOVER 第二十七节末尾。
2. **仍未做分布式选主**：本期按「进程角色 + 运行环境」判定，能挡住本次事故的全部形态（本地实例、ingestor、未设 NODE_ENV 的意外实例），但挡不住「生产宿主机上被手工起的第二个 server 实例」。真正的多实例选主（DB 心跳租约或 MySQL `GET_LOCK`）列入非目标，需要时另开 phase。
3. **本地联调告警/缓存要显式开**：`CLKLOG_BACKGROUND_WORKERS=true npm run start`。这是有意的摩擦——默认不开才是安全的。
