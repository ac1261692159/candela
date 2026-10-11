# AGENTS.md — Candela（Agent 工作规则）

> 本仓库是 **Candela**：开源、可私有化的用户行为分析平台（旁路跑在 ClkLog 社区版之上）。
> 项目入口看 `README.md`（含三件套部署），文件导航看 `INDEX.md`，**接手/交接看 `docs/project/handoff-candela-new-repo.md`**（仓库来源、目标机现状、待办与已知坑）。
> **部署真相在 `scripts/standalone-test-env/`**（脚本 + 渲染配置）——本仓库没有 Puppet 与内网 CI 发版链路。旧生产运维记录已撤出，见 `docs/project/legacy-production-handover.md` 的说明。公开检查在 `.github/workflows/ci.yml`；GitLab 发版模板在 `scripts/gitlab-ci.yml.template`。

---

## 项目与帽子

修改代码或文档前，先确认当前帽子；同一时刻只戴一顶：

| 帽子 | 工作目录 | 只回答 |
| ---------------- | ----------------------------------- | ------------------ |
| 架构 / 愿景 | `docs/architecture/` | 应该是什么？ |
| 产品 | `docs/product/` | 怎么无歧义地描述？ |
| 项目 | `docs/project/` | 怎么按时拼到一起？ |
| 程序 / 实现 | `apps/`（分析服务源码）、`scripts/`（构建、部署、门禁脚本） | 如何稳定实现与验证？ |
| 数据 / 配置 | `apps/analytics-server/config_server.yaml`（部署期配置源）、`apps/analytics-{server,web}/Dockerfile`、`deploy-assets/clklog-community/`（上游 ClkLog 资产，只读） | 实体、关系和配置如何成为可执行真相？ |

可增删帽子，但每顶帽子必须有：**唯一工作目录** + **唯一问题**。

**增删帽子须用户明确同意**；Agent 不得自创帽子或私自改帽子表职责边界。仅允许在已批准前提下，按「帽子工作目录与仓库对齐」修正路径字符串。

做设计时不考虑排期，拆解时不扩写创意，排期时不重新设计；产出放入对应帽子的目录。

### 戴上「程序 / 实现」之前的门禁

切换到或开始「程序 / 实现」工作前，本地必须已有完整前置文档，缺一不可：

1. **产品设计文档**（产品帽产出，在 `docs/product/`）
2. **实现方案文档**（架构帽产出，在 `docs/architecture/`）

两份文档须落地为仓库内真实文件（不可只存在于对话）。每份（或二者共同引用的 phase 块）须同时包含以下要素，**缺一视为门禁未过**：

| 要素 | 最低要求 |
|---|---|
| `phase` id | 稳定标识（如 `phase: clklog-analytics-v1`），可检索、可引用 |
| 阶段目标与范围 | 本次做什么 |
| 验收标准 | 可核对的完成条件（测试名、检查清单或明确断言均可） |
| 非目标 | 明确不做什么，防止范围蔓延 |

缺文档或门禁要素不全时：先补文档，再写代码；不要边实现边补方案冒充门禁已过。

### 帽子工作目录与仓库对齐

若仓库目录结构与帽子表工作目录不一致：

- **改本文件帽子表里的工作目录**，使其指向仓库真实路径；
- 不要为迁就帽子表去搬迁/虚构目录，也不要在错误路径下继续写文件。

对齐后若 `INDEX.md` 任务入口仍指向旧路径，同步改索引条目。

### 紧急覆盖（唯一逃生口）

仅当用户明确要求，或存在不可拖延的安全/数据损坏风险时，可暂时突破帽子或程序门禁。必须同时满足：

1. 提交说明或会话结论中声明 `OVERRIDE-REASON: [具体原因]`；
2. **24 小时内**补全缺失文档，并关联该提交 / 会话；
3. 事后在 `docs/project/` 留一条复盘记录。

不得将 OVERRIDE 用于「省事跳过设计」。

---

## 文档与 SSOT 边界

