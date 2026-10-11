# 设计方案：运维面板（慢 SQL / 服务器状态 / 监控告警）

- `phase: clklog-analytics-ops-console-v1`
- 日期：2026-09-07
- 帽子：架构 / 愿景（`docs/architecture/`）
- 状态：**已实现并上线**（2026-09-15 回写：§7 生产验证的 V1–V5 结论已全部落到实现；磁盘预估走趋势图，链路判据用 `system.parts.modification_time`）
- 形态：平台内**一级菜单**（用户已确认，不建独立应用）
- 权限：**仅 admin 超管**可见可用（`platform_role === 'super_admin'`）
- **前置依赖**：`clklog-analytics-trend-chart-v1`（趋势图）——用户要求先做趋势图，完成后再做本面板；磁盘预估依赖它
- 关联：`docs/project/legacy-production-handover.md` §10.9（本次需求的直接起因）

---

## 1. 背景与问题

2026-09-07 线上「场景与内部场景」看板打不开，排查过程暴露的可观测性缺口：

| 排查动作 | 实际做法 | 成本 |
|---|---|---|
| 定位看板 500 | 登服务器 grep 日志 | 需 SSH + 知道日志路径 |
| 统计慢查询影响面 | `grep -c "Timeout error"` + 按分钟聚合 | 需懂日志格式、无历史趋势 |
| 判断哪些卡片慢 | `grep -oE "卡片 card_xxx"` + `uniq -c` | 纯手工，无法下钻 |
| 看系统是否健康 | 登服务器跑 `df` / `free` / `supervisorctl status` | 每次都要连服务器 |
| 是否有告警 | **没有** | 故障靠用户报 |

结论：**平台能分析业务数据，但看不见自己**。本次要把「登服务器 + grep」的运维动作，收敛成平台内的三个菜单。

### 用户诉求原文

> 需要重新开一个运维面板，然后开一个：慢SQL的菜单、服务器状态菜单、监控告警菜单。

---

## 2. 调研结论（现状盘点）

### 2.1 慢查询：只打日志，不落库

打点共 3 处，全在 `apps/analytics-server/src/modules/shared/clickhouse.service.ts`：

| 方法 | 行号 | 日志文案 | 触发条件 |
|---|---|---|---|
| `query()` | 66-68 | `慢查询 ${elapsed}ms: ${sql}` | `elapsed > slowQueryThresholdMs` |
| `queryReconcile()` | 110-112 | `对拍慢查询 ${elapsed}ms: ${sql}` | 同上 |
| `querySql()` | 183-185 | `自定义 SQL 慢查询 ${elapsed}ms` | 同上（不打印 SQL 原文） |

- 阈值 `appConfig.log.slowQueryThresholdMs`，dev / server 配置均为 **5000ms**。
- 日志只写到 `/data/logs/production/clklog_manager/analytics-server.log`，**不落库**，无历史趋势、无法按卡片/用户聚合、无 UI。
- Prisma schema 中**没有** slow_query / query_log 相关 model。

> 副作用观察：`querySql()` 的慢日志**不打印 SQL 原文**，导致排查时无法直接定位是哪张卡片的 SQL。建议首期顺手补上（一行改动，见 §4.1）。

### 2.2 健康检查：存在但基本无用

`app.controller.ts:15-18`：

```ts
@Get('sa/api/health')
health() {
  return { status: 'ok', service: 'clklog-analytics-server' };
}
```

- 常量返回 `ok`，**不检查任何依赖**（ClickHouse / MySQL / Kafka 通断都不反映）。
- 不是 `@Public()`，`AuthGuard` 全局生效 → 无 token 直接 401，不能给外部探活/负载均衡用。
- 项目无 `@nestjs/terminus`，无 Prometheus/metrics 端点。

### 2.3 前端壳：菜单 / 路由 / 权限三处配套

