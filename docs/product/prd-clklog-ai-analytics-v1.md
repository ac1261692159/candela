# PRD：ClkLog AI 数据分析助手 v1

> phase: clklog-ai-analytics-v1
> 状态：MVP 已实现；生产验收与后续增强见 `CODE_HANDOVER.md`
> 产品形态：完整 DeepSeek Harness 能力嵌入所有分析页右侧
> 上游：`docs/product/prd-clklog-analytics-v1.md`、`docs/product/prd-clklog-analytics-sql-report-v1.md`
> 下游：`docs/architecture/clklog-ai-analytics-design.md`

---

## 1. 阶段目标与范围

在事件分析、漏斗分析、留存分析和自定义 SQL 页面右侧嵌入完整的 DeepSeek Harness 对话体验。AI 不只是解释聚合结果，还能使用 Harness 原生命令、模型与思考强度选择、权限预设、计划、目标、会话、Workspace、文件、Skills 和沙盒内工具；同时通过受控页面能力桥读取当前分析状态并提出页面修改。

本 phase 包含：

- 服务端与 Harness Runtime 统一升级到 Node.js 24 LTS；
- 多供应商、多模型及多思考强度配置；
- 默认展开且可拖动调整宽度的右侧 AI 面板；
- 每个用户、项目隔离的临时与永久 Workspace；
- 管理员可维护、版本化并同步到全部用户 Workspace 的初始化 Workspace；
- Harness 与分析页面之间的结构化读取、修改提案、用户确认和回执协议；
- Harness 原生能力在隔离 Runtime 中运行，不能获得宿主机权限或跨用户数据权限。

## 2. 用户与核心场景

| 用户 | 核心场景 |
|---|---|
| 运营 | 围绕当前事件趋势连续追问，并让 AI 调整分析条件 |
| 产品 | 解释漏斗或留存结果，制定并执行验证计划 |
| 数据分析师 | 读取当前 SQL，生成修改 diff，确认后写回编辑器并执行受控查询 |
| 研发 | 使用事件/属性字典和 Workspace 脚本定位埋点与数据问题 |
| 管理员 | 配置供应商和模型，维护初始化 Workspace，将分析经验与辅助脚本同步给全部用户 |

## 3. 全局右侧 Harness 面板

### 3.1 展示与布局

- 面板覆盖 `/analysis/event`、`/analysis/funnel`、`/analysis/retention`、`/report/sql`。
- 默认在 xl/lg 档停靠展开；用户仍可主动折叠。md 及更窄默认收起，点开为覆盖层。
- 停靠宽度、最小宽度、何时收起/覆盖：**以 `prd-clklog-analytics-shell-responsive-v1.md` 与其架构文档为 SSOT**。本段旧值（默认 480px、最小 320px、最大 42vw、<960px 全屏）作废，不得再实现。
- 拖动左侧独立分隔槽调整宽度仅在**已经停靠且不低于停靠下限**时有效；必须按下后移动才改宽度，命中区不覆盖 Harness iframe。
- 宽度和折叠意图按登录用户保存，但不得把低于停靠下限的侧栏画出来。
- 面板在分析路由的公共布局中挂载，页面切换不销毁当前会话。

### 3.2 Harness 原生体验

面板采用官方 Harness Web Profile 的组合能力，不以若干自制按钮替代原生交互。至少保留：

- 流式回答、思考过程、停止生成、重试和继续会话；
- 会话列表、恢复、压缩与导出；
- `/compact`、`/export`、`/feedback`、`/goal`、`/permission`、`/plan`、`/model` 等已注册命令及命令面板；
- 按供应商分组的模型选择和模型声明支持的思考强度选择；
- `Read Only`、`Workspace Write`、`Danger Full Access` 权限预设与逐次审批；
- Plan、Goal、文件、工具调用卡片、Skills、Jobs/Subagents 等所选官方 Web Profile 能力；
- 附件、错误、审批、工具结果等结构化状态，不降级为纯文本聊天记录。

以下能力保留产品入口，但受平台安全边界约束：

- `Danger Full Access` 只表示当前隔离 Runtime 内的完全权限，不是宿主机权限；它仍可能删除当前 Workspace 的可写内容及同用户/项目 DSH Home 中的会话历史；
- 普通用户不能新增任意模型供应商、安装任意插件或打开任意网络出口；
- `/feedback` 不得静默向外部发送数据，实际接收方和发送结果必须对用户明确；
- `/export` 只允许导出当前用户自己的会话，导出前移除密钥、token 和内部认证信息。

## 4. 供应商、模型与思考强度

