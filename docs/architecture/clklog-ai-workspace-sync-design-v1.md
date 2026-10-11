# 架构设计：AI 工作区内容入仓与双向同步（ai_workspace）

- `phase: clklog-ai-workspace-sync-v1`
- 帽子：架构
- 配套 PRD：`docs/product/prd-clklog-ai-workspace-sync-v1.md`
- 验收记录：`docs/project/acceptance-clklog-ai-workspace-sync-v1.md`
- 实现状态：**已完成并上线**（生产 17219，2026-09-16）
- 关联：`clklog-ai-workspace-design-project-isolation-v1.md`（app = 项目空间）、`clklog-ai-workspace-design.md`（模板/工作区模型）

---

## 1. 现状：内容散在三处，开发看不见也改不了

| 内容 | 现在的物理位置 | 谁在写 | 问题 |
|---|---|---|---|
| 默认模板（代码种子） | `apps/analytics-harness-host/workspace-template/`（随发布产物到 `harness-host/`） | 开发（git） | 只是**种子**，运行时看不到后续变化 |
| 模板草稿 | `<root>/initialization/draft/` + `initialization/draft-policies.json` | **平台**（AI Workspace 模板界面） | 开发改不到、也拉不回仓库 |
| 已发布模板版本 | `<root>/initialization/versions/<n>`、`current` | 平台（发布动作） | 同上 |
| 项目空间 | `<root>/workspaces/<hash(项目)>/app/`（本 phase 刚上线） | **AI 与人**在运行时写 | 路径是哈希、人肉找不到；内容无法回仓库 |

结论：需要一份**与运行时同构的仓库目录** + 一个**双向同步脚本**，并且把运行时路径换成人类可读、可预期的方式。

## 2. 目标布局（仓库与运行时同构）

### 2.1 仓库（新增）

```
ai_workspace/
├── README.md                 # 用途、同步命令、红线（不放密钥）
├── default/                  # 默认工作区模板（原 apps/analytics-harness-host/workspace-template 迁入）
│   ├── AGENTS.md
│   ├── tools/ files/ …
└── app/
    └── clklogapp/            # 项目空间基线（容器内 /workspace/app）
        ├── project.json      # 租户标识（运行时自动生成，仓库里保留同名文件）
        └── README.md
```

### 2.2 运行时（`<harness root>` = `/home/harness/clklog-ai`）

```
ai_workspace/
├── default/                  # = 模板草稿（draftRoot() 指向这里；平台在此编辑/发布）
└── app/
    ├── clklogapp/            # 项目空间（容器内挂到 /workspace/app，0750 harness:harness）
    └── <其他项目>/            # 按需创建
initialization/               # 保留：versions/<n>、current(软链)、draft-policies.json
runtimes/ workspaces/ rt/ gateway/   # 不变（会话工作区仍是 workspaces/<项目哈希>/<用户>/…）
```

**为什么把 app 目录从 `workspaces/<hash(项目)>/app` 换成 `ai_workspace/app/<项目名>`**

- 可读、可 rsync 对拷：同步脚本不需要复刻哈希函数，仓库与运行时**相对路径 1:1**；
- 隔离性不靠哈希保证，而靠：项目名严格正则 + 服务端推导路径 + broker 形状校验（只接受 `<root>/ai_workspace/app/<该 runtime 的 project>/`，且拒 symlink）。这与现状安全性等价；
- 代价：一次迁移（见 §6），且项目名成了路径的一部分（因此必须校验字符集，禁止 `..`、`/`、空白）。

## 3. 同步脚本契约（`scripts/ai-workspace-sync.sh`）

### 3.1 命令

| 命令 | 方向 | 说明 |
|---|---|---|
| `init [--from-release <dir>]` | 仓库/发布产物 → 运行时 | 创建 `ai_workspace/{default,app/*}` 缺失目录与文件；**不覆盖已有内容**；服务器升级时自动调用 |
| `push [target…] [--delete] [--dry-run]` | 仓库 → 运行时 | `target` ∈ `default`、`app/<项目>`、`--all`（默认 `--all`）；只覆盖仓库有的文件 |
| `pull [target…] [--delete] [--dry-run] [--allow-secrets]` | 运行时 → 仓库 | 先密钥扫描；默认不删仓库独有文件 |
| `diff [target…]` | 双向只读 | 分类输出：`仅仓库有` / `仅运行时有` / `内容不同`；有差异退出码 1 |
| `migrate` | 一次性 | 旧路径 → 新布局（见 §6），带备份 |
| `status` | 只读 | 打印两处根、各目标文件数/大小、模板草稿与已发布版本的差异数、最近一次同步记录 |
| `--self-test` | 离线 | 校验映射/忽略/密钥规则（不需要网络与服务器） |