| 层 | 唯一职责 | 不承担 |
| ------------- | ---------------------- | ------------------- |
| `README.md` | 面向人的项目现状与入口（含部署步骤） | Agent 行为规则、完整文件清单 |
| `AGENTS.md` | Agent 必须遵守的工作规则 | 易变化的阶段、数量和文档摘要 |
| `INDEX.md` | 按需文件导航与结构元数据 | 业务百科、当前阶段、行为规则、完整正文 |
| 规格 / 设计文档（`docs/`） | 目标、rationale、验收标准、设计红线 | 运行时字段值权威 |
| 代码 / 配置 / 部署脚本（`apps/`、`scripts/`、`deploy-assets/`） | 可执行行为、类型真相、部署期渲染值 | 在注释或 PR 描述里另起权威定义 |

链路：总体方案（`docs/architecture/analytics-extension-plan.md`）→ PRD（`docs/product/`）→ 架构设计（`docs/architecture/`）→ 服务代码（`apps/`）→ 部署脚本与配置渲染（`scripts/standalone-test-env/`）→ 部署与验收。

新建或修改「权威数值 / 实体 / API 契约」只写 SSOT 层；规格文档只写意图、体验与设计理由。ID、接口约定以架构文档为准，不在引用处硬编码文档版本号。

---

## 绝对红线

1. **不可侵入 ClkLog 社区版**：不修改官方容器镜像、不 fork 改造 `clklog-processing`/`receiver` 源码、不 ALTER 社区版表（`clklog.log_analysis` 及 19 张聚合表）；分析域一律旁路扩展（新库 `clklog_sa` / `clklog_sa_meta`、新消费组），保证官方升级可用。**上报协议的标识（`ClkLogClient`、`CLKLOG_ENDPOINT` 等）属上游协议，不得随品牌更名而改**。
2. **不可破坏数据链路**：`SDK → nginx → receiver → Kafka → Flink → ClickHouse` 任一环节改动必须先灰度验证；本仓库的验证入口是 `scripts/standalone-test-env/verify.sh`（12 项）与 `.../candela/verify.sh`（19 项），两者都做端到端上报 + 入库行数核对。
3. **不可把密钥写入仓库**：口令/token 只允许由部署脚本生成并落在目标机（`/data/app/candela/configs/candela.env`、`/data/clklog-oss-test/config/deploy.env`，均 0600）；`.env` 与明文口令文件不入库，也不得抄进对话、提交说明或文档。
4. **ClickHouse 分析查询必须有界**：强制 `project_name` 过滤 + 时间范围 + LIMIT/超时；自定义 SQL 只用只读账号（`sa_readonly`）执行，禁止 INSERT/ALTER/DROP/ATTACH。
5. **目录属主红线**（部署脚本强制，脚本里已注释说明）：ClickHouse 数据/日志目录必须 UID **101**、Flink checkpoints 必须 UID **9999**，Redis 配置与 Flink 配置文件必须对容器运行用户（999 / 9999）可读；不要用统一 chown/chmod 覆盖。
6. **不可删除或静默改写数据**而无备份与审计记录；DDL 变更（尤其 `sa_events`）先在测试库演练。
7. **部署真相在部署脚本**：不可在目标机上手工改容器/配置/nginx 而不回写仓库（`scripts/standalone-test-env/**` 与 `apps/analytics-server/config_server.yaml`）；平台运行配置 `configs/config.yaml` 由脚本渲染，手工改动会在下次部署被覆盖。

红线是产品宪章，不是代码风格偏好。触及相关改动须在 PR 中声明「红线未自动检：[条目]」。

---

## 实现专用规则

- **工作范围**：`apps/`（服务源码）、`scripts/`（构建、部署、门禁）。`deploy-assets/clklog-community/` 是上游 ClkLog 的资产副本，只读，不在此处改业务配置。不把规格表格改成字段 SSOT。
- **本地开发**（前后端分开起，需要可用的 MySQL / ClickHouse / Redis / Kafka）：
  ```bash
  cd apps/analytics-server && npm ci && npx prisma generate && npm run start:dev   # HTTP :3100
  cd apps/analytics-server && npm run start:ingestor:dev                           # Kafka 消费者（独立进程）
  cd apps/analytics-web && npm ci && npm run dev                                   # Vite :8180，代理 /sa/api → :3100
  ```
