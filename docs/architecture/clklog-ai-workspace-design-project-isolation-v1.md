# 架构设计：AI Workspace 按项目隔离（app 目录）

- `phase: clklog-ai-workspace-project-isolation-v1`
- 帽子：架构
- 配套 PRD：`docs/product/prd-clklog-ai-workspace-project-isolation-v1.md`
- 验收记录：`docs/project/acceptance-clklog-ai-workspace-project-isolation-v1.md`
- 实现状态：**已完成并上线**（生产 17213；harness `current` → `releases/17213`）
- 上游事实来源：`docs/architecture/clklog-ai-workspace-design.md`、`apps/analytics-harness-broker/src/server.mjs`、`apps/analytics-server/src/modules/ai-assistant/workspace/workspace-paths.service.ts`

---

## 1. 现状（隔离已经做到哪一步）

harness 运行时根目录 `/home/harness/clklog-ai`，五类子目录，**项目维度已经存在**：

```
/home/harness/clklog-ai/
├── initialization/                       # 平台级模板（全局共享，无项目维度）
├── runtimes/<hash(user)>/<hash(project)>/# 每 (用户,项目) 的 dsh-home、instances
│   ├── dsh-home/
│   └── instances/
├── workspaces/<hash(project)>/<hash(user)>/<kind>/<workspaceId>/   # 会话工作区（容器内 /workspace）
│   ├── .clklog/…                         # 控制面（只读挂载）
│   └── …会话产物
├── rt/<runtimeId>/{runtime.sock,ready.json,runtime-spec.json}
└── gateway/{control,runtime}/
```

已经带项目维度的还有：`AiWorkspace.project_name`（唯一键含 project）、runtimeKey = `userId\0project\0tabId`、
broker 的 `/v1/runtime/ensure` body 里的 `project_name`、工具层强制注入 project（模型传的 `dsl.project` 被删除）。

**仍然全局共享的是**：`initialization/` 模板；`max_runtimes` 计数；gateway/broker 的固定 socket 路径。

**缺口**：会话工作区是「每 (项目, 用户, 会话)」的，**项目级共享的工作目录不存在**——这就是本次要补的 `app`。

## 2. 目标形态：只加一个目录

```
/home/harness/clklog-ai/workspaces/
├── <hash(projectA)>/
│   ├── app/                              ← 新增：项目 A 的独立目录（唯一新增物）
│   │   ├── project.json                  # {"project":"clklogapp"}（人与模型都能确认租户）
│   │   ├── README.md                     # 用途说明
│   │   └── …（AI 与人在该项目下的持久文件）
│   └── <hash(user)>/<kind>/<workspaceId>/ # 既有会话工作区，不动
└── <hash(projectB)>/app/                  ← 项目 B 的另一份
```

容器视图（每个 runtime 一份，**同一路径 `/workspace/app`，内容随项目变**）：

```
/workspace          ← 会话工作区（既有，rw）
├── app             ← 本项目 app（新增，rw，bind 自 workspaces/<该项目的 hash>/app）
├── .clklog         ← 控制面（既有，ro）
└── …managed 只读项（既有）
```

> 为什么挂在 `/workspace/app` 而不是容器根 `/app`：模型的工作目录就是 `/workspace`（`--workdir=/workspace`），
> 相对路径 `app/…` 直接可达；且 `.clklog`、managed 只读项都在同一层级，语义一致。

## 3. 生命周期与创建

| 环节 | 行为 |
|---|---|
| 创建时机 | **服务端真正拉起 runtime 时**惰性创建（`HarnessRuntimeManagerService.createRuntime` 与复活路径 `ensureBrokerRuntime`，两处都调 `ensureProjectAppDirectory`）。设计初稿写在「签发 host-ticket 时」，实现放在更靠近使用的一步：签了 ticket 不一定真启动，避免为空项目留空目录；复活路径同样创建，可自愈人工误删 |
| 属主/权限 | 属主 = harness 运行用户（既有 `systemUser()` 解析），目录 `0750`（同项目成员共享，其他系统用户不可读） |
| 幂等 | `mkdir -p` + 校正属主权限；已存在则只校验不覆盖 |
| 种子文件 | 首次创建写 `project.json`（项目名 + 创建时间）与 `README.md`；已存在则不覆盖（允许用户/AI 修改） |
| 校验 | 创建后 `realpath(app)` 必须等于「**规范化根** + 分层」的路径（比较基准是 `realpath(root)`——根本身可能是符号链接，如 macOS 的 `/tmp` 或被软链的 home）；目录本身是 symlink 时直接拒绝 |
| 清理 | 项目停用/删除时由运维显式清理（PRD 非目标）；broker 的 30s 配额扫描与容器孤儿清理**不触碰** `app`（它不是 runtime） |

## 4. 挂载与校验（安全边界）

### 4.1 传递路径

```
前端 x-project-name
  → project.interceptor        （已有：body/query/header 取 project，缺省 clklogapp）
  → HarnessRuntimeManagerService.issueHostTicket  （已有：按 project 建/取 workspace）
     + 新增：ensureProjectAppDir(project) → 返回 appDir（host 绝对路径）
  → POST /v1/runtime/ensure { user_id, project_name, workspace_id, kind, app_dir }   ← app_dir 为新增字段
  → broker.ensureNow：校验 appDir 形状后追加一条 bind mount
  → 容器内 /workspace/app
```

### 4.2 broker 侧挂载

在现有挂载列表后追加一条：

```js
'--mount', mount(projectAppDir, '/workspace/app', false),   // rw
```

- 顺序放在 `--mount workspaceRoot:/workspace` **之后**，保证子路径覆盖（podman 按挂载声明顺序处理嵌套挂载，子路径挂载需在父挂载之后）。
- 仍受全局约束：`--read-only` 根文件系统 + 该挂载是唯一新增可写点（与 `/workspace`、`/dsh-home` 同级）。

