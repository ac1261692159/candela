# Candela 两套部署流程实测记录与验收（phase: candela-deploy-two-paths-v1）

> 配套实现方案：`docs/architecture/candela-deploy-two-paths.md`
> 执行日期：2026-10-10。目标机：`<目标机>`（AlmaLinux 9.6，4C/15G，与 ClkLog 社区版同机）。
> **结论：两套流程均从零跑通并验收通过——常规方案 18/18、Docker 方案 19/19；两套流程的幂等复跑均为零差异；浏览器登录实测均通过。**

---

## 1. 执行时间线

| 阶段 | 动作 | 结果 |
|---|---|---|
| 侦察 | 读 `config_server.yaml` / 52 个 Prisma 迁移 / CH 初始化脚本 / 生产 nginx 与 supervisor 形态 | 确定复用项与差异点 |
| 侦察 | 目标机能力实测（Node 源、npm 源、EPEL、ECR 基础镜像） | Node 24 与 npmmirror 可用；supervisor 需 EPEL；ECR 提供 node/nginx 官方镜像 |
| 流程 A | `deploy-native.sh` 首次跑通 | 18/18；浏览器登录进入看板页 |
| 流程 A | 幂等实证（连续复跑） | 代码/配置哈希未变 → 复用发布、跳过重启；前后状态**完全一致** |
| 铲库 | `wipe-databases.sh --yes` | MySQL 2 库 + 账号、CH 4 库 + 账号、Kafka topic + 2 消费组全部删除；环境级资源（topic、社区版 CH 19 表）自动重建 |
| 流程 B | `deploy-docker.sh` 首次跑通（从空库） | 19/19；浏览器登录进入看板页 |
| 流程 B | 幂等实证（连续复跑） | 镜像复用、容器未重建、migrate 输出 `noop`；前后状态**完全一致** |

---

## 2. 验收证据

### 2.1 常规方案（native + supervisord）：18/18

```
1. 进程         supervisor candela_server / candela_ingestor = RUNNING
2. HTTP 入口    /sa/api/health → 401（受鉴权，能返回即已监听）
                /sa/ → 200；/sa/index.html → 200（经 nginx，gzip 通道 481 字节）
                后端直连 :3100/sa/api/health → 401
3. MySQL        元数据库 clklog_sa_meta 61 表；超管 admin/super_admin/active；社区版 clklog 8 表
4. ClickHouse   clklog_sa 4 表；sa_readonly 可查询；sa_readonly 写入被拒（只读生效）
5. Kafka        topic clklog 存在；消费组 clklog-sa-ingestor LAG=0
6. 上报链路     上报 HTTP 200 → log_analysis 9→10 且 sa_events 0→1
7. 登录         admin 登录返回 token（长度 64）
```

### 2.2 Docker 方案（docker-compose）：19/19（从**完全铲空**的库开始）

```
1. 容器         candela-server / -ingestor / -web 全部 running
2. HTTP 入口    同上传（/sa/ 由 manager-web 容器提供，经宿主 nginx 反代）
3. MySQL        元数据库 61 表（基线流程建出）+ 超管就绪 + 社区版 8 表
4. ClickHouse   clklog_sa 4 表；sa_readonly 可查、写入被拒
5. Kafka        topic 存在（铲库后由铲库脚本重建）；消费组 LAG=0
6. 上报链路     上报 200 → log_analysis 0→1 且 sa_events 0→1（空库直通）
7. 登录         admin 登录返回 token
（Docker 形态多一项：manager-web 容器 running）
```

### 2.3 幂等实证（两套各自 A/B 比对）

| 方案 | 复跑时的行为 | A/B 比对项 | 结果 |
|---|---|---|---|
| 常规 | `代码与配置均未变化（code=f8e52438479a）→ 复用当前发布，跳过发布与重启`；`跳过 supervisor 重启（进程保持运行）` | 发布目录数(3)、current 目标、env 指纹、server/ingestor PID、`sa_events`、`log_analysis` | **完全一致** |
| Docker | `内容哈希 e31c1fd976dd 对应镜像已存在 → 跳过构建`；migrate 输出 `noop`；`只读账号配置未变化` | 容器 ID 集合、env 指纹、`sa_events`、`log_analysis` | **完全一致** |

### 2.4 浏览器实测（两套形态各一次）

- 常规方案：`http://<目标机>/sa/` → `/sa/login`（标题 `ClkLog Analytics`）→ `admin` 登录 → `/sa/report/dashboards`；侧栏 8 个菜单域（Reports / Analysis / Users / Tracking / Data management / Project access / Operations / Settings）、看板页 Folder/List 视图正常。
- Docker 方案：铲库后旧会话失效（预期）→ 重新登录成功，页面同样完整。