### 3.2 同步实现（as-built 关键点）

- **pull 采用「先暂存后合并」**：运行时 → `ai_workspace/.pull-staging/<目标>`（本地）→ 密钥扫描 → 干净才并入仓库，
  命中即整批删除。这样 ssh 模式下密钥文件**绝不会**先落进仓库再被拦（验收 SY-04）。
- 互斥用运行时根下原子 `mkdir`（macOS 无 `flock`）；`trap` 保证任何退出路径都清理暂存区与锁。
- 脚本按 bash 3.2 可移植编写（不用 `mapfile`/`xargs -r`/`sha256sum`），macOS 本地可直接跑。
- 中文串里紧贴 `$VAR` 会被 shell 当成变量名一部分（`unbound variable`）——统一写 `${VAR}`（SY-03）。

### 3.2.1 同步实现（原设计描述）

- 传输用 `rsync -a --itemize-changes`（脚本在服务器上跑时是本地拷贝；开发机在本地跑时走隧道 `-e "ssh -p 2223"` 直连同一路径）。
- 排除规则（`--exclude`，同时作用于两个方向）：`.DS_Store`、`*.swp`、`*~`、`node_modules/`、`.cache/`、`*.log`、`*.sock`、`.git/`、单文件 > 20 MB（可 `--max-size` 调）。
- **删除语义**：默认 `--ignore-existing`-style（只增改不删）；`--delete` 才让目标端与源端一致，且**必须** `--yes` 二次确认（避免误删 AI 产出）。
- **备份**：`push --delete` 与 `pull` 前，把目标侧将被改写的文件复制到 `<root>/ai_workspace/.sync-backup/<时间戳>/`（保留最近 10 份）。
- **并发**：脚本用 `flock` 串行化（同一台机器上禁止两个同步同时跑）。
- **服务端触发**：`init` 由 `server-upgrade.sh` 调用；`push`/`pull` 由人显式执行，`status` 记录写入 `<root>/ai_workspace/.sync-state.json`（时间、方向、目标、文件数）。

### 3.3 密钥与隐私门禁（红线 3、6）

`pull` 写仓库前扫描**待写入文件**，命中任一条即**整体拒绝**并列出文件与行号（需 `--allow-secrets` 显式放行，放行会在状态文件里记录并在输出中高亮）：

| 规则 | 例子 |
|---|---|
| 私钥/证书块 | `-----BEGIN (RSA |OPENSSH |EC |PGP )?PRIVATE KEY-----` |
| 常见凭据赋值 | `(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*\S{6,}` |
| 环境文件 | 文件名匹配 `.env*`、`*.pem`、`*.key`、`credentials*` |
| 高熵长串 | 连续 `[A-Za-z0-9_\-]{40,}`（base64/hex 形态）且不在白名单扩展名内 |
| 个人信息 | 中国大陆手机号、18 位身份证号（app 目录里可能有业务数据） |

- `push` 方向同样扫描**仓库待发送文件**（防止把已误提交的密钥推上服务器）。
- 白名单：`ai_workspace/default/tools/`（已是平台工具文档）与显式 `--allow-pattern` 参数。

## 4. 发版与部署集成

| 环节 | 改动 |
|---|---|
| `scripts/build.sh` | 把 `ai_workspace/` 复制进发布产物根（与 `server/`、`web/` 同级）；不再单独打包 `harness-host/workspace-template`（内容已并入 `ai_workspace/default`） |
| `scripts/install-harness-runtime.sh` | 目标机创建 `<root>/ai_workspace/{,app}`（0700/0750）+ 首次从发布产物 `init`；若 `initialization/draft` 存在且 `ai_workspace/default` 不存在 → 调 `migrate` |
| `scripts/server-upgrade.sh` | rsync 后调用 `ai-workspace-sync.sh init --from-release <release>`（幂等、不覆盖） |
| 服务端代码 | `draftRoot()` → `<root>/ai_workspace/default`；`copyCodeTemplate` 的候选路径改为发布产物里的 `ai_workspace/default`；`projectAppSegments()` → `['ai_workspace','app',<项目名>]` |
| broker | `projectAppDirectory()` 期望路径改为 `<root>/ai_workspace/app/<项目名>`，并新增项目名正则校验 |
| 平台 UI | 无需改动（模板界面读的是 `draftRoot()`，路径变化透明） |

## 5. 双向同步的冲突模型（显式、可预期）

