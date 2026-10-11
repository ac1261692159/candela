# Candela 新仓库交接文档

> 面向「在新仓库继续工作」的接手人（含 AI session）。读这一份就够开工；需要细节时按文中链接深入。
> 撰写日期：2026-10-10。公开前已去掉具体机器地址、家目录路径和来源仓库位置。部署时用 `HOST=user@your-server`，不要把目标写回仓库。

---

## 0. TL;DR

| 问题 | 答案 |
|---|---|
| 这是什么 | **Candela**：开源、可私有化的用户行为分析平台，跑在 ClkLog 社区版之上（AGPL-3.0） |
| 代码在哪 | `apps/analytics-server`（NestJS 后端 + Kafka ingestor）、`apps/analytics-web`（React + Vite，13 语言）、`apps/analytics-harness-{host,broker}`（AI 助手，可选） |
| 怎么部署 | `scripts/standalone-test-env/`：①中间件 ②ClkLog 社区版 ③Candela 平台（常规 supervisord ／ Docker Compose 两套） |
| 目标测试机 | `ssh root@<目标机>`，已部署并验收通过（平台 19/19、中间件+社区版 12/12） |
| 入口 | 平台 `http://<目标机>/sa/`；社区版 `http://<目标机>/` |
| 凭据 | 目标机 `/data/app/candela/configs/candela.env`（0600，含平台超管口令）；社区版 `admin/clklog` |
| 读什么 | 本文 → `README.md` → `docs/architecture/candela-deploy-two-paths.md` → `AGENTS.md`（注意其中已失效章节，见 §6.1） |
| 先做什么 | 见 §9「建议的第一步」 |

---

## 1. 仓库来源与拆分范围

本仓库由 `clklog_manager` 仓库拆分而来（品牌同时更名为 **Candela**）。

**已带入**：
- `apps/`（后端 / 前端 / Harness 两个进程）、`scripts/`（构建、部署、i18n 与结构门禁、运维脚本）、`examples/report-sdk/`（17 类语言示例，前端 onboarding 的下载包由它打包）
- `docs/`（`product/` PRD、`architecture/` 实现方案与契约、`project/` 验收与复盘 —— 这是本项目的设计记忆，别丢）
- `ai_workspace/`（AI 工作区模板）
- 根文档（清理后只剩 5 份 .md）：`README.md`（入口）、`AGENTS.md`（Agent 规则）、`INDEX.md`（导航）、`PRODUCT.md`（产品与设计基线）、`CODE_HANDOVER.md`（代码审计台账）；加 `LICENSE` / `NOTICE`
- 从根目录**转入 `docs/`** 的 5 份（引用已批量更新）：
  - `docs/architecture/analytics-extension-plan.md`（总体方案）
  - `docs/architecture/reporting-protocol.md`（上报协议与流程，原 `数据上报规范与流程.md`）
  - `docs/project/legacy-production-handover.md`（旧生产运维归档，原 `HANDOVER.md`）
  - `docs/architecture/templates/AGENTS_{exec,front}.md`（Agent 规则**分发源模板**，被 `docs/architecture/code-hard-gates.md` 引用）
- `deploy-assets/clklog-community/`（**新增位置**）：从上游 ClkLog 官方部署包复制的配置资产（init SQL、ui config.js、地区字典、ClickHouse/Flink 配置），是两套部署脚本的数据源

**未带入**（有意）：
- `.git`、`node_modules/`、`target/`、`.runtime/`、工具目录（`.agents/`、`.zcode/`、`.playwright-cli/`、`.impeccable/`）、构建产物（`dist/`、`.dart_tool/`、`obj/`、`bin/`）
- **全部 `.env`**（真实密钥不入库；`apps/analytics-server/.env.example` 是模板，保留）
- `puppet/`：它是另一个仓库（`旧工作区/puppet`）的对照副本，描述的是**旧生产环境**的 Puppet 编排。其对本仓库唯一有用的部分（ClkLog 配置资产）已迁到 `deploy-assets/`，两套部署脚本的引用路径已同步更新
- `scripts/server-upgrade.sh`（旧生产发版脚本，且原本就在 `.gitignore` 里）
- **移出仓库的 3 份根文档**（留在冻结的旧仓库 `旧工作区/clklog_manager`，需要时去那边取）：
  - `OPEN.md`（596 行开源前调研）——**本身就是一份「敏感面地图」**：逐条列出内网域名、密钥所在位置、内网拓扑，并精确到旧仓库的 `文件:行号`；放进将公开的仓库等于公开攻击面清单，且内容针对旧仓库
  - `development.md`（1071 行）—— 腾讯云全托管选型 + 成本测算（46 处金额），是「社区版怎么买云服务」且含商业信息，与 Candela 开发关系弱
  - `本地开发网络转发.md`（22 行）—— 纯内网 SSH 隧道说明；新环境直连目标机，不需要
