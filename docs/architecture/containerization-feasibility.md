# 容器化部署可行性调研（compose / k8s yaml / helm）

> phase: `clklog-containerization-feasibility-v0`
> 性质：**架构调研结论**，不是实现方案。任何一档方案落地前，须另出满足 `AGENTS.md`「程序/实现门禁」的实现方案文档（含验收标准与非目标）。
> 调研日期：2026-09-16。事实来源以仓库内 Puppet 副本、`scripts/`、`apps/` 源码为准；线上权威 Puppet 模块为 `旧工作区/puppet/modules/clklog`（本仓库为脱敏副本）。

---

## 1. 结论

1. **社区版 ClkLog 已经是 docker-compose 部署**。Puppet 渲染 `docker-compose.yml.epp` → `/data/clklog/clklog-docker-compose/docker-compose-clklog-simple-prod.yml`，再由 `exec { 'clklog_compose_up' }` 执行 `docker compose up -d`。所以「改成 compose 部署」对社区版是既成事实，不是新工作。
2. **真正未容器化的是分析扩展 `apps/`**：`analytics-server`（HTTP）、`analytics-ingestor`（Kafka 消费者）、`analytics-web`（静态）、harness（broker + 运行时容器）。现状是 **rsync 发版 + supervisord 直接跑宿主 Node**（`/opt/clklog/node-v24.20.0-linux-x64`），这是容器化真正要动的部分。
3. **难度分档**（详见 §6）：

| 方案 | 难度 | 阻断项 | 主要成本在哪 |
|---|---|---|---|
| docker-compose 化扩展服务 | **低** | 0 个硬阻断 | 写 Dockerfile + 配置/密钥外置 + 卷规划 + 建镜像仓库 |
| k8s yaml | **中高** | 3 个硬阻断（ClickHouse 数据面、Flink standalone-job、harness rootless podman） | 有状态组件如何安置 + 单写者/定时任务改造 |
| helm | **中** | 继承 k8s 全部阻断 | 在 k8s 之上的模板化增量；不解决任何阻断项 |

4. **最优路径不是「整体上 k8s」，而是分层**：无状态 Web/API 层进 k8s（有收益），有状态数据面（ClickHouse、Flink）与 harness（宿主耦合）留在 CVM。把「有状态但不做高可用」的组件搬进 k8s，是**用更复杂的编排换取更少的收益**。
5. **有一条与 k8s 无关、但必须先做的前置改造**：`analytics-server` 的定时任务与后台循环没有选主，多副本会重复触发（§5.3）。不做这个，任何「扩副本」都是假的。

---

## 2. 现状：部署真相盘点

### 2.1 组件分布

| 层 | 组件 | 部署方式 | 位置/端口 |
|---|---|---|---|
| 入口 | nginx | 宿主包 + systemd | `0.0.0.0:80`，4 个域名 vhost |
| 社区版应用 | clklog-ui / receiver / api / manage / init | **容器**（compose） | 127.0.0.1:8081/8082/8083/8084 |
| 数据面 | clickhouse | **容器**（compose） | **0.0.0.0:8123 / 9000** |
| 数据面 | jobmanager / taskmanager（Flink） | **容器**（compose） | jobmanager 127.0.0.1:8085 |
| 可视化 | grafana | 独立 compose 栈（`/data/clklog/grafana`），外部网络接入 | 127.0.0.1:3000 |
| 分析扩展 | analytics-server | **宿主 Node + supervisord**，user=root | 127.0.0.1:3100 |
| 分析扩展 | analytics-ingestor | **宿主 Node + supervisord**，user=root | 无端口（Kafka 消费） |
| 分析扩展 | analytics-web | 宿主 nginx 静态 root | `/data/app/clklog_manager/web` |
| AI | harness-broker | 宿主 Node + supervisord，user=harness，**Unix socket** | `<harness_root>/gateway/control/broker.sock` |
| AI | harness 运行时 | broker 用 **rootless podman** 动态拉 `node:24.20.0-bookworm-slim` | 容器内 127.0.0.1:39100/39200，`--network=none` |
| 外部依赖 | MySQL / Redis / CKafka | 云托管，**不在部署内** | <mysql-host>:3306 / <redis-host>:6379 / <kafka-host>:9092 |

