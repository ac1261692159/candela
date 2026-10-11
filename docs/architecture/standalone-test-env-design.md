# 独立测试环境（全自建中间件）实现方案

> phase: `clklog-standalone-test-env-v1`
> 性质：**实现方案 + 部署记录**。容器化可行性调研见 `docs/architecture/containerization-feasibility.md`；本次实测结果见 `docs/project/deployment-record-standalone-test-env.md`。
> 落地日期：2026-10-08。目标机：`<目标机>`（AlmaLinux 9.6）。

---

## 1. 阶段目标与范围

**目标**：在一台全新 AlmaLinux 机器上，用两个幂等脚本完成「中间件层 + ClkLog 社区版应用层」的全自建部署，产出可反复执行、可复现的测试环境，用于开源环境测试与后续容器化/编排方案的验证地基。

**范围**：
- 中间件层：Docker CE、MySQL 8.0、Redis 7、Kafka 3.7（KRaft 单节点）、ClickHouse 23.2。
- 应用层：ClkLog 社区版 1.3.0 标准模式（`clklog-ui` / `clklog-receiver` / `clklog-api` / `clklog-manage` / `clklog-init` / Flink `jobmanager` + `taskmanager`）+ 宿主 nginx 单机入口。
- 交付物：`scripts/standalone-test-env/` 下的脚本族与两份文档。

**非目标**：
- 不改 ClkLog 官方镜像、不 fork 社区版源码、不改社区版表结构（红线 1）。
- 不引入旁路分析域（`clklog_sa` / `sa_readonly` / 分析平台应用）——本环境只做社区版。
- 不做高可用/多副本：单机单实例，Kafka 单 broker、ClickHouse 单节点、Flink 单 JM/TM。
- 不做生产发布链路改造（本环境不经 CI/rsync，脚本即部署入口）。
- 不做成本测算与排期。

**验收标准**（`verify.sh` 全绿 + 幂等复跑零差异）：
1. 4 个中间件容器与 7 个应用容器全部 `running`，中间件容器 `healthy`。
2. MySQL `clklog` 库 8 张表；`tbl_project` 有 `clklogapp` 与 token。
3. ClickHouse `clklog` 库 19 张表（由 `clklog-init` 建）。
4. Kafka topic `clklog` 存在（6 分区）。
5. Flink 作业 `RUNNING`。
6. HTTP 入口 `/`、`/receiver/api/gp`、`/api/v3/api-docs`、`/manage/project/list` 均可用。
7. 上报链路端到端：经 nginx → receiver → Kafka → Flink → ClickHouse，`log_analysis` 行数增加。
8. 幂等：连续复跑两个部署脚本后，口令指纹、Kafka TopicId、容器 ID、数据行数完全不变。
9. 浏览器实测：`admin` 可登录 UI 并进入数据概览页。

---

## 2. 目标机事实与网络约束（决定方案形态）

部署前实测得到的环境事实，方案是按这些事实倒推的：

| 项 | 实测值 | 对方案的影响 |
|---|---|---|
| 规格 | 4 vCPU / 15 GiB / 92 GB（`/` 与 `/data` 同一 LV） | 资源限制必须按生产的 8C/31G 下调（§4） |
| 系统 | AlmaLinux 9.6，SELinux disabled，firewalld inactive | 无需处理 SELinux 上下文；但注意端口对外可达 |
| dnf 源 | `mirrors.almalinux.org` **域名不可解析** | 官方源不可用时切 `mirrors.aliyun.com/almalinux`（脚本内条件切换） |
| docker.io | **不可达**（`registry-1.docker.io` 连接失败） | 官方镜像改从 `public.ecr.aws/docker/library/*` 取（AWS 公共镜像库，托管 Docker Official Images，实测 mysql 1.1GB 约 10s） |
| 第三方 Docker Hub 代理 | `docker.m.daocloud.io` / `docker.1ms.run` / `docker.1panel.live` 均**拉取失败**（`/v2/` 可达但 blob 取不到） | 候选列表里保留为降级项，不作首选 |
| 阿里云 ClkLog 镜像库 | 可达（`/v2/` 401 为正常鉴权挑战），`clickhouse_clickhouse-server:23.2.1` 等可拉 | 所有 ClkLog 官方镜像的唯一来源 |
| 时间同步 | `System clock synchronized: yes`，时区 Asia/Shanghai | Flink 按事件时间切窗依赖时钟，保持同步 |