- 运维人员可在服务端配置多个供应商，每个供应商可声明多个模型。
- YAML 键名使用小写 snake_case，供应商 ID 使用小写 `[a-z0-9_-]+`。
- 普通用户只能选择管理员允许的供应商、模型和思考强度。
- 模型选择和 `/model` 命令使用同一份服务端目录，不能出现选项不一致。
- 思考强度只展示当前模型明确声明支持的选项。
- 环境变量密钥优先于配置文件密钥；环境变量为空时回退配置文件。
- 环境变量名称默认由供应商 ID 派生：`tencent` 对应 `TENCENT_API_KEY`，`deepseek_official` 对应 `DEEPSEEK_OFFICIAL_API_KEY`。
- 单个供应商缺少密钥时只将该供应商标记为不可用；默认供应商不可用时面板显示可操作错误。

## 5. 会话与 Workspace

### 5.1 隔离维度

- 会话、Harness Home 和 Workspace 按登录用户与项目隔离。
- 切换项目后切换到新项目的会话和 Workspace，不继承其他项目上下文。
- 多浏览器标签页通过 `tab_id` 精确绑定页面能力，不能误改另一个标签页。
- 默认不提供跨用户共享 Workspace；管理员初始化模板不等于共享用户 Workspace。

### 5.2 永久 Workspace

- 每个用户、项目默认创建名为 `default` 的永久 Workspace。
- 跨会话、进程重启和发版保留。
- 用户可创建和切换其他永久 Workspace。
- 只允许显式删除，并保留删除审计。

### 5.3 临时 Workspace

- 每个临时 Session 使用独立 Workspace。
- 最后访问 24 小时后自动回收。
- 回收前用户可以将其转为永久 Workspace。
- 临时 Workspace 与永久 Workspace 使用相同初始化模板和只读同步规则。

### 5.4 初始化状态

- 新 Workspace 从当前已发布的初始化模板创建，并记录模板版本。
- 上线前已经存在且没有模板记录的 Workspace 标记为 `legacy_uninitialized`。
- 遗留 Workspace 的普通初始化文件不自动补齐；管理员可单独执行“初始化遗留 Workspace”。

## 6. 管理员初始化 Workspace

### 6.1 管理入口

新增管理员页面 `/sa/admin/ai/workspace`。只有 `admin` 角色可以：

- 创建、编辑、移动、重命名和删除模板文件或目录；
- 上传辅助脚本，设置可执行位；
- 将文件标记为只读，将目录标记为递归只读；
- 保存草稿、预览 diff、发布不可变版本；
- 同步全部 Workspace，或按项目、用户、Workspace 类型选择目标；
- 查看同步进度、失败原因、审计和恢复副本；
- 选择旧版本重新发布和同步。

初始化模板对普通用户不可编辑。模板内容对使用它的用户和 AI 可读，因此不能把密钥或隐藏权限数据写进模板。

### 6.2 文件策略

| 策略 | 管理员选择方式 | 新 Workspace | 已有 Workspace |
|---|---|---|---|
| `managed_readonly` | 标记文件只读或目录递归只读 | 复制并只读挂载 | 强制镜像同步 |
| `seed_once` | 未标记只读 | 初始化时复制为用户文件 | 后续永不覆盖 |

同步语义：

- 新增 `managed_readonly` 路径：同步新增；
- 修改 `managed_readonly` 路径：无须普通用户确认，强制覆盖；
- 从模板删除 `managed_readonly` 路径：从所有目标 Workspace 删除，但先备份；
- `managed_readonly` 改为 `seed_once`：停止后续同步，当前副本转为用户可写；
- `seed_once` 改为 `managed_readonly`：备份现有同名内容后强制接管；
- 删除或修改模板中的 `seed_once`：不影响已有 Workspace，只影响以后新建的 Workspace；
- 只读目录的规则递归作用于全部后代路径。

### 6.3 发布与恢复

- 管理员先编辑 draft，再发布新版本，不能直接修改已发布版本。
- “同步全部”是后台、幂等、可重试的同步任务；管理员一次确认后不再逐个询问普通用户。
- 覆盖和删除前在目标 Workspace 的 `.clklog/recovery/<sync_job_id>/` 保存恢复副本。
- 同步审计至少记录操作人、模板版本、文件 diff、目标范围、每个 Workspace 的结果和时间。
- 同步前停止目标 Workspace 的活动 Runtime，已完成会话日志保留在 DSH Home；同步后用户重连恢复会话列表，正在进行的输出可能中断。

## 7. 页面上下文与页面能力桥

### 7.1 读取

每个分析页向当前 AI Session 注册结构化快照：

- 页面类型、路由、`tab_id` 和单调递增 `revision`；
- 当前 DSL、SQL 模式、SQL 文本、选区和时间范围；
- 最近一次查询的列定义、聚合结果摘要、行数、耗时和截断状态；
- 当前登录用户和服务端绑定项目的不可伪造引用。

