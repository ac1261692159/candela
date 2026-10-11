# 架构设计：ClkLog AI 数据分析助手 v1

> phase: clklog-ai-analytics-v1
> 状态：MVP 已实现，生产验收与增强项见 `CODE_HANDOVER.md`
> 上游：`docs/product/prd-clklog-ai-analytics-v1.md`
> 运行时基线：Node.js 24.20.0 LTS + 固定版本 DeepSeek Harness Web Profile
> 项目记录：`docs/project/retrospective-clklog-ai-analytics-v1-2026-09-01.md`

---

## 1. 阶段目标与范围

本 phase 将现有简单 AI 对话接口重构为完整 Harness Host 集成：分析页右侧加载由官方 Harness Web 包组合的客户端，服务端通过受认证网关连接按用户、项目隔离的 Harness Runtime。Runtime 使用配置指定的非 root Linux 用户，以该用户 home 下的 `clklog-ai` 目录保存 DSH Home、临时/永久 Workspace 和初始化模板状态。

范围包括：

- Node.js 24 LTS 构建与生产运行基线；
- `config_server.yaml` 中小写、多供应商 Harness 配置和按供应商派生的环境变量密钥覆盖；
- Harness Web Profile、原生命令、模型与 reasoning effort、权限预设和会话能力；
- Runtime Broker、非 root 容器、文件系统和网络隔离；
- 永久/临时 Workspace 初始化、版本、回收和提升；
- 管理员初始化 Workspace 的编辑、发布、只读策略、全量同步、恢复和审计；
- Harness 与 React 分析页面之间的结构化 Page Bridge；
- 继续复用现有元数据、事件、漏斗、留存和 SQL 安全查询链路。

旧实现可以作为迁移期间的回滚路径，但其受限工具 Profile、固定模型、环境变量单供应商和简单 JSON 对话接口均不是本设计的最终契约。

## 2. 架构验收标准

- [ ] **ARCH-AI-1**：CI、analytics-server、analytics-ingestor 和 Harness Host 均在 Node.js 24.20.0 上构建、测试和运行。
- [ ] **ARCH-AI-2**：配置加载器严格解析 §6 schema，支持多个供应商、小写键名、环境变量优先和配置密钥回退。
- [ ] **ARCH-AI-3**：Harness 以配置指定的非 root Linux 用户运行，根目录从系统用户数据库中的真实 home 推导；root/UID 0 被拒绝。
- [ ] **ARCH-AI-4**：右侧客户端由官方 Harness Web Profile 能力组合而成，命令、模型、reasoning effort、权限、会话和工具状态不以自定义文本协议仿制。
- [ ] **ARCH-AI-5**：每个 Runtime 只能看到当前用户、项目允许的 DSH Home 和 Workspace；不能看到宿主机应用目录、其他用户/项目目录或 Docker Socket。
- [ ] **ARCH-AI-6**：Runtime 必须由 rootless Podman 外层强制隔离；官方内层 Sandbox 不可用时命令 fail closed，任何情况都不回退为宿主机裸进程。
- [ ] **ARCH-AI-7**：`Danger Full Access` 只绕过 Runtime 内 Harness 文件限制，不能突破容器、mount、网络、身份和资源边界。
- [ ] **ARCH-AI-8**：Workspace 创建、临时回收、转永久及模板初始化原子、幂等、可恢复。
- [ ] **ARCH-AI-9**：初始化模板具有 draft、不可变发布版本和 manifest；代码模板只负责首次 bootstrap，不覆盖管理员内容。
- [ ] **ARCH-AI-10**：`managed_readonly` 持续镜像同步，`seed_once` 仅初始化复制；遗留 Workspace 使用单独规则。
- [ ] **ARCH-AI-11**：只读受管路径由容器只读 bind mount 强制保护，并以 mode/digest 校验落盘状态，不能仅依赖提示词或 chmod。
- [ ] **ARCH-AI-12**：全量同步先生成计划和恢复副本，再逐路径原子替换与验真；任务可重试，逐 Workspace 可审计。
- [ ] **ARCH-AI-13**：Page Bridge 按用户、项目、Runtime、`tab_id` 和 revision 路由；SQL 修改只生成提案，确认后由 React 状态写回。
- [ ] **ARCH-AI-14**：SQL 执行与编辑提案使用不同 action 和审批，执行继续经过只读账号、项目/时间/LIMIT/超时守卫。
- [ ] **ARCH-AI-15**：实际供应商密钥不进入 Harness Workspace、prompt、客户端、日志或导出；模型出口由网关代理并执行配额与审计。
- [ ] **ARCH-AI-16**：AI Runtime、模型或同步失败只降级 AI 功能，不影响分析查询和社区版数据链路。
- [ ] **ARCH-AI-17**：真实供应商、假模型、跨用户/项目、路径逃逸、命令、同步、备份恢复和页面冲突测试全部通过。

## 3. 非目标

- 不直接 iframe 未认证的原始 `dsh web` 服务，不向公网暴露 Harness Host 端口。
- 不在 analytics-server 中复刻一套与官方 Harness 演进脱节的命令、模型或审批状态机。
- 不让普通用户添加任意供应商、插件、原始网络出口或宿主机挂载。
- 不让 Web 请求传入 Linux 用户、宿主机路径、容器参数或任意执行命令。
- 不允许 Harness 直接持有 ClickHouse/MySQL/Kafka 凭据或绕过现有分析 API。
- 不提供跨用户共享 Workspace；同项目不同用户仍物理隔离。
- 不修改 ClkLog 社区版镜像、源码、数据库表或原有数据链路。
- 不把 AGENTS.md、文件权限位或提示词当成安全边界。

## 4. 总体拓扑

