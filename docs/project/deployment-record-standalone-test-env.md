# 独立测试环境部署记录与验收（phase: clklog-standalone-test-env-v1）

> 配套实现方案：`docs/architecture/standalone-test-env-design.md`
> 执行日期：2026-10-08。目标机：`<目标机>`（AlmaLinux 9.6，4C/15G，92G 盘）。
> 结论：**部署成功，`verify.sh` 12 项全通过，幂等复跑零差异，浏览器登录实测通过。** 过程共定位并修复 9 个缺陷（4 个属本环境新踩，5 个属脚本自身）。

---

## 1. 执行时间线

| 步骤 | 方式 | 结果 |
|---|---|---|
| 主机探测 | `ssh root@<目标机>` | 4C/15G/92G；dnf 官方源不可解析；docker.io 不可达 |
| 系统前置 | 脚本内条件切换阿里云源 | `dnf makecache` 通过 |
| Docker 安装 | 阿里云 docker-ce 源 | Docker 29.8.2 / Compose v5.6.0，data-root `/data/docker` |
| 镜像可用性实测 | 逐个 `docker pull`，实测耗时 | MySQL(ECR,10s) / Redis(ECR,15s) / Kafka 3.7.0 / ClickHouse + ClkLog 六镜像（阿里云）全部可用 |
| 中间件层部署 | `deploy-middleware.sh` | 4 容器 healthy；MySQL 8 表；topic `clklog` 6 分区 |
| 应用层部署 | `deploy-clklog.sh` | 7 容器 running；5 个 HTTP 入口就绪；`clklog` 库 19 表 |
| 端到端验证 | `verify.sh` | **12 项通过 / 0 失败** |
| 幂等实证 | 连续复跑两层脚本，比对 A/B 状态 | **完全一致**（详见 §3） |
| 浏览器实测 | 打开 `http://<目标机>/` | `admin` 登录成功，进入「ClkLog- 数据概览」，项目选择器显示 `clklog` |

---

## 2. 验收证据

### 2.1 `verify.sh` 结果（12/12）

```
1. 容器状态        mysql/redis/kafka/clickhouse healthy；ui/receiver/api/manage/init/jobmanager/taskmanager running
2. MySQL 元数据    clklog 库 8 表；tbl_project = clklogapp / ddf51db3-7c99-1310-a44f-79feb7b63c69
3. ClickHouse      clklog 库 19 表；log_analysis 行数 8
4. Kafka           topic: clklog；消费组 clklog-group（分区 3/4 各 LAG=0）
5. Flink 作业      RUNNING
6. HTTP 入口       / → 200；/receiver/api/gp → 200；/api/v3/api-docs → 200；/manage/project/list → 200
7. 上报链路        上报 200 → log_analysis 8 → 9（经 nginx → receiver → Kafka → Flink → ClickHouse）
8. 聚合与登录      管理后台登录接口返回 token；/api/flow/getFlow 可达
```

### 2.2 幂等实证（A/B 比对）

连续执行 `deploy-middleware.sh` + `deploy-clklog.sh` 各两次，第二次执行时 compose 输出**全部为 `Running`，无 `Recreate`/`Created`**。两次执行前后比对项：

| 比对项 | 结果 |
|---|---|
| `deploy.env` 口令指纹（sha256 前 16 位） | 一致 `cf8bea0d6b701538` |
| Kafka TopicId | 一致 `QmaYv91nRuKou8tpn8WNAg`（未重建） |
| 11 个容器 ID | 逐一一致（未重建） |
| `log_analysis` 行数 | 一致（数据未重复、未丢失） |
| MySQL 表数 | 一致 8（未重复建表） |
| `admin.display_name` / `tbl_project.status` | 一致（中文列校正为 no-op） |

### 2.3 浏览器实测

- 打开 `http://<目标机>/` → 自动跳 `/#/login`；填 `admin` / `clklog` 登录 → 进入 `/#/index`，标题「ClkLog- 数据概览」。
- 页面完整渲染：项目选择器 `clklog`、全部菜单（数据概览/趋势分析/访客分析/访问分析/用户分析/App崩溃分析/系统设置/密钥管理）、流量概览卡片、时间与渠道筛选。
- API 侧同口径复核：`POST /manage/auth/login` 返回 200 + token；带 token 调 `POST /api/flow/getFlow` 返回 200（`访问次数=1`、`ip数=1`）。
- 中文显示：`sys_user.display_name` 与 `tbl_project.status` 实际入库为 `管理员` / `已保存`（字符集缺陷修复后）。

---

## 3. 过程中定位的缺陷与修法

