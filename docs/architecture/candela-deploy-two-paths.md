# Candela 两套部署流程实现方案（常规 supervisord / docker-compose）

> phase: `candela-deploy-two-paths-v1`
> 性质：**实现方案**。实测过程、验收证据与缺陷复盘见 `docs/project/deployment-record-candela-two-paths.md`。
> 落地日期：2026-10-10。目标机：`<目标机>`（AlmaLinux 9.6，4C/15G）。**不依赖现有 CI/CD**：源码由本地 rsync 推送、在目标机构建。

---

## 1. 阶段目标与范围

**目标**：在已部署 ClkLog 社区版（含自建 MySQL/Redis/Kafka/ClickHouse，见 `docs/architecture/standalone-test-env-design.md`）的同一台机器上，用**两套独立、可反复执行的企业级流程**部署 Candela（分析平台后端 + Kafka 消费 + 前端 + 数据库初始化 + nginx），并保证两套流程可互相切换。

**范围**：
- 流程 A「常规方案」：宿主 Node 24 + supervisord 拉起 `candela_server` / `candela_ingestor`，宿主 nginx 直出前端静态。
- 流程 B「Docker 方案」：`docker compose` 三容器（server / ingestor / web）+ 一次性 `manager-migrate` 工具容器，接入中间件共享网络。
- 共用件：数据库初始化脚本（MySQL + ClickHouse）、配置渲染、密钥契约、验证脚本、铲库脚本。
- 交付物：`scripts/standalone-test-env/candela/`（脚本）、`apps/analytics-{server,web}/Dockerfile`（镜像配方）、本文件与项目记录。

**非目标**：
- 不引入 CI/CD 或私有 rsync 链路（本次明确排除）。
- 不改社区版镜像/表结构（红线 1）；不改分析平台的 API/事件/表契约。
- 不做域名与 TLS（按 IP 访问）。
- 不启用 AI Harness（`deepseek_harness.enabled=false`）：它需要 LLM 供应商密钥 + rootless podman + 独立 broker/runtime，属另一 phase；本次只把 nginx 的 `/sa/harness/`（含 SSE/WS）路由预留好。
- 不做高可用/多副本（单实例）。

**验收标准**（`verify.sh` 全绿 + 幂等复跑零差异 + 浏览器实测）：
1. 进程/容器就绪；`/sa/api/health` 有响应（受鉴权返回 401 即算监听）。
2. 经宿主 nginx：`/sa/`、`/sa/index.html` 返回 200；`/sa/api/health` 返回 401。
3. MySQL 元数据库 61 张表（schema.prisma 基线）+ 超管 `admin/super_admin/active`；社区版 `clklog` 8 表。
4. ClickHouse `clklog_sa` ≥4 张核心表；`sa_readonly` 可查、**写入被拒**（红线 4）。
5. Kafka topic 存在，`clklog-sa-ingestor` 消费组 LAG=0。
6. 端到端：经社区版 receiver 上报 → `clklog.log_analysis` 与 `clklog_sa.sa_events` **行数同时增长**。
7. 分析平台 `admin` 登录返回 token；浏览器可登录并进入看板页。
8. 幂等：复跑部署脚本后镜像/容器/口令/数据零变化。

---

## 2. 两套流程的形态

```
                        宿主 nginx :80（统一入口，无域名）
        /sa/ ───────────┬─────────────────────────────┐
                        │ 流程A：root /data/app/candela/current/web
                        │ 流程B：proxy → 127.0.0.1:8086（manager-web 容器）
        /sa/api/、/sa/harness/ ────────────────────────→ 127.0.0.1:3100

流程A（常规）                          流程B（Docker）
─────────────────────────             ─────────────────────────
宿主 Node 24.20.0 @ /opt/clklog        镜像 candela-server:<hash>
supervisord 两程序                     docker compose 栈 candela
releases/<ts>/{server,ingestor,web}    manager-server / manager-ingestor / manager-web
+ current / previous 软链              manager-migrate（仅 run --rm，不随 up 启动）
DB：127.0.0.1:3306 / :8123             DB：服务名 mysql / clickhouse（clklog-net 内）
```

**目标机上的脚本目录**（与仓库同构，两层避免同名 `lib.sh` 互相覆盖）：

```
<BASE_DIR>/ops/lib.sh            ← scripts/standalone-test-env/lib.sh（公共函数）
<BASE_DIR>/ops/candela/*.sh      ← scripts/standalone-test-env/candela/*.sh（本产品脚本）
```

**两套流程共享同一份「数据库初始化脚本、配置渲染、密钥契约、验证脚本」**，差异只在加载方式：
`set_endpoints native|docker` 一处切换应用侧寻址（`127.0.0.1` ↔ 服务名），运维脚本则**永远走宿主 127.0.0.1 的已发布端口**（`OPS_*` 端点），与容器内寻址解耦。