宿主：`生产主机`，AlmaLinux 9.7，**8 核 31G 单机**。全部容器资源限制加总 ≈ CPU 7.3 核、内存 ≈ 25G（`docker-compose.yml.epp` 的 `deploy.resources.limits`），已接近饱和——这决定了 k8s 化的节点规划不能按「随便加几个 pod」来算。

### 2.2 一句话判断

社区版那 8 个容器是「部署工具在管理 compose 文件」；扩展那 4 个服务是「部署工具在管理宿主进程」。**容器化的收益主要落在这 4 个服务上**，而不是重复社区版已完成的事。

---

## 3. 状态性矩阵

「有状态」分三类，混在一起谈会得出错误结论：**数据状态**（必须持久化）、**单写者状态**（多副本会写坏）、**宿主耦合状态**（进程必须与某台机的某个路径/内核能力绑定）。

| 组件 | 数据状态 | 单写者状态 | 宿主耦合 | 可水平扩副本 | 备注 |
|---|---|---|---|---|---|
| clickhouse | **重**：`/var/lib/clickhouse`，UID **101**，TB 级 | 无（单节点非复制表） | 无 | ❌ 单实例 | 扩副本 = 改 ReplicatedMergeTree + Keeper，属数据架构变更 |
| clklog-ui | 无 | 无 | 无 | ✅ | 静态 + `config.js` |
| clklog-receiver | 弱：`/log/*.log` | 无 | 无 | ✅（受 Kafka 分区约束） | 日志文件若容器化应改 stdout |
| clklog-api | 无 | 无 | 无 | ✅ | |
| clklog-manage | 弱：`/setting` 只读 + MySQL | 弱（`SPRING_FLYWAY_ENABLED=false` 是刻意的） | 无 | ✅ 但多实例不稳 | |
| clklog-init | 无 | 无 | 无 | — | **一次性任务**，却写了 `restart: always`；k8s 里语义应为 Job |
| jobmanager（Flink standalone-job） | 中：checkpoints，UID **9999** + 固定 `--job-id` | 是 | 无 | ❌ | Flink standalone 语义，不能多副本 |
| taskmanager | 中：同 checkpoints | 无 | 无 | ✅（调 slot/并行度） | `numberOfTaskSlots: 8` |
| grafana | 中：sqlite（named volume `grafana_data`） | 是 | 无 | ❌ | sqlite 不能多副本 |
| **analytics-server**（3100） | 无（DLQ 在 ingestor 侧） | **是**：内存态 + 定时任务无选主 | 是：harness runtime 是本机 unix socket + 本机进程 | ⚠️ 需先改造 | 见 §5.3 |
| analytics-ingestor | 弱：DLQ JSONL（**在 release 目录内，见 §7.1**） | Kafka 消费组（外部协调） | 无 | ⚠️ 上限 = 分区数 **6** | |
| analytics-web | 无 | 无 | 无 | ✅ | 纯静态，base=`/sa/`，API 走相对路径 `/sa/api`，天然适配任意反代 |
| **harness-broker** | 中：`<harness_home>/clklog-ai/**` | 是 | **强**：rootless podman、动态 UID、`/etc/subuid`、`/run/user/<uid>`、linger、cgroup delegate、宿主 bind mount | ❌ 单节点 | 见 §6.2 B3 |
| harness 运行时容器 | 中：`/dsh-home`、`/workspace` | 由 broker 管 | 强 | ❌ | **由 broker 动态创建，不是 k8s workload** |

---

## 4. 持久化存储清单

容器化/编排迁移时必须逐条落实的资源。**「UID 红线」是这一节的关键**：ClickHouse 数据目录必须 UID/GID 101、Flink checkpoints 必须 9999（`init.pp:75-98` 用 Puppet `chown` 强制），编排层不能靠镜像默认用户蒙过去。

### 4.1 社区版 compose 栈（`/data/clklog/clklog-docker-compose/`）