不通过 DOM、鼠标模拟或浏览器自动化读取编辑器。页面快照在进入模型前继续执行大小限制和敏感字段裁剪。

### 7.2 修改 SQL 编辑器

1. Harness 调用页面读取工具获取当前 SQL 和 `revision`。
2. Harness 返回结构化修改提案：新 SQL、diff、解释和 `expected_revision`。
3. 页面展示“应用/拒绝”，默认不自动覆盖。
4. 用户确认且 revision 一致时，由 React 状态更新 CodeMirror。
5. revision 已变化时拒绝应用并提示重新生成。
6. 页面向 Harness 返回应用或拒绝结果。

执行 SQL 是独立动作：编辑确认不等于执行确认。执行仍通过现有安全 SQL API，并强制项目、时间范围、只读账号、LIMIT 和超时。

事件、漏斗和留存页面在 MVP 中发布结构化快照；其表单/DSL 写回 action 留作增强项。SQL 页已实现完整的读取、提案、确认写回和独立执行确认。

## 8. 权限与安全体验

Harness 权限分为两个互不替代的维度：

| 维度 | 示例 | 规则 |
|---|---|---|
| Runtime/文件权限 | Read Only、Workspace Write、Danger Full Access | 只影响当前隔离 Runtime 和 Workspace |
| ClkLog 页面/API 权限 | 读取页面、提出修改、执行查询 | 由登录角色、项目绑定和逐次确认控制 |

- `Workspace Write` 不能自动获得 SQL 执行权限。
- `Danger Full Access` 不能读取宿主机目录、其他用户 Workspace、部署源码或数据库凭据。
- AI 读取页面和提出修改可以自动执行；实际写回页面需要用户确认。
- 查询执行默认再次确认，且不能绕过现有服务端查询守卫。

## 9. 回答、数据与隐私要求

- 默认用中文回答，先给结论，再列证据、口径和建议。
- 数字必须来自页面上下文或工具结果；事实、推测和建议验证明确区分。
- 页面结果默认最多发送 100 行，单字段最多 2,000 字符，整体最多 128 KiB。
- `distinct_id`、`user_key`、`device_id` 和手机号、邮箱、证件号默认移除或脱敏。
- 登录 token、数据库凭据和供应商密钥不得进入 prompt、会话正文、前端响应、导出包或日志。
- MVP 以 Harness 会话日志和模型出口结构化日志记录用户、项目、模型、供应商、耗时与结果状态；工具审计持久化及供应商未返回时的 token 用量统计留作增强项。

## 10. 验收标准

- [ ] **AI-1**：四个分析页共用右侧 Harness 面板，默认在 xl/lg 停靠、可折叠、可拖动；宽度与收起规则改走 `prd-clklog-analytics-shell-responsive-v1.md` SH-3/SH-6/SH-8（旧 320px～42vw 作废）。
- [ ] **AI-2**：md 及更窄默认收起 Harness；用户点开为覆盖层或全屏，主分析页与 AI 入口均可到达（细则 SH-7/SH-8）。
- [ ] **AI-3**：原生命令面板、会话、流式状态、工具卡片、审批、Plan、Goal、文件、Skills 和所选 Profile 能力可用。
- [ ] **AI-4**：`/model` 与 composer 模型选择展示一致的多供应商模型目录，并只展示模型支持的思考强度。
- [ ] **AI-5**：配置中可声明至少两个供应商；环境变量密钥覆盖配置密钥；缺少单个供应商密钥不会拖垮其他供应商。
- [ ] **AI-6**：Harness 使用配置指定的非 root Linux 用户运行，目录根从该用户真实 home 推导。
- [ ] **AI-7**：默认永久 Workspace、临时 Workspace、24 小时回收和转永久流程全部可验证。
- [ ] **AI-8**：新 Workspace 完整应用当前模板，并准确记录初始化版本。
- [ ] **AI-9**：管理员能编辑、发布、预览和同步初始化模板；普通用户无法调用对应管理接口。
- [ ] **AI-10**：`managed_readonly` 的新增、覆盖、删除、策略转换和递归目录同步符合 §6.2，覆盖/删除前均有恢复副本。
- [ ] **AI-11**：`seed_once` 只影响新 Workspace；已有 Workspace 的同名用户文件不被模板更新覆盖。
- [ ] **AI-12**：遗留 Workspace 默认只接收只读受管项，只有管理员显式初始化时才补充缺失 seed 文件。
- [ ] **AI-13**：Harness 即使尝试修改、删除或替换只读受管路径也失败；管理员发布后内容可以同步更新。
- [ ] **AI-14**：SQL 页读取当前 SQL 和 revision，生成 diff，经用户确认后写回受控 CodeMirror；多标签页和 revision 冲突不会误覆盖。
- [ ] **AI-15**：SQL 执行与编辑分离确认，所有查询仍强制项目、时间、LIMIT、超时和只读账号。
- [ ] **AI-16**：用户、项目、会话、DSH Home 与 Workspace 严格隔离；跨用户、跨项目和跨标签页测试全部拒绝。
- [ ] **AI-17**：`Danger Full Access` 只能影响当前隔离 Runtime；宿主机目录、其他用户/项目的 Workspace、Docker Socket 和内网任意地址不可达。
- [ ] **AI-18**：模板同步任务幂等、可恢复、可审计；同步活动 Runtime 后已完成会话可重连恢复。
- [ ] **AI-19**：Harness、供应商或页面桥失败时只降级 AI 面板，不影响分析页面主功能。
- [ ] **AI-20**：前后端构建、Node 24 运行验证、假模型测试、真实供应商测试和至少 20 条分析问题回归通过。

