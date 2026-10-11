# 验收记录：AI 工作区内容入仓与双向同步（ai_workspace，phase: clklog-ai-workspace-sync-v1）

- 日期：2026-09-16
- 帽子：项目（`docs/project/`）
- 环境：**生产** 生产主机，应用版本 **17213 → 17217 → 17218 → 17219**；broker 重启装载新路径校验
- 上游：PRD `docs/product/prd-clklog-ai-workspace-sync-v1.md`、实现方案 `docs/architecture/clklog-ai-workspace-sync-design-v1.md`
- 触发：用户要求「代码里加 `ai_workspace/default`、写双向同步脚本、把 `ai_workspace/app/clklogapp` 纳入同步、发版把 `ai_workspace/` 同步到目标机」，并要求做完后把运行时 workspace 同步回仓库

---

## 1. 结论

**通过。** 仓库与运行时现在**同构**（`ai_workspace/{default,app/<项目>}` 相对路径一一对应），`scripts/ai-workspace-sync.sh` 支持 `init/push/pull/diff/status/migrate`，发版链路把 `ai_workspace/` 带到目标机。生产完成了两处迁移（模板草稿、两个项目的空间目录），并按要求**把运行时内容拉回了仓库**。

## 2. 落地形态

| 仓库 | 运行时（`/home/harness/clklog-ai/`） | 谁在写 |
|---|---|---|
| `ai_workspace/default/` | `ai_workspace/default/` | 平台（模板草稿，`draftRoot()` 指向它）与开发（git） |
| `ai_workspace/app/<项目>/` | `ai_workspace/app/<项目>/`（容器内 `/workspace/app`） | AI 与人（运行时）；git 侧为同步副本 |

- 项目空间路径由 `workspaces/<哈希>/app` 改为 `ai_workspace/app/<项目名>`（可读、可 rsync 对拷）；隔离改由**项目名正则 + 服务端推导 + broker 形状校验 + 拒 symlink** 保证（旧的哈希布局被明确拒绝，broker 单测覆盖）。
- 模板草稿从 `initialization/draft` 搬到 `ai_workspace/default`（`versions/`、`policies` 原地不动）。

## 3. 端到端实测

| # | 动作 | 观察结果 |
|---|---|---|
| 1 | 发版（`server-upgrade.sh`）→ 自动 `init` | 检测到旧草稿并**先并入活内容**（15 → 15 个文件），再从发布产物补缺失；提示旧项目空间待迁移 |
| 2 | `migrate --projects clklogapp,default`（服务器 root） | 两个项目各自迁移；旧目录归档到 `ai_workspace/.migrated/<时间戳>/app/<项目>`；旧位置剩余 **0** |
| 3 | `init` 幂等复验 | init 前 20 个文件 → 后 20 个文件（内容未被改写） |
| 4 | 启动 runtime（项目 clklogapp） | 容器 `/workspace/app` 挂载源 = `ai_workspace/app/clklogapp`；容器内 `project.json` = 迁移过来的活版本 |
| 5 | 容器内写 `ai-note.md` → 本机 `pull app/clklogapp` | 文件回到仓库，内容一致（`AI 在项目空间里写的笔记`） |
| 6 | 仓库写 `dev-note.md` → 本机 `push app/clklogapp` | 服务器侧出现该文件（容器内同目录可见） |
| 7 | 运行时放 `mysql_password = SuperSecret123` → `pull` | **命中门禁，整批丢弃**：仓库零落地、暂存区已清理（见 §4 修复） |
| 8 | `diff --all` | 三个目标（default / app/clklogapp / app/default）全部「一致」 |
| 9 | 本机 ssh 模式 `status` | 仓库 11 文件 vs 运行时 15 文件（`default`）——直观看出运行时有 git 还没有的内容 |

## 4. 验收中发现并修复的脚本缺陷