| 宿主路径 | 容器挂载 | owner:group / mode | 内容 | 迁移注意 |
|---|---|---|---|---|
| `clklog_dc_data/clickhouse` | `/var/lib/clickhouse:rw` | **101:101** 0755 | ClickHouse 全部数据 | k8s 需 StatefulSet + 独立 PVC + `fsGroup: 101` 或 initContainer chown；**存储类必须能本地/块设备语义** |
| `clklog_dc_data/clickhouse/log` | `/var/log/clickhouse-server` | **101:101** | CH 服务日志 | 可改 stdout |
| `clklog_dc_data/processing/checkpoints` | `/opt/flink/usrlib/checkpoints:rw`（jm + tm 共享） | **9999:9999** 0755 | Flink checkpoints | 需 jm/tm 共享的 **RWX** 卷，或改 state backend 到对象存储 |
| `clklog_dc_data/receiver` | `/log`（receiver）+ `/receiverlog`（manage） | root:root | receiver 文件日志 | ⚠️ 被运维面板「日志目录治理」直接删 `*.log` |
| `clklog_dc_data/initlog` | `/log` | root:root | init 日志 | |
| `clklog_dc_data/{redis,mysql/data}` | 未挂载 | root:root | **残留空目录**（Redis/MySQL 已云托管） | 迁移时可直接删 |
| `.env` | env_file | root:root **0600** | CK/MySQL 口令、`PROCESSING_JOB_ID` | → k8s Secret |
| `clklog_dc_config/`（递归） | bind 源 | Puppet 未指定（继承 fileserver） | CH 配置、UI config.js、manage 字典、Flink config.properties | → ConfigMap；注意 `processing/config.properties` 含 CH 明文口令 |
| `/data/clklog/grafana` + named volume `grafana_data` | `/var/lib/grafana` | root:root | Grafana sqlite | → PVC |

### 4.2 扩展服务（宿主）

| 路径 | owner:group / mode | 内容 | 迁移注意 |
|---|---|---|---|
| `/data/app/clklog_manager/{server,ingestor,web}` | root（supervisor 以 root 跑） | release 树：`dist/`、`node_modules/`、`prisma/`、`configs/config.yaml` | → 镜像；运行用户必须显式 pin（现在跑 root） |
| `/data/app/clklog_manager/ingestor/dist/dlq` | root | **DLQ JSONL** | ⚠️ **在 release 树内**，见 §7.1；容器化时应落独立卷 |
| `/home/harness/clklog-ai/**` | harness:harness **0700** | `runtimes/`、`workspaces/`、`rt/`（unix socket）、`gateway/`、`ai_workspace/` | → PVC；但 socket 路径长度上限 107 字节，与 pod 内路径拼接要验算 |
| `/etc/clklog/harness-broker.json` | root:harness 0640 | broker 配置（runtime root、container image、配额） | → ConfigMap（不含密钥） |
| `/data/logs/production/clklog_manager/*.log` | root:root | server/ingestor/broker 日志（20MB×20 滚动） | k8s 应改 stdout + 采集 |
| `/opt/clklog/node-v24.20.0-linux-x64`、`/opt/clklog/harness/current` | root:root | 宿主 Node 与 harness 版本软链 | → 镜像内 Node；harness 版本软链应换成镜像 tag |
| `/etc/subuid`、`/etc/subgid`、`/run/user/<uid>`、`/etc/tmpfiles.d/clklog-harness.conf`、`user@<uid>.service.d/clklog-cgroup-delegate.conf` | root:root | rootless podman 前置条件 | **k8s 内无法表达**，见 §6.2 B3 |

### 4.3 不在部署内的（无需迁移，但需连通）

MySQL `<mysql-host>:3306`（`clklog` 社区库 + `clklog_sa_meta` 元数据库）、Redis `<redis-host>:6379`（无密码，Key 前缀 `clklog_sa:`）、CKafka `<kafka-host>`（topic `clklog`，6 分区 1 副本）、SMTP、腾讯云 SMS、LLM 供应商（`tokenhub.tencentmaas.com`、`api.deepseek.com`）。