- **部署（三件套，均幂等，不依赖 CI/CD）**：`scripts/standalone-test-env/deploy-remote.sh mw` → `... clklog` → `... candela/deploy-remote.sh native|docker`。用户要求「部署/发版/上生产」时按 `README.md` 的部署章节执行；两套平台方案（常规 supervisord / Docker Compose）互斥，脚本会自动停对方。目标机与部署根可用 `HOST=` / `BASE_DIR=` / `MW_BASE_DIR=` 覆盖。
- **发版后的验收（缺一不可）**：`bash .../candela/deploy-remote.sh verify`（平台 19 项）与 `bash .../deploy-remote.sh verify`（中间件 + 社区版 12 项）；两者都验证「上报 → `log_analysis` 与 `sa_events` 行数同时增长」。仅看容器/进程状态不算验证通过。
- **判定「产物就绪」用内容标记，不用文件名/哈希比对**：前端 chunk 名本地与 CI 可能不同，按文件名比对会得到假的「产物是旧的」；用「本次新增的符号/文案是否出现在产物里」判定（并先用已知存在的符号验证核验方法本身可用）。
- **改到 AI Harness 的两处内容要各自走一步**（本仓库 harness 默认关闭，只在启用 harness 的环境需要）：
  - 改了 `ai_workspace/default/**` → 显式推模板 `bash scripts/ai-workspace-sync.sh push default`（推送前先 `diff` 确认只有自己改的文件；`default/` 也是平台 UI 的模板草稿，存在双写）。
  - 改了 `apps/analytics-harness-host/**`（含 `plugins/analytics-tools` 工具定义）→ 重装运行时 `bash scripts/install-harness-runtime.sh <release 目录>`，随后**重启 broker**（它在启动时 `realpath` 一次 `harness_host`，不重启就仍用旧 release）。
- **改了容器资源限制**（`Dockerfile` / compose 的 `deploy.resources`）必须重建容器：`docker compose up -d` 不检测 `deploy.resources` 变化。
- **ClickHouse 验证**（在目标机上；口令从该机 env 文件读，不回显）：
  ```bash
  curl -sS -u "default:$CK_USER_PWD" 'http://127.0.0.1:8123/' --data-binary '<SQL>'
  ```
- 分析域实体 ID（事件 / 属性 / 虚拟事件 / 看板 / 卡片）遵循 `docs/architecture/clklog-analytics-design.md` 的 ID 约定；不在调用方另起 ID。
- **PR / 交付附变更证据**：容器或进程状态、ClickHouse 查询结果、验收脚本输出，或明确声明未部署。
- **交付前自检三件**：`python3 scripts/arch_ratchet.py`（结构棘轮）、`python3 scripts/i18n_check.py` + `python3 scripts/i18n_scan.py --check`（i18n 两道门禁）；改了文档再跑一次链接校验（相对链接与反引号路径都要真实存在）。

---

## 通用文件规则

- 新增、删除、重命名文档或变更目录结构后，同步更新 `INDEX.md` 对应条目和 `RUNTIME-META` 计数。
- 项目阶段或里程碑变化时，更新 `README.md` 与项目文档；不要在 `AGENTS.md` 或 `INDEX.md` 复制阶段快照。
- `INDEX.md` 的 `最后全量扫描` 距当前日期超过 7 天时，提示用户是否重新扫描；未超过时不提示。
- 规格/PRD 命名保持稳定约定（`prd-{系统名}-v{N}.md`），放在 `docs/product/` 下。
- 改动触及公共契约（API、事件、配置键、数据库列）时，同步更新 `docs/architecture/` 契约文档。
- 不要默认通读整个索引；先用关键词定位，再读相关章节；只有任务范围不清时才读根索引。

---

## 索引维护

`INDEX.md` 文末保留等价说明：