```text
Analysis Page (React controlled state)
  ├─ AiPanelHost（展开/拖动/偏好）
  │    └─ opaque-origin sandbox iframe: official Harness Web
  │          └─ /sa/harness/<runtime_id>/<signed_access>/*
  └─ PageBridgeAdapter（event/funnel/retention/sql）
       └─ authenticated snapshot + long poll + action acknowledgement

analytics-server / AiAssistantGateway
  ├─ 登录态、RBAC、project、tab/session 绑定
  ├─ ContextSanitizer / action validator
  ├─ Workspace/Admin API
  ├─ ModelEgressGateway（持有真实供应商密钥）
  ├─ Harness Web reverse proxy（上游认证 Cookie 仅存服务端内存）
  └─ narrow Unix sockets
       ├─ HarnessRuntimeBroker（固定 ensure/stop，计算路径和容器参数）
       └─ isolated Harness Runtime (uid/gid = configured linux_user)
            ├─ official Harness Host + custom ClkLog tools
            ├─ selected Workspace + per-user/project DSH_HOME
            ├─ model/page capability（只对 Unix Gateway 有效）
            └─ no host network / Docker socket / host credentials
```

### 4.1 代码边界

| 目录 | 职责 |
|---|---|
| `apps/analytics-web/` | 面板宿主、管理员模板页面、各分析页 Page Adapter |
| `apps/analytics-server/src/modules/ai-assistant/` | 登录网关、配置适配、模型出口、Page Bridge、Workspace 元数据和管理 API |
| `apps/analytics-harness-host/`（新增） | 官方 Harness Web Profile 组合、ClkLog Host/Client 插件、代码内 bootstrap 模板 |
| `apps/analytics-harness-broker/`（新增） | 仅通过 Unix socket 提供固定 Runtime ensure/stop，管理 rootless Podman 与 mount；不接受任意命令或路径 |
| `puppet/clklog/` | Node、Linux 用户、目录、服务、容器与服务器配置 SSOT |

### 4.2 Web 嵌入

- `AiPanelHost` 加载官方 Harness Web；iframe 不声明 `allow-same-origin`，因此其脚本运行在 opaque origin，不能读取父页面 DOM、Cookie 或 localStorage。
- 已登录父页面先调用 `POST /sa/api/assistant/host-ticket` 领取一次性、两分钟 bootstrap ticket；ticket 只可消费一次且绑定服务端登录用户、项目、tab 和 Workspace。
- `/sa/harness/bootstrap?ticket=...` 在服务端启动/复用 Runtime，并由服务端用上游 launch token 换取 Harness HttpOnly Cookie；该 Cookie 不下发浏览器。
- 浏览器随后只访问 `/sa/harness/<runtime_id>/<expires>.<hmac>/...`。签名访问路径绑定 Runtime 且有时效；代理剥离浏览器的 Cookie、Authorization 与 Referer，再注入服务端保存的上游 Cookie。若转发时 Runtime Unix socket 已消失（容器退出），代理对同一 `runtime_id` 调用 Broker `ensure` 拉起后再重试一次；仍失败则返回 401，而不是把 `ENOENT` 映射成 502。
- Harness 绝对资源、API、插件和 WebSocket 路径由代理改写到同一签名前缀；响应禁用 Referer，并不转发 `Set-Cookie`。iframe 内只提供内存型偏好存储兼容层，持久会话仍由 DSH Home 保存。HTML 的 `src`/`href`/`base` 在响应里改写；字面量 `/plugins` 与带路径的 `/api/...` 一并改写，但单独的 `"/api"` 是官方 DSH 的 RPC 通道名，不可改写（否则 `assertTarget` 报 `invalid RPC target`）。动态 `fetch` / `WebSocket` / `script.src` 由注入的 shim 在请求时加上签名前缀。转发上游时去掉浏览器的 `Sec-Fetch-Site` 等 Fetch Metadata，并把 `Origin`/`Host` 写成 Runtime loopback，避免官方 `/api` trust fence 把 opaque-origin iframe 判成 `cross-site` 而 403。
- 原始 Harness 仅监听 Runtime 容器 loopback，并通过当前 Runtime 的 Unix socket 暴露给 analytics-server，不承担 ClkLog 登录认证，也不直接暴露端口。
- 父页面不与 iframe 交换 token 或任意 `postMessage` 命令；页面交互统一走 §14 的登录 API 与 Runtime capability 网关。

## 5. Node.js 与 Linux 服务身份

### 5.1 Node 基线

- Puppet 和 CI 固定 Node.js `24.20.0`，不使用浮动 `latest`。
- analytics-server、analytics-ingestor 与新增 Harness 应用的 `package.json` 声明 `engines: { "node": ">=24 <25" }`。
- 生产并行安装 Node 24，Supervisor 显式使用版本化二进制路径；Node 20 保留到上线验收通过后再另行处理。
- 启动脚本输出 Node 主版本和应用版本，但不得输出环境或配置内容。

Node 版本是部署 SSOT，不放进 `deepseek_harness` 业务配置。

### 5.2 Linux 用户

配置默认 `linux_user: harness`。部署阶段幂等创建：

```text
name: harness
home: /home/harness
shell: /usr/sbin/nologin
managehome: true
```

- 立即部署可由 `server-upgrade.sh` 在用户不存在时执行等价 `useradd`，同一变更必须把 user 资源写回 Puppet。
- 应用启动调用 `getpwnam(3)` 等价能力取得 UID、GID 和真实 home；不通过字符串拼接假设 `/home/<name>`。
- 拒绝 `root`、UID 0、空 home、非绝对 home、无法 canonicalize 的 home 或不存在的用户。
- `home_subdir` 只能是一个普通相对目录名，默认 `clklog-ai`，禁止 `/`、`.`、`..` 和路径分隔符。
- Runtime 容器进程使用解析出的 UID/GID；配置变更需要重启并显式迁移目录，不热切换。

