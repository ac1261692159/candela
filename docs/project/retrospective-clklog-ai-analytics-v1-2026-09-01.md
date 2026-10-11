# 复盘与红线覆盖记录：ClkLog AI 数据分析助手 v1

> phase: clklog-ai-analytics-v1
> 日期：2026-09-01
> 状态：目标设计已由项目所有者确认；实现尚未按新设计开始
> 产品基线：`docs/product/prd-clklog-ai-analytics-v1.md`
> 架构基线：`docs/architecture/clklog-ai-analytics-design.md`

---

## 1. 记录目的

本记录回答三件事：

1. 为什么此前已实现并部署的受限 AI 对话框不能直接作为最终方案继续扩展；
2. 项目所有者明确批准了哪一项临时红线覆盖，如何限制影响并退出；
3. 新方案进入实现前必须完成哪些门禁，避免再次先写代码再对需求。

## 2. 事件概述

此前在需求细节尚未逐项确认时，项目已经实现并部署了第一版 AI 数据分析助手。该版本采用受限 Harness SDK 子进程和简单 JSON 对话接口，默认关闭命令、模型选择、思考强度、文件、Shell、Skills、Subagents 和 Workspace；配置以单供应商环境变量为主，面板及自定义 SQL 交互也没有覆盖最终要求。

项目所有者随后暂停继续改造，补充并确认以下目标：

- 服务端升级 Node.js 24 LTS；
- `config_server.yaml` 使用全小写、多供应商配置，环境变量按 `<PROVIDER>_API_KEY` 覆盖配置密钥；
- 面板默认展开、可拖动且最大 `50vw`，保留完整 Harness 体验；
- Harness 使用配置指定的 Linux 用户，运行目录基于其真实 home；
- 同时支持临时、永久和管理员初始化 Workspace；
- 管理员可发布受管只读文件/目录并强制同步全部 Workspace，普通初始化文件只复制一次；
- Runtime 必须隔离，页面交互通过结构化 Page Bridge，不操作 DOM；
- SQL 修改和 SQL 执行分别确认。

2026-09-01，项目所有者回复“按这版”，确认以上产品与架构方向。

## 3. 偏差与影响

### 3.1 偏差

- 在“完整 Harness”含义、Workspace、管理员模板、页面写回和 Sandbox 边界尚未确认前进入实现。
- 旧 PRD/架构把“关闭原生能力”写成验收标准，与最终目标相反。
- 先发版后对需求，导致线上存在一个可运行但不满足最终验收范围的过渡实现。
- Node 20 上 Harness 完整握手存在兼容问题，进一步证明运行基线没有先形成门禁。

### 3.2 影响

- 已有代码需要按新架构重构，不能仅增加几个前端按钮。
- 旧版受限 AI 功能继续作为迁移/回滚基线，但不标记 phase 验收完成。
- 本次复盘未发现对 ClkLog 社区版表、原数据链路或分析数据造成破坏。
- 当前工作区中的 `config_server.yaml` 是项目所有者的未提交修改，本次文档阶段保持原样。

## 4. 根因

- 将“集成 Harness”过早理解成一个窄范围 SDK 调用，而没有先确认是否要求完整 Web/命令/Workspace 体验。
- 没有先把产品问题拆成 UI、Provider、Workspace、Sandbox 和 Page Bridge 五个独立决策。
- 把可快速部署视为可以跳过需求对齐，没有执行仓库规定的“产品文档 + 架构文档”实现门禁。

## 5. 纠正措施

- 已停止继续修改代码、配置、服务器和生产环境。
- 重写 AI PRD 和架构设计，以本次确认方案替代旧受限方案。
- 修正自定义 SQL PRD/架构中“AI 默认折叠占位”的冲突描述。
- 在 README 中将 AI 阶段标记为“重构设计已确认、实现待开始”，不再称旧方案已完成核心。
- 后续必须按文档顺序推进：Node/配置 → Linux 用户与隔离 → Harness Host → Workspace/模板 → Page Bridge → 测试/部署。
- 任何新增需求先写回 PRD/架构，再进入代码；验收以稳定 ID `AI-*`、`ARCH-AI-*` 为准。

## 6. 临时红线覆盖

### 6.1 授权