| 关注点 | 文件 | 机制 |
|---|---|---|
| 菜单构建 | `analytics-web/src/layouts/MainLayout.tsx:33-146` | `buildMenuItems(permissions)` 返回分组数组；`buildSettingsMenu()` 单独构建「设置」 |
| 菜单权限开关 | `analytics-web/src/layouts/shell-menu.ts:21-45` | `filterMenuByPermissions()` 返回 `showXxx` 布尔旗标 |
| 默认展开 | `MainLayout.tsx:241` | `defaultOpenKeys={['report','analysis','user','meta','iam','settings']}` |
| 路由 | `analytics-web/src/routes.tsx:160-224` | `page(code, node)` = `RequirePermission` + `LazyWrap` |
| 路由权限 | `routes.tsx:32-47` | `useIamStore(s => s.has)` 判定，无权限渲染 `ForbiddenPage` |

**新增一个一级菜单需改 3 个文件**：`shell-menu.ts`（加旗标）、`MainLayout.tsx`（加分组 + `defaultOpenKeys`）、`routes.tsx`（加路由）。

### 2.4 IAM：已有 `ops.*` 权限簇，且有预留位

`analytics-server/src/modules/iam/permission-catalog.ts:35-69` 定义 31 个权限点，其中运维簇：

| code | feature | 说明 |
|---|---|---|
| `ops.user.manage` | 运维 · 账号 | 新建、禁用、启用登录账号 |
| `ops.owner.assign` | 运维 · 项目设置 | 新建分析项目；指定 owner |
| `ops.apikey.manage` | 运维 · API Key | 查看、创建、撤销 Key |
| `ops.ai_workspace.manage` | 运维 · AI Workspace | 模板与同步 |
| **`ops.runtime.access`** | **运维 · 后续运维管理** | **`detail: '占位，本期无路由'`** |

`ops.runtime.access` 就是为本次预留的权限点——**直接复用，不必新增权限码**（见 §4.4）。

关键机制：

- `PermissionDef.ops?: boolean` → `OPS_CODES`（`:71`），`ADMIN_GRANT_FORBIDDEN`（`:73`）禁止把运维权限下放给「分析管理员」。
- 角色默认权限**不是**独立映射表，而是 catalog 里的布尔列，由 `codesForRole()`（`:83-86`）按角色取列。
- 因此新增权限点 = 在 `PERMISSION_CATALOG` 加一行并置各角色布尔值，**无需改角色表或迁移**。

### 2.4.1 「仅超管可见」的机制（用户明确要求）

用户要求：**运维面板只有 admin 超管能使用，其他用户均不可见**。现有体系已天然支持：

| 机制 | 位置 | 说明 |
|---|---|---|
| 超管判定 | `common/utils/rbac.util.ts:5-7` | `isAdmin(user)` = `user?.platform_role === 'super_admin'` |
| 超管自动获得运维权限 | `modules/iam/iam-evaluate.ts:15-17` | `if (platformRole === 'super_admin') for (const code of OPS_CODES) set.add(code);` |
| 运维权限禁止下放 | `permission-catalog.ts:73` | `ADMIN_GRANT_FORBIDDEN = new Set(['iam.role.edit_admin', ...OPS_CODES])`——「分析管理员」也拿不到 |

即：**`ops.*`（含 `ops.runtime.access`）只可能被超管持有**，项目内任何角色（project_owner / analysis_admin / analyst / member / external）都不会获得。

因此「仅超管可见」= 复用 `ops.runtime.access`，无需新增权限码、无需角色迁移。实现上再加一道 `isAdmin()` 显式校验作双保险（见 §4.4）。

### 2.5 后端模块注册

`app.module.ts:26-45`：12 个业务 module + 4 个全局 provider。Guard 顺序 `AuthGuard → ApiKeyGuard → IamGuard`（注释明确：顺序即执行顺序，不可调换）。

新增 ops module = 建目录 → 在 `app.module.ts` 的 `imports` 数组加一项。无全局路由前缀，`@Controller('sa/api/...')` 自带路径。

### 2.6 ⚠️ 关键障碍：`ensureProjectFilter` 会拦截 `system.*` 查询