> 镜像来源是本次部署最大的不确定性，因此脚本不写死单一来源：`ensure_image` 按候选列表逐个尝试（每个候选重试 2 次，避免网络抖动被误判为「镜像不存在」），命中的引用写入 `deploy.env`，compose 文件通过 `${VAR}` 取用。

---

## 3. 架构与落位

```
                        ┌─────────────── 宿主 nginx :80（单机入口，按路径分流）───────────────┐
SDK ──► /receiver/ ──►  │ :8082 clklog-receiver ──► Kafka topic clklog ──► Flink(JM+TM) ──► ClickHouse
浏览器 ─► /            ──► :8081 clklog-ui                                                    │
         /api/         ──► :8083 clklog-api  ──────────────────────────────────────────────► │
         /manage/      ──► :8084 clklog-manage ──► MySQL clklog + Redis（会话/JWT 共享）      │
                        └──────────────────────────────────────────────────────────────────┘
```

**两个 compose 项目，一个共享网络**（`clklog-net`，external）：

| 栈 | 项目名 | 服务 | 数据 |
|---|---|---|---|
| 中间件层 | `clklog-testenv-mw` | mysql / redis / kafka / clickhouse | `/data/clklog-oss-test/data/{mysql,redis,kafka,clickhouse}` |
| 应用层 | `clklog-testenv` | clklog-ui / clklog-receiver / clklog-api / clklog-manage / clklog-init / jobmanager / taskmanager | `/data/clklog-oss-test/clklog/clklog_dc_data/*` |

**为什么中间件单独成栈**（与生产不同）：生产把 ClickHouse 放在 ClkLog 的 compose 里、MySQL/Redis/Kafka 用云托管；本环境把四个数据存储独立成一栈，好处是数据面与业务面可分别启停/重建，且后续做「容器化 vs Kubernetes」对比时可以独立替换数据层。代价是应用栈不能对数据层用 `depends_on`（跨 project 的服务在 compose 里不算已定义），就绪顺序改由脚本前置检查保证——这一条在首次部署时踩到过（`service "clklog-init" depends on undefined service`）。

**落位**（本机自包含，便于整目录搬迁/清理）：

```
/data/clklog-oss-test/
├── config/deploy.env          # 0600：随机口令 + 解析后的镜像引用（不提交仓库）
├── assets/                    # 从仓库 deploy-assets/clklog-community 同步的配置资产
├── deploy/                    # 从仓库 scripts/standalone-test-env 同步的脚本
├── middleware/                # 中间件 compose + CH/Redis 渲染后配置
├── clklog/                    # 应用 compose + clklog_dc_config + clklog_dc_data
└── data/                      # 四个存储的数据目录（属主见 §5）
```

**与生产的关键差异**（有意为之）：

| 维度 | 生产（生产主机） | 本环境 |
|---|---|---|
| MySQL / Redis / Kafka | 云托管（`云托管地址`） | 容器自建，compose 服务名寻址 |
| ClickHouse | ClkLog compose 内 | 中间件栈内（独立生命周期） |
| 入口 | 多域名 vhost + 云 CLB 终止 TLS | 单机 `:80` 按路径分流，无 TLS |
| 发版 | CI 构建 → rsync → 手工脚本 | 脚本即部署入口（幂等，可反复执行） |
| 配置真相 | Puppet 模板 + 手工注入 | 脚本渲染（脚本即可执行真相） |
| ClickHouse 端口 | `0.0.0.0:8123/9000` | 同（便于局域网用客户端连接；口令保护，见 §7 风险） |

---

## 4. 资源限制（按 4C/15G 折算）

生产 `deploy.resources.limits` 合计约 7.3 核 / 25 GiB，直接照搬会打满本机。实测折算如下（容器 limits 合计约 12.6 GiB，留出 OS 与页缓存）：

