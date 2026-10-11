# 实现方案：Debug 实时查询——口径修正 + 结果留档（v1）

> phase: `clklog-analytics-debug-query-v1`
> 配对 PRD：`docs/product/prd-clklog-analytics-debug-query-v1.md`
> 问题证据：`docs/project/test-report-debug-query-2026-10-08.md`（含 `system.query_log` 实测）
> 状态：待评审（未实现）

**阶段目标**：消除 Debug 页三处会误导使用的口径错误（时间/条数/参数校验），把设备·账号维度的查询成本降到可用区间，并新增「查询留档」（永久保存、可删除、可回看）。
**非目标**：不改 `sa_events` 写入链路、不动社区版、不做异步任务队列、不做导出/对比、不做自动清理。

---

## 1. 修复设计

### 1.1 D1 时间列：按「平台时区墙钟 → 真实时刻」解析

**根因**：`DebugQuery.tsx:108` 用 `new Date(v.replace(' ', 'T') + 'Z')` 把 ClickHouse 的 naïve datetime 串当 UTC。
`sa_events.log_time` 的真实语义是「事件时刻在**平台时区**的墙钟」（写入侧 `sa-event-flattener.service.ts:23`
`formatChDateTimeMs(logTime, platformTz)`），于是显示时又被 `formatDateTime` 按平台时区渲染一次，恒定 +8h。

**改法**（前端，1 个 helper + 1 个调用点）：

1. 在 `apps/analytics-web/src/features/time-range/resolve.ts` 增加：

```ts
/** ClickHouse naïve 墙钟串（'YYYY-MM-DD HH:mm:ss[.SSS]'）+ 写入时区 → 真实时刻 */
export function parseWallClock(value: string, tz = getPlatformTimeZone()): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value?.trim() ?? '');
  if (!m) return null;
  const ms = epochOfWallClock(tz, +m[1], +m[2], +m[3], +m[4], +m[5], +m[6]) + Number((m[7] ?? '0').padEnd(3, '0'));
  return new Date(ms);
}
```

2. `DebugQuery.tsx` 改为 `formatDateTime(parseWallClock(v) ?? undefined)`（`formatDateTime` 内部按**显示时区**渲染：用户偏好 → 项目 → 平台，复用现网时区链，`format.ts` 已实现）。
3. 解析失败回退原串显示（不吞数据）。

**同源问题巡检（同一 PR 内一并处理或登记）**：`components/DataTable.tsx:101` 对「标题含『时间』」的列直接
`formatDateTime(String(v))`——SQL 报表/明细里若出现 CH 墙钟串，`new Date('2026-10-04 22:59:08')` 会按**浏览器本地时区**
解释（Safari/iOS 直接 Invalid Date）。建议同一 helper 接入该分支，判据：能匹配 `YYYY-MM-DD HH:mm:ss` 形态才走 `parseWallClock`，否则维持现状。

**单测锚点**：`parseWallClock` 三种串形态（有/无毫秒、带 T）；`Asia/Shanghai` 与 `America/New_York` 两个 tz 下的期望 epoch；
非法串返回 null；DebugQuery 渲染断言「同一行时间 = 直查 log_time 的墙钟」。

### 1.2 D2 命中数：同一次扫描里取总数

不改查询次数、不加成本：在结果集上挂窗口函数（已实测：`LIMIT 3` 时每行都返回 `matched_total=27492`，
read_rows 28.03M / 807ms，与不带窗口函数同量级）。

```sql
SELECT log_time, event, distinct_id, user_key, properties,
       count() OVER () AS matched_total      -- LIMIT 之前求值 = 命中总数
FROM clklog_sa.sa_events
WHERE ...
ORDER BY log_time DESC
LIMIT {limit: UInt32}
```

- 服务端契约：`{ items, matched_total }`（`GET /recent` 与新的 `POST /query` 都带）。
- 前端文案：`meta:debug.hitTotal`（「命中 {{total}} 条」）+ `meta:debug.shownRecent`（「已显示最近 {{count}} 条」），
  空结果只显示空态，不再出现「共 N 条」这种把返回数当命中数的文案（`DebugQuery.tsx:87` 的 `showTotal` 一并去掉）。

### 1.3 D3 可用性：窗口可选 + 让时间条件可裁剪

**实测（同一账号、同一 7 天窗，`count()` 探针）**：