### 3.1 本环境新踩（部署侧）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | ClickHouse 容器 healthy，但**容器间与宿主端口全部 `Connection refused`** | 我把 `config.d` **整个目录**挂载进容器，遮掉了官方镜像自带的 `docker_related_config.xml`（其中 `<listen_host>0.0.0.0</listen_host>`），CH 退回只监听 `127.0.0.1/::1` | 改为**按文件挂载**（`config.d/default-config.xml`、`users.d/default-password.xml`），与生产 Puppet 写法一致。验证：容器内 `ls /etc/clickhouse-server/config.d/` 能看到 `docker_related_config.xml` |
| 2 | Flink 作业反复重启（`RestartCount=7`），日志 `FileNotFoundException: /opt/flink/config.properties (Permission denied)` | `config.properties` 设了 `0600 root`，而 Flink 镜像以 **UID 9999** 运行 | `chown 9999:9999` + `chmod 0640` |
| 3 | 同上，Flink 内存不足 | `jobmanager.memory.process.size=768m` 扣掉 metaspace(256m)+overhead(192m)+off-heap(128m) 后**堆只剩 192m** | JM 提到 `1024m`（容器 limit 1280M），TM 提到 `1536m`（limit 1792M） |
| 4 | Redis 容器 `Restarting`，日志 `can't open config file: Permission denied` | `redis.conf` 设了 `0600 root`，容器以 **UID 999** 运行 | `chown 999:999` + `chmod 0640`；同时给 healthcheck 补上 `REDIS_PASSWORD` 环境变量 |
| 5 | 管理后台返回的中文是乱码（`ç®¡ç†å‘˜`） | 容器内 `mysql` 客户端默认字符集是 **latin1**；`CREATE/INSERT` 时把 UTF-8 字节按 latin1 解释后双重编码入库 | 导入时显式 `--default-character-set=utf8mb4`；**并去掉 `/docker-entrypoint-initdb.d` 挂载**（entrypoint 导入无法指定字符集，是同一个坑的第二次入口）；对已写坏的两列加幂等校正 `UPDATE ... WHERE col <> '期望值'` |

### 3.2 脚本自身缺陷（首次执行即暴露）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 6 | 应用层首次 `up -d` 直接失败：`service "clklog-init" depends on undefined service "clklog-clickhouse"` | 跨 compose 项目的服务**不能**用 `depends_on` | 去掉对外部服务的 `depends_on`（仅保留 `taskmanager → jobmanager`），就绪顺序由脚本前置检查保证 |
| 7 | 远端脚本执行到第二条 ClickHouse 查询就中断，无报错 | `docker exec -i` 把调用方的 stdin（`ssh host 'bash -s'` 的脚本体）当输入吃掉 | 查询改走参数传入并**去掉 `-i`**；同时修正 `scripts/standalone-test-env/lib.sh` 的 `ck_query` |
| 8 | `deploy-remote.sh` 报 `HOST: unbound variable` | 中文全角字符紧跟在 `$VAR` 后，被 bash 当作变量名的一部分 | 统一改写为 `${VAR}` 形式，并全目录排查同类写法 |
| 9 | 应用层脚本一度「报就绪」但服务其实没起 | 原就绪判定只看容器 `running`，而 Java 应用要 30~90s 才监听端口 | 改为**轮询真实端口**（`curl` 拿到非 `000` 状态码才算就绪），并对 `clklog-init` 单独等待「`clklog` 库出现」 |
| 10 | 复跑验收时 `/api/v3/api-docs` 报 `000000` 假失败（同一命令此前是通过的） | 两处叠加：社区版 api 的 swagger 由 springdoc **懒生成，首次请求实测 41.6s**（容器重启后必现），而验收脚本超时只有 10s；且 `code=$(curl … \|\| echo 000)` 在 curl 失败时会拼成六位 `000000` | 该路径超时放宽到 60s 并注明原因；状态码改为安全捕获（空则填 `000`） |

### 3.3 与生产不一致的发现（值得回写生产认知）

- **`/manage/v3/api-docs` 是死路径**：生产 nginx 的 `clklog-admin` vhost 配了 `/manage/v3/ → 127.0.0.1:8084/manage/v3/`，但 manage 服务的真实 swagger 路径并非如此（实测 404），管理后台真实业务接口是 `/manage/project/list`（200）。本环境保留该 location 以维持与生产一致，但验证脚本改用真实业务接口做判定。
- **顶层 `lib` 对象会让属性解析整体失效**：报文里写 `"lib": {"$lib": "js", ...}`（神策 JS SDK 的形状）时，ClkLog 1.2.0 receiver 只落 `event`/`distinct_id`/`client_ip`，`properties` 里的 `$url`/`$os`/`$browser` 全部丢失；改成 `"lib": "js"`（字符串）后属性恢复。仓库 `docs/architecture/reporting-protocol.md` §2.1 的示例用的是顶层 `lib` 对象，与实际运行行为不符，**建议后续复核该文档示例**。

