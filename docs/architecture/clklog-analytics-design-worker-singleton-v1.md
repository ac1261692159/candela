# 架构：后台调度单写者与非生产环境不调度

> phase: clklog-analytics-worker-singleton-v1
> 帽子：架构（`docs/architecture/`）
> 产品：[PRD](../product/prd-clklog-analytics-worker-singleton-v1.md)
> 相关：`clklog-analytics-design.md`（进程角色：server / ingestor 复用同一 AppModule）、`clklog-analytics-design-i18n-v1.md` §11.1（日志文案不翻译）

---

## 1. 阶段目标、范围与验收

不新增进程、不新增组件、不新增表。改动集中在三处：**调度开关的判据**、**三个漏掉守卫的定时任务**、**启动时的可观测性**。验收对齐 PRD SC-1～SC-7，非目标同 PRD。

## 2. 现状与缺口

`background_workers` 目前只有一个判据：

```ts
background_workers: process.env.ENABLE_INGESTOR !== 'true',   // configuration.ts:182
```

两个缺口：

| 缺口 | 后果 |
|---|---|
| 判据不看运行环境，默认即为真 | 本地 `nest start --watch`（`NODE_ENV=development`、`config_dev.yaml`、经隧道连生产）照样跑全部后台调度。2026-09-24 事故：一个残留实例在生产库上跑了 2 天调度 |
| 三个 `@Cron` 任务完全没有守卫 | ingestor 复用 `AppModule`（`run-ingestor.ts` + `configuration.ts:186` 的注释即为此设计），于是 01:00 埋点元数据统计、02:00 分群重算、02:30 标签重算**在生产环境各跑两遍** |

已有守卫的五处（可作为改造样板）：`card-cache.worker.ts:37`、`alert-detector.service.ts:90`、`alert-retention.service.ts:56`、`log-cleanup.service.ts:42`、`metric-sampler.service.ts:44`。

## 3. 判据设计

```ts
function resolveBackgroundWorkers(): boolean {
  const override = process.env.CLKLOG_BACKGROUND_WORKERS;
  if (override === 'true') return true;    // 显式开：本地联调告警/缓存时用
  if (override === 'false') return false;  // 显式关：安全兜底
  if (process.env.ENABLE_INGESTOR === 'true') return false;
  return process.env.NODE_ENV === 'production';
}
```

判据顺序（也是启动摘要里打印的理由）：

1. `CLKLOG_BACKGROUND_WORKERS` 显式覆盖 —— 最高优先级，给本地联调与特殊部署用；
2. ingestor 进程 —— 只做消费与写入，不起调度（与既有设计一致）；
3. `NODE_ENV === 'production'` —— 生产 server 才跑。

**为什么用 `NODE_ENV` 而不是别的标记**：生产 supervisor 已经设了 `NODE_ENV="production"`（`/etc/supervisord.d/clklog_analytics_server.ini`），本地 `run_dev.sh` 设 `NODE_ENV=development`，两边天然可分，**不需要改 Puppet 或 supervisor**——避免为了加开关去动那个已知有漂移风险的手工 ini。

**为什么不用「连的是不是生产库」判断**：本地开发本来就是经隧道连生产数据（`config_dev.yaml` 里 MySQL `localhost:13306`、ClickHouse `localhost:18123`），读生产数据是既有工作方式；本期要挡的只是**写侧调度**。判断「库在哪」既会误伤合法开发，也识别不出隧道背后的真实目标。

## 4. 两个写侧收口

### 4.1 五处已有守卫

不改动，判据变严后自动生效。跳过时维持各自既有日志行为。

### 4.2 三个 `@Cron` 任务补守卫

`meta-stats-refresh.job.ts`、`cohort-compute.job.ts`、`tag-compute.job.ts` 的 handler 首行：

```ts
if (!appConfig.background_workers) return;
```

**这里刻意不写日志**，理由：三个任务分别在 01:00/02:00/02:30 触发，跳过时逐条打日志只会把「为什么没跑」稀释成每天的噪声；真正的答案在**启动那一行**（§5）已经给全，且日志文案按 i18n §11.1 属于「日志与审计原文」不翻译——少写它就少一条需要解释的棘轮计数。

## 5. 启动可观测性

`configuration.ts` 导出：

```ts
export const appConfigPath: string;                 // loadYamlConfig 解析出的真实配置路径
export function backgroundWorkerSummary(): string;  // 一行摘要，含角色/开关/判据/配置路径/库主机/被跳过的任务名
```

`main.ts`（server）与 `scripts/run-ingestor.ts`（ingestor）各打印一次。

摘要形如：

```
后台调度：未启用（NODE_ENV=development）｜角色=server｜配置=/…/config_dev.yaml｜MySQL=localhost:13306｜ClickHouse=localhost:18123｜跳过=卡片缓存刷新/告警检测/告警保留期清理/日志清理/指标采样/分群重算/埋点元数据统计/标签重算
```

**脱敏约束**：只取主机与端口，绝不打印 `DATABASE_URL` 原文、用户名或口令（生产 supervisor 环境里是真口令）。MySQL 主机从 `DATABASE_URL` 用 `new URL()` 取 `hostname:port`，解析失败时打 `(无法解析)`；ClickHouse 取 `appConfig.clickhouse.readonly.host:port`。

## 6. 本地残留自查

新增 `scripts/dev-cleanup.sh`：

- 默认只列出匹配 `nest start --watch` / `node …/analytics-server/dist` 的本地进程（PID、启动时间、工作目录），**不动手**；
- `--kill` 才发 SIGTERM，3 秒后仍在的补 SIGKILL，最后复查并打印结果；
- 只在本机执行，不碰服务器。

运维记录写在根目录 `docs/project/legacy-production-handover.md`（本地起停与残留自查一节）。

## 7. 与硬门禁的关系

- 入口装配文件数（`main.ts` + `app.module.ts` + `src/config/` + `src/scripts/`）**不新增生产文件**：判据与摘要都放进既有的 `configuration.ts`，两个入口只加一行调用。
- `background_workers` 的读者数量不变（仍是 5 处 + 新增 3 处 = 8 处），但它是 `appConfig` 字段读取、不是 `process.env` 读取，不触碰 envReaders 冻结表。
- 新增中文只出现在启动摘要一句（日志原文，不翻译），i18n 覆盖率棘轮如上升按规则 `--force --update` 并在提交说明写明原因。
