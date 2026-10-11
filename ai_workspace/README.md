# ai_workspace —— AI 工作区内容（入仓 + 双向同步）

本目录是「AI 工作区内容」在代码里的真源，与目标机运行时**同构**（相对路径一一对应），
由 `scripts/ai-workspace-sync.sh` 做双向同步。

| 仓库 | 运行时（`/home/harness/clklog-ai/`） | 说明 |
|---|---|---|
| `ai_workspace/default/` | `ai_workspace/default/` | 默认工作区模板（= 平台「AI Workspace 模板」的草稿，平台也会写它） |
| `ai_workspace/app/<项目>/` | `ai_workspace/app/<项目>/` | 项目空间：容器内挂到 `/workspace/app`，同项目成员共享 |

## 常用命令

```bash
# 本地（走隧道，默认 -p 2223 root@localhost）
bash scripts/ai-workspace-sync.sh diff                 # 双向差异（只读）
bash scripts/ai-workspace-sync.sh push default         # 仓库 → 运行时（默认不删运行时独有文件）
bash scripts/ai-workspace-sync.sh pull app/clklogapp   # 运行时 → 仓库（先过密钥扫描）
bash scripts/ai-workspace-sync.sh status               # 两处根、文件数、最近同步记录

# 服务器上（发版时自动调用）
ops/ai-workspace-sync.sh init --from-release /data/project/clklog_manager/production
```

## 约定与红线

- **不放密钥**：任何 token、口令、私钥、`.env` 都不进这里；`pull` 会做密钥/隐私扫描，命中即整体拒绝
  （确需放行用 `--allow-secrets`，会被记录）。
- **不自动合并**：`push` = 仓库版本胜，`pull` = 运行时版本胜；先 `diff`/`--dry-run` 看一眼再执行。
- **默认不删除**：两个方向都只增改；要删必须 `--delete`（并会先备份到运行时 `ai_workspace/.sync-backup/`）。
- **发布是平台动作**：`push default` 只改「草稿」，不会影响已发布的工作区；要生效请在平台上发布新版本。
- 会话工作区（`workspaces/<项目哈希>/<用户>/…`）、`runtimes/`、`rt/`、`gateway/` **不在同步范围**。