## 6. `config_server.yaml` 契约

所有 DeepSeek/Harness 配置位于 `apps/analytics-server/config_server.yaml` 的 `deepseek_harness` 节点。键名必须是小写 snake_case；发现旧的大写键、未知键或类型错误时启动失败并给出不含值的字段路径。

```yaml
deepseek_harness:
  enabled: true

  runtime:
    linux_user: harness
    home_subdir: clklog-ai
    idle_ttl_ms: 900000
    max_runtimes: 8
    max_tokens: 8192
    container_image: docker.io/library/node:24.20.0-bookworm-slim

  workspace:
    default_kind: persistent
    temporary_ttl_ms: 86400000
    recovery_retention_ms: 604800000
    max_bytes: 1073741824

  defaults:
    provider: tencent
    model: deepseek/deepseek-v4-flash
    reasoning_effort: high
    permission_preset: workspace_write

  providers:
    tencent:
      adapter: openai_compatible
      display_name: Tencent
      base_url: https://provider.example/v1
      protocol: openai-completions
      api_key: temporary_plaintext_value
      api_key_env: TENCENT_API_KEY
      models:
        - id: deepseek/deepseek-v4-flash
          display_name: DeepSeek V4 Flash
          reasoning_efforts:
            - off
            - high
            - max
          default_reasoning_effort: high

    deepseek_official:
      adapter: deepseek
      display_name: DeepSeek Official
      base_url: https://api.deepseek.com
      api_key: temporary_plaintext_value
      api_key_env: DEEPSEEK_OFFICIAL_API_KEY
      models:
        - id: deepseek-chat
          display_name: DeepSeek Chat
          reasoning_efforts:
            - off
            - high
```

### 6.1 Provider ID 与环境变量

- provider ID 仅允许 `[a-z0-9_-]+`。
- 未配置 `api_key_env` 时，将 provider ID 中 `-` 转为 `_` 后大写并追加 `_API_KEY`。
- 示例：`tencent` → `TENCENT_API_KEY`；`deepseek_official` → `DEEPSEEK_OFFICIAL_API_KEY`；`token-hub` → `TOKEN_HUB_API_KEY`。
- 两个 provider 派生为相同环境变量名时配置无效，必须显式消除冲突。
- 本设计中的 `PROVIDER_API_KEY` 是命名模板，不读取固定的 `PROVIDE_API_KEY` 或 `PROVIDER_API_KEY`。

### 6.2 密钥解析优先级

对每个 provider 独立解析：

1. `api_key_env` 指向的非空环境变量；
2. `providers.<id>.api_key`；
3. 均不存在时 provider 状态为 `unavailable_missing_key`。

单个 provider 不可用不阻止其他 provider 启动。默认 provider 不可用时 AI 网关仍启动，返回结构化诊断并允许用户选择其他可用模型。

任何配置打印、验证错误、健康检查和 API 响应只返回 `configured_by: environment|config|missing`，不得返回密钥内容。不能把完整 `config_server.yaml` 挂入 Harness 容器。

### 6.3 配置到 Harness 的适配

- `ConfigurationService` 使用本仓库的小写 schema；`HarnessConfigAdapter` 显式映射到官方 Harness 所需的 camelCase/Provider Settings，调用方不直接读取 YAML。
- UI 模型目录、`/model` 命令和 Runtime Provider Settings 均由同一个已验证目录生成。
- `reasoning_efforts` 是每个模型的允许集合；请求其他值在进入 Harness 前拒绝。
- provider/model 配置为运维只读，不开放普通用户修改接口。

### 6.4 密钥不进入 Harness 权限域

完整 Harness 包含 Bash 和文件能力，同 UID 子进程可以读取进程环境或凭据文件。因此真实 provider key 只由 `ModelEgressGateway` 持有：

- Harness 的 provider `base_url` 被适配为内部模型出口；
- Runtime 只获得短生命周期、绑定 `runtime_id/user_id/project_name/tab_id` 的 capability token；provider/model 由出口网关逐请求按 allowlist 校验；
- 出口网关用真实 key 请求外部供应商，并执行模型 allowlist、速率、token 预算和审计；官方 DSH 可能发出 OpenAI 的 `developer` 角色，出口在 openai-compatible `/chat/completions` 上把它改写成供应商接受的 `system`，不把原文写入审计。
- capability token 泄露最多允许当前 Runtime 在有效期和配额内调用已授权模型，不能得到真实供应商密钥；
- Harness 容器只允许访问模型出口和 ClkLog Page/Tool Gateway，不直接访问供应商或任意互联网。

## 7. 目录、标识与所有权

### 7.1 运行目录

根目录为：

```text
<getpwnam(linux_user).home>/<home_subdir>/
```

默认布局：

```text
/home/harness/clklog-ai/
├── initialization/
│   ├── draft/
│   ├── versions/<template_version>/
│   └── current
├── runtimes/
│   └── <user_hash>/<project_hash>/dsh-home/
└── workspaces/
    └── <project_hash>/<user_hash>/
        ├── persistent/<workspace_id>/
        └── temporary/<session_id>/
```

