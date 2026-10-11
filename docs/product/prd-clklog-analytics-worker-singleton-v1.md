# PRD：后台调度单写者与非生产环境不调度

> phase: clklog-analytics-worker-singleton-v1
> 帽子：产品（`docs/product/`）
> 上游：`docs/architecture/clklog-analytics-design.md`（进程角色与后台任务）、`docs/product/prd-clklog-analytics-v1.md`
> 下游：`docs/architecture/clklog-analytics-design-worker-singleton-v1.md`

---

## 1. 阶段目标与范围

平台里有一类工作不是由请求触发的，而是自己按时间跑：卡片缓存刷新、告警检测与保留期清理、日志清理、指标采样，以及每日的分群重算 / 埋点元数据统计 / 标签重算。

它们现在是「谁加载了 AppModule 谁就跑」。这带来两个后果，都是本次事故暴露出来的：

1. **本地开发实例也在跑生产调度。** `background_workers` 的判据只有 `ENABLE_INGESTOR !== 'true'`，默认就是开。开发机上用隧道直连生产库时，一个本机实例会照样去刷生产卡片缓存、查生产 ClickHouse、写生产库。2026-09-24 实际发生：一个残留的 `nest start --watch` 进程在生产库上跑了 2 天调度，最后自己崩在连接池超时上，同时给生产 ClickHouse 制造了额外读负载。
2. **同一个生产环境里，有两份调度在跑。** 三个 `@Cron` 任务（分群重算 02:00、埋点元数据统计 01:00、标签重算 02:30）**完全没有** `background_workers` 守卫，而 ingestor 进程复用同一个 `AppModule`，于是这三个任务在 server 与 ingestor 里各注册一次 —— 每天各跑两遍。

本期把「后台调度由谁跑」这件事变成**进程角色说了算、且只有一个进程跑**，并且**非生产环境默认不跑**。

| 模块 | 本次做什么 |
|------|------------|
| 调度开关 | `background_workers` 判据纳入运行环境：仅生产实例为真；提供显式覆盖开关供本地/特殊部署使用 |
| 定时任务 | 三个 `@Cron` 任务补上与其他后台任务一致的守卫（此前完全不设防） |
| 可观测 | 启动时打印进程角色、调度开关、判据与目标库主机（不带凭据），把「本机在跑生产调度」变成启动即可见 |
| 自查 | 提供本地残留进程自查/清理脚本，并在运维文档写明用法 |

## 2. 用户流程

**本地开发（默认）**：`npm run start` 起本机实例 → 启动日志明确写「后台调度：未启用（NODE_ENV 非 production）」并列出被关掉的任务名 → 开发照常读写数据、调接口、看图表，**但不会替生产跑任何定时任务**。需要本地验证告警/缓存等调度行为时，显式设 `CLKLOG_BACKGROUND_WORKERS=true` 再起。

**生产**：server 进程正常跑全部调度，启动日志写明「后台调度：已启用」；ingestor 进程写明未启用。

**自查**：怀疑有残留实例时，跑一次清理脚本，先看清单（默认不动手），确认后加 `--kill` 终止。

## 3. 验收标准

- [ ] **SC-1（非生产不调度）**：`NODE_ENV` 非 `production` 且未显式覆盖时，`background_workers` 为假；五处已有守卫的后台服务（卡片缓存、告警检测、告警保留期清理、日志清理、指标采样）全部跳过。
- [ ] **SC-2（Cron 也受控）**：三个 `@Cron` 任务（分群重算 / 埋点元数据统计 / 标签重算）在 `background_workers` 为假时直接返回，不产生任何查询或写入。
- [ ] **SC-3（生产不受影响）**：生产 server 进程（`NODE_ENV=production`）的 `background_workers` 仍为真，五处后台服务与三个 Cron 任务的既有行为不变；ingestor 进程仍为假。
- [ ] **SC-4（可发现）**：server 与 ingestor 启动时各打印一行后台调度决定，含进程角色、开关、判据与目标数据库主机（**不含任何凭据**）。
- [ ] **SC-5（可覆盖）**：`CLKLOG_BACKGROUND_WORKERS=true/false` 能显式覆盖环境判定，用于本地联调与特殊部署。
- [ ] **SC-6（自查工具）**：清理脚本默认只列不杀；`--kill` 才终止；输出包含进程、启动时间与所在目录。
- [ ] **SC-7（门禁与回归）**：新增/改动单测通过；`python3 scripts/arch_ratchet.py`、`python3 scripts/i18n_check.py`、`python3 scripts/i18n_scan.py --check` 通过。

## 4. 非目标

- 不做分布式选主 / 心跳租约：本期只按「进程角色 + 运行环境」判定，不引入新表或新组件。（真正的多实例选主属于后续工作，见遗留。）
- 不改任何后台任务自身的业务逻辑、周期、批大小与幂等语义。
- 不改 ingestor 的消费链路，不碰 Kafka、ClickHouse 写入路径。
- 不改生产 supervisor 配置与 Puppet 模板：生产 server 已设 `NODE_ENV=production`，本期不依赖新增环境变量。
- 不做「启动时禁止连生产库」的硬拦截：本地读生产数据是既有开发方式，本期只阻止**写侧调度**。