---

## 3. 过程中定位并修复的缺陷

### 3.1 仓库级（部署侧已绕过，建议排期修 —— 详见实现方案 §5）

按发现顺序，每条都伴随一次真实失败：

1. **迁移链无法从零重放**：`20260729_fix_event_pk_and_lowercase_types` 报 `Table 'clklog_sa_meta.metaeventproperty' doesn't exist`（引小写表名，而 init 迁移建的是 PascalCase）→ 深挖发现 6 个迁移存在同类大小写不一致、`MetaEventAttribute` 无任何迁移创建、`redesign_card_dashboard` 迁移自述生产失败并附 `repair.sql`。**结论：schema.prisma 才是权威**，新库改走 Prisma 基线流程。
2. **schema.prisma 含 MySQL 非法默认值**：`verified_json TEXT NOT NULL DEFAULT '[]'` → `db push` 报 `BLOB, TEXT, GEOMETRY or JSON column ... can't have a default value` → 改 `migrate diff` 生成 DDL 并把 TEXT/JSON/BLOB 的字面量默认值规范化为表达式默认 `DEFAULT ('[]')`。
3. **前端 `tsc` 依赖兄弟应用 JSON**：`tsc` 报 `TS2307: Cannot find module '../../../../analytics-harness-host/plugins/analytics-tools/analysis-cases.json'` → 前端无法单独构建；部署侧一并推送该文件，镜像要求仓库根作上下文。
4. **前端构建依赖仓库根脚本**：`scripts/build-sdk-demos.sh`（打包 `examples/report-sdk` → `public/sdk-demos/*.zip`，zip 不入库）→ 部署流程化执行。
5. **`nest build` 产物布局随 `test/` 变化**：只推 `src/` 时产物是 `dist/main.js`，而脚本/生产硬编码 `dist/src/main.js` → 改为两种布局自适应（并在实现方案里建议给 tsconfig 加 `rootDir`）。
6. **DLQ 默认路径不安全**：由 `__dirname` 推导，会落在发布目录内（随版本切换丢失）或容器根 `/dlq` → 两套流程均显式设 `DLQ_DIR` 到持久路径。

### 3.2 脚本自身缺陷（首次执行即暴露，已修）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `write_service_env` 写出空口令，且同键出现两值 → Prisma 认证失败 | `cat > "$f" <<ENV` **先截断文件**再展开 heredoc 里的 `$(get_env …)`，读到的是空文件 | 先把值读进变量再写文件 |
| 2 | 发布目录/静态文件全是 0600，nginx 读不到 → `/sa/` 404 | `write_service_env` 里的 `umask 077` **泄漏到整个脚本** | umask 放子 shell；并对产物显式 `chmod -R a+rX` |
| 3 | nginx 的 `/sa/` 路由从未生效 | location 片段写成 `sa.conf`，而 include 通配是 `*.inc` | 文件名改为 `sa.inc` |
| 4 | `nginx` 报 `duplicate default server`（早期）/ 路由缺失 | 两套部署都要在 `:80` 按路径分流，但各自写了 server 块 | 改为「站点 server 块 include `mgr-locations/*.inc`」；社区版脚本里写死该 include 行，避免重跑社区版时抹掉 `/sa/` |
| 5 | 服务「未就绪」但实际已在服务 | `/sa/api/health` 受 AuthGuard 保护返回 401，而就绪判定只认 200 | 就绪判定与验证接受 `200|401|403` |
| 6 | 校验「超管缺失」但登录明明可用 | 校验查询用 `sa_user`，真实表名是 `SaUser` | 新增大小写不敏感的表名解析 `db_table`；验证脚本与种子提取统一使用 |
| 7 | 种子重放只提取到 3 条（应为 6 条） | 提取器把「以注释开头的语句块」整块跳过 | 先剥注释行再判断语句类型 |
| 8 | 修改 Dockerfile（补 OpenSSL）后镜像未重建 | 内容哈希未包含 Dockerfile | 把 Dockerfile 与 nginx 配置纳入哈希 |
| 9 | 容器内 CH 初始化报 `MODULE_NOT_FOUND: /app/dist/src/scripts/...` | 镜像内是 `dist/scripts/*` 布局 | 容器内同样做布局自适应 |
| 10 | 宿主侧 SQL/CH 查询在 docker 形态下失败 | 用了容器内服务名（`mysql`/`clickhouse`）做宿主侧连接 | 引入 `OPS_*` 端点（恒为 127.0.0.1 已发布端口），应用侧与运维侧寻址解耦 |
| 11 | `deploy-native.sh` 一度语法报错 | 替换时 `if/else` 缺收尾 `fi` | 补 `fi`；交付前统一 `bash -n` |
| 12 | 远端脚本执行到第二条查询中断 | `docker exec -i` 吞掉 `ssh host 'bash -s'` 的 stdin（同早前中间件阶段的坑） | 查询去掉 `-i`，SQL 走参数 |
| 13 | 容器显示 `unhealthy` 但服务实际正常 | `node:*-slim` 镜像内**没有 wget/curl**，健康检查命令本身失败 | 健康检查改用 `node -e` 自检（镜像必有 node） |