### 4.3 路径校验（**不放宽现有白名单**）

现有 `pathWithoutLinks()` 只允许 workspaceRoot 内路径。新增一条**独立、精确**的规则：

```js
// 允许的唯一额外挂载：<root>/workspaces/<hash(project)>/app
function assertProjectAppDir(config, project, candidate) {
  if (typeof candidate !== 'string' || !candidate.startsWith('/')) throw new Error('app_dir_invalid');
  const expected = within(config.root, join(config.root, 'workspaces', hash('project', project), 'app'));
  if (candidate !== expected) throw new Error('app_dir_not_allowed');   // 只接受这一种形状
  return expected;
}
```

再对 `expected` 做与工作区同样的强校验：`realpath === expected`（拒绝 symlink）、存在性、属主为该 harness uid、`mkdir` 只允许服务端做（broker 只校验，不创建，避免 broker 成为路径策略的第二真相源）。

> 设计红线：**不把白名单放宽成「workspaces/ 下任意路径」**，否则一旦 upstream 被污染就能挂载别的项目目录。只认「`hash(当前 runtime 的 project)` + `app`」这一种形状。

### 4.4 隔离证明（为什么跨项目不可见）

- 挂载源由 `hash(project)` 决定，而 runtime 的 `project` 来自 ticket（ticket 绑定用户与项目，proxy 三重校验项目）；
- 一次 runtime 只挂一个 `app`，容器内没有任何指向其他项目的路径；
- `--network=none`，没有旁路；
- 会话工作区与 `app` 是**两个独立挂载**，删掉会话工作区不影响 `app`，反之亦然。

## 5. 容量与配额

| 项 | 处理 |
|---|---|
| 用量统计 | 现有 `workspaceUsage(workspaceRoot)` 只算会话工作区 → 新增对 `app` 的统计，或在 ensure 时把 `app` 用量并入「项目用量」 |
| 上限 | 复用 `max_workspace_bytes`（默认 2 GiB）语义：**按项目累计**（会话工作区 + app）超限时 ensure 失败并给出可读原因 |
| 单文件 | 沿用 `--ulimit fsize`（按挂载无法分别设限；`app` 内单文件同样受该值约束） |
| 增长治理 | 记录 `app` 用量到 `hostmetricsample`/审计（可选项，便于运维观察） |

## 6. 与既有能力的关系

| 能力 | 是否受影响 |
|---|---|
| `dsh-home`（每 user×project） | 不变 |
| 会话工作区（每 project×user×session） | 不变 |
| `initialization/` 模板 | 不变（非目标：不做每项目模板） |
| `max_runtimes` 全局计数 | 不变（非目标：不做每项目配额） |
| gateway / proxy 的项目校验 | 不变，继续作为第一道闸 |
| 工具层强制 project | 不变；`app` 只是文件系统侧的同项目落点 |

## 7. 备选与取舍

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A（本设计）** | `workspaces/<项目>/app`，项目级共享，容器内 `/workspace/app` | 满足「只加一个目录 + 项目独立」；同项目成员共享 |
| B | `workspaces/<项目>/<用户>/app` | 隔离更细（用户级），但与用户要求「项目独立」不符；且路径多一层，用户看不到「切项目即切换目录」的效果 |
| C | 直接把整个会话工作区改成项目级 | 破坏「每会话一份产物」的既有模型与回收策略，影响面大 |
| D | 用一个新卷/新根目录 `apps/<项目>` | 需要新增挂载白名单根与配额逻辑，超出「只加一个目录」的约束 |

> 若日后要切到 B（用户级），改动只在两处：路径规则（`workspace-paths.service` 的 `projectAppDir`）与 broker 的形状校验；挂载点与容器视图不变。这是本设计刻意保留的「一个开关」。

## 8. 验收与测试

| 层 | 用例 |
|---|---|
| 单测（server） | `ensureProjectAppDir`：路径形状、幂等、权限校正、symlink 拒绝、跨项目 hash 不同 |
| 单测（broker） | `assertProjectAppDir`：合法形状通过；`../`、绝对路径注入、别的项目 hash、symlink → 全部 `app_dir_*` 错误码 |
| 端到端（生产） | P-1~P-3：A 写文件 → B 不可见 → 回 A 可见；权限与属主核验；`project.json` 内容与当前项目一致 |
| as-built 补充 | 单测落在 `workspace-paths.service.spec.ts`（6 例：分层哈希、首次创建种子、幂等不覆盖、拒 symlink、拒占位文件、两项目互不影响）与 broker `server.test.mjs`（3 例：只认项目形状、拒 symlink、payload 透传）；模型侧说明写在 `apps/analytics-harness-host/workspace-template/AGENTS.md`，随**模板发布**对工作区生效 |
| 回归 | 既有 AI Workspace 会话（不读 `app`）行为不变；发版脚本 `install-harness-runtime.sh` 不受影响 |

## 9. 实施拆解（供排期，不在本 phase 执行）

1. `workspace-paths.service.ts`：新增 `projectAppDir(project)` + `ensureProjectAppDir(project)`（含种子文件）。
2. `harness-runtime-manager.service.ts`：签发 ticket 时调用并透传 `appDir`。
3. `harness-broker-client.service.ts` + `server.mjs`：payload 加 `app_dir`，broker 校验并追加挂载。
4. `runtime-wrapper.mjs`：把 `app` 出现在 `AGENTS.md`/工作区说明里（让模型知道这是项目共享目录与其边界）。
5. 测试与验收脚本；`docs/project/legacy-production-handover.md` 补一节「app 目录的运维事实」。