- **`sql/`（有意不带）**：它由三部分组成，三部分都不适合进本仓库——
  ① `sql/test/场景/*.sql` 是 20 个**具体业务场景查询**（内部场景游戏漏斗、服装店/礼物店/活动、社交互动…），属内部业务材料（旧仓库的 `OPEN.md` §1.7 已列为易忽略的敏感项）；
  ② `sql/test/out/*.json` 是**生成产物**（本应 gitignore）；
  ③ 其余验证脚本（`clklog_client.py` / `data_overview_validate.py` / `event_verification.py` / `funnel_batch_analyze.py` / `query_event_count.sh`）是**环境运维工具**，默认指向生产基址（旧仓库的 `OPEN.md` §358 要求改环境变量）、依赖本地 `sql/test/.env` 密钥，且其冒烟职能已被本仓库的部署验收覆盖（`scripts/standalone-test-env/verify.sh` 12 项、`.../candela/verify.sh` 19 项，含端到端上报与入库行数）。
  代码与脚本对 `sql/` 零引用（仅 `docs/project/legacy-production-handover.md` / `CODE_HANDOVER.md` 等历史文档提及）。
  若将来确实需要「数据一致性对拍/埋点质量」能力，建议做成平台内的正式能力（平台已有「数据质量」页与 `scripts/reconcile.sh`），而不是把内部场景 SQL 带进开源仓库。

**带入时做过的两处订正**（除品牌更名外）：
1. ClkLog 配置资产从 `puppet/clklog/files/clklog_dc_config/` 迁到 `deploy-assets/clklog-community/`，两套部署脚本的引用路径、`README`、`NOTICE`、相关设计文档同步更新。
2. **清掉了 SDK 示例里机器专属的绝对路径**：`examples/report-sdk/{go,c,cpp,java,ios,android}` 六个示例的 `.env` 候选路径里原本有一条 `/Users/<某人>/workspaces/.../examples/report-sdk/.env`（开发机遗留，既会在开源时暴露家目录、也会在新路径下静默失效）。现已删除，只保留两种文档化的运行方式：从语言目录跑（`../.env`）或从仓库根跑（`examples/report-sdk/.env`）。

初始提交：`d99de53`（1582 文件）。

---

## 2. 目标测试环境（<目标机>）

> ### ⚠️ 当前状态（2026-10-10 19:43）：**已铲空，等待重新部署**
>
> 已按要求执行 `bash scripts/standalone-test-env/deploy-remote.sh teardown --yes`（脚本默认 dry-run，加 `--yes` 才真删）。
>
> | | 内容 |
> |---|---|
> | **已清除** | 全部容器与镜像（含 `candela-*`、`clklog-*`、官方基础镜像）、自定义网络 `clklog-net`、全部悬空卷、`/data/app`、`/data/clklog-oss-test`、`/data/logs`、`/opt/clklog`、项目 nginx 站点与 `mgr-locations`、supervisor 程序、`/etc/sysctl.d/90-clklog-testenv.conf`、项目日志 |
> | **保留（重新部署会复用）** | Docker 引擎 29.8.2（`/etc/docker/daemon.json`、data-root `/data/docker`）、宿主 nginx 1.20.1、supervisord、EPEL 源、dnf 阿里云镜像改动 |
> | **注意** | 密钥文件已随目录删除 → 重新部署会**重新生成全部随机口令**（含平台 `admin` 口令，登录前需从新生成的 env 文件读取） |
>
> **下一步就是按 §3 从零部署一遍**（这正好是部署脚本的从零验证）。重启浏览器上的 `/sa/` 标签页前先确认部署完成。