> 维护触发条件、命名规则和保鲜检查见 `AGENTS.md`。目录计数统一按 `rg --files <目录> -g '*.md'` 口径；全量扫描时更新 `最后全量扫描` 和 `下次计划扫描`。

Agent 侧必须遵守：

- **触发更新**：文档增删改名、目录结构调整、全量扫描、或用户明确要求刷新索引时。
- **计数口径**：`rg --files <目录> -g '*.md'`；不要用「肉眼估数」覆盖 `RUNTIME-META`。
- **全量扫描**：更新 `最后全量扫描` 与 `下次计划扫描`（默认 +7 天）；扫描结果写回各目录计数，不把业务摘要抄进 `AGENTS.md`。
- **命名**：索引内链接路径与仓库真实路径一致；任务入口表保持「任务 → 首选文件」，不堆长文。
- **失效处理**：发现索引条目指向的路径不存在 → 标记 `⚠️ 路径失效（发现于: {日期}）`，**不删除条目** → 并触发「帽子工作目录与仓库对齐」检查。不得因死链直接放弃任务。

---

## 系统代码架构硬门禁（精简版）

> 分级同步自分发源模板 `docs/architecture/templates/AGENTS_exec.md`（TEMPLATE-VERSION 1.0）；作用域限 `apps/`（NestJS 后端 + React 前端）。裁决细则、TS 等价改写与占位符定值见 `docs/architecture/code-hard-gates.md`。判定以命令输出为准；数值类由棘轮自动检，其余为 Agent/人工自检——触及相关改动须在 PR 声明「门禁未自动检：[条目]」。

### A. 结构规模

1. **行数与包上限**：单文件 ≤1200 行；单目录生产 ≤30 文件 / 8000 行，达 80%（24 文件 / 6400 行）先拆再加；越线须同一任务内拆分实现与测试（棘轮自动检）。
2. **入口装配纯净**：`main.ts`、`app.module.ts`、`src/config/`、`src/scripts/` 合计 ≤5 文件，只做参数解析、配置构造、依赖装配、路由挂载与启停，不含业务规则与持久化。
3. **禁止伪模块与集中分派**：同目录 ≥3 个共享前缀文件应独立成包；单函数/文件路由或命令分派分支 ≤20，超出由各模块自注册。
4. **禁止承接式包**：不得新建或扩大 `common`、`utils`、`shared`、`core` 类杂项包；存量 `src/common/`、`src/modules/shared/`、web `src/utils/` 已登记为结构债（冻结值与退出条件见 `docs/architecture/arch-ratchet-baseline.md`），只减不增；新公共能力落语义窄包。

### B. 棘轮（超标处只能变小）

检查命令：`python3 scripts/arch_ratchet.py`（默认即检查，退出码非 0 为失败）；`--report` 只打印数值；`--update` 只允许下调基线。初始化器唯一份保存在分发源模板，脚本或基线缺失时只允许从分发源模板取回同一段重新生成，禁止另写实现。

5. **棘轮脚本契约**：脚本与语言无关地实现以下行为，配置集中在文件顶部一个 CONFIG 块（扫描根、源文件 glob、测试文件 glob、入口目录前缀、跳过目录、生产/测试/单文件上限）：
   - 默认运行 = 检查：统计当前值与基线比较，任一超标目录的生产文件数、生产行数、测试文件数或测试行数上升，出现新的生产/测试超标目录、新的超长文件，或非入口目录新增环境变量读取，均打印差异并以退出码 `1` 失败。
   - `--report`：只打印当前数值，不比较，用于拆分过程中观察。
   - `--update`：写基线，且**只允许下调**；当前值高于基线时拒绝写入并退出码 `1`，确需上调必须显式 `--force` 并记录原因。
   - 基线存为脚本旁的 JSON（`scripts/arch_ratchet.json`），含 `updatedAt`、`limits`、生产超标目录、测试债目录、超长文件和环境变量读取表。
   - 实现必须来自分发源模板内嵌初始化器，不得临时写一个只返回成功的空检查器。