**互斥**：两套流程都占用 `:3100` 与 `/sa/` 路由，因此互相切换时脚本会自动停掉对方（常规→Docker 时 `supervisorctl stop`；Docker→常规时 `docker compose stop`），并在日志里说明。

**根路径兜底（不依赖 nginx）**：后端 `GET /` 由应用自身 302 到 `/sa/`（`main.ts` 用 Express 实例的精确路由注册，不走 Nest 守卫/管道）。这样直连后端端口（`:3100`，含容器内）或 web 层不可达时，访问根路径仍能到达平台入口，不依赖宿主 nginx 的分流配置。回归锁在 `apps/analytics-server/test/root-redirect.spec.ts`（源码不变量：注册方式 + 目标地址 + 禁止 `app.use('/')` 前缀匹配）。

---

## 3. 数据库初始化脚本（两套流程共用）

### 3.1 MySQL 初始化（`init-db-mysql.sh`）

| 步骤 | 内容 | 幂等性 |
|---|---|---|
| 建库 | `clklog`（社区版）、`clklog_sa_meta`（平台元数据） | `CREATE DATABASE IF NOT EXISTS` |
| 社区版表 | 导入 `deploy-assets/clklog-community/init/mysql_clklog.sql` | `CREATE TABLE IF NOT EXISTS` + `INSERT`→`INSERT IGNORE`；显式 `--default-character-set=utf8mb4` |
| 应用账号 | `clklog_sa_app` 仅授权 `clklog_sa_meta.*`（最小特权，不用 root 跑应用） | `CREATE USER IF NOT EXISTS` + `ALTER USER`（每次都收敛到当前口令） |
| 元数据表 | Prisma 基线：`migrate diff` 生成 DDL → 应用 → `migrate resolve --applied` × N → 重放幂等种子 | 已存在迁移历史时改走 `migrate deploy` 增量路径 |
| 超管 | `init-admin.js`（口令来自 `ADMIN_INIT_PASSWORD`） | 已存在则跳过 |

**为什么新库不用 `prisma migrate deploy`**：实测该仓库的迁移链**无法在大小写敏感的 MySQL 上从零重放**（详见 §5 缺陷 1）。schema 的权威是 `prisma/schema.prisma`，因此新库按 Prisma 官方「基线」流程建结构，再把迁移逐个登记为 `applied`（使 `_prisma_migrations` 与仓库一致，后续新增迁移仍可正常 `deploy`），最后**重放迁移里的幂等种子**（内置告警规则 7 条、日志治理白名单、保留策略、项目行——它们不是 schema 能表达的）。

### 3.2 ClickHouse 初始化（`init-db-clickhouse.sh`）

| 步骤 | 内容 | 幂等性 |
|---|---|---|
| 只读账号 | 写中间件 CH 的 `users.d/sa_readonly.xml`：`sa_ro` profile（`readonly=2` + constraints 锁死不可降级）+ 内嵌 `GRANT SELECT ON clklog_sa.* / clklog.*` | 文件内容比对，未变化不重启 CH |
| 事件库表 | `init-clickhouse.js` → `clklog_sa` + `sa_events`/`sa_user_profiles`/`sa_cohort_members`/`sa_tag_members` | DDL 全 `IF NOT EXISTS` |
| 结构对齐 | `migrate-clickhouse.js` → 跳数索引、`clklog_sa_bak`/`clklog_sa_staging`、`sa_cleanup` 账号（仅 `clklog_sa*` 库权限） | 脚本自身幂等（实测二次执行输出 `noop`） |

**只读账号为什么走 XML 而不是 SQL 建用户**：生产用「profile + constraints + 内嵌 grants」这一组来规避「SQL 建的用户 `readonly` 设置不可靠」的历史缺陷（发版曾把该文件覆盖回去导致越权，见 `docs/project/legacy-production-handover.md` 与分析平台会话记录）。这里原样复刻已验证形态，不另造一套。

---

## 4. 脚本清单与职责