单机 AlmaLinux 9.6（4 核 / 15 GiB / 92 GB）。重新部署后应回到下面这个形态：

| 层 | 内容 | 形态 |
|---|---|---|
| 中间件 | MySQL 8 / Redis 7 / Kafka 3.7(KRaft) / ClickHouse 23.2 | 4 个容器（`clklog-mysql` 等），数据在 `/data/clklog-oss-test/data/` |
| 社区版 | `clklog-ui/receiver/api/manage/init` + Flink `jobmanager/taskmanager` | 容器，标准模式（receiver → Kafka → Flink → ClickHouse） |
| **Candela 平台** | 前端 + `analytics-server`(HTTP) + `analytics-ingestor`(Kafka) | 两套方案二选一（互斥）：容器方案 `candela-server/ingestor/web`，或常规方案 `candela_server`/`candela_ingestor`（supervisord） |
| 入口 | 宿主 nginx `:80` 按路径分流 | `/sa/` → 平台，`/` → 社区版，`/receiver/` 上报 |

关键路径：

| 用途 | 路径 |
|---|---|
| 平台部署根 | `/data/app/candela/`（`releases/` + `current`/`previous`；`configs/`；`docker/`；`src/` 构建工作区；`ops/` 脚本；`dlq/`；`logs/`） |
| **密钥（唯一来源）** | `/data/app/candela/configs/candela.env`（0600）→ 平台超管口令 `ADMIN_INIT_PASSWORD`、DB/CH/Redis 口令、`ALERT_CONFIG_KEY` |
| 中间件密钥 | `/data/clklog-oss-test/config/deploy.env`（0600） |
| 平台日志 | `/data/logs/production/candela/`（常规方案）；容器方案看 `docker logs candela-server` |
| nginx | `/etc/nginx/conf.d/clklog-testenv.conf`（社区版站点，含 `include /etc/nginx/mgr-locations/*.inc`）+ `candela-map.conf` + `/etc/nginx/mgr-locations/sa.inc` |
| supervisor | `/etc/supervisord.d/candela_server.ini`、`candela_ingestor.ini` |
| Node | `/opt/clklog/node-v24.20.0-linux-x64`（两套方案共用） |

> 平台管理员口令请直接从目标机读：`grep ADMIN_INIT_PASSWORD /data/app/candela/configs/candela.env`。**不要把口令写进任何文档或提交。**

---

## 3. 部署速查（三件套）

```bash
# 在工作站、本仓库根目录执行（脚本自行 ssh/rsync 到目标机并在目标机构建）
M=scripts/standalone-test-env/candela/deploy-remote.sh

bash scripts/standalone-test-env/deploy-remote.sh mw       # ① 中间件（MySQL/Redis/Kafka/ClickHouse）
bash scripts/standalone-test-env/deploy-remote.sh clklog   # ② ClkLog 社区版（标准模式）+ 宿主 nginx 入口
bash $M native        # ③ Candela 平台 —— 常规方案（宿主 Node + supervisord）
bash $M docker        # ③ Candela 平台 —— 容器方案（docker compose）

# 验收
bash $M verify                                             # 平台 19 项
bash scripts/standalone-test-env/deploy-remote.sh verify    # 中间件 + 社区版 12 项

# 运维
bash $M push          # 只推送源码/脚本
bash $M wipe          # 只铲数据库（默认 dry-run）；bash $M wipe --yes 真删并重建环境级资源
bash scripts/standalone-test-env/deploy-remote.sh teardown        # 清空整机部署（dry-run）
bash scripts/standalone-test-env/deploy-remote.sh teardown --yes  # 真删（容器/镜像/卷/数据目录/配置/Node）
```

换目标机：`HOST=root@10.0.0.5 bash ...`；换部署根：`BASE_DIR=/data/app/candela MW_BASE_DIR=/data/clklog-oss-test`。