> 这些都是 **IP 白名单 + 跨网段**（`<data-net>` ↔ 宿主 `<app-net>`）。k8s 集群若新建 VPC，pod 出口 IP 段变化 → 安全组/对等连接要重做。**这是纯网络工作量，容易在评估时被漏掉。**

---

## 5. 扩展性：能扩什么，扩之前必须先改什么

### 5.1 真无状态、开箱可扩

`clklog-ui`、`clklog-api`、`analytics-web`、`clklog-receiver`（受 Kafka 分区间接约束）。这四个组件上 k8s 是**纯收益**：Deployment + Service，滚动更新，副本随意。

### 5.2 有状态但有外部协调、可有限扩

`analytics-ingestor`：Kafka 消费组保证分区不重复消费，所以只要**副本数 ≤ 分区数**就是安全的。CKafka topic `clklog` 是 **6 分区**（`docs/project/legacy-production-handover.md:174`），因此 **ingestor 副本上限 6**。前置条件：DLQ 必须落共享卷（现在落 release 目录，见 §7.1），否则每个副本各写各的、发版即丢。

### 5.3 单写者状态：扩副本的硬前置改造

`analytics-server` 内有 7 个定时/循环任务，**当前靠「只有一个进程」这个事实成立**：

| 任务 | 周期 | 是否受 `background_workers` 门禁 | 文件 |
|---|---|---|---|
| 告警评估（含内存 streak） | 60s | ✅ 受门禁 | `src/modules/alerting/alert-detector.service.ts:87` |
| 卡片缓存预热 | 30s | ✅ | `src/modules/report/card-cache.worker.ts:41` |
| 主机/磁盘采样 | 1h | ✅ | `src/modules/ops/metric-sampler.service.ts:50` |
| 日志清理（**会删文件**） | 1h | ✅ | `src/modules/ops/log-cleanup.service.ts:44-49` |
| 元数据统计刷新 | 每日 01:00 | ❌ **无门禁** | `src/modules/meta/meta-stats-refresh.job.ts:15` |
| 分群重算 | 每日 02:00 | ❌ **无门禁** | `src/modules/cohort/cohort-compute.job.ts:15` |
| 标签重算 | 每日 02:30 | ❌ **无门禁** | `src/modules/tag/tag-compute.job.ts:15` |

最后三个 `@Cron` 注册在 `AppModule` 里，**ingestor 进程也会加载**——即当前 2 个进程部署下，这三个任务本来就在重复执行。多副本会放大这个问题。

此外还有一批长生命周期内存态，天生与多副本冲突：harness runtime 表/tickets/capabilities（`harness-runtime-manager.service.ts:52-60`）、page bridge（`page-bridge.service.ts:48-50`）、限流窗口（`harness-gateway.service.ts:40-41`）、卡片 worker 退避、告警 streak。

> **结论：扩 `analytics-server` 副本 ≠ 改副本数，而是先做选主。** 可选路径：k8s Lease 选主、把后台任务拆成独立 Deployment（replicas=1）、或把三个 `@Cron` 改 CronJob。这一步与是否上 k8s 无关，**先做它，compose 和 k8s 都受益**。

### 5.4 不能扩（单实例，且理由各不相同）

- `clickhouse`：单节点非复制表；扩副本 = ReplicatedMergeTree + Keeper = **数据架构变更**。
- `jobmanager`：Flink standalone-job 语义 + 固定 `--job-id`。
- `grafana`：sqlite。
- `harness-broker`：宿主耦合（§6.2 B3）。

---

## 6. 三档方案难度

### 6.1 A 档：docker-compose 化扩展服务

**难度：低。无硬阻断项。**

社区版那一半不用动（已是 compose）。要做的：