| 形状 | 读行数 | 耗时 | 结果 |
|---|---|---|---|
| 现状：只有 `log_time >= now()-7d` | 千万级 | 4.4s | 27492 |
| 加 `stat_date` 下界（本次改法） | 千万级 | 2.0s | 27492（**逐值一致**） |
| 窗口收到 24h + `stat_date` 下界 | 百万级 | 0.39s | — |

差别来自**分区裁剪**：表按 `toYYYYMM(stat_date)` 分区，
而原查询只给 `log_time`（不在分区键、也不在排序键 `(event, stat_date, distinct_id, crc)` 前缀），
ClickHouse 只能靠 `log_time` 的 minmax 跳过部分 granule；补上 `stat_date` 下界后可整分区跳过。

> ⚠️ 实现陷阱（已于 2026-10-08 生产实测抓到并修）：下界必须从**窗口起点**往前留余量。
> 曾写成「今天 - 余量」，7 天窗被悄悄截成 2 天——单设备命中 27492 → **8102**、`fish_open` 4 条 → **0 条**；
> 单测只断言了 SQL 形状，是拿生产数据复核才发现。回归用例：`debug.service.spec.ts` 的「stat_date 下界从窗口起点算」。

**SQL 改法**：

```sql
AND stat_date >= toDate({stat_from: Date})     -- = 窗口起点当天 - 2 天；只加下界，保留「时钟超前」的行可见
```

- 时间参数一律用 **epoch 秒 + `toDateTime({since:UInt32})`**（沿用 `clickhouse.service.ts` 的既有约定：
  naïve 字符串字面量会按 CH 服务端时区解释，曾造成 8 小时偏移事故）。
- **语义代价（明示，不藏）**：`stat_date` 是「按项目/平台时区切日」的列。补下界后，
  `stat_date` 与 `log_time` 相差超过 2 天（设备时钟严重异常、历史补数落进老分区）的行**不再进入**本窗口过滤。
  这是本轮为可用性付出的代价，需在界面说明条与 PRD 中写明；不想付这个代价的替代路线见 §1.3 备选。
- 上界不加（保持现状）：`log_time` 超前的行仍可见——「设备时钟快了」本身就是埋点排查要看的事实。

**窗口选择**：`window = 1h | 24h | 7d`，默认 `24h`；`since = 服务端 now - window`（epoch）；
选 `7d` 时前端提示「数据量大时设备/账号维度可能数十秒」；查询中显示已等待秒数，>10s 追加
「建议同时填事件名（事件名是索引前缀，会快很多）」——实测依据：`event=` 前缀查询 0.1–0.7s、读 23–29 万行。

**备选（不改语义）**：给 `sa_events` 加跳数索引
`ALTER TABLE clklog_sa.sa_events ADD INDEX idx_debug_distinct_id distinct_id TYPE bloom_filter(0.01) GRANULARITY 4`
（`user_key` 同）。收益预期大但不能凭猜：须先在 `clklog_sa_staging` 演练（红线 6），
并评估 `MATERIALIZE INDEX` 在 亿级行上的后台开销。**本 phase 不做，登记为后续 phase 候选。**

### 1.4 D4 参数校验与错误外泄

- `debug.controller.ts`：`limit` 只接受 1–100 的整数（缺省 20）；非法值 → `badRequest({ code: 'meta.debug.invalidLimit', messageKey: 'meta:error.debug.invalidLimit' })`；
  `service` 里的 `Math.min/max` 收敛保留为纵深防御（对 `NaN` 不生效，故不能只靠它）。
- `window` 只接受 `1h|24h|7d` 枚举，其它 → 400。
- ClickHouse 报错不再直接进响应：service 捕获后记完整日志，抛统一的 500
  `{ code: 'meta.debug.queryFailed', messageKey: 'meta:error.debug.queryFailed' }`。

## 2. 留档设计（F1）

### 2.1 存储：MySQL 元数据库（Prisma）

理由：属用户可见的派生产物（与已保存指标、看板同域）、天然按项目隔离、删除要级联与审计、迁移走既有
`prisma migrate deploy`；单条数据量小（≤100 行），不需要列存。