**幂等**：两套方案都按内容哈希判断是否需要重建/重启，重复执行是零动作或无害动作（实测：镜像未重建、容器未重建、口令未轮换、数据不变）。

**两套互斥**：都占用 `:3100` 与 `/sa/`，切换时脚本会自动停掉对方。

细节见 [`docs/architecture/candela-deploy-two-paths.md`](../architecture/candela-deploy-two-paths.md)（含数据库初始化脚本的设计与「为什么新库不用 `migrate deploy`」）与 [`docs/architecture/standalone-test-env-design.md`](../architecture/standalone-test-env-design.md)。

---

## 4. 品牌与命名边界

| 名字 | 指什么 | 是否可改 |
|---|---|---|
| **Candela** | 本项目/平台（仓库、镜像 `candela-*`、容器、compose 栈 `candela`、部署目录、界面标题与字标、邮件署名） | ✅ 已统一 |
| **ClkLog** | 上游社区版（官方镜像、社区版容器与库、上报协议与 SDK：`ClkLogClient`、`CLKLOG_ENDPOINT/TOKEN/PROJECT`） | ❌ **不要改**：它指向上游组件与协议，改了会让接入指南示例失效 |
| `sa` 系列技术标识 | `/sa/` 路径、`sa/api` 前缀、库名 `clklog_sa` / `clklog_sa_meta`、只读账号 `sa_readonly`、环境变量 `CLKLOG_*`、已保存 SQL 里的 `clklog_sa.` 与 `sa_in_cohort()` | ⏳ 见 §6.3，需独立 phase |

`README.md` 的「命名与边界」章节有同样一张表（对外说明用）。

---

## 5. 上机常用命令

```bash
# 平台（容器方案）
docker compose -f /data/app/candela/docker/docker-compose.yml ps
docker logs -f candela-server        # 或 candela-ingestor
# 平台（常规方案）
supervisorctl status candela_server candela_ingestor
tail -f /data/logs/production/candela/analytics-server.log
# 中间件与社区版
docker ps --filter name=clklog-
docker logs --tail 50 clklog-receiver
# ClickHouse 查数（口令见目标机 env）
curl -sS -u "default:$CK_PWD" 'http://127.0.0.1:8123/' --data-binary 'SELECT count() FROM clklog_sa.sa_events'
# 端到端上报冒烟
python3 <目标机>/tmp/test_report.py 2>/dev/null || 见「docs/architecture/reporting-protocol.md」的 curl 示例
```

回滚：常规划 `previous` 软链 + `supervisorctl restart candela_server candela_ingestor`；容器改回上一个 `DOCKER_*_TAG` 后 `deploy-docker.sh --skip-build`。

---

## 6. 待办（按优先级）

### 6.1 【P0】修订本仓库里从旧仓库带过来的「失效说明」

以下文件是整体复制过来的，其中**部分章节已不适用于新仓库**，接手时先改掉，避免后续 session 照旧文档走错路：

| 文件 | 已失效的内容 | 建议 |
|---|---|---|
| `AGENTS.md` | 「实现专用规则」里的 release 发版流程（2223 隧道 → push master → 等 CI → 上机 rsync）、`puppet/` 相关红线与「服务器配置真相在 Puppet」、`scripts/server-upgrade.sh`、`scripts/install-harness-runtime.sh` 等路径 | 本仓库部署真相是 `scripts/standalone-test-env/`；把发版章节重写为「本地 push → 目标机构建 → 验收」，红线改为针对新环境 |
| `INDEX.md` | 计数、`puppet/` 行、「部署现状 docs/project/legacy-production-handover.md」等条目 | 重新全量扫描并更新计数；把 `puppet/` 行换成 `deploy-assets/`；补本文档与两套部署脚本的入口行 |
| `docs/project/legacy-production-handover.md`（根） | 描述的是**旧生产环境**（生产主机、Puppet、CI、内网地址），作为历史保留 | 不要删（很多文档引用它的 §10 线上调试经验）；但要在开头加一句「本文件描述旧生产环境，新仓库部署见 README + 本文档」 |
| `OPEN.md`（**已移出本仓库**，在旧仓库） | 开源前准备调研（含 git 历史重写方案、内网拓扑、脱敏清单）——针对旧仓库 | 本仓库是全新 git 历史，天然规避「历史含明文密钥」；脱敏清单仍值得照做一遍 |
| `CODE_HANDOVER.md` | 代码审计问题登记 | **有价值，保留**；其中问题多数仍未修 |