- 管理根及一级运行目录由配置 Linux 用户所有、模式 `0700`，以便 rootless Broker 创建 Runtime 数据；`initialization/draft`、`initialization/versions` 及其内容由 root 身份的 analytics-server 创建和维护。
- `initialization/` 从不挂入 Runtime；Broker 只接收 Runtime ensure/stop，普通用户和模型没有到该宿主机路径的文件系统通道。管理员只能通过 RBAC API 修改 draft。
- 用户 Workspace 与 DSH Home 只挂入匹配 user/project 的 Runtime；目录 hash 不是授权依据，认证元数据与 Broker 规范化计算才是授权依据。
- 发布目录、Git checkout、CI target 和服务器应用目录不进入此树，发版不能清理此树。

### 7.2 路径键与实体 ID

- `user_hash = hex(sha256("user\0" + user_id))[0:32]`。
- `project_hash = hex(sha256("project\0" + project_name))[0:32]`。
- 永久 Workspace ID：`aiw_` + 48-bit 毫秒时间前缀 + 80-bit CSPRNG；用户输入的名称只是 display name，不进入路径。
- 临时目录使用服务端生成并校验的 Harness `session_id`，不得接收浏览器路径片段。
- 模板版本是从 `1` 开始单调递增的整数；同步任务 ID 使用同结构的 `aiws_` 前缀有序随机 ID。
- 所有文件操作都由实体 ID 查元数据后计算路径；管理 API 和 Broker API 不接受绝对路径。

Hash 只用于稳定且不泄露原始标识的目录名，不作为授权机制。

## 8. Workspace 元数据与生命周期

### 8.1 元数据实体

分析元数据库新增以下实体；数据库是状态 SSOT，Workspace 内 manifest 是可审计镜像：

| 实体 | 最低字段 |
|---|---|
| `ai_workspace` | `id, user_id, project_name, kind, display_name, status, initialized_from, applied_template_version, last_access_at, expires_at, created_at, updated_at` |
| `ai_workspace_template_version` | `version, state, manifest_json, content_digest, published_by, published_at` |
| `ai_workspace_sync_job` | `id, template_version, scope_json, state, requested_by, planned_count, success_count, failed_count, created_at, finished_at` |
| `ai_workspace_sync_item` | `job_id, workspace_id, state, diff_json, recovery_path, error_code, started_at, finished_at` |

唯一约束：

- 同一 `user_id + project_name` 只能有一个名为 `default` 的有效永久 Workspace；
- 同一模板版本不可重复发布；
- 同一 Workspace 同时最多有一个运行中的同步任务；
- 已删除 Workspace 不作为同步目标。

### 8.2 Workspace 内部结构

```text
.dsh-root
AGENTS.md
AGENTS.local.md
.clklog/
├── workspace.yaml
├── managed-manifest.json
└── recovery/<sync_job_id>/
files/
├── sql/
├── notes/
├── exports/
└── artifacts/
```

- `.clklog/` 是保留目录，普通 Harness 文件工具不得修改其控制文件。
- `workspace.yaml` 记录 ID、kind、owner/project hash、模板版本和 schema version，不保存 token、密钥或原始用户标识。
- `AGENTS.md` 默认是 `managed_readonly`；`AGENTS.local.md` 默认是 `seed_once`。
- AGENTS 内容是模型上下文，不承担权限、SQL 守卫或同步授权。

### 8.3 永久与临时

- 首次进入某项目时幂等创建 `default` 永久 Workspace。
- 临时 Workspace 的 `expires_at = last_access_at + temporary_ttl_ms`；有活动 turn、同步或提升任务时不回收。
- 转永久使用同一文件树做原子目录迁移并更新元数据，不复制后删除。
- 回收临时 Workspace 先写审计；本 phase 不要求为 TTL 回收创建长期恢复副本。

## 9. 初始化模板

### 9.1 三层职责

1. 代码模板：`apps/analytics-harness-host/workspace-template/`，只用于系统首次 bootstrap。
2. 管理员 draft：`initialization/draft/`，Web 编辑的工作副本。
3. 发布版本：`initialization/versions/<version>/`，不可变、带 manifest 和整体 digest。

首次启动且数据库中不存在任何模板版本时，analytics-server 的 `WorkspaceTemplateService` 将代码模板复制到 draft，校验后发布版本 1。存在管理员模板后，发版不得用代码模板覆盖 draft 或已发布版本。

代码模板至少包含：

- `.dsh-root`；
- 平台维护的 `AGENTS.md`；
- 用户可扩展的 `AGENTS.local.md`；
- `files/sql`、`files/notes`、`files/exports`、`files/artifacts`；
- 辅助脚本目录及说明文件。

### 9.2 Manifest

每个发布版本包含排序稳定的 manifest：

```yaml
schema_version: 1
template_version: 12
entries:
  - path: AGENTS.md
    kind: file
    policy: managed_readonly
    mode: "0444"
    sha256: "..."
  - path: tools
    kind: directory
    policy: managed_readonly
    mode: "0555"
    sha256: "..."
  - path: AGENTS.local.md
    kind: file
    policy: seed_once
    mode: "0644"
    sha256: "..."
```

发布校验：

- 只接受普通文件和目录；拒绝软/硬链接、socket、device、FIFO 和路径穿越；
- 单文件、文件数、总大小和层级受配置限制；
- 路径使用标准 UTF-8 相对路径，拒绝绝对路径、`.`、`..`、NUL 和保留控制路径；
- 只读目录策略递归覆盖后代，manifest 不允许冲突或重叠策略；
- 可执行脚本只能记录 `0555` 或 `0755` 语义，不允许 setuid/setgid/sticky 特权位；
- 发布时计算逐项和整体 digest，发布目录随后不可变。

## 10. 初始化与同步算法

### 10.1 新 Workspace 初始化