| 文件 | 职责 |
|---|---|
| `lib.sh` | 路径与口令契约、端点切换（native/docker + OPS_*）、配置渲染（**逐项断言命中次数**）、数据库客户端封装（宿主客户端缺失时回退容器内执行）、大小写不敏感表名解析、nginx 片段渲染 |
| `init-db-mysql.sh` | §3.1，支持 `--runner host\|docker` |
| `init-db-clickhouse.sh` | §3.2，支持 `--runner host\|docker` |
| `deploy-native.sh` | Node 24 安装（校验 SHA256）→ supervisord 安装（EPEL）→ 构建（npm ci 按 lock 哈希跳过）→ 前/后端产物组装（含 gzip 预压缩、sdk-demos 打包）→ releases + current/previous 原子切换 → DB 初始化 → supervisor 程序 → nginx → 就绪判定 |
| `deploy-docker.sh` | 基础镜像就位 → 按内容哈希构建三镜像（含 Dockerfile）→ compose 渲染与起栈 → DB 初始化（runner=docker）→ nginx → 就绪判定 |
| `wipe-databases.sh` | 破坏性：铲 MySQL/CH 全部库与账号 + Kafka topic 与消费组；**并重建环境级资源**（topic、社区版 CH 库表），避免留下半死环境。默认 dry-run，需 `--yes` |
| `verify.sh` | 19 项验收，自动识别当前形态（存在 `candela-server` 容器即 docker） |
| `deploy-remote.sh` | 本地入口：rsync 源码/脚本/资产 → 执行指定动作（`push\|native\|docker\|verify\|wipe`） |

**幂等策略**（关键机制）：
1. **内容哈希决定是否重做**：常规方案对「编译产物 + schema + 前端产物」与「config.yaml + 密钥文件」分别算哈希，写入 `releases/<ts>/.release-meta`；两者都未变则复用当前发布、跳过重建与重启。Docker 方案对源码 + Dockerfile + lock 算哈希作为镜像 tag，内容不变则复用镜像。
2. **npm ci 按 lock 哈希跳过**（`node_modules/.clklog-lock-hash`），重跑不再重装依赖。
3. **配置渲染逐项断言**：每处替换声明期望命中行数，仓库配置一旦改形立刻报错而不是静默错配（顺序敏感处已注明原因：先换 CH 的三处 `127.0.0.1`，再换 MySQL/Redis，否则后者写入的新值会被前者统计进去）。
4. **密钥不轮换**：生成类口令首次写入 `configs/candela.env`（0600）后复用；派生类（连接串、中间件口令）每次按当前形态重算。
5. **就绪判定打到真实端口**：不拿「进程在跑」当就绪；`/sa/api/health` 受鉴权保护，返回 401 也算监听（这一条写错会误报未就绪）。

---

## 5. 本次发现的仓库级缺陷（部署侧已绕过，建议排期修）

| # | 缺陷 | 影响 | 部署侧规避 | 建议修法 |
|---|---|---|---|---|
| 1 | **Prisma 迁移链无法从零重放**：6 个迁移以小写表名引用 PascalCase 表（`card`/`metaevent`/`saproject`/`sqlreport` 等）；`MetaEventAttribute` 无任何迁移创建它；`20260901090000_redesign_card_dashboard` 自述「生产执行时在 INSERT 处失败」并附 `repair.sql` | 新环境/灾备无法用 `migrate deploy` 建库；OSB 用户照文档执行会直接失败 | 新库走基线流程（`migrate diff` + `resolve --applied` + 幂等种子）；已有历史走 `migrate deploy` | 生成一条「补齐缺失对象 + 统一命名」的新迁移，并在生产受控窗口 `resolve` 历史；此后把 `migrate deploy` 恢复为唯一建库路径 |
| 2 | **schema.prisma 含 MySQL 非法默认值**：`verified_json String @db.Text @default("[]")`（TEXT 不允许字面量默认值） | `prisma db push` 直接报错 `BLOB, TEXT... can't have a default value` | 部署期把 TEXT/JSON/BLOB 的字面量默认值规范化为表达式默认 `DEFAULT ('…')` | 改用表达式默认或去掉默认值（列入 §5 的迁移修复批次） |
| 3 | **前端构建依赖兄弟应用文件**：`apps/analytics-web/src/features/ai-analysis/*.spec.ts(x)` 引 `../../../../analytics-harness-host/plugins/analytics-tools/analysis-cases.json`，而 `npm run build` 里的 `tsc` 会类型检查 spec | 前端**无法单独构建**（TS2307）；容器化时上下文必须包含兄弟应用 | 部署时一并推送该 JSON；web 镜像要求「仓库根」作为构建上下文 | 二选一：把 spec 排除出生产 `tsc`，或把该 JSON 收进 web 应用内（推荐后者，彻底解耦） |
| 4 | **前端构建依赖仓库根脚本与 `examples/`**：`scripts/build-sdk-demos.sh` 需在 `npm run build` 前把 `examples/report-sdk` 打包进 `public/sdk-demos/`，而 zip 产物不入库 | 干净检出后单独构建前端会缺 onboarding 示例包（按钮静默隐藏） | 部署流程化推送 `examples/report-sdk` + 该脚本并在构建前执行 | 把 zip 生成并入 web 的 `prebuild`，或改为从后端下发 |
| 5 | **`nest build` 产物布局随 `test/` 是否存在而变**：`tsconfig.json` 无 `rootDir`/`include`，含 `test/` 时根推导为项目根 → `dist/src/*`，否则 → `dist/*` | 生产 supervisor 与 CI 都硬编码 `dist/src/main.js`；只推 `src/` 的部署会直接起不来 | 部署脚本同时支持两种布局（探测 `dist/src/main.js` 是否存在） | 给 `tsconfig.json` 加 `"rootDir": "src"` 或 `"include": ["src/**/*"]`，并同步 CI 产物路径 |
| 6 | **DLQ 落盘路径由 `__dirname` 推导且不设 `DLQ_DIR`** | 生产部署下落在 `<release>/dlq`：**每次切换发布都会丢 DLQ**（消费失败数据无审计）；容器布局下还会落到文件系统根 `/dlq` | 两套流程都显式设 `DLQ_DIR`（native `$BASE_DIR/dlq`；docker `/app/dlq` 独立卷），并落到持久卷 | 生产同样应显式设 `DLQ_DIR`（独立于发布目录） |
| 7 | **`prisma generate` 写在启动命令里**（生产 supervisor 的 `command`） | 启动依赖 npm 网络、冷启变慢；网络抖动会导致服务起不来 | 两套流程都在**构建期**生成 Prisma Client，启动即 `node dist/.../main.js` | 生产可同样改为构建期生成（`node_modules` 随发布带上） |
| 8 | 迁移种子与模型名大小写混用（`INSERT IGNORE INTO alertrule` 依赖 `@@map`，同文件另有多处小写引用） | 大小写敏感环境下部分种子会写不进去且**静默**（管道吞异常） | 种子重放改为「先剥注释再提取 + 表名大小写不敏感解析」；校验查询同样用 `information_schema` 解析真实表名 | 迁移内统一以 `@@map` 名引用；CI 增加「大小写一致性」检查 |