`clickhouse.service.ts:275-282`：

```ts
private ensureProjectFilter(sql: string): void {
  const trimmed = sql.trim().toLowerCase();
  if (!trimmed.startsWith('select')) return;
  if (!sql.includes('project_name')) {
    throw new Error('ClickHouse 查询缺少 project_name 过滤（红线）');
  }
}
```

- `query()`、`exec()`、`command()` 都会调用它 → **任何 `SELECT ... FROM system.query_log` 都会抛异常**（system 表没有 `project_name` 列）。
- 未受此约束的通道只有两条：`queryReconcile()`（强制 `readonly: true`）、`querySql()`（走 readonly client，不调用该校验）。

**这是首期设计必须正面处理的问题**，解法见 §4.5。

---

## 3. 设计决策总览

| 决策 | 选择 | 理由 |
|---|---|---|
| D1 形态 | 分析平台内新增「运维」一级菜单，不建独立应用 | 复用现有登录、项目切换、IAM、菜单壳；独立应用要重建认证与权限，收益不抵成本 |
| D2 慢 SQL 数据源 | 首期查 ClickHouse `system.query_log`，应用层落库列为增强项 | 零采集改造即可获得历史查询与完整执行指标；落库需新增表 + 采集链路，且与 query_log 重复 |
| D3 服务器状态 | 读 `/proc` + `fs.statfs`，**不执行 shell 命令** | 避免命令注入面；`/proc/meminfo`、`/proc/loadavg`、`/proc/stat`、`fs.statfs` 足够覆盖 CPU/内存/磁盘/负载 |
| D4 告警 | 页面内规则列表 + 轮询检测 + 页面内告警中心；通知通道留接口不实现 | 首期无邮件/企微/短信通道，硬做通知会引入密钥与外发依赖；先把「看得见告警」做实 |
| D5 权限 | 仅 **admin 超管**可见可用（`platform_role === 'super_admin'`），复用 `ops.runtime.access` 并加 `isAdmin()` 双保险 | 用户明确要求；且 `ops.*` 只会被超管持有、禁止下放（§2.4.1），等价于「仅超管」 |

---

## 4. 详细设计

### 4.1 慢 SQL 菜单

**数据源**：ClickHouse `system.query_log`（需验证该表在生产已开启且保留足够时长，见 §7）。

首期展示字段（均为 query_log 原生列，无业务改造）：

| 展示列 | query_log 列 | 说明 |
|---|---|---|
| 时间 | `event_time` | |
| 耗时 | `query_duration_ms` | 主要排序与筛选维度 |
| 状态 | `type` | `QueryFinish` / `ExceptionWhileProcessing` |
| 读取行数 | `read_rows` | |
| 读取字节 | `read_bytes` | |
| 内存 | `memory_usage` | |
| 账号 | `user` | 可区分 `default` / `sa_readonly` |
| SQL 原文 | `query` | 截断展示，可展开 |
| 异常 | `exception` | 失败查询直接看到原因 |

**查询约束（红线 4 对应）**：

- 只允许 `SELECT ... FROM system.query_log`，**禁止**跨到业务库；服务端固定表名与列白名单，不接受调用方传入表名或 SQL 片段。
- 强制时间范围（默认近 24 小时，最大 7 天）+ `LIMIT`（默认 100，最大 1000）。
- 走 readonly client（`sa_readonly` 账号）。
- SQL 原文可能含业务敏感值，页面仅对 `ops.runtime.access` 持有者开放。

**顺带修复（一行）**：`querySql()` 的慢日志（`clickhouse.service.ts:183-185`）目前只打耗时不打 SQL，建议补上 SQL 前若干字符，便于与 query_log 对照定位卡片。

**增强项（不在首期）**：应用层 `slow_query` 表，记录 `card_id` / `user_id` / `dashboard_id` 等业务上下文——query_log 只有 SQL 文本，无法直接回答「哪张卡片慢」。若确需业务维度下钻，再按独立 phase 做采集。