### 6.2 【P0】仓库远程与开源准备

- 在 GitLab/GitHub 新建仓库（建议名 `candela`）并推初始提交；决定是否保留旧仓库历史（新仓库是**全新 git 历史**，天然规避旧仓库「历史含明文密钥」的问题）。
- 开源前按旧仓库 `OPEN.md` 的脱敏清单过一遍（注意：本仓库已排除 `.env`，但**旧仓库文档里含内网拓扑/域名/路径**的描述性内容仍在，例如 `docs/project/legacy-production-handover.md`、`本地开发网络转发.md`）。

### 6.3 【P1】`sa` 技术标识迁移（成本高，独立 phase）

`/sa/`（前端 base + nginx 路由）、`sa/api`、库名 `clklog_sa` / `clklog_sa_meta`、`sa_readonly`、`CLKLOG_*` 环境变量、npm 包名 `@clklog/analytics-*`、已保存 SQL 里的 `clklog_sa.` / `sa_in_cohort()`。

改这些会影响到：nginx 路由、前端构建 base、Prisma 数据源、ClickHouse DDL 与迁移、**用户已保存的看板/SQL/告警模板**、以及部署脚本与文档。建议：**保留旧路径并 302 一段时间**，用独立 phase 做（先出方案，含兼容与回滚点）。

### 6.4 【P1】仓库级缺陷修复批次（8 项，均有实测证据）

见 [`docs/architecture/candela-deploy-two-paths.md`](../architecture/candela-deploy-two-paths.md) §5，摘要：

1. **Prisma 迁移链无法从零重放**（6 个迁移大小写不一致、`MetaEventAttribute` 无任何迁移创建、`redesign_card_dashboard` 迁移生产即失败并有 `repair.sql`）→ 新环境只能走「基线建表 + 重放幂等种子」。建议：补一条统一命名的新迁移，让 `migrate deploy` 恢复为唯一建库路径。
2. `schema.prisma` 含 MySQL 非法默认值（`@db.Text @default("[]")`）→ 部署期已规范化，建议根因修掉。
3. **前端构建依赖兄弟应用**（`analytics-web` 的 spec 引 `analytics-harness-host/.../analysis-cases.json`）→ 前端无法单独构建，容器构建上下文必须是仓库根。建议：把该 JSON 收进 web 应用内。
4. 前端构建依赖仓库根脚本 `scripts/build-sdk-demos.sh` + `examples/report-sdk`（zip 不入库）。
5. `nest build` 产物布局随 `test/` 是否存在而变（`dist/main.js` ↔ `dist/src/main.js`）→ 建议给 `tsconfig.json` 加 `rootDir: "src"` 并同步 CI。
6. **DLQ 默认路径不安全**（由 `__dirname` 推导，会落在发布目录内/容器根）→ 新部署脚本已显式设 `DLQ_DIR`；生产同样应显式化。
7. `prisma generate` 写在启动命令里（旧生产 supervisor）→ 新部署已在构建期生成。
8. 迁移种子与模型名大小写混用（部分种子在大小写敏感环境静默写不进）。

### 6.5 【P2】其它

- **AI Harness 默认关闭**（`deepseek_harness.enabled: false`）。启用需要 rootless podman + broker 运行时 + 模型供应商密钥（平台内配置，密文入库）。nginx 的 `/sa/harness/`（含 SSE/WS）路由已预留。
- 生产环境（旧仓库那一套）是否迁移到 Candela 命名与新的两套部署流程 —— 需单独决策（生产机路径仍为 `/data/app/clklog_manager`）。

---

## 7. 已知坑（实测教训，改部署/代码前先看）

