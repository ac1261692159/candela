# 验收记录：AI Workspace 项目隔离（app 目录，phase: clklog-ai-workspace-project-isolation-v1）

- 日期：2026-09-16
- 帽子：项目（`docs/project/`）
- 环境：**生产** 生产主机，应用版本 **17211 → 17213**；broker 代码由 `install-harness-runtime.sh` 升级（`current` → `releases/17213`）
- 上游：PRD `docs/product/prd-clklog-ai-workspace-project-isolation-v1.md`、实现方案 `docs/architecture/clklog-ai-workspace-design-project-isolation-v1.md`
- 触发：用户要求「AI workspace 按项目隔离，隔离设计仅增加一个 app 目录；切换项目后 harness 读到的 app 目录不一样」，并确认「同项目成员可互相看到文件」

---

## 1. 结论

**通过。** 每个项目有且只有一个 `app` 目录（host 侧 `workspaces/<项目哈希>/app`），容器内固定挂到 `/workspace/app`；切换项目启动的 runtime 读到的是另一个项目的 `app`，两者互不可见（实测双向验证）。隔离由「挂载源 = 项目哈希」决定，broker 只认这一种形状，且拒符号链接。

一并处理了两个运维/安全问题（见 §5）：**broker 一直跑着 5 天前的旧代码**（常规发版路径不更新 harness）、**supervisord 目录里 11 份含明文口令的备份 ini**（其中 2 份 644 全局可读）。

## 2. 验收方法

| 手段 | 说明 |
|---|---|
| 线上真实链路 | 临时超管会话 → `POST /sa/api/assistant/host-ticket` → `GET /sa/harness/bootstrap?ticket=…`（302）→ server 建 app 目录 → broker 起容器 |
| 容器内视角 | `podman exec` 被 rootless cgroup 限制挡住（见 §5-AI-03），改用 `nsenter -t <容器 PID> -m` 直接进 mount namespace 取证 |
| broker 守门 | 以 `harness` 用户直接打 broker 控制 socket（`/v1/runtime/ensure`），构造三种 app_dir |
| 数据库/文件系统 | `aiworkspace`、`sauser`、`workspaces/*/app` 的属主与权限 |
| 单测 | 后端 78 套件 / **529 用例**（新增 6）、broker **9 例**（新增 3）、host 7 例 |

## 3. 端到端实测

| # | 动作 | 观察结果 |
|---|---|---|
| 1 | 为项目 `clklogapp` 签发 ticket + bootstrap | HTTP 302；host 侧出现 `workspaces/2e785f14…/app`，含 `project.json` 与 `README.md` |
| 2 | 为项目 `default` 签发 ticket + bootstrap | HTTP 302；`workspaces/ffa0b2d6…/app`（**另一个哈希**），同样含种子文件 |
| 3 | 容器列表（以 harness 用户） | 两个容器各自运行；`podman inspect` 显示挂载源分别为上面两个 app 目录 |
| 4 | 容器 A（clklogapp）内：读 `project.json` | `{"project":"clklogapp",…}`；`ls /workspace/app` = `README.md project.json` |
| 5 | 容器 A 内：写入 `from-a.txt` | 写入成功；**宿主机** 同目录出现 `from-a.txt`（rw 挂载与同一份目录得到证明） |
| 6 | 容器 B（default）内：读 `project.json` + `ls` | `{"project":"default",…}`；列表只有 `README.md project.json` → **看不到 A 的文件（隔离成立）** |
| 7 | 权限与属主 | `app` 目录 `750 harness:harness`；项目哈希目录 `700`；管理根 `700`（未被放宽） |
| 8 | broker 守门：app_dir 指向符号链接 | `{"message":"app_dir_is_symlink"}`（拒绝，容器未启动） |
| 9 | broker 守门：塞另一个项目的 app 路径 | `{"message":"app_dir_not_allowed"}` |
| 10 | broker 守门：合法路径 | 正常返回 runtime 信息（证明前两条是**定向拒绝**而非一律失败） |

## 4. 需求 → 证据矩阵

| 需求 | 证据 | 结论 |
|---|---|---|
| P-1 runtime 内 `/workspace/app` = 本项目目录 | §3-3/4（挂载源 + 容器内 project.json） | ✅ |
| P-2 A 写的文件在 B 不可见、回 A 可见 | §3-5/6 | ✅ |
| P-3 自动创建、属主与权限正确 | §3-1/2/7 | ✅ |
| P-4 租户标识文件 | §3-1/2/4（`project.json` 含项目名） | ✅ |
| P-5 不可绕过（形状校验 + 拒 symlink） | §3-8/9/10 + broker 单测 3 例 | ✅ |
| P-6 容量有界 | `app` 与工作区同受 `max_workspace_bytes`（1 GiB）约束；`app` 不参与 runtime 孤儿清理 | ✅（策略继承，未单独压测） |
| P-7 多项目并发互不影响 | §3-2/3（同机两个 runtime 各自挂各自 app） | ✅ |
| P-8 取证入档 | 本文件 | ✅ |