### 4.2 服务器状态菜单

分三组，全部**只读、无 shell 调用**：

**A. 应用进程**（Node 原生，无外部依赖）

| 指标 | 来源 |
|---|---|
| 进程 uptime | `process.uptime()` |
| 堆内存 / RSS | `process.memoryUsage()` |
| Node 版本、环境 | `process.version`、`NODE_ENV` |
| 应用版本 | `.version` 文件（HANDOVER §10.3 已有约定） |

**B. 主机**（读 `/proc`，`fs.readFileSync`）

| 指标 | 来源 |
|---|---|
| 内存总量 / 可用 | `/proc/meminfo`（`MemTotal` / `MemAvailable`） |
| 负载 | `/proc/loadavg`（1/5/15 分钟） |
| CPU 核数与利用率 | `/proc/stat`（两次采样差值，或简化取瞬时） |
| 磁盘总量 / 可用 | `fs.statfsSync()`（Node 18.15+；服务器为 v24，可用） |
| 时区与当前时间 | `Intl` / `Date` |

**C. 依赖与数据链路**（ClickHouse system 表 + 心跳）

| 指标 | 来源 | 说明 |
|---|---|---|
| ClickHouse 通断与版本 | `SELECT version()` | 健康检查基础 |
| 库表体积 / 行数 | `system.parts`（`clklog_sa.sa_events`） | 数据量趋势 |
| 当前运行查询 | `system.processes` | 实时慢查询现场 |
| 磁盘（CH 侧） | `system.disks` | CH 数据目录占用 |
| ingestor 存活与延迟 | **需设计心跳**（见下） | 关键：数据链路是否断 |

> **ingestor 心跳（前置待办）**：ingestor 与主服务是**两个独立 supervisor 程序**，主服务无法直接感知 ingestor 状态，建议 ingestor 每次成功写入 ClickHouse 后更新一行心跳（MySQL 现成连接）。
>
> ⚠️ **已验证：不能用 `SELECT max(stat_date) FROM clklog_sa.sa_events` 判断链路停滞**——实测该值为 **`2027-01-02`**（未来日期，亿级行），说明 `stat_date` 含业务口径的未来值/脏值，与「写入时间」无关。改用下列任一方案，实现前确认：
>
> 1. `system.parts` 的 `modification_time`（CH 侧最后写入时间，无需改造）；
> 2. ingestor 写心跳表（需改造 ingestor，精度最高）。

**Kafka 消费延迟**：主服务不连 Kafka（仅 ingestor 连）。首期不展示 lag；如需，走 ingestor 心跳里带 offset 差值。

**D. 磁盘使用量预估（用户重点要求，依赖趋势图）**

这是「服务器状态」的核心诉求：**不是看当前用了多少，而是看什么时候会用完**。

| 环节 | 设计 |
|---|---|
| 采样 | 后端定时（建议每小时）采集 `/data` 与 CH `system.disks` 的用量落表，形成时间序列 |
| 渲染 | 使用 **趋势图**（`phase: clklog-analytics-trend-chart-v1`）：X = 采样时间，Y = 已用空间 |
| 阈值 | 取磁盘总量（`fs.statfs` / `system.disks` 的 `total_space`），或 90% 告警线 |
| 输出 | 图上标注「按近期增速，预计 YYYY-MM-DD 用尽，剩余 N 天」 |

> ⚠️ **前置依赖**：本能力依赖趋势图 phase **先落地**（用户已明确「先做趋势图，做完再做运维面板」）。趋势图设计为通用能力（等距时间轴 + 线性回归外推 + 阈值交汇推演），磁盘预估是它的第一个消费者；二者解耦，趋势图不感知运维语义。

采样表建议 `HostMetricSample`（`metric_key` / `sampled_at` / `value`），保留 90 天，随 ops module 的迁移一起建。

### 4.3 监控告警菜单

**模型**（三张概念表，落 MySQL）：