| 服务 | CPU | 内存 | 说明 |
|---|---|---|---|
| clickhouse | 1.0 | 5G | 生产 12G；本环境数据量小 |
| mysql | 0.5 | 640M | |
| redis | 0.2 | 192M | `maxmemory 128mb` + `allkeys-lru` |
| kafka | 0.5 | 768M | `KAFKA_HEAP_OPTS=-Xmx512m -Xms512m` |
| clklog-ui | 0.3 | 64M | |
| clklog-receiver / api / manage | 0.5 | 640M | 配 `JAVA_OPTS=-XX:MaxRAMPercentage=70.0` |
| clklog-init | 0.3 | 384M | |
| jobmanager | 0.5 | 1280M | `jobmanager.memory.process.size=1024m` |
| taskmanager | 1.0 | 3328M | `taskmanager.memory.process.size=3072m`，4 slots（切出约 1.1 GiB 堆，见下方 Flink 内存坑） |

**Flink 内存的坑（实测踩到）**：`*.memory.process.size` 不是堆大小，要扣掉 metaspace(256m)、JVM overhead、off-heap 才是堆。生产写 2048m/4096m 看不出问题，本环境按比例缩到 768m 时 JM 堆只剩 **192m**，作业反复崩溃重启（`RestartCount=7`）。最终 JM 提到 1024m（堆约 448m）才稳定。
TM 侧同类问题在 2026-10-10 二次部署时暴露：1536m 切出的 task heap 约 400m，`LogRichMapper` 初始化 Yauaa UA 解析规则库（解析全部 YAML 规则，初始化峰值需数百 MiB 堆）时 OOM，作业在 `INITIALIZING` 阶段无限重启、数据始终不入库（`sa_events` 进、`log_analysis` 不进）。TM 提到 3072m（堆约 1.1 GiB）后通过。
**推论**：判定 Flink 内存是否够，不能只看「作业跑起来过」——两处 OOM 都发生在**算子初始化**（非数据处理）阶段，且 Kafka 无堆积时同样触发；调整后必须观察 `docker logs clklog-taskmanager | grep -c OutOfMemoryError` 为 0 且作业 `tasks.running` 等于总数。

---

## 5. 属主与持久化（对齐生产红线）

| 路径 | 属主 | 原因 |
|---|---|---|
| `data/clickhouse`、`data/clickhouse/log` | **101:101** | ClickHouse 镜像以 UID 101 运行（红线 5） |
| `clklog/clklog_dc_data/processing/checkpoints` | **9999:9999** | Flink 镜像以 UID 9999 运行（红线 5） |
| `data/mysql` | 999:999 | MySQL 镜像内 `mysql` 用户 |
| `data/redis` | 999:999 | Redis 镜像内 `redis` 用户 |
| `data/kafka` | 1000:1000 | `apache/kafka` 镜像以 `appuser`(1000) 运行 |
| `middleware/redis/redis.conf` | 999:999 / **0640** | **不是 0600**：容器以 999 身份读配置，0600 会 `Permission denied` 起不来 |
| `clklog/clklog_dc_config/processing/config.properties` | 9999:9999 / **0640** | 同理，Flink 以 9999 读该文件 |
| `config/deploy.env` | root / **0600** | 含全部随机口令 |

> 两个 0640 是本次实测的直接教训：权限「更严」反而让服务起不来。生产 Puppet 对这两个文件用的是 0644，即同样考虑过可读性。

---

## 6. 脚本契约

| 文件 | 职责 |
|---|---|
| `lib.sh` | 公共函数：日志、口令生成、镜像候选解析、目录属主、等待就绪、compose 包装、ClickHouse 查询 |
| `deploy-middleware.sh` | dnf 源兜底 → Docker 安装 → 口令生成 → 镜像解析 → 目录/属主 → 渲染配置 → 起栈 → 等 healthy → 导入 MySQL 表结构 → 建 Kafka topic |
| `deploy-clklog.sh` | 前置检查 → 镜像解析 → 目录/属主 → 渲染 Flink 配置 → 起栈 → **按真实端口判就绪** → 等 `clklog-init` 建库 → 宿主 nginx 安装与 reload |
| `verify.sh` | 8 节端到端验证，末行返回非 0 表示失败 |
| `deploy-remote.sh` | 本地入口：rsync 脚本与资产到目标机并依次执行（`all|mw|clklog|verify`） |