1. **写镜像**：`analytics-server` 与 `analytics-ingestor` 共用一份代码（同一 `AppModule`），可**共用一个镜像、不同 command**，比现在两个 rsync 目录更简洁。`analytics-web` 用 nginx/静态镜像（`vite base=/sa/`，产物带 `/sa/` 层级）。
2. **配置与密钥外置**：现在密钥靠 supervisord 进程环境传递，`scripts/server-upgrade.sh` 还要从 `/proc/<pid>/environ` 里捞——容器化后改为 `env_file` / `.env`。注意 `apps/analytics-server/config_server.yaml` 目前**明文含 LLM API Key**，必须一并清理。
3. **卷规划**：DLQ 独立卷（顺带修 §7.1）、日志卷或改 stdout、harness root 与宿主共享挂载。
4. **harness 怎么办**（唯一需要决策的点）：
   - **推荐**：broker 保持宿主进程，容器内 server 通过挂载 `<harness_root>/gateway` 目录访问 broker 的 unix socket。要求**两侧挂载路径一致**（socket 路径长度还有 107 字节上限）。
   - **不推荐**：把 broker 容器化并让容器内跑 rootless podman。需要 `--privileged`、`--userns=host`、宿主 `/etc/subuid` 等，等于放弃隔离换取「都在 compose 里」的形式统一。
5. **发版链路改造**：CI 从 `build → rsync target/` 改成 `build → docker build → push registry`；服务器侧从 `server-upgrade.sh`（rsync + `prisma migrate deploy` + `prisma generate` + supervisorctl）改成 `docker compose pull && up -d`。**需要先有镜像仓库**（腾讯云 TCR）。
6. **入口不变**：宿主 nginx 继续反代，容器端口映射到 127.0.0.1。

**收益**：发版原子化、可回滚（镜像 tag）、消除两类现存缺陷（§7.1 的 DLQ 丢失、§7.2 的 prisma client 不同步）；`deploy.resources.limits` 的变更在 compose v2 里依然需要 `--force-recreate`（同 HANDOVER 问题 7），这点 k8s 反而更干净。

**成本量级**：写成「若干天」而非「若干周」，且不依赖任何新基础设施（除镜像仓库）。

### 6.2 B 档：k8s yaml

**难度：中高。3 个硬阻断 + 8 个工程项。**

先说定位：**k8s 对无状态层（§5.1）是净收益；对有状态但不做高可用的组件是负收益。** 三个硬阻断都在「有状态 + 宿主耦合」这一侧，且都需要专项设计决策，不是写 yaml 能解决的。

#### 硬阻断

**B1. ClickHouse 数据面。**
当前 CH 数据是宿主目录 bind mount，等价于**本地盘语义**。k8s 里必须落 PVC，而存储类选择直接决定成败：
- 用本地盘/块存储（如 CBS）：语义可行，但 PVC 与节点绑定，节点故障即不可调度。
- 用 NFS/CFS：**ClickHouse 官方不建议在网络文件系统上跑数据目录**（fsync/锁语义与性能），这是明确风险项。
- 单节点非复制表进 k8s：**不能水平扩、不做高可用**，收益仅剩「声明式管理」，却要付出 TB 级数据迁移 + `fsGroup: 101`/chown + 节点亲和 + 存储类验证的成本。
- 要真正受益必须上 Keeper + ReplicatedMergeTree（或用 CH Operator），那是**数据架构变更**，需要独立的实现方案与灰度。

→ **建议 CH 不进 k8s（至少在阶段 1/2 不进）。**

**B2. Flink standalone-job。**
`jobmanager` 用 `standalone-job --job-classname … --job-id ${PROCESSING_JOB_ID} --allowNonRestoredState`，与 `taskmanager` 共享 checkpoints 目录（UID 9999）。
- k8s 原生形态是 **Flink Kubernetes Operator**（改成 Application 模式 + HA + 自愈），属引擎侧变更，必须专项验证后再动生产链路（红线 2：任一环节改动必须先灰度验证）。
- 折中：普通 Deployment + jm 固定 `replicas: 1` + checkpoints 落 RWX 卷（或改 state backend 到对象存储，更稳）。可行但比现在的 compose 更绕。

→ **建议 Flink 与 CH 同批处置，同样留在 CVM（阶段 1/2）。**

**B3. harness（AI 运行时）——最大阻断。**
broker 要在**容器内做 rootless podman**，依赖：
- 宿主 `/etc/subuid`、`/etc/subgid`（200000–265535 区间）
- `/run/user/<uid>` 0700 + `/etc/tmpfiles.d/clklog-harness.conf` + `loginctl enable-linger`
- cgroup 委派 `Delegate=cpu cpuset io memory pids`（rootless podman 的 `--cpus/--memory` 靠它）
- 宿主路径 bind mount（`--userns=keep-id`、`--network=none`、`--read-only`，1GB/2CPU/256pids 配额）
- broker 显式**拒绝以 uid 0 运行**（`server.mjs:113-115`）

