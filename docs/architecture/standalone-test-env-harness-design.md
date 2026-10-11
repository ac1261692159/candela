# 测试环境 AI Harness 启用（phase: standalone-test-env-harness-v1）

> 产品需求来源：[`docs/product/prd-clklog-ai-workspace-v1.md`](../product/prd-clklog-ai-workspace-v1.md)（AI Workspace 的能力与交互）；
> 系统设计来源：[`docs/architecture/clklog-ai-workspace-design.md`](clklog-ai-workspace-design.md)（broker/host/工作区的契约与安全边界）。
> 本文只解决一件事：**让 `scripts/standalone-test-env/` 部署出的测试环境能启用 AI Harness 运行时**——生产已有的 `ops/install-harness-runtime.sh` 依赖三个未随仓库迁移的 `ops/install-*.sh`，在本仓库不可用（2026-10-10 全仓确认缺失）。

## 阶段目标与范围

| 项 | 内容 |
|---|---|
| 产品设计文档 | `docs/product/prd-clklog-ai-workspace-v1.md`（已有，本 phase 不改产品行为） |
| 阶段目标 | 在 standalone 测试环境（如 <目标机>）一键安装 harness 运行时并让平台识别 `deepseek_harness.enabled: true`、broker 就绪；**模型供应商密钥由部署后在平台 UI 配置（不在本 phase）** |
| 范围 | ① 新增 `scripts/standalone-test-env/candela/install-harness.sh`（幂等安装器）；② `lib.sh` 渲染开关支持 `harness.enabled` 标记 / `HARNESS_ENABLED=1`；③ `deploy-remote.sh` 推送补全 harness 源码与 `ai_workspace` 种子 |
| 非目标 | ① 不改平台应用代码与前端（harness 功能本身无改动）；② 不接入模型供应商/密钥（用户后续 UI 操作）；③ 不改生产发版路径（`install-harness-runtime.sh` 仍为生产真相）；④ 不引入 K8s/容器化部署（见 containerization-feasibility） |

## 关键设计

### 1. 运行时布局（与生产契约一致，路径不变）

| 项 | 值 | 来源 |
|---|---|---|
| Linux 用户 | `harness`（系统用户，home `/home/harness`） | `config.yaml` `deepseek_harness.runtime.linux_user` |
| 运行时根 | `/home/harness/clklog-ai`（0700 harness:harness） | `runtime.home_subdir` |
| broker socket | `<root>/gateway/control/broker.sock` | broker 与 `harness-broker-client.service.ts` 的约定 |
| 运行时 release | `/opt/clklog/harness/releases/<内容哈希>/{host,broker}` + `current` 软链 | 与生产同构；哈希未变则复用（幂等） |
| broker 配置 | `/etc/clklog/harness-broker.json`（0640 root:harness） | broker `loadConfig` 契约 |
| supervisor 单元 | `/etc/supervisord.d/clklog-harness-broker.ini` | 由 `scripts/supervisord-harness-broker.conf` 渲染（`@@HARNESS_*@@` 占位符） |
| 容器镜像 | `docker.io/library/node:24.20.0-bookworm-slim`（rootless podman 拉取） | `runtime.container_image` |

平台侧（analytics-server）在 `enabled: true` 时执行 `ensureRoot()`：要求 `harness` 用户存在（否则报 `ai.runtime.linuxUserMissing`），并自建/收敛上述目录树——因此**必须先装运行时再开开关**。

### 2. 安装器行为（幂等，可反复执行）

1. 前置检查：podman 可用、`config.yaml` 存在、仓库源码已推送（`src/apps/analytics-harness-{host,broker}`）。
2. 用户与目录：`useradd -m harness`（不存在时）；补 `/etc/subuid`、`/etc/subgid`（rootless 必需）；`loginctl enable-linger`；`/run/user/<uid>`（tmpfiles.d）；建目录树（chown harness）。
3. release 组装：按内容哈希建 `/opt/clklog/harness/releases/<hash>`，host 侧 `npm ci --omit=dev --ignore-scripts`（registry 用 `NPM_REGISTRY`，默认 npmmirror）；切换 `current`。
4. 配置与单元：写 `harness-broker.json`；渲染 supervisor 单元（日志路径改 standalone 的 `/data/logs/production/candela/`）。
5. 镜像：为 harness 用户配置 container registries 镜像源（沿用 docker 的 `hub.rat.dev`，podman 不读 docker 配置），`podman pull`（已有则跳过）。
6. 工作区种子：调用 `scripts/ai-workspace-sync.sh init --from-release "$SRC_DIR"`（只补缺失，不覆盖运行时已有内容）。
7. 启动：`supervisorctl reread/update/restart clklog_harness_broker`，随后探活 socket 与 `GET /v1/health`。

### 3. 开关机制（避免"下次部署又被关掉"）

- `lib.sh` 渲染时：`harness.enabled` 标记文件存在（或 `HARNESS_ENABLED=1`）→ 保留仓库默认 `enabled: true`；否则替换为 `false`（测试环境默认不变）。
- `install-harness.sh` 成功安装后创建 `$BASE_DIR/configs/harness.enabled` 标记；卸载/停用 = 删标记 + `supervisorctl stop clklog_harness_broker`。
- 首次启用流程：`install-harness.sh` → 重新部署（`HARNESS_ENABLED=1 bash deploy-native.sh --skip-build`）让 `config.yaml` 收敛为 `enabled: true` 并重启服务。

## 验收标准

| # | 判定 | 方法 |
|---|---|---|
| 1 | 用户与目录就绪 | `id harness`；`ls -ld /home/harness/clklog-ai/{gateway/control,ai_workspace}` 属主 harness |
| 2 | broker 进程运行 | `supervisorctl status clklog_harness_broker` = RUNNING |
| 3 | broker 探活 | `curl --unix-socket <root>/gateway/control/broker.sock http://localhost/v1/health` → `{"ok":true}` |
| 4 | 容器镜像就绪 | `runuser -u harness -- podman image exists docker.io/library/node:24.20.0-bookworm-slim` |
| 5 | 工作区种子 | `<root>/ai_workspace/default/AGENTS.md` 存在 |
| 6 | 平台识别开关 | 目标机 `config.yaml` `deepseek_harness.enabled: true`；平台 AI 入口在 UI 可见（浏览器实测） |
| 7 | 既有链路不回归 | `verify.sh` 18 项与中间件 12 项仍全通过 |
| 8 | 幂等 | 安装器复跑零差异（release 复用、镜像跳过拉取） |

## 风险与对策

| 风险 | 对策 |
|---|---|
| podman 不读 docker 的 registry-mirrors → 拉镜像失败 | 安装器写 `/etc/containers/registries.conf.d/candela-harness.conf` 指向 `hub.rat.dev`；失败时回退候选源并在日志中提示 |
| rootless podman 需 subuid/subgid 与 linger | 安装器显式补齐并断言；`/run/user/<uid>` 用 tmpfiles.d 固化 |
| host 依赖 `@deepseek-ai/dsh@0.1.2-alpha.3` 需 npm 可达 | 复用部署期的 `NPM_REGISTRY`（npmmirror 已验证存在） |
| 生产 `ops/ai-workspace-sync.sh` 在本仓库名为 `scripts/ai-workspace-sync.sh` | 安装器用后者；两者命令契约一致（`init --from-release`） |