---

## 6. 环境约束（本机实测，已固化进脚本）

| 约束 | 现象 | 脚本处置 |
|---|---|---|
| dnf 官方源不可解析 | `mirrors.almalinux.org` 解析失败，`dnf` 全部不可用 | 仅当官方源不可用时切 `mirrors.aliyun.com/almalinux` |
| docker.io 不可达 | `registry-1.docker.io` 连接失败；第三方代理镜像拉取同样失败 | 官方镜像改从 `public.ecr.aws/docker/library/*` 取；ClkLog 镜像用阿里云仓库 |
| `supervisor` 不在 AlmaLinux 仓库 | `dnf list supervisor` 无匹配 | 走 EPEL（阿里云镜像），并对其 metalink/openh264 子仓库做兜底 |
| EPEL 元数据慢 + dnf 锁竞争 | `makecache --timer` 持锁，`install` 干等数分钟；sack setup 实测 267s | 安装前**有界等待**（最多 300s）后临时停掉该定时任务 |
| `node:*-slim` 无 OpenSSL | Prisma 报 `failed to detect the libssl/openssl version` 并失败 | Dockerfile 内 `apt-get install openssl`，apt 源可由 `--build-arg APT_MIRROR` 指向国内镜像 |
| npm 11.19 `allowScripts` 门禁 | `npm ci` 跳过 postinstall（prisma/esbuild 等 5 个包） | 构建流程**不依赖 postinstall**：`prisma generate` 显式执行；Vite 走 `@esbuild/linux-x64` 可选依赖，实测可用 |
| 社区版 `clklog-init` 冷启约 95s | 铲库后重建社区版 CH 库表需等待 | 铲库脚本等待窗口放到 180s 并断言表数量 |

---

## 7. 使用方式

```bash
# 本地入口（默认目标 root@<目标机>）
M=scripts/standalone-test-env/candela/deploy-remote.sh
bash $M push                 # 只推送源码/脚本/资产
bash $M native               # 流程A：常规方案（含推送）
bash $M docker               # 流程B：docker-compose（含推送）
bash $M verify               # 验证（自动识别形态）
bash $M wipe                 # 铲库 dry-run
bash $M wipe --yes           # 铲库（真删，并重建环境级资源）
```

访问：`http://<目标机>/sa/`（分析平台，`admin` / 口令见目标机 `configs/candela.env` 的 `ADMIN_INIT_PASSWORD`）；`http://<目标机>/`（ClkLog 社区版，`admin` / `clklog`）。

**回滚**：常规方案切 `previous` 软链后重启 supervisor；Docker 方案把 `DOCKER_*_TAG` 改回上一个 tag 并 `--skip-build` 重跑。