1. 数据库创建 `creating` 元数据并取得当前发布模板版本。
2. 在目标父目录创建同文件系统 staging 目录。
3. 复制模板全部条目；`seed_once` 归 Harness 用户，`managed_readonly` 按受管所有权落盘。
4. 生成 `.clklog/workspace.yaml` 和 `managed-manifest.json`。
5. 校验文件类型、digest、owner、mode、配额和路径边界。
6. 原子 rename 到最终目录，元数据切换为 `active`。
7. 任一步失败都删除 staging，不暴露半初始化 Workspace。

### 10.2 已有 Workspace 同步

发布模板不自动修改已有 Workspace；管理员明确触发同步任务。每个目标按以下状态机执行：

```text
planned → snapshotting → applying → verifying → succeeded
                                      └────────→ failed
```

- `managed_readonly` 新增：复制并登记受管；
- `managed_readonly` 修改：先备份现有路径，再原子替换；
- `managed_readonly` 删除：先备份，再删除已登记受管路径；
- `seed_once` 新增/修改/删除：已有 Workspace 不处理；
- `seed_once → managed_readonly`：备份同名路径后强制接管；
- `managed_readonly → seed_once`：保留当前内容，解除挂载和受管标记，转为 Harness 用户所有；
- `legacy_uninitialized`：默认只应用 `managed_readonly`；管理员显式“初始化遗留 Workspace”时只补充缺失的 `seed_once`，不覆盖已有同名路径。

恢复副本位于 `.clklog/recovery/<sync_job_id>/`，保存被覆盖/删除内容和恢复 manifest。恢复副本达到 `recovery_retention_ms` 后由单独清理任务删除并写审计。

单个 analytics-server 进程内以 Workspace ID 串行化同步；数据库 item 状态、逐项 diff 和恢复目录承担可审计断点。服务重启会把未完成任务标记为 `server_restarted`，管理员的“仅重试失败项”会创建只包含失败目标的新任务；每一步仍按 manifest/digest 重验，已一致的受管项不重复替换。

### 10.3 活跃 Runtime

- 同步开始前 analytics-server 停止目标 Workspace 的活动 Runtime，避免在 bind mount 存续时替换受管路径。
- 已完成消息和 Session 日志保留在对应 user/project DSH Home；正在进行的 turn 会随 Runtime 停止而中断。
- 同步完成后用户点击重连或面板下一次领取 ticket 时，Broker 以新 manifest 重建只读 mount；官方会话列表可从 DSH Home 恢复。

## 11. 只读路径的强制实现

chmod 不能作为唯一保护：同一 UID 对可写父目录中的只读文件仍可删除或替换。因此采用两道强制边界加同步校验：

1. **容器物理层**：Broker 将每个 `managed_readonly` 文件或最上层只读目录作为 Podman read-only bind mount 覆盖到 Runtime 对应路径；`.clklog` 控制目录也单独只读挂载。Runtime 无 capability、无设备挂载且 rootfs 只读，不能卸载或替换这些 mount。
2. **落盘与同步层**：manifest mode 使用 `0444/0555`，每次 Runtime 启动前拒绝链接/特殊文件并核验 Workspace 配额；模板同步后校验受管文件 digest，再原子更新 managed manifest。

Runtime 无 `CAP_SYS_ADMIN`，不能卸载 bind mount。普通用户不能通过 Web 修改 managed manifest。管理员不是直接以 Harness 用户编辑用户副本，而是修改模板 draft、发布并由 Broker 同步。

## 12. Runtime Broker 与 Sandbox

### 12.1 Broker 边界

Broker 是唯一能调用容器运行时和创建 Runtime bind mount 的组件：

- 只监听本机 Unix socket，socket 权限仅 analytics-server 服务组可访问；
- API 只接受实体 ID 和固定动作：`POST /v1/runtime/ensure`、`POST /v1/runtime/stop`；
- 不接受镜像名、命令行、UID、host path、container path、环境变量或 mount 参数；
- Broker 自行从只读配置、实体 ID hash 和固定目录布局计算所有值；Workspace 同步由 analytics-server 的 RBAC 管理服务执行，不暴露给 Runtime；
- Harness 容器和 analytics-server 均不挂载 Docker Socket。

### 12.2 Runtime 隔离

每个活动用户/项目 Runtime 至少满足：

- 进程 UID/GID 为配置 Linux 用户，非 root；
- 只读 root filesystem；
- `cap_drop: ALL`、`no_new_privileges`、默认 seccomp、private IPC/UTS/cgroup namespace、PID/CPU/内存限制、单文件 `fsize` 与主动 Workspace 配额扫描；
- 只挂载当前用户/项目的 DSH Home 和允许的 Workspace 范围；
- 不挂载 `/data/app`、Git 仓库、SSH、数据库目录、宿主机 `/home` 根或设备；
- Podman `network=none` 且禁用代理环境继承；模型出口与受限 ClkLog Tool/Page Gateway 只经一个固定的只读挂载 Unix socket 中继；
- 禁止访问云 metadata、宿主机管理端口和任意内网地址；
- 官方 Harness 内层 sandbox/permission 继续控制 Read Only、Workspace Write、审批和命令；若内核能力不足，相关命令 fail closed。无论其报告 full 或 partial，宿主机安全边界始终是外层 rootless Podman，而不是提示词或 chmod。

配置 Linux 用户是宿主机文件所有者，不是业务用户隔离边界。业务隔离由认证、独立目录、容器 mount namespace、Sandbox 与 capability token 共同实现。

### 12.3 权限预设语义

| 预设 | Runtime 内含义 | 不授予 |
|---|---|---|
| `read_only` | 读取当前 Workspace 和工具结果，写操作需拒绝/审批 | 页面写回、SQL 执行、宿主机读取 |
| `workspace_write` | 可写当前 Workspace 的非受管路径 | 受管路径、其他用户/项目、页面自动写回 |
| `danger_full_access` | 可绕过 Harness 文件限制，但仍在容器/mount/网络边界内；可能删除当前 Workspace 的可写内容和同用户/项目的 DSH 会话历史 | 宿主机 root、Docker、其他用户/项目、真实 provider key、数据库凭据 |

