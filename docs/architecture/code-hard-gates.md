# 代码架构硬门禁细则（code-hard-gates）

> 来源：分级同步自分发源模板 `docs/architecture/templates/AGENTS_exec.md`「系统代码架构硬门禁」（TEMPLATE-VERSION 1.0），按本仓库技术栈（NestJS 后端 + React 前端）做 TS 等价改写。常驻精简版见 `AGENTS.md`「系统代码架构硬门禁」，本文是裁决细则。
> 作用域：`apps/`（`analytics-server`、`analytics-web`）。`puppet/`、`sql/`、`scripts/` 不适用代码门禁；Puppet 变更遵循 `AGENTS.md` 实现专用规则。
> 检测分工见文末表：数值类已由结构棘轮（`scripts/arch_ratchet.py`）自动检；其余为 Agent/人工自检，触及相关改动须在 PR 声明「门禁未自动检：[条目]」。

## 占位符定值（2026-09-01 起生效）

| 占位符 | 定值 | 说明 |
|---|---|---|
| 单文件行数上限 | 1200 | 棘轮 `fileLines` |
| 单包生产文件 / 行数 | 30 / 8000 | 棘轮 `packageFiles` / `packageLines` |
| 单包测试文件 / 行数 | 30 / 8000 | 棘轮 `packageTestFiles` / `packageTestLines` |
| 伪模块前缀共享文件数 | 3 | 同目录同前缀文件达 3 个应独立成包 |
| 集中分派分支上限 | 20 | 单函数/文件路由或命令分派 |
| 入口包文件上限 | 5 | 装配层（main/app.module/config/scripts） |
| 聚合领域组件上限 | 5 | 单容器依赖注入数 |
| 双轨兼容层删除期限 | 30 天 | 登记于 `CODE_HANDOVER.md` |
| ADR 位置 | `docs/architecture/adr-{主题}.md` | 不可逆技术决策 |

## A. 结构规模

1. **单文件上限**：任何代码文件 ≤1200 行，越线须同一任务内按职责拆分实现与测试（棘轮自动检）。
2. **单包上限**：任一业务目录 ≤30 生产文件 / 8000 行生产代码；达 80%（24 文件 / 6400 行）先拆再加，不得先超标后补拆。当前最接近线的是 `modules/meta`（26 文件），新增功能优先落 `meta/` 之外的新窄包。
3. **入口包禁止承载业务**：`main.ts`、`app.module.ts`、`src/config/`、`src/scripts/` 只做参数解析、配置构造、依赖装配、路由挂载与启停，合计 ≤5 文件，不含业务规则、持久化和供应商调用。
4. **禁止文件名伪模块**：同目录 ≥3 个共享前缀文件（如 `report_*.ts`）视为该前缀应独立成包；禁止用文件名前缀代替包边界新增文件。
5. **禁止集中式分派**：单函数/文件中路由或命令分派分支 ≤20；超出由各模块自注册（NestJS 按模块组织 controller 即天然满足，警惕手写 switch 分派器）。
6. **禁止承接式包**：不得创建或扩大 `common`、`utils`、`shared`、`core`、`app` 之类无领域含义的杂项包。存量 `src/common/`、`src/modules/shared/`、web `src/utils/` 已登记为结构债（冻结值与退出条件见 `arch-ratchet-baseline.md`「承接式包结构债」），只减不增；新公共能力落语义窄包。

## B. 棘轮（超标处只能变小）

细则见 `AGENTS.md` B 节与 `docs/architecture/arch-ratchet-baseline.md`（统计口径、自举记录、冻结清单、债登记）。脚本或基线缺失时，只允许从分发源模板 `docs/architecture/templates/AGENTS_exec.md` 取回初始化器同段重新生成，禁止另写实现。

## C. 依赖与分层（TS 等价改写）

- **依赖单向**：领域包（`modules/*`）互相只依赖公开契约=NestJS module 的 `exports`；禁止 import 循环，禁止子组件反向持有父容器/根对象引用（React 中禁止把整个 store 或 app 实例当 props 传给子组件）。循环检测可在评审时运行 `npx madge --circular apps/analytics-server/src`（可选工具，未入 CI）。
- **领域包纯净**：`modules/*` 的 service 不得出现 Express `Request`/`Response` 类型（传输关注点走拦截器/装饰器/DTO）、不得读 `process.env`、不得硬编码文件路径与供应商 SDK 细节；DTO 转换与错误映射留在传输边界。
- **配置集中**：环境变量只允许 `src/config/` 与 `src/scripts/` 读取，其余经 `configuration.ts` 显式注入。此口径与棘轮 `envReaders` 基线闭环：现存 5 处债务（最大 `harness-runtime-manager.service.ts` 16 处）只减不增，清单见基线文档。
- **接口定义在使用方**：需要抽象时由调用方声明窄 interface，实现方以 TS 结构类型满足；禁止新建 `interfaces/`、`contracts/` 大包。
- **聚合上限**：构造函数注入的领域组件 ≤5，超出按上下文拆为多个应用服务；容器不得当服务定位器四处传递。

