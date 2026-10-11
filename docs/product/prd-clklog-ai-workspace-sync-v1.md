# PRD：AI 工作区内容入仓与双向同步（ai_workspace）

- `phase: clklog-ai-workspace-sync-v1`
- 帽子：产品
- 上游：`docs/architecture/clklog-ai-workspace-design-project-isolation-v1.md`（app 目录 = 项目空间）、`docs/architecture/clklog-ai-workspace-design.md`（模板与工作区）
- 触发：用户要求「代码里加 `ai_workspace/default`；写脚本在仓库与程序真实写入的目录之间做**双向同步**；并把 `ai_workspace/app/clklogapp`（项目空间）纳入同步；**发版要把 `ai_workspace/` 同步到目标机**」

---

## 1. 阶段目标与范围（门禁要素①）

把「AI 工作区的内容」从三处分散的运行时目录，收拢成**一份 git 可见的 `ai_workspace/`**，并提供双向同步脚本，让开发能在本地改、能快速拉回平台与 AI 的产出，发版时自然带到目标机。

范围：

| 内容 | 仓库位置 | 运行时位置 | 谁在写 |
|---|---|---|---|
| 默认工作区模板 | `ai_workspace/default/` | `<harness root>/ai_workspace/default/`（= 模板草稿） | 平台（模板编辑/发布）与开发（git） |
| 项目空间（每项目一份） | `ai_workspace/app/<项目名>/` | `<harness root>/ai_workspace/app/<项目名>/`（容器内 `/workspace/app`） | AI 与人在运行时写入；开发可回拉 |

- **仓库与运行时同构**（相对路径一一对应），因此同步脚本不依赖任何哈希映射。
- 发版产物包含 `ai_workspace/`；服务器升级时执行 `init`（幂等、**不覆盖**运行时已有内容）。
- 同步语义显式：`push` = 仓库→运行时（默认不删运行时独有的文件）；`pull` = 运行时→仓库（默认不删仓库独有文件，且必须先过密钥扫描）。

## 2. 验收标准（门禁要素②）

- [x] **W-1**：仓库根存在 `ai_workspace/README.md`、`ai_workspace/default/`（默认模板内容）、`ai_workspace/app/clklogapp/`（项目空间）；`default/` 与运行时模板草稿**同构**（同名同层级）。
- [x] **W-2**：`scripts/ai-workspace-sync.sh init`（服务器上执行）按需创建运行时布局与缺失的项目空间；**已存在的目录与文件内容不被改写**；重复执行结果稳定。
- [x] **W-3**：`push [default|app/<项目>|--all]` 把仓库内容同步到运行时；默认**不删除**运行时独有的文件；`--delete` 才删除；`--dry-run` 只列动作。
- [x] **W-4**：`pull [default|app/<项目>|--all]` 把运行时内容同步回仓库；**先做密钥/隐私扫描**，命中私钥、`password=`/`token=`/`secret=` 赋值、`.env` 等模式时**拒绝写入并列出文件**，需显式 `--allow-secrets` 才能继续；默认不删除仓库独有文件。
- [x] **W-5**：`diff` 双向列出差异并分类（仅仓库有 / 仅运行时有 / 内容不同），退出码可用于 CI。
- [x] **W-6**：发版链路到位——`build.sh` 把 `ai_workspace/` 打进发布产物；`server-upgrade.sh` 调用 `init`；**首次部署自动迁移**旧路径（`initialization/draft` → `ai_workspace/default`；`workspaces/<哈希>/app` → `ai_workspace/app/<项目>`），迁移前留备份，失败可回滚。
- [x] **W-7**：运行时布局与权限正确——`ai_workspace/default` 为模板草稿（平台可写），`ai_workspace/app/<项目>` 权限 0750 属主 harness，**项目名严格校验**（`^[a-z0-9][a-z0-9_-]{0,63}$`），路径由服务端推导、broker 形状校验，符号链接拒绝。
- [x] **W-8**：同步脚本自带 `--self-test`（离线校验映射规则、忽略规则、密钥规则），可在 CI 或本地无网络运行。
- [x] **W-9**：端到端验收——一条命令完成「本地改 → 推上服务器 → 容器内可见」与「AI 写入 → 拉回仓库（密钥被拦或放行）」两个方向，并留证。

## 3. 非目标（门禁要素③）

- 不做自动双向合并（无三方合并、无冲突自动解）；`push`/`pull` 都是「单向覆盖 + 默认不删」的显式动作。
- 不做实时/定时双向同步（无 watch、无 cron）；要自动化请显式加任务。
- 不做 Web 端内容编辑器（模板编辑仍走既有「AI Workspace 模板」界面）。
- 不自动发布模板版本：`push` 只改草稿，**发布**仍是平台动作（避免推代码意外影响所有工作区）。
- 不同步运行时数据：`runtimes/`、会话工作区（`workspaces/<项目>/<用户>/…`）、`rt/`、`gateway/` 一律不碰。
- 不允许把 A 项目的 `app/` 推给 B 项目（同步单元按项目名隔离）。

---

## 4. 用户可见行为

| 场景 | 行为 |
|---|---|
| 开发改模板 | 改 `ai_workspace/default/…` → `push default` → 平台上「模板」页看到草稿变化 → 需要时发布 |
| 平台改模板 | 平台上编辑草稿 → `pull default` → 仓库里看到 diff（含密钥会**被拦下**） |
| AI/人在项目空间产出 | 容器内 `/workspace/app/…` 写入 → 宿主机 `ai_workspace/app/clklogapp/…` 可见 → `pull app/clklogapp` 回仓库 |
| 首次部署 | 老目录自动迁移到新布局，旧内容不丢（有备份） |
| 发版 | 新内容（模板/项目空间基线）随发布产物到目标机，`init` 只补缺失、不改运行时已有内容 |