6. **超标包只减不增**：进入基线的目录处于超标状态。禁止向其新增生产文件、测试文件、导出类型或功能分支；只允许迁出、拆分、删除和必要的缺陷修复。新增能力必须落在新包，测试随实现迁入真实所有者，禁止把白盒测试继续堆在组合根。
7. **基线不得回退**：每次涉及基线目录的改动后重新运行检查，数值必须持平或下降。检查失败时回退或当次完成拆分；禁止为通过检查而重记基线、放宽上限或把文件挪进跳过目录。
8. **禁止改名逃逸**：把超标包整体改名、整体搬到新路径或整体包进新壳，不算拆分，基线继续沿用原条目。
9. **退出基线**：某目录降到上限内后运行 `--update` 将其移出基线，并同步删除结构基线文档（`docs/architecture/arch-ratchet-baseline.md`）中对应行。

### CONFIG 口径（2026-09-01 自举定型）

- 扫描根 `apps/`（NestJS 后端 + React 前端，纯 TS）：源文件 `*.ts` / `*.tsx`；测试 `*.spec.ts(x)` / `*.test.ts(x)`；跳过 `node_modules`、`dist`、`build`、`coverage`、`dlq`、`harness`、`public` 等非源码目录。
- 上限：单文件 1200 行；单目录生产 30 文件 / 8000 行；测试 30 文件 / 8000 行。
- 环境变量读取（`process.env`）仅豁免 `analytics-server/src/config`、`analytics-server/src/scripts`；其余目录读取处数量只减不增。当前冻结 5 处（见结构基线文档），最大债务 `harness-runtime-manager.service.ts`（16 处）。
- 自举时无超标目录、无测试债、无超长文件，基线仅冻结环境变量读取表；结构超标项出现时按上述条目冻结。

### C. 依赖与分层

10. **依赖单向**：`modules/*` 只依赖对方 NestJS module `exports` 的公开契约；禁止 import 循环，禁止子组件反向持有父容器/根对象引用。
11. **领域包纯净**：领域 service 不出现 Express `Request`/`Response`、不读 `process.env`（配置经 `src/config` 注入，envReaders 基线只减不增）；接口定义在使用方；单容器注入领域组件 ≤5。

### D. 生命周期与状态所有权

12. **可控启停**：`enableShutdownHooks` + `OnApplicationShutdown` 显式启停，退出前停 ingestor 消费与后台 worker、关连接；禁止无关闭路径的裸 `app.listen()`。
13. **单一写入方**：每类可变业务状态只有一个权威写入模块；`prisma/schema.prisma` 是持久化模型唯一权威。
14. **一致性与恢复**：Kafka 消费必须幂等 + 有限重试 + DLQ + 崩溃恢复；外部调用不得持有业务写锁，返回后以版本/CAS 确认状态未漂移。
15. **单一写入口**：HTTP、CLI（`src/scripts/`）、定时任务复用同一 service，不复制业务规则或绕过校验直连存储。

### E. 迁移与双轨

16. **迁移整组搬**：按领域闭环整组迁移（实现+测试同批），不逐函数剥离；一次迁移只改一个主要风险轴，结构拆包期间 API 路径/事件名/DSL/持久化协议不变。
17. **双轨须登记**：`legacy`/`v1/v2`/facade 兼容层创建时登记根目录 `CODE_HANDOVER.md`（负责领域、删除条件、30 天期限；与运维交接 `docs/project/legacy-production-handover.md` 分开）；禁止 `tmp_*`、`*_new`、`*_old`、`*_backup` 等临时文件入库。

### F. 验证与例外

18. **方案先行**：新增系统、新增包、改变依赖方向或迁移数据所有权前，复用「程序/实现门禁」的文档要求，不另建标准。
19. **交付自检**：宣称完成前运行棘轮检查并附结果（见实现专用规则）；不可逆技术决策写 `docs/architecture/adr-{主题}.md`。
20. **例外唯一出口**：仅用户明确批准或不可拖延的安全/数据风险，按「紧急覆盖」记录 `OVERRIDE-REASON`、补档期限与复盘位置。