- **不自动合并**。`push` = 仓库版本胜；`pull` = 运行时版本胜。
- 推荐工作流：`diff` 看差异 → `push --dry-run` / `pull --dry-run` → 再执行；`pull` 后先 `git diff` 复核再提交。
- `default` 的双写风险（平台 UI 与 git 同时改草稿）：同步前 `status` 会给出「草稿 vs 最近一次同步」的差异文件数；`push` 默认**要求**工作副本干净（`git status --porcelain` 无未提交改动）或显式 `--force`，避免把未提交的改动推上服务器后又被 `pull` 覆盖而丢失。
- 已发布版本（`versions/<n>`、`current`）**不同步**：发布是平台动作，避免 git 推代码即改动所有工作区。

## 6. 迁移（一次性，可回滚）

| 旧 | 新 | 动作 |
|---|---|---|
| `<root>/initialization/draft/**` | `<root>/ai_workspace/default/**` | 复制（不删旧目录）→ 校验文件数与关键文件一致 → 改写 `draftRoot()` 生效 → 观察一段时间后由人删除旧目录 |
| `<root>/initialization/draft-policies.json` | 原地保留（仍是 `initialization/`） | 不动（减少改动面） |
| `<root>/workspaces/<hash(项目)>/app/**` | `<root>/ai_workspace/app/<项目名>/**` | 复制 → 校验 → 新路径生效 → 旧目录保留 `<root>/ai_workspace/.migrated/<时间戳>/` 归档 |
| 哈希目录里的会话工作区 | 不动 | 仍由平台按 `workspaces/<项目哈希>/<用户>/…` 管理 |

回滚：把 `draftRoot()`/`projectAppSegments()` 两个函数改回旧值即可（内容在新旧两处都在）。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| `pull` 把业务数据/个人信息带进 git | §3.3 密钥+隐私扫描默认拦截；`app/` 目录在仓库里默认只保留基线文件（`project.json`、`README.md`），并允许 `.gitignore` 局部排除大文件 |
| `push` 覆盖 AI 在生产里积累的成果 | 默认不删；`--delete` 需 `--yes`；执行前自动备份到 `.sync-backup/` |
| 平台与 git 同时改草稿导致互相覆盖 | `status` 显示双写差异；`push` 要求工作副本干净；发布仍是平台动作 |
| 项目名进入路径带来注入风险 | 项目名正则 `^[a-z0-9][a-z0-9_-]{0,63}$` + 服务端推导 + broker 形状校验 + 拒 symlink（与现有守门同级） |
| 迁移丢数据 | 复制而非移动 + 校验 + 归档 + 两个函数即可回滚 |
| 同步脚本成为第二套路径真相 | 路径只在 `scripts/ai-workspace-sync.sh` 顶部的 CONFIG 块与后端两处常量里定义，并加一致性自检（`--self-test` 校验两者一致，且与 `--self-test` 的期望布局一致） |

## 8. 实施拆解

1. `ai_workspace/`：建目录、迁入 `workspace-template/` 内容、写 `README.md` 与 `.gitignore` 约定、加 `app/clklogapp/` 基线。
2. 后端：`draftRoot()`、`copyCodeTemplate` 候选路径、`projectAppSegments()`（改项目名路径 + 正则）；`ensureRoot()` 建 `ai_workspace/{,app}`。
3. broker：`projectAppDirectory()` 期望路径 + 项目名校验；补单测（形状/注入/symlink）。
4. `scripts/ai-workspace-sync.sh`：init/push/pull/diff/migrate/status + 忽略与密钥规则 + `--self-test`；本机与服务器两种运行方式。
5. 发版链路：`build.sh` 打包、`install-harness-runtime.sh` 建目录与首迁、`server-upgrade.sh` 调 `init`；生产执行迁移并验收（W-9 双向各一次）。

## 9. 验收与测试

| 层 | 用例 |
|---|---|
| 脚本自检 | `--self-test`：映射规则、忽略规则、密钥规则（正反例）、后端常量一致性 |
| 后端单测 | `projectAppSegments` 项目名正则/拒绝非法名；`draftRoot` 路径；migration 复制与校验逻辑（临时目录） |
| broker 单测 | 新形状通过；旧哈希路径/别的项目/`../`/symlink 拒绝 |
| 端到端（生产） | ① 本地改 `ai_workspace/default/AGENTS.md` → `push default` → `status` 显示草稿已变 → 平台界面可见；② 容器内写 `app/clklogapp/x.md` → `pull app/clklogapp` → 仓库出现该文件；③ 故意放一个假 `password=...` 文件 → `pull` 被拦；④ `init` 重复执行不改内容 |