## D. 生命周期与状态所有权

- **可控启停**：启用 `app.enableShutdownHooks()`，实现 `OnApplicationShutdown`/`OnModuleDestroy`，SIGTERM 时先停 ingestor 消费与后台 worker，再关 Prisma/Redis/ClickHouse/Kafka 连接；禁止无关闭路径的裸 `app.listen()`。
- **单一写入方**：每类可变业务状态只有一个权威写入模块；`prisma/schema.prisma` 是持久化模型唯一权威，禁止在代码或注释里另起表结构真相。
- **跨域解耦**：跨 `modules/*` 联动走事件或对方公开 service，由接收方更新自己的投影；写侧不得直接全量重建另一领域数据。
- **一致性与恢复**（ingestor 重点）：Kafka 消费必须幂等键 + 有限重试 + DLQ + 崩溃恢复（checkpoint）；Kafka/ClickHouse 等外部调用不得持有业务写锁，返回后重读版本/CAS 确认状态未漂移；仅进程内锁、布尔标志或内存队列视为未通过。
- **单一写入口**：HTTP controller、`src/scripts/` CLI、定时任务复用同一 service，不得复制业务规则或绕过校验直连存储。

## E. 迁移与双轨

- **迁移整组搬**：按领域闭环整组迁移，仓储、状态机、失败语义、补偿顺序与测试同批落位，不逐函数剥离；阶段开始前列出不可退化语义（幂等键、CAS、checksum、恢复证据），收尾恢复全部验证。阶段内允许短暂编译失败。
- **双轨须登记**：任何 `legacy/new`、`v1/v2`、facade 兼容层创建时登记根目录 `CODE_HANDOVER.md`：负责领域、删除条件、期限（默认 30 天）；逾期由下一次实现任务优先清理。文件不存在时由登记动作触发创建。
- **不夹带重做**：一次迁移只改一个主要风险轴；结构拆包期间 API 路径、事件名、DSL、持久化协议不变，数据模型或基础设施替换单独立项。
- **禁止临时文件入库**：`tmp_*`、`*_new`、`*_old`、`*_backup`、`*_copy` 发现即删除或正式命名。

## F. 验证与例外

- **方案先行**：新增系统、新增包、改变依赖方向或迁移数据所有权前，复用 `AGENTS.md`「程序/实现门禁」（PRD + 实现方案 + phase 块），不另建标准。
- **测试所有权**：新包至少一组外部视角测试（只 import 公开 API；NestJS 用模块级/e2e 测试）；迁出实现时测试随迁真实所有者并尽量黑盒化；组合根只留装配与生命周期集成测试。现存测试在 `apps/analytics-server/test/`（按模块分域）与 web `__tests__/`，新增测试跟随模块目录。
- **完成定义**：新增状态变更覆盖成功、拒绝、重复请求、中途失败四类用例；迁移验证顺序=目标黑盒 → 原入口兼容 → 全量 → 结构棘轮 → lint/diff；实测耗时记录，超时只表示结果未知；「编译通过」不算证据。
- **交付前自检**：宣称完成前运行 `python3 scripts/arch_ratchet.py` 并附结果；一个迁移阶段=一个可独立评审、可单独回退的变更单元；除非用户明确要求，不自动创建 git 提交。
- **决策留痕**：引入新基础设施、改变依赖方向或不可逆方案时，写 `docs/architecture/adr-{主题}.md`，记录选择、替代方案、迁移与回滚方式。
- **例外唯一出口**：只有用户明确批准，或存在不可拖延的数据损坏/安全风险时才能突破门禁，按「紧急覆盖」记录 `OVERRIDE-REASON`、补档期限和复盘位置。

## 阶段性架构审计

- **触发**：完成一个领域业务组 / 单次实现改动 ≥20 个代码文件 / 核心代码距上次审计 >14 天 / 用户明确要求。
- **记录**：问题统一写根目录 `CODE_HANDOVER.md`（与运维交接 `docs/project/legacy-production-handover.md` 职责分开，不合并）：发现日期、影响领域、严重级别、证据、建议方案、状态、最后复查日期。文件不存在时由首次审计创建。
- **增量复查**：修改已登记问题涉及代码时复查对应条目并更新状态；已修复项保留记录；证据失效标记 `⚠️ 待重新确认`，不得未验证直接关闭。
- **重构授权**：审计只记录问题；修复与重构须用户确认授权，不得自动扩大任务范围；重构按领域批量迁移完整业务组（含测试），阶段目标与验证同 E 节。

## 检测分工

| 条目 | 检测方式 |
|---|---|
| A1/A2 行数与文件数、C 配置集中（envReaders） | 棘轮自动检（`python3 scripts/arch_ratchet.py`） |
| A3–A6、C 依赖方向/纯净、D 全部、E 全部 | Agent/人工自检；触及则 PR 声明「门禁未自动检：[条目]」 |
| F 方案先行 | 与「程序/实现门禁」同一套文档检查 |
| F 交付前自检 | 棘轮退出码 + PR 证据 |