```
alert_rule    规则：指标项 / 比较符 / 阈值 / 持续时长 / 启用开关 / 静默期
alert_event   事件：规则命中记录（首次触发时间、最近触发、当前值、状态）
alert_state   检测状态机内存态：某规则连续满足次数（用于「持续 N 分钟」判定）
```

**首期内置规则（不可删，可停用）**：

| 规则 | 默认阈值 | 依据 |
|---|---|---|
| 慢查询次数突增 | 近 5 分钟耗时 >5s 的查询 ≥ N 次 | 本次事故中「每分钟 2-8 次 Timeout」的量化 |
| 查询失败率 | 近 15 分钟 `ExceptionWhileProcessing` 占比 > X% | |
| 卡片缓存连续刷新失败 | 某卡片连续失败 ≥ 3 次 | §10.9 修复后已有「连续第 N 次」语义 |
| ClickHouse 不可达 | 探活连续失败 ≥ 2 次 | |
| 磁盘可用空间 | < 10% | 通用 |
| 数据链路停滞 | CH 侧最后写入（`system.parts.modification_time`）距今 > 30 分钟，或 ingestor 心跳超时 | 上报链路断裂（**不可用 `max(stat_date)`**，见 §4.2 与 §7-V5） |

**检测**：服务内定时任务轮询（复用 `CardCacheWorker` 的同款 `OnModuleInit` / `OnApplicationShutdown` 生命周期模式，门禁 D12 要求可控启停）。轮询间隔建议 60s，与卡片 worker 解耦。

**展示**：告警中心列表（按状态筛选：触发中 / 已恢复 / 已静默），支持对规则启用/停用、调阈值。

**通知**：首期**只做页面内可见 + 规则状态**，不接外部通道。预留 `NotificationChannel` 接口，后续接企微/邮件时再引入密钥（红线 3 相关，需单独评估）。

### 4.4 权限：仅 admin 超管

用户要求「只有 admin 超管才能使用，其他用户均不可见」。实现两道闸，**缺一不可**：

**① 路由与菜单层（前端）**

- `routes.tsx`：`page('ops.runtime.access', <OpsXxxPage />)` —— 无该权限直访 URL 渲染 `ForbiddenPage`。
- `shell-menu.ts` 的 `filterMenuByPermissions` 增加 `showOps: hasPerm(permissions, 'ops.runtime.access')`。
- `MainLayout.tsx` 增加「运维」分组（icon 建议 `ToolOutlined`），并把 `'ops'` 加入 `defaultOpenKeys`（`:241`）与 `selectedKeys` 逻辑。

因 `ops.*` 仅超管持有（§2.4.1），非超管的 `permissions` 中不含该码 → **菜单不出现、直访被拦**，满足「其他用户均不可见」。

**② 接口层（后端，双保险）**

三个 controller 除 `@RequirePermission('ops.runtime.access')` 外，**显式调用 `isAdmin(user)`**（`common/utils/rbac.util.ts:5-7`）拒绝非 super_admin。

> 理由：权限码是「可配置的策略」，`platform_role` 是「身份事实」。运维面板属平台级能力、与具体项目无关，用身份事实兜底可避免未来误配权限导致越权——即便有人误把 `ops.*` 加进某角色，接口仍只认超管。

**不做的事**：不新增权限码、不改 `PERMISSION_CATALOG` 布尔列、不做角色迁移。

### 4.5 绕过 `ensureProjectFilter` 的正解

**不要**放宽 `ensureProjectFilter`——它是红线 4 的执行点，放宽会让业务查询失去项目隔离保护。

**做法**：在 `ClickHouseService` 新增语义明确的方法：

```ts
/**
 * 只读系统表查询（运维面板专用）。
 * 不强制 project_name：system.* 表无该列，且本方法只接受白名单表名，
 * 不接受调用方传入任意 SQL。仍走 readonly client。
 */
async querySystem<T = unknown>(allowedTable: SystemTableName, where: string, params): Promise<T[]>
```

约束：