### G. 国际化与多语言（新增内容必读）

> 界面、接口提示、通知、导出、报表列名等**一切用户可见文本**都已多语言化。新增功能时最容易踩的坑就是"顺手写一句中文"——
> 这类改动会被覆盖率棘轮与资源一致性校验在 CI 拦下。语言清单、术语与新增语言流程以 `docs/architecture/i18n-glossary.md` 为准。

21. **文案零硬编码**：任何用户可见文本不得写死字面量（中文英文一视同仁）。
    - 前端组件：`const { t } = useT('<域>')`（`apps/analytics-web/src/i18n`），键写**全限定形式** `t('report:dashboard.create')`；模块级常量改成接收 `t` 的工厂函数或搬进组件 `useMemo`；禁止在模块作用域调用 i18n 实例。
    - 后端抛错：`badRequest({ code, messageKey, params, message })`（`apps/analytics-server/src/i18n/domain-error.ts`），`message` 保留中文原文作老客户端兜底。
    - 服务端**产出内容**（通知 / 导出 / 模板预览）：`serverT(locale, key, params)` 按**收件人 / 操作者**语言渲染，文案落 `apps/analytics-server/src/i18n/messages/<语言>.json`。
    - 服务端下发的**展示名**（角色、权限目录、渠道名、健康度、列名、示例值……）：服务端只下发**稳定 key + 数据参数**，前端在渲染边界翻译；不要把译好的文本塞进接口。
22. **新增文案必须同时补齐全部已上线语言**：只写源语言（`zh-CN`）会让 `scripts/i18n_check.py`（键集/占位符一致）与 `scripts/i18n_scan.py --check`（硬编码清零棘轮）失败，CI（`scripts/build.sh`）直接红。
23. **键与资源规范**：语义键 `<命名空间>.<子域>.<名>`（每段 lowerCamelCase、≤4 段）；命名空间在 `apps/analytics-web/src/i18n/config.ts` 注册（新域先注册再加键）；插值统一 `{{name}}`；**复数**：基础键是必备兜底形态，屈折语按 CLDR 追加 `_one/_few/_many/_other`，中/日/韩/越/泰/印尼只用基础键；键内禁止编码语言或版本。
24. **不翻译什么**：用户数据（事件名 / 属性名 / 看板与卡片名 / 备注 / SQL 文本）、对象 `value` 字段、代码标识 / URL / 正则 / 字段名、日志与审计原文、语言自称（`简体中文` / `English` …）。判据：**用户自己起的名不译；平台替你写的话都要译**。
25. **语言不得进入缓存载荷**：看板卡片结果、查询结果这类**带缓存**的载荷只准存结构化字段或 key，翻译必须发生在浏览器端（按**查看者**语言）；服务端按请求语言渲染只用于一次性产出（通知 / 导出 / 模板预览 / 列表接口的展示名）。
26. **交付前必跑**：`python3 scripts/i18n_check.py` 与 `python3 scripts/i18n_scan.py --check`（覆盖率棘轮只减不增）；涉及界面或语言集的改动，附**浏览器实测**证据（切换语言后 `<html lang>`、页面标题、关键页文案正确且无源语言残留）。
27. **新增一门语言**（纯数据改动，照清单执行）：`docs/architecture/i18n-glossary.md` 的「新增语言检查清单」——`LOCALES` 一行 + `SUPPORTED_LOCALE_TAGS` + `messages.ts` 注册（**缺注册会静默回退中文**，校验脚本会拦）+ `locales/<tag>/` 16 个命名空间 + antd/dayjs 语言包映射 + 术语表补列 + 浏览器实测；翻译交接走 `scripts/i18n_export.py`（导出待译 CSV / 回填）。
28. **RTL 语言（阿语 / 希伯来语）**：接入前必须先做 CSS 逻辑属性与布局镜像改造（独立 phase），不允许只加语言包上线。
29. **长语言不得溢出**（拉丁/西里尔/泰文标签普遍比中文长 30–100%，俄/德/越/泰/法最甚）：
    - **容器自适应，而不是挤压**：壳层侧栏展开宽度由 `useSiderWidth()` 按当前语言**实测菜单标签宽度**后 clamp 到 `[SIDER_EXPANDED_MIN, SIDER_EXPANDED_MAX]`（`apps/analytics-web/src/layouts/`）；**禁止**写死"按中文长度算"的固定宽度，也不要按语言维护一张宽度表（标签一改就漂移）。
    - **导航类文案要短**：菜单 / 按钮 / 分段控件是导航而非说明，标签目标 ≤ ~18 个拉丁字符；父级分组已表明语境时删掉"用户XXX / of the user"这类限定词。
    - **兜底可见性**：可能被截断的文本必须 `text-overflow: ellipsis` 且带 `title`（悬停看全称）；**禁止** `word-break: break-all`、禁止把标签切成半个字或压成竖排（红线见 `docs/architecture/templates/AGENTS_front.md`）。
    - **表格与表单**：列宽用 `min-width` + 省略号，不用固定 `width`；表单标签过长允许换行，不允许反过来压窄输入框。
    - **交付前**：新增语言或新增界面文案后，用**最长的那门语言**（俄/德/越/泰/法）目视关键页（导航、列表、详情、表单）一次，并在 PR/验收记录里留证据。**登录后的页面需要账号**：生产管理员口令非仓库默认值，无凭据时不要猜测口令或用文档里的默认口令反复试；此时以「登录页实测（`<html lang>` + 加载的产物 chunk）+ 产物内 CSS/JS 标记」作为代理证据，并在结论里列出**由用户硬刷新后自查的页面清单**（措辞用"待自查"，不要写成"已验证"）。