### 3.3 环境约束（同实现方案 §6）

dnf 官方源不可解析、docker.io 不可达、supervisor 需 EPEL、EPEL 元数据慢且与 dnf 定时任务争锁、`node:*-slim` 无 OpenSSL、npm 11.19 `allowScripts` 跳过 postinstall、`clklog-init` 冷启约 95s。

---

## 4. 遗留项

| 项 | 说明 | 建议 |
|---|---|---|
| AI Harness 未启用 | `deepseek_harness.enabled=false`；启用需 LLM 供应商密钥（平台内配置）+ rootless podman + harness broker/runtime 安装 | 单独 phase；nginx 的 `/sa/harness/`（含 SSE/WS）路由已预留，启用时无需再改 nginx |
| §3.1 的 6 项仓库缺陷 | 部署侧均已绕过，但每个都会让「按文档从零部署」的外部用户踩坑 | 建议合并为一个 `clklog-repo-bootstrap-fixes-v1` 批次修复（含给 tsconfig 加 `rootDir`、统一迁移表名大小写、DLQ_DIR 显式化、web 构建解耦） |
| 两套流程无自动化互切校验 | 目前靠脚本内互斥守卫停对方；未做「一键切换并回归」 | 可在 `deploy-remote.sh` 增加 `switch native\|docker`（停对方 → 部署自己 → 跑 verify） |
| 未接 CI | 本次按要求完全不依赖 CI/CD；改镜像/脚本后需要人工 `push` | 若要长期维护，建议把 `push` 与镜像构建纳入 CI（构建放在 Linux runner） |

---

## 5. 2026-10-10 目标机 <目标机> 复跑（native 18/18）

在第二台目标机（AlmaLinux 9，4 核 / 15 GiB / 92 GB）从零部署 native 方案：**18/18 通过**，社区链路与分析平台链路双端入库核对均通过（`log_analysis` 与 `sa_events` 行数同步增长）；两个入口（`/` 与 `/sa/`，nginx 按 IP 直访）浏览器实测正常。

本次暴露并修复一个部署脚本缺陷（只在「首次生成口令」的部署上触发）：

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 14 | `init-db-mysql.sh` 基线流程报 `./.env:行12: 生成随机口令：未找到命令`，以 127 退出；检查发现 `candela.env` 的 `DATABASE_URL` 被写成两行（`mysql://clklog_sa_app:[candela] 生成随机口令 MYSQL_PASSWORD` + 换行 + `<口令>@127.0.0.1:3306/clklog_sa_meta`） | `ensure_secret()` 首次生成口令时用 `log` 打印提示，而 `log` 走 **stdout**；调用方 `MYSQL_PASSWORD="$(ensure_secret MYSQL_PASSWORD)"` 把提示一并捕获 → 内存中的口令值多出一行 → `set_endpoints` 派生出的 `DATABASE_URL` 被写坏。中间件层因为生成后有 `load_env` 从文件回读干净值而侥幸未受影响 | `scripts/standalone-test-env/lib.sh`：提示改为 `log ... >&2`，并在函数注释固定「stdout 只输出值」的契约 |

> 复现/收敛说明：口令已存在时 `ensure_secret` 不再打印提示，因此只在「首次生成口令」的部署上触发；对已写坏的文件重跑部署即可自动收敛（`write_service_env` 每次覆盖写、从文件回读干净值），不需要清库。

本次新增遗留项（下次复跑需留意）：

| 项 | 说明 | 建议 |
|---|---|---|
| ~~程序被停止后重跑部署不会自动启动~~ **已修**（见 §5.1 缺陷 15） | 根因比最初判断更深：`reread/update` 对「配置未变」的程序一律不做动作，而 ini 内路径恒为 current 软链 → **任何仅改配置的部署都不会重启服务** | 已在 `deploy-native.sh` 改为显式 `restart` + REUSE 分支的进程状态检查 |
| 目标机可能存在旧名部署痕迹 | 该机器曾用旧名（`clklog_manager`）部署，supervisord 中有 `clklog_analytics_*` 历史进程 | 已由更名守卫与 ini 重写覆盖；跨环境复用时建议先跑 `teardown` 清干净 |

---