项目所有者明确说明当前系统和机器只有其本人拥有开发权限，并明确批准阶段性把 AI 模型供应商密钥写入 `apps/analytics-server/config_server.yaml` 并提交，同时保留环境变量覆盖。

提交说明必须包含：

```text
OVERRIDE-REASON: 当前仅项目所有者拥有开发与机器权限，
用户明确要求阶段性将供应商密钥提交到私有仓库，
用于多供应商 Harness 联调。
```

### 6.2 覆盖范围

仅覆盖 AGENTS.md 红线 3 中以下路径：

```text
deepseek_harness.providers.<provider_id>.api_key
```

不覆盖：

- ClkLog 管理员密码；
- ClickHouse、MySQL、Kafka、SSH、CI 或部署凭据；
- 登录 token、用户 session、页面 capability token；
- 把密钥打印到日志、API、前端、prompt、会话导出或测试快照。

### 6.3 缓解措施

- 环境变量 `<PROVIDER>_API_KEY` 始终优先，以便不改配置就能紧急轮换。
- 配置校验、健康检查和日志只能返回密钥来源，不返回值。
- 完整配置文件不挂载到 Harness Runtime；真实密钥由模型出口网关持有。
- 联调验收后轮换已提交的供应商密钥，并优先使用环境变量覆盖。
- 删除后不默认重写 Git 历史；如需历史清理，必须另行取得明确授权并评估所有 clone/CI 缓存。

### 6.4 退出条件

以下全部完成后，临时覆盖结束：

- 至少一个配置密钥和一个环境变量覆盖密钥完成真实模型验收；
- 多供应商模型切换和日志脱敏验收通过；
- 已提交的联调密钥完成轮换；
- `config_server.yaml` 中的明文 key 被清空或替换为无效测试值；
- README 和本记录更新为“覆盖已结束”，并关联完成提交。

本记录与 PRD、架构文档在实现提交前完成，因此“24 小时内补文档”的要求提前满足。实际包含密钥的提交尚未产生，届时必须在提交说明中关联本记录。

## 7. 其他红线处置

| 红线 | 处置 |
|---|---|
| 不侵入社区版 | AI 只调用旁路分析 API，不改社区版源码或表 |
| ClickHouse 查询有界 | SQL/DSL 继续强制 project、时间、LIMIT、超时和只读账号 |
| 不删除/静默改写数据 | 管理员覆盖/删除 Workspace 文件前自动备份并写审计 |
| 服务器配置真相在 Puppet | 首次 `useradd harness` 与 Puppet user 资源在同一实现批次落地 |
| 目录权限 | `/home/<linux_user>/clklog-ai` 单独建模，不改 ClickHouse/Flink 目录 owner |

## 8. 实现门禁与顺序

### 8.1 进入实现前

- [x] 产品 PRD 包含 phase、范围、验收标准和非目标。
- [x] 架构文档包含 phase、范围、验收标准和非目标。
- [x] 多供应商、密钥优先级、Linux 用户、目录和同步语义已确认。
- [x] 页面桥、SQL 两次确认和 Runtime 安全边界已确认。
- [x] 临时红线覆盖已有书面记录。
- [ ] 文档 diff 完成一致性检查并由项目所有者决定是否进入代码实现。

### 8.2 实现顺序

1. Node.js 24、配置 schema 和密钥解析测试。
2. Puppet/部署中的 `harness` 用户、home 目录与权限。
3. Runtime Broker、容器隔离、模型出口和 Sandbox fail-closed。
4. Harness Host Profile、原生命令、模型与 reasoning effort。
5. Workspace 元数据、bootstrap 模板、管理员编辑/发布/同步。
6. 右侧面板、Page Bridge 和 SQL revision/diff/确认。
7. 本地测试、CI、手动 CD 和生产浏览器验收。

不得因 CI/CD 速度快而合并未完成安全隔离或未通过门禁的中间状态。

## 9. 验收与关闭

本记录在下列条件同时满足后关闭：

- PRD 的 `AI-1` 至 `AI-20` 全部有验证证据；
- 架构的 `ARCH-AI-1` 至 `ARCH-AI-17` 全部通过；
- 生产浏览器验证命令、模型、effort、Workspace、管理员同步和 SQL 写回；
- 宿主机越权、跨用户/项目和受管只读路径测试通过；
- 临时密钥覆盖按 §6.4 退出或项目所有者书面延长。