### 阶段性架构审计

- **触发**：完成一个领域业务组 / 单次实现改动 ≥20 个代码文件 / 核心代码距上次审计 >14 天 / 用户明确要求。
- **记录**：问题统一写根目录 `CODE_HANDOVER.md`（发现日期、影响领域、严重级别、证据、建议方案、状态、最后复查日期）；文件不存在时由首次审计创建。修复与重构须经用户确认授权，不自动扩大范围。

---

## 按需导航

| 任务 | 首选入口 |
| ------------ | -------------------------- |
| 项目现状与部署步骤 | `README.md` |
| **接手 / 交接（仓库来源、目标机现状、待办、已知坑）** | `docs/project/handoff-candela-new-repo.md` |
| 文件导航 / 结构 | `INDEX.md` |
| 部署脚本的设计与取舍 | `docs/architecture/standalone-test-env-design.md`、`docs/architecture/candela-deploy-two-paths.md` |
| 部署实测与验收证据 | `docs/project/deployment-record-standalone-test-env.md`、`docs/project/deployment-record-candela-two-paths.md` |
| 上报协议与 SDK 实测 | `docs/architecture/reporting-protocol.md`、`examples/report-sdk/` |
| 旧生产运维记录（已撤出，只留说明） | `docs/project/legacy-production-handover.md` |
| 容器化 / K8s / Helm 可行性 | `docs/architecture/containerization-feasibility.md` |
| 国际化规范（术语表 / 新增语言清单 / 各语言规则） | `docs/architecture/i18n-glossary.md` |
| 国际化实现方案（键与资源组织 / 错误码契约 / 语言解析链） | `docs/architecture/clklog-analytics-design-i18n-v1.md` |
| 分析平台总体方案（调研结论） | `docs/architecture/analytics-extension-plan.md` |
| 需求拆解（PRD） | `docs/product/` |
| 实现方案与契约 | `docs/architecture/` |
| 排期与里程碑 | `docs/project/` |
| 代码审计台账（未修问题） | `CODE_HANDOVER.md` |
| 架构棘轮（脚本 / 基线 / 口径） | `scripts/arch_ratchet.py`、`docs/architecture/arch-ratchet-baseline.md` |
| 门禁模板（分发源，不是本项目规则） | `docs/architecture/templates/` |