1. 表名**枚举白名单**（`query_log` / `processes` / `disks` / `parts` / `metrics` / `asynchronous_metrics`），调用方只能传枚举值，不能传字符串 SQL。
2. 过滤条件由**服务端按参数拼装**（时间范围、阈值、LIMIT），不接收调用方 SQL 片段。
3. 走 `readonlyClient`（`sa_readonly`）。
4. 强制 `max_execution_time` 与 `max_result_rows`（红线 4：查询必须有界）。

这样既拿到 system 表数据，又保持红线不被削弱，且调用点无法夹带任意 SQL。

### 4.6 模块划分

新增 `apps/analytics-server/src/modules/ops/`，按语义拆三个子域（避免做成杂项包，符合门禁「新公共能力落语义窄包」）：

```
ops/
├── ops.module.ts
├── slow-query.controller.ts / .service.ts       慢 SQL
├── server-status.controller.ts / .service.ts    服务器状态
├── alert.controller.ts / .service.ts            告警规则与事件
├── alert-rule.repository.ts                     （若落库）
└── host-metrics.ts                              /proc 与 statfs 读取（纯函数，可单测）
```

Prisma 新增 `AlertRule` / `AlertEvent` 两个 model（若首期规则内置不落库，则可省，待 PRD 确认持久化需求）。

前端新增 `apps/analytics-web/src/pages/Ops/`：`SlowQueriesPage.tsx`、`ServerStatusPage.tsx`、`AlertsPage.tsx`，service 放 `services/ops.service.ts`。

---

## 5. 阶段目标与范围

### 目标

| 编号 | 目标 |
|---|---|
| G1 | 慢 SQL 可查：无需登服务器即可看到慢查询列表、耗时分布、SQL 原文与失败原因 |
| G2 | 服务器状态可见：主机资源、依赖通断、数据链路是否停滞，一页看完 |
| G3 | 告警可配可看：内置规则覆盖本次事故暴露的失效模式，触发后页面可见 |
| G4 | 全程不削弱红线：项目过滤、查询有界、密钥不入库、可控启停 |

### 范围（首期）

1. 前端「运维」一级菜单 + 3 个子页面。
2. 后端 ops 模块：3 组只读接口 + 告警规则/事件。
3. `ClickHouseService.querySystem()` 白名单通道。
4. 顺带补 `querySql()` 慢日志的 SQL 原文。

### 非目标（首期不做）

1. **不优化慢 SQL 本身**（用户已明确「记录下来即可」）。
2. 不接外部通知通道（企微/邮件/短信）——涉及密钥与外发依赖，单独立项。
3. 不改 `/sa/api/health` 的鉴权（如需给外部探活，单独立项评估）。
4. 不做分布式/多节点视图——当前是单节点部署。
5. 不引入 Prometheus / Grafana 等外部监控栈。
6. 不做告警自动修复动作（只告警不处置）。
7. 不做 Kafka lag 展示（依赖 ingestor 心跳，见 §4.2）。

---

## 6. 验收标准

| 编号 | 标准 |
|---|---|
| AC1 | 有 `ops.runtime.access` 的账号侧边栏出现「运维」菜单，含慢 SQL / 服务器状态 / 监控告警三项；无该权限者不出现且直访 URL 跳 Forbidden |
| AC2 | 慢 SQL 页可按时间范围与耗时阈值筛选，展示 SQL 原文（可展开）、耗时、读取行数、状态、异常 |
| AC3 | 慢 SQL 接口走 readonly 账号；服务端拒绝非白名单表与无时间范围的请求 |
| AC4 | 服务器状态页展示主机 CPU/内存/磁盘/负载 + ClickHouse 通断与版本 + 数据量 + 数据链路状态（按 §4.2 确认的判据，**不得用 `max(stat_date)`**） |
| AC4b | 磁盘区域展示用量**趋势图**，含拟合外推与「预计 YYYY-MM-DD 用尽」标注（依赖趋势图 phase 先落地） |
| AC5 | 服务器状态采集不执行 shell 命令（代码审查确认无 `child_process` 调用） |
| AC6 | 监控告警页展示内置规则列表，可启用/停用、调阈值；触发后产生事件并在页面可见 |
| AC7 | 告警检测任务随应用启停（`OnApplicationShutdown` 停表），不泄漏定时器 |
| AC8 | `python3 scripts/arch_ratchet.py` 通过；ops 模块不落入结构债基线 |
| AC9 | 单元测试覆盖：`querySystem` 白名单拒绝、`host-metrics` 解析、告警状态机「持续 N 次才触发」 |