## 11. 非目标

- 不赋予 Harness 宿主机 root 权限，不把宿主机完整 home、应用目录、Docker Socket 或数据库目录挂入 Runtime。
- 不允许普通用户编辑供应商、任意添加网络出口、安装任意插件或修改初始化模板。
- 不提供跨用户共享 Workspace、协同编辑或管理员冒充用户对话。
- 不允许 AI 绕过用户确认自动写回分析页面或自动执行自定义 SQL。
- 不修改 ClkLog 社区版容器、源码和表结构，不把社区版数据链路变成 Harness 依赖。
- 不在本期实现模型微调、向量数据库、因果推断、预测决策或定时主动洞察。
- 暂时提交供应商明文密钥属于经项目所有者批准的阶段性例外，不将其扩展为其他密钥的通用存储方案。

## 12. 降级与错误路径

| 场景 | 用户体验 |
|---|---|
| 默认供应商不可用 | 面板保留，显示原因并允许选择其他可用模型 |
| Harness Runtime 启动失败 | 显示重试和错误码，不显示进程环境、路径或堆栈 |
| Sandbox 无法达到强制隔离 | Fail closed，不降级为宿主机裸进程 |
| 页面尚未查询 | AI 可读取当前表单/SQL，并明确当前没有结果 |
| 页面已关闭或标签页失联 | 页面工具返回 `page_unavailable`，不广播到其他标签页 |
| SQL revision 冲突 | 保留提案，拒绝覆盖，允许基于最新 SQL 重新生成 |
| 模板同步部分失败 | 已成功目标不回滚；失败目标可重试，并保留逐项结果和恢复副本 |
| 切换项目 | 中止当前展示中的 turn，切换到目标项目的会话和 Workspace |

---

## 13. 后续 phase：Harness 会话保活

> phase: `clklog-ai-harness-session-v1`
> 范围：同一浏览器登录期内 Harness iframe 只启动一次；Page Bridge revision 可恢复；同账号多窗口不合并实时对话。
> 上游：本文 §3 / §7；实现见 `docs/architecture/clklog-ai-analytics-design.md` §18。

### 13.1 阶段目标

用户打开分析平台后，DeepSeek Harness 在本浏览器标签内只初始化一次。从「分析」切到看板/埋点再切回，不得拆掉 iframe、不得重新领取启动票据、不得弹出「页面 revision 已过期」。

### 13.2 验收标准

- [ ] **AI-S1**：登录后首次进入任一分析页启动 Harness；切到非分析菜单再回来时 iframe `src` 不变，无「正在启动隔离 Harness」整页重入。
- [ ] **AI-S2**：切走再切回不出现「页面 revision 已过期」toast；快照 409 由客户端按服务端 `current_revision` 续号，不打扰用户。
- [ ] **AI-S3**：折叠面板或离开分析路由时 iframe 仍保留在 DOM（可移出视口）；仅切换项目、切换 Workspace、点「重新连接」或退出登录才重建。
- [ ] **AI-S4**：同一账号的另一浏览器窗口打开同一 Workspace 时，本窗口显示提示：对话文件可能互相覆盖；SQL 写回只作用于本标签的 `tab_id`。提示可关闭；关闭后本窗口不再出现，关闭浏览器窗口后再开才重新显示。不把两个窗口的实时 token 流合成一条对话。
- [ ] **AI-S5**：Page Bridge 长轮询失败、请求取消、快照 409 不走全局错误 toast。交付前 `python3 scripts/arch_ratchet.py` 退出码 0。

### 13.3 非目标

- 不实现跨窗口 CRDT / 操作变换合并对话。
- 不把不同账号的 Workspace 做成共享文档。
- 不在本期做「接管并踢掉另一窗口」的强制锁。
- 不修改 Harness 官方 Web 包源码以消除其内部 `startTime` 报错；通过避免拆 iframe 消除诱因。