---

## 4. 遗留项与下一步

| 项 | 说明 | 建议 |
|---|---|---|
| `pv` / `uv` 聚合为 0 | `log_analysis` 有数据、`visit_count` 与 `ip_count` 正常计数，但 `visitor_detail_bydate.pv/uv` 与 `visituri_detail_bydate.pv/uv` 始终为 0，UI 流量概览显示 `--`。定位到：聚合的 `pv/uv` 依赖 `log_analysis.lib` 列，而手工构造的报文（无论顶层 `lib` 是对象还是字符串）都**填不进该列**；且顶层 `lib` 为对象时属性解析整体失效 | 生成演示数据集时改用 **ClkLog 官方 JS/Web SDK**（其 `lib` 取值与列映射才与聚合口径对齐）；若要手工构造，需先逆向确认 `lib` 列的填充条件。**这是报文口径问题，不是部署缺陷**——部署责任边界（数据从 SDK 到 ClickHouse 落库）已由 `log_analysis` 行数增长证明 |
| 管理后台默认口令 | `admin` / `clklog` 是社区版 init SQL 内置种子值（已实测验证） | 该环境长期保留时应在管理后台改密；口令不写入仓库 |
| 无 TLS、CH 端口对局域网开放 | 见实现方案 §7 | 内网测试可接受；对外前先加反代与证书 |
| 未纳入本环境 | 旁路分析域（`clklog_sa`、只读账号、分析平台应用）、harness | 属另一 phase；本环境只做社区版全自建 |

---

## 5. 本次新增文件

| 文件 | 说明 |
|---|---|
| `scripts/standalone-test-env/lib.sh` | 公共函数库 |
| `scripts/standalone-test-env/deploy-middleware.sh` | 中间件层幂等部署 |
| `scripts/standalone-test-env/deploy-clklog.sh` | 应用层幂等部署 |
| `scripts/standalone-test-env/verify.sh` | 端到端验证（12 项） |
| `scripts/standalone-test-env/deploy-remote.sh` | 本地入口（rsync + 远程执行） |
| `docs/architecture/standalone-test-env-design.md` | 实现方案 |
| `docs/project/deployment-record-standalone-test-env.md` | 本文档 |

---

## 6. 2026-10-10 目标机 <目标机> 全量复跑（第二次独立实战）

同一套脚本在第二台目标机（AlmaLinux 9，4 核 / 15 GiB / 92 GB，与首测机同规格）从零部署：中间件与社区版 **12/12 通过**，双端入库核对（`log_analysis` 行数增长）通过。本次暴露并修复 3 个新缺陷：

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 11 | `deploy-middleware.sh` 两次都在「创建 Kafka topic」处中断，进程退出码 **141**（SIGPIPE），汇总不打印（但部署实际已完成） | `kafka-topics.sh --describe \| head -1`：head 读一行即关管道，上游收到 SIGPIPE，配合 `set -o pipefail` 判整脚本失败 | 改用 `sed -n '1p'`（读完输入，不产生 SIGPIPE）；全目录排查 `\| head` 用法（仅存另一处已带 `\|\| true` 保护） |
| 12 | Flink 作业在 `INITIALIZING` 阶段无限 OOM 重启（`java.lang.OutOfMemoryError: Java heap space`），数据始终不进 `log_analysis`；Kafka 无堆积 | TM `process.size=1536m` 切出的 task heap 仅约 400m，`LogRichMapper` 初始化 Yauaa UA 解析规则库（解析全部 YAML 规则，初始化峰值需数百 MiB 堆）即打满 | TM 提到 `3072m`（limit 3328M）。判定口径：`docker logs clklog-taskmanager \| grep -c OutOfMemoryError` 归零 且 Flink `tasks.running == tasks.total` |
| 13 | Kafka 容器长期 `unhealthy`（功能与端到端链路均正常） | healthcheck 用 `kafka-broker-api-versions.sh`，每次探测要起一个 JVM 客户端，在 0.5 CPU 限额下超过 10s timeout | healthcheck 改轻量 TCP 探活（`bash /dev/tcp`）；broker 可用性由 `verify.sh` 的端到端链路验证承担，不由健康检查承担 |

> 缺陷 12 与首测的「Flink 内存坑」同源（都是 `process.size` 折算问题），但发生在**另一个算子初始化路径**上，且首测 1536m 曾通过——说明「1536m 够用」是脆弱的边缘值，已按 §4 更新实现方案的取值与判定口径。缺陷 11/13 的修法均已回写脚本。