在 k8s 里表达这些，等价于 **privileged DaemonSet + hostPath 挂载 `/run/user`、`/etc/subuid`**——「在编排系统里再跑一个编排系统」。而且 harness 值钱的部分（runtime 进程、unix socket、workspace 文件）本来就必须与调用它的进程同机。

→ **建议 harness 明确留在节点/VM 上，作为应用的外部依赖**，通过 gateway socket 或（若跨机）HTTP 暴露。若组织上强制要求进 k8s，接受它是「绑死单节点 + hostPath + privileged」的特殊 workload，不要试图让它可调度。

**B4. 单写者与定时任务**（即 §5.3）：需要 k8s Lease 选主或拆分 workload。**这不是 k8s 引入的问题，是 k8s 暴露的问题。**

#### 工程项（不难，但都要做）

| # | 项 | 说明 |
|---|---|---|
| B5 | Harness WebSocket 亲和 | `/sa/harness` 的 WS 必须在持有该 runtime 的进程上终止（runtime 是本地 socket + 本地进程）。副本>1 时需 sticky session，且 runtime 归属进程与 WS 必须同 pod。现在这个约束靠「只有 1 个进程」隐式满足。 |
| B6 | UID/fsGroup 冲突 | CH 要 101、Flink 要 9999，**不能共用一个 `fsGroup`**。每个 PVC 单独 `fsGroup`，或 initContainer `chown`；容器运行用户显式 pin（现在 server/ingestor 跑 root）。 |
| B7 | 配置与密钥 | `config_server.yaml` 明文含 LLM Key 与 DB 口令 → Secret；`${VAR}` 插值是**环境变量**机制（`src/config/configuration.ts:107-119` 缺变量直接抛错），Secret 若以文件挂载需改读取路径。 |
| B8 | 镜像仓库与 CI | 现在官方镜像从阿里云公共 registry 拉；自建镜像要建 TCR 并把 CI 从 `build → rsync` 改成 `build → push`。 |
| B9 | 出口网络 | 云 MySQL/Redis/CKafka 按 IP 白名单放行、跨网段；新集群要重做安全组或 VPC 对等。⚠️ 另有一处现存不一致需先理清：Puppet 里 CKafka 端口写 `9093-9096`，应用配置写 `9092`。 |
| B10 | 入口与 TLS | 宿主 nginx 提供 4 个域名 + SSE/WS 反代（`map $http_upgrade`）+ 腾讯云 CLB 终止 TLS → Ingress + 注解（`proxy-buffering: off`、`proxy-read-timeout`、websocket-services），并理清 CLB 与 Ingress 的证书归属。 |
| B11 | 上报端口暴露 | ClickHouse 现在监听 `0.0.0.0:8123/9000`，k8s 里应收敛为 ClusterIP（红线 4 的安全边界）。 |
| B12 | 迁移作业语义 | `prisma migrate deploy` + `generate` 现在在启动命令里跑 → k8s 应拆成 Job/initContainer；副本>1 时迁移需串行。`clklog-init` 同理（现在 `restart: always`，应是 Job）。 |

### 6.3 C 档：helm

**难度：中（相对 B 档的增量），但前置依赖 B 档全部结论。**

- **增量工作**：把 B 档的 yaml 模板化 + 收敛成 values（镜像 tag、副本数、资源、存储类、外部依赖地址、Secret 引用、Ingress 域名）。这是**机械工作**，不产生新的架构风险。
- **真正价值**：本仓库是**私有化交付**形态，「一份 chart 覆盖多客户环境」的收益是真实的（同一 chart，不同 values 应对不同网段/域名/存储类/中间件地址）。这正是 helm 的主场。
- **不解决任何阻断项**：B1–B4 一条都不会因为用了 helm 而消失。先解决阻断，再谈 chart。
- **反面提示**：如果实际只有 1–2 个环境，kustomize（base + overlay）比 helm 更轻，不必引 helm 的模板语法与 release 状态。
- **依赖管理**：MySQL/Redis/Kafka 是云托管，**不要**引入 bitnami 子 chart 把它们搬进集群——那是与当前架构相反的方向（`development.md` 的选型就是「托管中间件 + 自建 CH」）。