```prisma
// ===== Debug 查询留档（phase: clklog-analytics-debug-query-v1）=====
model MetaDebugRecord {
  id              String   @id @default(uuid())
  project_name    String
  created_by      String
  created_by_name String?            // 冗余显示名：用户改名后历史仍可读
  created_at      DateTime @default(now())
  window          String             // 1h / 24h / 7d
  cond_distinct_id String?
  cond_user_key   String?
  cond_event      String?
  cond_limit      Int
  matched_total   Int
  row_count       Int
  truncated       Boolean  @default(false)
  duration_ms     Int?
  rows            MetaDebugRecordRow[]

  @@index([project_name, created_at])
  @@index([created_by])
}

model MetaDebugRecordRow {
  id                   String  @id @default(uuid())
  record_id            String
  seq                  Int
  log_time             String            // 原文（CH 墙钟串），回看时按 §1.1 同口径渲染
  event                String
  distinct_id          String
  user_key             String
  properties           String  @db.Text  // 原文；超限截断
  properties_truncated Boolean @default(false)

  record MetaDebugRecord @relation(fields: [record_id], references: [id], onDelete: Cascade)

  @@index([record_id, seq])
}
```

迁移：`prisma/migrations/2026xxxxxxxxxx_debug_query_record/`，先在测试库 `migrate dev`，
生产前在 `clklog_sa_staging` 演练（红线 6：DDL 先演练后生产）。

**体积上限**（常量集中在上限块，便于调）：单条 ≤100 行；单行 `properties` ≤ 32KB（超出截断并 `properties_truncated=true`）；
单条总 payload ≤ 1MB（超出按 `seq` 丢弃剩余行并 `truncated=true`）。任何截断都在界面标注，不静默。
两个上限必须同量级才不落空：8KB × 100 行 = 800KB 会让 1MB 那条永不生效，故单行取 32KB（32KB × 100 行 = 3.2MB，总量上限是活的）。