Filesystem permission 与 ClkLog application capability 分开判断，不能相互推导。

## 13. Harness Host Profile

`apps/analytics-harness-host/` 以固定官方版本组合 Web Profile，并增加 ClkLog Host/Client 插件：

- 保留 session、persistence、streaming、commands、compact、export、feedback、goal、plan、model selection、reasoning effort、permission presets、approvals、filesystem、sandboxed shell、skills、jobs/subagents 和工具投影；
- provider/model 目录由 §6 适配器生成；普通用户的 provider settings 页面只读或隐藏新增/删除操作；
- plugin 安装、任意 provider endpoint、未受控网络和宿主机 full access 不注册给普通用户；
- `session-telemetry-otel` 被禁用；官方 `/feedback` 命令仍把反馈事件写入当前 Session，并明确显示 sharing 未配置，不向 DeepSeek telemetry endpoint 上传；
- `/export` 使用官方 Session 导出，只能看到当前隔离 DSH Home 中的会话。平台不会把真实 provider key、登录 token 或数据库凭据放入 Runtime；用户主动输入到对话或文件中的秘密仍会进入其个人导出包，属于验收时必须提示的残余风险；
- Profile 启动时输出功能清单摘要并做快照测试，不输出配置值。

升级 Harness 必须重新运行 Profile 功能清单、命令、模型、投影、权限、Sandbox 和 Page Bridge 兼容测试。

## 14. Page Bridge

### 14.1 连接与状态

浏览器使用现有 Bearer 登录态与项目头建立 Page Bridge：

```text
POST /sa/api/assistant/page-bridge/snapshot
GET  /sa/api/assistant/page-bridge/events?tab_id=<tab_id>&after=<sequence>
POST /sa/api/assistant/page-bridge/proposals/<proposal_id>/decision
```

连接绑定：

```text
user_id + project_name + tab_id
```

Harness Runtime 不直接调用这些浏览器 API。它携带绑定 runtime 的 capability，经 Unix Tool Gateway 读取精确 tab 快照或创建提案；Gateway 从 Runtime 上下文补入 `user_id/project_name/tab_id`，不信任模型参数。浏览器以最长 25 秒的认证 long poll 领取提案并用单调 `sequence` 去重。

页面在初始化和受控状态变化后发布快照：

```json
{
  "type": "page.snapshot",
  "tab_id": "tab_xxx",
  "revision": 42,
  "page": "sql",
  "route": "/report/sql",
  "state": {
    "mode": "sql",
    "sql": "select ...",
    "selection": { "from": 0, "to": 6 },
    "time_range": { "from": "...", "to": "..." },
    "result": { "columns": [], "rows": [], "meta": {} }
  }
}
```

服务端忽略浏览器传入的用户和项目，只使用登录态绑定值。ContextSanitizer 限制 SQL/DSL 单字段 32 KiB、结果数组 100 项、单元格 2,000 字符、整体 128 KiB，并递归移除敏感键和值。

### 14.2 Harness 页面工具

```text
clklog_page_read
clklog_propose_sql
clklog_request_sql_execution
clklog_get_schema
clklog_run_event_analysis
clklog_run_funnel_analysis
clklog_list_dashboards
clklog_list_cards
clklog_get_card
clklog_execute_sql_card
clklog_load_sql_card
clklog_propose_sql_chart
```

`clklog_propose_sql_chart`（phase: clklog-ai-sql-chart-v1）写回 SQL 结果区字段绑定，详见 `clklog-ai-analytics-design-sql-chart-v1.md`。

每个工具使用短生命周期 capability，固定到 `runtime_id/user/project/tab`，且仅能通过当前容器挂载的 Unix Gateway 使用。事件与漏斗工具删除模型输入中的 project 字段，网关使用登录绑定项目调用现有安全 API；当前留存页尚未提供查询 API，因此本 phase 只暴露留存页面快照，不伪造一个不可执行工具。

`clklog_list_*` / `clklog_get_card` / `clklog_execute_sql_card` 走登录用户的会话安全 API（internalApi），静默执行仍经过 SQL AST 守卫、项目、时间、LIMIT、超时和只读账号。`clklog_load_sql_card` 只触发 Page Bridge `sql_load_card`（加载已有卡片 SQL 到编辑器，不执行）。本期不把事件/漏斗写回混进 Page Bridge。详见 `clklog-analytics-design-dashboard-sql-cards-v1.md`。

### 14.3 页面 Action

```json
{
  "proposal_id": "aip_xxx",
  "action": "sql_edit",
  "expected_revision": 42,
  "sql": "select ...",
  "reason": "..."
}
```

允许的 action 类型固定为：

```text
sql_edit
sql_execute
sql_load_card
sql_chart_edit
```

`sql_chart_edit` 携带 `chart_config`（字段绑定提案），自动写入结果区图表配置，不执行 SQL。

`sql_load_card` 携带 `card_id` / `card_name` / `sql`；页面自动写入编辑器并更新 `?card=`，toast 卡片名，**不执行查询**。编辑确认与执行确认仍分离。

- 网关只向精确 `tab_id` 转发，不存在“当前活动标签页”回退。
- 页面根据受控 React 状态计算并显示 diff 与“写入编辑器/拒绝”；用户决定后提交 decision。
- 应用时 `expected_revision` 必须等于当前 revision；不一致返回 `revision_conflict`。
- React Adapter 调用组件既有 `onChange/setState`，不操作 DOM 或模拟键鼠。
- 应用完成返回新的 revision；Harness 收到结构化 ACK 后才能声称已修改。
- 页面断开返回 `page_unavailable`，action 不排队到其他标签页。