---

## 7. 容器化顺带能解决的现存缺陷 / 会新增的问题

### 7.1 顺带能解决（当前真实在漏的地方）

1. **DLQ 会被发版冲掉**（应当现在就先修）。`dlq.service.ts:10` 默认路径 `path.resolve(__dirname, '../../../dlq')`，生产 `__dirname` 是 `<release>/dist/src/modules/ingestor` → 落到 **`/data/app/clklog_manager/ingestor/dist/dlq`，即 release 树内**；`DLQ_DIR` 环境变量**从未被设置**（supervisor env、`server-upgrade.sh` 均无）。每次发版替换 release 目录 = DLQ 数据丢失。容器化天然修掉（独立卷），但**不容器化也应该修**。
2. **`prisma generate` 在启动命令里跑**：`supervisord-clklog-manager.conf:33` 的 command 是 `npx prisma generate && exec node dist/src/main.js`。这是 HANDOVER §10.4「发版后 Prisma Client 不同步」的补丁式修法——启动变慢且依赖运行期有 npm 缓存。镜像化后应在**构建期** generate。
3. **发版路径分裂**：supervisor 跑 `/data/app/clklog_manager/{server,ingestor}`，而 `server-upgrade.sh` 拉到 `/data/project/clklog_manager/production`——两个目录并存，靠脚本内的 `cd` 与 `${CLKLOG_RELEASE_DIR}` 缝合。镜像化后不再存在。
4. **密钥散落**：`config_server.yaml` 明文 LLM Key（**已入库**）、渲染出的 `processing/config.properties` 明文 CH 口令、Grafana datasource yaml 明文口令。容器化是清理它们的天然时机（Secret / 外部注入）。

### 7.2 会新增的问题（要有预期）

1. **日志从文件变 stdout** → 需要日志采集；且**运维面板的「日志目录治理」直接删 `/data/clklog/.../clklog_dc_data/receiver/*.log`**（`log-cleanup.service.ts:187`，白名单种子来自迁移 SQL）。若把 receiver 日志改成 stdout，**这个功能会静默失效**。要么保留文件日志，要么同步改这个模块的语义。
2. **ClickHouse 存储从本地盘变网络存储**（若进 k8s）→ 性能与语义风险，见 B1。
3. **入口从 nginx 变 Ingress** → SSE/WS 行为差异需实测，尤其 harness 的长连接。
4. **主机指标采集语义变化**：`host-metrics.ts` 读 `/proc/meminfo`、`/proc/loadavg`、`statfs('/data')`，`alert-detector.service.ts` 与 `metric-sampler.service.ts` 统计 `/data` 磁盘。**容器里读到的 `/proc` 是宿主命名空间的还是 pod 的、`/data` 挂的哪个卷，会直接改变运维面板与「磁盘预计用尽」告警的含义。** 这一条容易被忽略，需要显式设计（挂宿主 `/proc` 只读？还是改采集方式？）。
5. **资源限制语义收紧**：CH 当前 memcg 12 GiB，且已发生过 12.5GB RSS 被杀的 OOM 事故（`docs/project/legacy-production-handover.md:540`）。k8s 里 `limits: 12Gi` 会**复现**这个问题；`requests` 设得过低还会叠加 eviction 风险。CH 的内存参数需要重新标定。

---

## 8. 建议路径（渐进，每步独立可回退）