部署相关（均已固化进脚本，但排查时要知道）：
- **`node:*-slim` 无 OpenSSL** → Prisma 引擎失败；Dockerfile 已装（apt 源可由 `--build-arg APT_MIRROR` 指定）。
- **`node:*-slim` 无 wget/curl** → 容器健康检查要用 `node -e` 自检。
- **ClickHouse 的 `config.d` 必须按文件挂载**（挂目录会遮掉镜像自带 `docker_related_config.xml`，导致只监听回环）；`users.d` 反过来要按目录挂（镜像里是空的）。
- **社区版 `clklog-init` 冷启约 95 秒**，铲库后重建社区版 CH 库表要等（脚本等 180s）。
- **社区版 api 的 swagger 首次请求实测 41.6 秒**（springdoc 懒生成）→ 验收脚本该路径超时给 60s。
- **`docker exec -i` 会吞掉调用方 stdin**（`ssh host 'bash -s' < script` 场景会让脚本执行两条命令后中断）→ 查询走参数、不加 `-i`。
- **shell 陷阱**：`cat > file <<HEREDOC` 会先截断文件再展开 `$(...)`（曾导致写出空口令）；`umask 077` 会泄漏到整个脚本（曾导致静态文件 0600、nginx 404）；`[[ ]] && return 0` 在 `set -e` 下会直接退出。
- **同名 `lib.sh` 互相覆盖**：目标机上 `ops/lib.sh`（公共库）与 `ops/candela/lib.sh` 必须分层存放（脚本用 `../lib.sh` 引用）。

运行/数据相关：
- **迁移种子不能省**：新库必须重放 `INSERT IGNORE` 类种子，否则内置告警规则（7 条）、日志治理白名单、保留策略、项目行都会缺。
- **`reconcile.reportDir` 由部署期渲染**为 `/data/logs/production/candela/reconcile`（仓库配置里写的是旧生产路径）。
- **平台登录失败先看密钥文件**：若 `configs/*.env` 被重建（等于换了口令），而库里 `admin` 已存在，`init-admin.js` 会跳过 → 表现为「部署成功但登录失败」。脚本已有「旧密钥文件自动迁移」守卫。

---

## 8. 交接前的验证证据（2026-10-10，**铲空前**的状态）

> 以下记录的是**铲除之前**那次成功部署的证据，用于证明本仓库的部署链路可用；机器现已清空，重新部署后请再跑一遍 §3 的两条验收。

均从**本仓库**入口执行：

| 验证 | 结果 |
|---|---|
| 容器方案部署（`$M docker`） | 成功；镜像 tag `31eaee4f1a9d`，三容器 running（server/web healthy） |
| Candela 平台验收（`$M verify`） | **19/19**（含端到端：上报 → `log_analysis` 与 `sa_events` 行数同时增长、`sa_readonly` 只读性、admin 登录） |
| 中间件 + 社区版验收（`deploy-remote.sh verify`） | **12/12**（含 Flink 作业 RUNNING、上报入库） |
| 幂等 | 两套方案复跑均为零差异（镜像复用、容器未重建、口令未轮换、数据不变） |
| 结构棘轮 / i18n 门禁 | `python3 scripts/arch_ratchet.py` 通过；`i18n_check.py` + `i18n_scan.py --check` 通过（13 语言 × 16 命名空间，4176 键） |
| 品牌 | 浏览器实测界面标题 `Candela Analytics`、DOM 含 Candela 且无 ClkLog 残留 |

---

## 9. 建议的第一步（给新 session）

1. **读**：本文 → `README.md` → `docs/architecture/candela-deploy-two-paths.md`。
2. **验环境**：`ssh root@<目标机> 'docker ps --filter name=candela'` + 跑 `bash scripts/standalone-test-env/candela/deploy-remote.sh verify`，确认 19/19 后再动手。
3. **修文档债（§6.1）**：优先改 `AGENTS.md`（发版与红线章节）与 `INDEX.md`（计数 + puppet 行 + 新入口），这两份是后续 session 的第一手依据。
4. **然后按 §6.4 挑一项仓库级缺陷开修**（推荐第 3 项「前端构建依赖兄弟应用」或第 1 项「迁移链」，两者对后续开发影响最大），或按用户指定的方向推进。