---

## 7. 生产环境验证结果（2026-09-07 已核实）

| # | 验证项 | 结果 | 对设计的影响 |
|---|---|---|---|
| V1 | `system.query_log` 可用性与保留期 | ✅ 可用。**484 万条**，覆盖 `2026-09-05 00:00` ~ `2026-09-07 14:37` | 慢 SQL 数据源方案 A 成立。**但保留仅约 2.5 天**，页面时间范围上限须收紧到「近 3 天」，超出要给出「超出 query_log 保留期」提示，不能让用户以为没数据 |
| V2 | `sa_readonly` 能否读 `system.query_log` | ✅ 能读（返回 485 万条） | 无需扩权，直接走 readonly client，红线 4 不受影响 |
| V3 | `system.disks` 可用性 | ✅ 可用：`default` 盘 `free 1.45 TiB / total 2.88 TiB` | 服务器状态页磁盘指标可直接取 CH 侧 `system.disks` |
| V4 | Node v24 `fs.statfsSync('/data')` | ✅ 可用（`blocks=773803056, bavail=389014698, bsize=4096`）。实测：内存 31G、可用 20G；负载 2.46；`/data` 2.9T 已用 48% | 磁盘采集按 `fs.statfs` 实现，无需 shell |
| V5 | 数据链路「最近写入」判据 | ⚠️ **不可用**：`SELECT max(stat_date) FROM clklog_sa.sa_events` = **`2027-01-02`**（未来日期，亿级行） | **不能用 `max(stat_date)` 判断数据链路是否停滞**。改用 `system.parts` 的 `modification_time`（CH 侧最后写入时间）或由 ingestor 写心跳，二选一，实现前确认 |

---

## 8. 红线声明

| 红线 | 本方案处理 |
|---|---|
| 1 不侵入社区版 | 只读 ClickHouse system 表，不改社区版容器与表结构 |
| 2 不破坏数据链路 | 全部只读；告警不触发任何自动处置 |
| 3 密钥不入库 | 首期无外部通知通道，不引入新密钥 |
| 4 查询必须有界 | `querySystem` 白名单 + 强制时间范围 + LIMIT + 限额；不削弱 `ensureProjectFilter` |
| 6 数据变更有备份与审计 | 新增表需走 Prisma 迁移；告警事件只增不改 |

---

## 9. 与既有文档的关系

- **前置 phase（先做）**：`docs/architecture/clklog-analytics-design-trend-chart-v1.md` —— 趋势图。磁盘使用量预估依赖它。
- 起因记录：`docs/project/legacy-production-handover.md` §10.9（含本次事故与退避修复的实测数据）。
- 实现前需产品帽产出 PRD：`docs/product/prd-clklog-analytics-ops-console-v1.md`（命名遵循 `prd-{系统名}-v{N}.md`），本方案可直接作为其实现依据。
- 新增文档后需同步 `INDEX.md` 条目与 `RUNTIME-META` 计数。

## 10. 实施顺序建议

1. **先** `clklog-analytics-trend-chart-v1`（趋势图）—— 用户明确优先，且是磁盘预估的前置。
2. **后** 本 phase 运维面板，其中：
   - 服务器状态页接入趋势图实现磁盘预估；
   - 慢 SQL 页注意 `query_log` 仅保留约 2.5 天（§7-V1）；
   - 数据链路判据按 §4.2 结论实现，**不要**用 `max(stat_date)`。