| ID | 现象 | 根因与修复 |
|---|---|---|
| SY-01 | `migrate --projects clklogapp,default` 只处理了第一个项目 | `printf` 输出无末尾换行 + `tr` 转换后最后一行没有终止换行 → `while read` 跳过它。修复：补换行 + `read ... \|\| [ -n "$p" ]` 兜底 |
| SY-02 | `migrate` 报 rsync `syntax or usage error` | `cmd_migrate` 里 `local IFS=','` **泄漏**到后续 rsync：带逗号的 IFS 让 `$RSYNC_ARGS` 不再按空格拆词，整串被当成一个参数。修复：改用 `tr` 转行后逐行读，不动全局 IFS |
| SY-03 | 脚本在 macOS（bash 3.2）本地跑不起来；中文串里的 `$VAR` 被当成变量名一部分 | ① `mapfile`/`xargs -r`/`flock`/`sha256sum` 换成可移植写法（互斥用原子 `mkdir`，哈希用 `shasum` 回退）；② `$VAR` 紧跟中文标点会导致 `unbound variable`，统一改成 `${VAR}`（`--self-test` 会校验映射与密钥规则） |
| SY-04 | ssh 模式下密钥文件**已被复制进仓库**才被拦下 | 改为「先拉到本地暂存区 `.pull-staging/` → 扫描 → 干净才并入仓库」，命中即整批删除；`trap` 保证任何退出路径都清理暂存区 |

## 5. 把运行时 workspace 同步回仓库（用户要求的收尾）

| 内容 | 处理 |
|---|---|
| 运行时独有、git 里没有的文件 | 拉回并入库：`default/{SOUL.md,TOOLS.md}`、`default/files/notes/acceptance-probe.md`、`app/default/*`。产品背景文件已在公开前删除 |
| 仓库领先的内容 | 保留 git 版本：`default/AGENTS.md` 的「项目工作目录 app/」一节与 sql_chart 说明、`tools/{README.md,analysis-playbook.md}` 的「提案自动应用」语义 |
| 判断依据 | 运行时草稿与**已发布版本 3 逐文件一致**（平台自发布后未改过），而 git 里含 2026-09-09「提案自动应用」决策后的内容 → **git 领先** |
| 对齐 | 随后 `push --all` 让运行时草稿与仓库一致；`diff --all` 三个目标均「一致」 |
| 提交 | `3909153 chore(ai_workspace): 把运行时（程序真实写入）的 workspace 内容同步回仓库` |

> 注意：草稿对齐 ≠ 工作区生效。要让模型看到新说明需在平台「AI Workspace 模板」**发布新版本**（当前版本 1/2/3）。

## 6. 需求 → 证据矩阵

| 需求 | 证据 | 结论 |
|---|---|---|
| W-1 仓库三组目录 | `ai_workspace/{README.md,default/,app/clklogapp/}` 已入库（`--self-test` 校验同构） | ✅ |
| W-2 `init` 幂等、不覆盖 | §3-1/3 | ✅ |
| W-3 `push` 默认不删、`--delete` 需 `--yes`、`--dry-run` | 离线演练 + §3-6 | ✅ |
| W-4 `pull` 密钥门禁、默认不删 | §3-5/7 + 离线演练（私钥/凭据/个人信息/高熵四类正反例） | ✅ |
| W-5 `diff` 双向分类、退出码 | §3-8 + 多处演练 | ✅ |
| W-6 发版链路（打包/建目录/自动 init/迁移） | §3-1/2 | ✅ |
| W-7 运行时布局与权限、项目名校验、拒 symlink | 容器挂载源核对 + 后端与 broker 单测（项目名非法、旧哈希路径、symlink 全部拒绝） | ✅ |
| W-8 `--self-test` 离线自检 | 本地通过（含与后端常量一致性） | ✅ |
| W-9 双向端到端 + 留证 | §3 全表 + 本文件 | ✅ |

## 7. 收尾状态

| 项 | 状态 |
|---|---|
| 生产版本 | **17219**；harness `current` → `releases/17219` |
| 运行时 | `ai_workspace/default`（15 文件）、`ai_workspace/app/{clklogapp,default}`（各 2 文件）、`.migrated/` 2 份归档 |
| 旧位置 | `workspaces/<哈希>/app` 剩余 **0**；`initialization/draft` 保留未删（观察期后可人工删除） |
| 容器 / 临时账号 | 0 个容器；`zz_%` 临时账号 0、孤儿工作区 0 |
| 仓库 | 工作区干净，`ai_workspace/` 已入库并与运行时一致 |

## 8. 遗留

| 项 | 说明 |
|---|---|
| 模板发布 | 草稿已含「项目工作目录 `app/`」等新内容，需在平台发布新版本才进入新工作区（旧工作区仍用其 `applied_template_version`） |
| `initialization/draft` 旧目录 | 保留作回滚（改回 `draftRoot()`/`projectAppSegments()` 两处即可回退）；确认无误后人工删除 |
| 自动同步 | 本期不做定时/watch（PRD 非目标）；需要时由 cron 调 `init`（只补缺失）或人工 `push/pull` |