**幂等策略**（逐条对应实现）：

1. **口令不轮换**：`ensure_secret` 只在键不存在时生成；已存在则复用（改口令会与已初始化数据不一致）。
2. **镜像不重拉**：解析结果写入 `deploy.env`；本地已有同引用则跳过。
3. **建表可重入**：导入前把 `INSERT INTO` 改写为 `INSERT IGNORE INTO`；表用 `CREATE TABLE IF NOT EXISTS`。
4. **topic 可重入**：`--create --if-not-exists`。
5. **中文列校正**：`UPDATE ... WHERE col <> '期望值'`，已正确时为 no-op。
6. **容器不重建**：`docker compose up -d` 仅在配置变化时重建对应服务（实测配置稳定后连续复跑零重建）。
7. **网络不重复建**：`docker network inspect` 存在即跳过。
8. **就绪判定不撒谎**：应用层不用「容器 running」当就绪，改为轮询真实端口（Java 应用要 30~90s 才监听）。
9. **nginx 先校验后生效**：写入配置 → `nginx -t` → 通过才 reload，失败不打断已有服务。

**密码与配置的处理**：全部随机口令（32 位 hex，避免 JDBC/XML/shell 转义问题）由脚本生成，仅存于目标机 `config/deploy.env`（0600）；ClickHouse 的 `default` 用户用 `password_double_sha1_hex` 存储（不落明文）；Redis 口令走挂载的 `redis.conf` 而非容器 Args（避免出现在 `docker inspect` 里）。**任何口令不写入仓库、不打印到标准输出**。

**资产管理**：`ui/config.js`、`manage/project-setting.json`、地区字典、`init/mysql_clklog.sql` 不复制进脚本目录，而是部署时从 `deploy-assets/clklog-community/` 同步，避免同一份配置在仓库里存在两处真相。

---

## 7. 风险与已知限制

| 项 | 说明 | 处置 |
|---|---|---|
| ClickHouse 端口对局域网开放 | `8123/9000` 绑定 `0.0.0.0`（与生产一致，便于客户端接入），仅靠口令保护 | 机器无防火墙；如需收紧：`firewalld` 放行 80/8123 或改绑定 `127.0.0.1` 后用 SSH 隧道 |
| MySQL/Redis/Kafka 仅绑 `127.0.0.1` | 宿主调试端口不对局域网开放 | 需外部接入时改 compose 端口映射 |
| 镜像源依赖外部可用性 | `public.ecr.aws` 与阿里云仓库均为外部依赖 | 候选列表 + `deploy.env` 固化**已解析引用**；重装前可先确认引用仍可拉取 |
| 无 TLS / 无域名 | 单机 `:80` 明文 | 仅用于内网测试；上公网需前置反代与证书 |
| 单实例无高可用 | Kafka 单 broker、CH 单节点、Flink 单 JM/TM | 与「测试环境」定位一致；高可用属数据架构专项 |
| `pv`/`uv` 聚合对报文格式敏感 | 见项目记录「遗留项」 | 生成演示数据集建议改用 ClkLog 官方 JS SDK |
| 宿主 nginx 为配置真相之一 | `/etc/nginx/conf.d/clklog-testenv.conf` 由脚本渲染 | 该文件由脚本覆盖，禁止手工改（与红线 7 同精神） |

---

## 8. 使用方式

```bash
# 全流程（幂等，可反复执行）
bash scripts/standalone-test-env/deploy-remote.sh

# 分步
bash scripts/standalone-test-env/deploy-remote.sh mw       # 只部署中间件层
bash scripts/standalone-test-env/deploy-remote.sh clklog   # 只部署应用层
bash scripts/standalone-test-env/deploy-remote.sh verify   # 只跑验证

# 换目标机
HOST=root@10.0.0.5 BASE_DIR=/data/xx bash scripts/standalone-test-env/deploy-remote.sh
```

访问：`http://<目标机>/`，管理后台 `admin` / `clklog`（社区版内置种子账号，首次登录后应改密）。

**首次部署（0 → 1）需注意的依赖顺序**：脚本已内置前置检查，但若只想跑应用层，必须已有中间件层在运行；顺序颠倒在脚本里会直接明确报错而不是留下半成品。