### 5.1 AI Harness 启用（同日，用户要求；phase: standalone-test-env-harness-v1）

实施方案与验收标准见 [`docs/architecture/standalone-test-env-harness-design.md`](../architecture/standalone-test-env-harness-design.md)。实测结果：

| 步骤 | 结果 |
|---|---|
| `install-harness.sh` 安装运行时 | harness 用户 + `/home/harness/clklog-ai` 目录树 + release `6ba44c646019` + broker 配置/supervisor 单元 + rootless podman 镜像（`node:24.20.0-bookworm-slim`；podman 不读 docker 的 registry-mirrors，镜像源经 `registries.conf.d` 指到 `hub.rat.dev`） |
| broker 探活 | `--unix-socket …/gateway/control/broker.sock /v1/health` → `{"ok":true}` |
| 平台开关 | `config.yaml` `deepseek_harness.enabled: true`（渲染由 `configs/harness.enabled` 标记驱动；删标记即回到默认关闭） |
| 平台初始化 | 日志 `Harness 管理根已就绪 (harness, uid=1001)`、`Harness 安全网关已监听 …/gateway/runtime/server.sock` |
| 接口验证 | `GET /sa/api/assistant/catalog` → `{"enabled":true,"providers":{}}`（模型供应商待用户在 UI 配置） |
| 验收 | `verify.sh` **21/21**（新增 3 项 harness 检查：进程 / socket 探活 / 开关一致性）；双端入库核对继续通过 |

过程中暴露并修复 `deploy-native.sh` 一个**长期潜伏缺陷**：

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 15 | 配置/产物变化后重跑部署，**服务没有重启**（`config.yaml` 已改成 `enabled: true`，但进程 uptime 未变、平台仍读旧配置）；被停止的程序也不会被拉起 | 第 9 节用 `supervisorctl reread/update` 代替 restart，而 ini 内工作目录恒为 `current` 软链（内容恒定）→ supervisor 认为「配置无变化」而不做任何动作 | ① `SUPERVISOR_RESTART=1` 分支改为显式 `supervisorctl restart`（对 STOPPED 等价 start）；② `REUSE_RELEASE=1` 分支补进程状态检查，非 RUNNING 则 `start` |

> 影响面：该缺陷让「部署成功」与「新配置生效」脱钩——修复前任何仅改配置的部署都不会真正生效，且日志显示「已启动」造成误导（本次靠「config.yaml 已改但 uptime 未变」识破）。
> 待用户自查（口令不在自动化流程中使用）：登录后 AI 入口可见性，以及「设置 → AI Workspace 管理 → 模型供应商」的配置流程。

---

### 5.2 全铲后用 docker-compose 重建（同日，用户要求）

`teardown --yes` 全铲（容器/镜像/网络/卷/数据目录/宿主配置/harness 运行时）后，按三件套重建为**容器方案**：中间件 12/12、平台 **22/22**（容器形态比常规多 1 项），AI Harness 复装后 broker 探活通过，`/sa/` 与社区版入口浏览器实测正常。**全部数据与口令随铲除重置**（新 admin 口令见目标机 `configs/candela.env`）。

本次又暴露并修复 3 个缺陷：

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 16 | 首次 docker 部署成功，但紧接着的 `--skip-build`（README 记载的**回滚路径**）报「deploy.env 里没有 DOCKER_SERVER_TAG」 | `write_service_env` 覆盖写整个 env 文件（只含密钥与派生键），把此前记录的 `DOCKER_*_TAG` 抹掉；且 `deploy-docker.sh` 的记录点在渲染**之前** | ① `deploy-docker.sh` 的记录段移到渲染之后；② `write_service_env` 显式保留既有 `DOCKER_*_TAG`（跨形态安全：native 重渲染不再破坏 docker 回滚元数据） |
| 17 | teardown 后复装 harness，rootless podman 报 `stat /home/harness/.config: no such file or directory` | teardown 删 `/home/harness` 目录**但保留用户**；安装器用 `install -d` 重建目录树时把 home 当「中间父目录」建成 root:root，harness 用户写不了自己的 home | `install-harness.sh` 显式收敛 home 属主与权限（`install -d -o harness -g harness -m 0700`） |
| 18 | 中间件验收首次 `/api/v3/api-docs → 000`（冷启动） | 已知问题（§3.2 #10：springdoc 懒生成）；全新容器的首次请求生成可能超过脚本 60s 宽限 | 不改脚本：请求一次触发后即缓存（重跑验收 12/12）；冷启动后首跑验收若仅此项失败，重跑一次即可 |

另：`install-harness.sh` 的「下一步」提示改为同时给出两套形态的命令（原先只写 `deploy-native.sh`，容器形态下会误导）。