### 14.4 SQL 执行

`sql_execute` 只生成执行请求，且 SQL 必须逐字等于当前编辑器快照，不能直接访问数据库：

1. 页面展示即将执行的 SQL、项目、时间范围和风险提示；
2. 用户单独确认；
3. 浏览器调用现有 SQL 执行 API；
4. 服务端使用 `sa_readonly`，强制单条 SELECT、逻辑表改写、项目/时间、LIMIT、超时和资源上限；
5. 裁剪后的结果通过 Page Bridge 回到会话。

`Workspace Write` 或 SQL 编辑确认不会自动批准执行。

## 15. 管理员模板 API

所有接口要求服务端 `admin` RBAC：

```text
GET    /sa/api/admin/ai/workspace-template/draft/tree
PUT    /sa/api/admin/ai/workspace-template/draft/file
POST   /sa/api/admin/ai/workspace-template/draft/directory
PATCH  /sa/api/admin/ai/workspace-template/draft/entry
DELETE /sa/api/admin/ai/workspace-template/draft/entry
GET    /sa/api/admin/ai/workspace-template/preview
POST   /sa/api/admin/ai/workspace-template/publish
GET    /sa/api/admin/ai/workspace-template/versions
POST   /sa/api/admin/ai/workspace-template/versions/<version>/restore-draft
POST   /sa/api/admin/ai/workspace-sync-jobs
GET    /sa/api/admin/ai/workspace-sync-jobs/<job_id>
POST   /sa/api/admin/ai/workspace-sync-jobs/<job_id>/retry
GET    /sa/api/admin/ai/workspaces
POST   /sa/api/admin/ai/workspaces/<workspace_id>/initialize-legacy
```

- entry API 只接受规范化相对路径、内容、policy 和普通 mode；不接受宿主机路径。
- draft 写入使用同目录临时文件 + rename，发布操作在进程内串行；当前管理页面是单管理员编辑模型，不声明跨实例 ETag 合并。
- publish 返回新 template version 和 digest，不隐式同步已有 Workspace。
- sync job 的 scope 只允许 `project_name`、`user_id`、`workspace_ids` 和 `kind`，字段取交集；空对象表示全部 Workspace，未知字段直接拒绝。
- 强制覆盖/删除不要求普通用户确认，但管理员创建任务前必须看到摘要并确认；审计不可关闭。

## 16. 启动、运行与回收

1. analytics-server 解析并验证配置、Linux 用户和目录根。
2. Runtime Broker 以配置用户启动，验证 rootless Podman、管理根和 Broker 配置；外层容器参数固定在 Broker 代码中。
3. WorkspaceTemplateService 首次 bootstrap 创建 draft；存在 active admin 时发布代码模板版本 1，否则保留 draft 并记录告警。
4. 用户打开面板时，网关验证身份、项目与 Workspace，Broker 按需启动 Runtime。
5. 同一用户/项目的会话使用隔离 DSH Home；Sandbox 的 cwd 指向所选 Workspace。
6. Runtime 空闲达到 `idle_ttl_ms` 后停止容器，DSH Home 和永久 Workspace 保留。
7. 临时 Workspace 独立按 `temporary_ttl_ms` 清理；清理与活动 turn、同步、提升互斥。
8. 服务关闭时停止 Runtime，但不删除 DSH Home、模板或永久 Workspace。

最多活动 Runtime 数由配置限制；定时器回收超过 idle TTL 的 Runtime。达到上限时不抢占仍登记为活动的 Runtime，直接返回可重试的容量错误。

## 17. 测试与验证门禁

### 17.1 配置与 Node

- Node 24 构建、单测、ingestor 启停、Supervisor 二进制路径和回滚测试；
- 小写 schema、未知键、root 用户、非法 home_subdir、provider ID/env 冲突测试；
- 环境变量覆盖配置、空环境回退配置、单 provider 缺 key 降级和日志脱敏测试。

### 17.2 Workspace 与同步

- 首次 bootstrap、不覆盖管理员 draft、原子初始化、临时回收和转永久；
- `managed_readonly` 增删改、目录递归、两种策略互转、`seed_once` 不覆盖；
- legacy 默认同步与显式初始化；
- 失败恢复、幂等重试、同步并发锁、配额、路径穿越、链接/特殊文件拒绝；
- Runtime 中对 managed path 执行 write/edit/mv/rm/chmod 均失败；管理员重新发布可更新。

### 17.3 Sandbox 与越权

- Read Only、Workspace Write、Danger Full Access 三套测试；
- 尝试读取其他用户/项目、应用目录、`/root`、Docker Socket、进程环境和真实 provider key 全部失败；
- 任意公网、内网和 metadata 访问失败；模型出口和受限工具网关按 allowlist 成功；
- 外层 rootless Podman 任一强制边界缺失时 Runtime 拒绝启动；官方内层 Sandbox partial/unavailable 时 shell 命令拒绝执行且不得回退到宿主机。

### 17.4 Harness 与页面

- 命令注册和执行、模型/effort 同源、计划/目标、审批、文件、Skills、会话恢复和导出脱敏；
- 四分析页 snapshot、精确 tab 路由、失联、revision 冲突和 action ACK；
- SQL replace/patch 经用户确认写回，query run 独立确认；
- project/time/LIMIT/只读账号测试和至少 20 条固定分析问题回归；
- 假模型测试不得访问外网；真实供应商测试与网关结构化日志记录 provider/model/状态/耗时/字节数但不记录 prompt 或密钥。持久化工具审计与可靠 token 用量属于增强项。