### 2.2 接口契约

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/sa/api/meta/debug/query` | 查询 + 留档；body `{ distinct_id?, user_key?, event?, window?, limit? }`；返回 `{ items, matched_total, archived, record_id?, truncated?, archive_disabled? }`；**留档失败不影响查询**（`archived:false`，前端提示「本次结果未留档」）；项目关闭留档时 `archived:false, archive_disabled:true` |
| `GET` | `/sa/api/meta/debug/recent` | 保留：只查不留档（外部调用 / AI 工具用），返回补 `matched_total` |
| `GET` | `/sa/api/meta/debug/records` | 列表；`{ items, total, page, pageSize }`（沿用既有列表契约）；item 只含概要字段，不含行 |
| `GET` | `/sa/api/meta/debug/records/:id` | 详情：概要 + `rows`（快照行，按 `seq`） |
| `DELETE` | `/sa/api/meta/debug/records/:id` | 删除（级联删行）；写审计；越权 403、不存在 404 |

均限本项目（`project_name` 从既有 `CurrentProject` 取），沿用 `@RequirePermission('meta.view')`。

### 2.3 权限与审计

- 查看：`meta.view` + 本项目。
- 删除（**已定决议**）：**创建者本人 / 平台超管 / 持 `meta.edit` 的项目成员**（三者之一）；不满足 → 403。
- 审计：写 `ops_action_log`，`action = 'meta_debug_record_deleted'`，`detail = { record_id, cond, window, matched_total, row_count }`，
  `operator = 当前用户`。**不用 `auth_` 前缀**——账号审计列表按该前缀过滤，混入会污染。
- 删除只删派生快照，不触碰 `sa_events`（红线 6 的「无审计不删除」由上面的审计记录满足）。

### 2.4 项目级留档开关（F2，已定决议：默认开）

- 存储：`sa_project` 增列 `debug_archive_enabled Boolean @default(true)`（与既有 `timezone` 同表同域，随同一个迁移落地）。
- 读：`DebugService` 落档前查一次开关（随连接池/进程内短缓存，避免每查询多一次 DB 往返；缓存 TTL 30s，改动时由写接口清缓存）。
- 写：`PUT /sa/api/meta/debug/archive-setting`，`@RequirePermission('ops.owner.assign')`（**与项目时区设置同权限**；方法级元数据覆盖类级 `meta.view`），body `{ enabled: boolean }`；写后清缓存 + 写审计 `meta_debug_archive_toggled`。
  （放在 meta 控制器而非 `iam/ops`：开关与缓存同属 Debug 域，避免 iam → meta 的模块耦合；权限口径不变。）
- 读：`GET /sa/api/meta/debug/archive-setting`（`meta.view`）返回 `{ enabled }`，供页面显示状态与权限内开关。
- 行为：开关关闭 → 查询照常返回结果，**不落档**，响应带 `archived:false, archive_disabled:true`，前端明示「本项目已关闭留档，本次结果不会保存」。
- 入口：Debug 页历史区域的开关，仅对 `ops.owner.assign` 可见（不另起设置页；项目时区目前也只有接口没有页面，这里顺手给它一个可见入口）。

### 2.5 前端

- 页面分两块：「本次结果」（现有区域 + 命中数/留档状态行）与「历史记录」（列表 + 详情抽屉/展开 + 删除二次确认）。
- 历史详情复用同一张表格与同一时间渲染口径（§1.1），命中数/条数与列表一致；`truncated` 显示「本次记录不完整（已截断）」。
- i18n：新增键落在 `meta:debug.*`（`historyTitle / historyEmpty / column条件/操作人/命中/返回 / view / delete / deleteConfirm / deleted / archived / notArchived / truncated / windowLabel / window.1h|24h|7d / slowHint / hitTotal / shownRecent / statDateNotice / invalidLimit`），
  **13 语言 × 16 命名空间同步补齐**（`scripts/i18n_check.py` 键集/占位符一致；`i18n_scan.py --check` 硬编码清零棘轮只减不增）。

## 3. 契约与文档同步

| 文档 | 动作 |
|---|---|
| `docs/architecture/` 接口契约（分析域接口表） | 登记 4 个 Debug 接口与 `{ items, matched_total }` 字段 |
| `docs/architecture/implementation-breakdown-clklog-analytics-v1.md` P1-M7 | 窗口口径由「固定最近 7 天」改为「1h/24h/7d，默认 24h」 |
| 本 PRD §3.3 备注 | 已写明 `stat_date` 裁剪的语义代价（±2 天） |
| `INDEX.md` | 新增两份文档的条目与计数 |

## 4. 验收与验证

1. **静态门禁**：`python3 scripts/arch_ratchet.py`、`python3 scripts/i18n_check.py`、`python3 scripts/i18n_scan.py --check`、
   后端 `npm run build` + `npx jest`、前端 `npm run build` + `npm test -- --run`。
2. **契约测试**：接口返回字段快照（含 `matched_total`）；`limit/window` 非法值 → 400 且响应体内不含 ClickHouse 文本。
3. **迁移演练**：测试库 `migrate dev` + `clklog_sa_staging` 演练，确认两表与外键级联。
4. **生产实测**（发布后，浏览器 + 直查对拍）：
   - AC-1 时间：同一行界面时间 = CH `log_time` 墙钟；实时流交叉验证不出现未来时间；
   - AC-2 命中数：`distinct_id=样例标识` 显示 27492；
   - AC-3 速度：默认 24h 窗口按设备查询 <3s；7d 有提示；
   - AC-4 参数：`limit=abc` → 400；
   - AC-5/6/7 留档：查询 → 列表出现 → 重启服务仍在 → 详情行与当时一致 → 删除后 404 且有审计、`sa_events` 不变；
   - AC-8 截断：构造超长 properties 标注「已截断」。
5. **发版**：按 `AGENTS.md`「release 环境快速部署」（隧道 → push → 等 CI 产物就绪 → `server-upgrade.sh` → 验证）。

## 5. 实施顺序（每步可独立验收）

1. D1（helper + 调用点 + 单测）→ 2. D2（SQL 窗口函数 + 契约 + 前端文案）→ 3. D4（校验 + 错误映射）
→ 4. D3（窗口参数 + `stat_date` 谓词 + UI 选择与提示）→ 5. F1 后端（迁移 + 模型 + 4 接口 + 单测）
→ 6. F1 前端（历史区 + 详情 + 删除 + 13 语言文案）→ 7. 门禁 + 发版 + 生产验收。

D1/D2/D4 各自都是「改一处、能立刻在生产验证」的小改动；F1 依赖 D1 的时间口径（快照行要按同一口径回看）。

## 6. 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| R-1 | `stat_date` 裁剪会漏掉「时钟偏差 >2 天 / 历史补数」的行 | 界面与 PRD 明示；备选路线是跳数索引（不改语义，需演练） |
| R-2 | 记录永久保存会长期留存原始 properties | **已定**：项目级开关（默认开，§2.4）+ 按项目隔离 + 权限 + 可删除 + 删除审计 |
| R-3 | 留档写入放大写压力（每次查询 1 + N 行） | 单条 ≤100 行、异步不阻断返回、失败降级 `archived:false` |
| R-4 | 前端 60s axios 超时仍在（7d + 设备维度可能仍 >60s） | 本 phase 用窗口默认值 + 慢查询提示缓解；彻底解法（异步任务）登记后续 phase |
| R-5 | 前端外若有其它调用方（脚本/外部工具）直接打 `GET /recent` | 该接口**保留**且只增字段（`matched_total`），契约向后兼容；仓库内目前只有前端 `meta.service.ts` 调用，留档走新的 `POST /query` |