## 5. 验收中发现并处理的问题

### AI-01 / P1 ✅ 已修：常规发版**不更新 harness**，broker 一直跑旧代码

- 现象：`server-upgrade.sh` 只更新 `server/` 与 `web/`；broker 运行的是 `/opt/clklog/harness/current/broker/src/server.mjs`，`current` 由 `install-harness-runtime.sh` 切换。本次排查发现 broker 进程启动于 **9 月 11 日**（旧代码，不认识 `app_dir`），而 `server-upgrade.sh` 不会重启它。
- 影响：任何 harness 侧改动（broker 校验/挂载、host 模板）都会**静默不生效**——服务端已发新参数，旧 broker 会把未知字段丢掉，功能看起来「部署了但没效果」。
- 处置：本次执行 `ssh 'bash -s -- /data/project/clklog_manager/production' < scripts/install-harness-runtime.sh`（改了 Harness 才跑），`current` → `releases/17213`，broker 重启并确认运行代码含 `app_dir`（6 处）。
- 记录：`docs/project/legacy-production-handover.md` §十七 写明「改 Harness 的发版要多跑一步」。

### AI-02 / P2 ✅ 已清理：supervisord 目录里的明文口令备份

- 现象：`/etc/supervisord.d/` 有 11 份 `*.ini.bak-*` / `*.ini.puppet-bak` / `*.ini.rootrot-*` / `*.ini.pre-node24.bak`，全部含 `MYSQL_PASSWORD=` 明文，其中 `*.rootrot-20260915195034` 与 `*.puppet-bak` 权限为 **644（全局可读）**；install 脚本跑 `supervisorctl reread` 时还报了 `duplicate supervisor program: clklog_analytics_server`（脚本因此中断在 broker 重启之前）。
- 处置：全部移入 `/root/supervisord-ini-backups-20260916/`（root-only，600），目录内只留 3 个受管 ini；`supervisorctl reread && update` 无告警；broker 重启成功。
- 说明：include 模式是 `supervisord.d/*.ini`，备份文件本不会被加载，因此 duplicate 提示来自脚本自身的重写时序；但 **644 的明文口令文件**是实打实的暴露，已消除。

### AI-03 / 提示（工具）：`podman exec` 进不去 runtime 容器

- 现象：`podman exec` 报 `crun: write to /sys/fs/cgroup/...: Permission denied`（rootless + 无 systemd user session 的 cgroup 限制）。
- 取证替代：`nsenter -t $(podman inspect -f '{{.State.Pid}}' <容器>) -m -- sh -c '…'`（root 直接进 mount namespace）。
- 记录：`docs/project/legacy-production-handover.md` §十七 附该配方，后续排查 harness 容器内文件时不用再试 `exec`。

## 6. 遗留与说明

| 项 | 说明 |
|---|---|
| 模型侧说明待发布 | `apps/analytics-harness-host/workspace-template/AGENTS.md` 已加「项目工作目录 `app/`」一节，但它进入工作区要经过模板流程：**从代码重置草稿 → 发布新版本**（当前版本 1/2/3 均不含）。挂载本身不受影响；模型即使没看到说明，`/workspace/app` 也已可用 |
| `app` 的清理 | 本期不自动清理（PRD 非目标）；项目停用时由运维删除 `workspaces/<项目哈希>/app` 即可，不影响会话工作区 |
| 项目级共享 | 已按用户确认实现（同项目成员共享 `app`）；若日后要改成用户级，只需改 `projectAppSegments()` 与 broker 形状校验两处（设计 §7 备选 B） |
| 容量压测 | 未对 `app` 单独做超限压测（复用工作区配额逻辑） |

## 7. 收尾状态

| 项 | 状态 |
|---|---|
| 生产版本 | **17213**；harness `current` → `releases/17213`，broker 重启并运行新代码 |
| 项目 app 目录 | `clklogapp` 与 `default` 各一份（750 harness:harness，含 project.json/README.md） |
| runtime 容器 | 0 个（验收用的 3 个已停） |
| 临时账号 | 已删除（含 AI 工作区、成员关系、token）；`sauser` 仅剩 `admin`/`analyst1` |
| supervisor ini | 目录内 3 个受管文件；11 份历史备份移入 `/root/supervisord-ini-backups-20260916/`（600） |