| 阶段 | 内容 | 依赖 | 回退 |
|---|---|---|---|
| **阶段 0**（与 k8s 无关，先做） | ① 修 §7.1 的 DLQ 落卷；② 三个 `@Cron` 与后台循环做选主/拆分；③ 密钥从仓库与渲染文件中清出 | 无 | 独立提交 |
| **阶段 1** | compose 化 `apps/` 三服务（server/ingestor/web），harness 保持宿主；建 TCR + 改 CI 为 build+push | 镜像仓库 | 保留 `server-upgrade.sh` 作为回退路径 |
| **阶段 2** | 若确有 k8s 需求：只把**无状态层**搬进 k8s（web/api/ui/receiver + analytics-server 单副本 + ingestor ≤6 副本），数据面（CH、Flink）与 harness 留 CVM，通过 Service/直连打通 | 阶段 0 的选主；B4–B12 工程项 | 保留 compose 栈并行运行，切流量回退 |
| **阶段 3** | 仅在有明确高可用/多租户诉求时：CH 上 Keeper + ReplicatedMergeTree；Flink 上 Operator；harness 单独立项 | 各自专项实现方案 | 各自灰度 |

**k8s + helm 的正确触发条件不是「容器化听起来更好」，而是**：多环境交付需求、无状态层需要弹性伸缩、或需要故障自愈。**如果真实诉求只是「发版更干净、回滚更容易」，阶段 1 就够了**——用 helm/k8s 去解决发版问题属于杀鸡用牛刀。

---

## 9. 非目标

- 不做 ClickHouse 复制/高可用架构设计（属数据架构专项，需独立实现方案）。
- 不做成本测算与节点规格选型（属项目帽 `docs/project/`）。
- 不改社区版任何镜像、不 fork `clklog-processing`/`receiver` 源码、不 ALTER 社区版表（红线 1）。
- 不排期、不拆里程碑。
- 本文不构成实现方案；落地前须补满足「程序/实现门禁」四要素（phase id / 范围 / 验收标准 / 非目标）的实现方案文档。

---

## 10. 治理影响（需用户决策）

容器化会改变「配置真相在哪」，因此触及 `AGENTS.md` 的帽子表与红线 7：

- 红线 7「服务器配置真相在 Puppet」→ 若 compose/helm 成为部署入口，真相应移到 **compose 模板 / Helm values**，否则会出现 Puppet 与 helm 双真相（比现在的配置漂移更糟）。
- 帽子表中「数据 / 配置」帽的工作目录含 `puppet/clklog/templates/`；helm/compose 模板需要有明确归属。
- 按 `AGENTS.md`，**增删帽子或改帽子表职责边界须用户明确同意**。本调研不擅自改动，仅登记为待决策项。

---

## 附：关键事实索引

| 事实 | 来源 |
|---|---|
| 社区版由 Puppet 渲染 compose 并 `docker compose up -d` | `puppet/clklog/manifests/init.pp:125-143, 207-224` |
| CH 数据 UID 101 / Flink checkpoints UID 9999 | `puppet/clklog/manifests/init.pp:75-98` |
| `deploy.resources` 变更需 `--force-recreate` | `puppet/clklog/manifests/init.pp:227-235`；`docs/project/legacy-production-handover.md` 问题 7 |
| 扩展服务为宿主 Node + supervisord，user=root | `scripts/supervisord-clklog-manager.conf:32-48` |
| `prisma generate` 在启动命令内 | `scripts/supervisord-clklog-manager.conf:33, 46` |
| DLQ 默认路径在 release 树内，`DLQ_DIR` 未被设置 | `apps/analytics-server/src/modules/ingestor/dlq.service.ts:10` |
| 单写者/定时任务清单（含 3 个无门禁 `@Cron`） | `apps/analytics-server/src/modules/{alerting,report,ops,meta,cohort,tag}/**` |
| Kafka topic 6 分区 1 副本 | `docs/project/legacy-production-handover.md:174` |
| CH 内存 OOM 历史（12 GiB memcg，12.5GB RSS） | `docs/project/legacy-production-handover.md:540` |
| 日志清理会删 receiver 目录 `*.log` | `apps/analytics-server/src/modules/ops/log-cleanup.service.ts:187` |
| 宿主规格 8 核 31G 单机 | `docs/project/legacy-production-handover.md:9` |
| 主机指标读 `/proc`、`statfs('/data')` | `apps/analytics-server/src/modules/ops/host-metrics.ts`、`metric-sampler.service.ts:17-19` |