### 17.5 部署证据

- CI 构建结果和锁定依赖版本；
- Node、Linux 用户、目录 owner/mode、Runtime uid/gid 和 mount 列表；
- 容器 caps、network、rootfs、资源限制和 Sandbox enforcement；
- 管理员模板发布/同步审计和恢复演练；
- 浏览器四页面、命令、模型、Workspace、SQL 读取/写回/执行的端到端截图或日志；
- 现有分析 API、ingestor 与社区版上报链路回归。

## 18. 迁移与回滚

实现顺序不越过文档门禁：

1. Node 24 与配置 schema；
2. Linux 用户、目录和 Runtime Broker/Sandbox；
3. Harness Host Profile 与认证代理；
4. Workspace、代码模板和管理员模板管理；
5. 右侧面板和 Page Bridge；
6. 全量测试、部署与浏览器验收。

`deepseek_harness.enabled` 可整体关闭新 AI 入口；代码回滚使用上一生产 release 并停止 Broker/Runtime。不得删除 `/home/<linux_user>/clklog-ai`、模板版本、会话或 Workspace。Node 回滚使用 Supervisor 的 `.pre-node24.bak` 或保留的版本化二进制，不改数据目录。

## 19. 红线、覆盖与人工检查

- 红线 1：数据查询继续旁路 `clklog_sa`，不修改社区版实现和表。
- 红线 4：所有分析查询继续强制项目、时间、LIMIT、超时和只读账号。
- 红线 6：管理员模板强制覆盖/删除前必须创建恢复副本并写审计。
- 红线 7：Linux 用户和服务器目录最终由 Puppet 声明；部署脚本的首次 `useradd` 只能作为同批 bootstrap，不能形成配置漂移。

本 phase 有一项经项目所有者明确批准的临时红线 3 覆盖：允许把 AI 模型供应商 `api_key` 写入 `config_server.yaml` 并提交，同时保留环境变量覆盖。

```text
OVERRIDE-REASON: 当前仅项目所有者拥有开发与机器权限，
用户明确要求阶段性将供应商密钥提交到私有仓库，
用于多供应商 Harness 联调。
```

覆盖范围仅限 `deepseek_harness.providers.*.api_key`，不包含登录、数据库、Kafka、SSH 或其他凭据。实现合并前必须已有本架构文档和项目复盘；真实模型验收后应轮换密钥，并使用已实现的 `<PROVIDER>_API_KEY` 覆盖路径。删除配置值不会自动清除 Git 历史，是否重写历史需另行明确授权。

红线未自动检：供应商数据条款、生产容器和内核实际隔离能力、Broker 权限、只读 mount 完整性、模板同步恢复副本、外网/内网出口、导出包脱敏。生产验收时必须人工核对并留证。

---

## 20. 后续 phase：Harness 会话保活

> phase: `clklog-ai-harness-session-v1`
> 上游：`docs/product/prd-clklog-ai-analytics-v1.md` §13

### 20.1 目标与范围

同一浏览器标签在登录期内只领取一次 Host Ticket、只挂载一个 Harness iframe。路由切换不得卸载该 iframe。Page Bridge revision 在客户端续号，409 带 `current_revision` 供恢复。

### 20.2 验收

与 PRD **AI-S1～AI-S5** 对应。自动化至少覆盖：过期 snapshot 抛 409 且带 `current_revision`；客户端续号函数；axios `silent`/取消不 toast。

### 20.3 非目标

与 PRD §13.3 相同。不合并多窗口 token 流。

### 20.4 前端生命周期

- `MainLayout` 在已登录壳内始终挂载 `AiAssistantPanel`；非分析路由把面板移出视口（固定尺寸、不可点），**不**条件卸载。
- 折叠态同样保留 iframe，只显示 44px 入口。
- Host Ticket 缓存键：`user_id + project + workspace_id + reloadEpoch`。仅该键变化时重发 `POST /assistant/host-ticket`。
- Page Bridge `revision` 写入 `sessionStorage`（按 `tab_id`）。本地计数不得从 0 覆盖服务端更大值。
- `POST snapshot` 与 `GET events` 使用 `silent` 请求，不走全局错误 toast。409 时读取 `data.current_revision`，本地改为 `max(local, server)+1` 后重试一次。

### 20.5 同账号多窗口（不实时同步）

身份是账号，不是自然人。两个浏览器登录同一用户：

| 层 | 行为 |
|----|------|
| Page Bridge | 键仍为 `user_id + project + tab_id`。SQL 提案只投递到发出快照的标签。不把提案广播到其他窗口。 |
| Workspace 文件 / DSH Home | 仍按用户+项目共享。两窗口同时改同一文件时后写覆盖先写，不做 CRDT。 |
| Runtime | 仍按 `user + project + tab_id` 各起各的。Host Ticket 返回 `peer_sessions`：其他 tab 上同一 Workspace 的活动 Runtime 数。前端提示覆盖风险；提示可关，用 `sessionStorage` 记住本窗口已关闭，新窗口再显示。 |
| 实时对话 | 不把 A 窗口正在流式输出的 token 同步到 B。B 刷新后看到的是磁盘上已落盘的会话，可能落后或交错。 |

冲突解决：页面写回走既有 `expected_revision`；文件层后写为准；用户需自己避免两人共用一个登录同时改同一 Workspace。本期不做强制互斥锁。

### 20.6 API

`POST /sa/api/assistant/host-ticket` 响应增加 `peer_sessions: number`（默认 0）。

`POST /sa/api/assistant/page-bridge/snapshot` 在 `revision < 已存 revision` 时仍 409，`data.current_revision` 为服务端当前值。
