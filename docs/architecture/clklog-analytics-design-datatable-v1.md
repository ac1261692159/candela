# 实现方案：数据表（维度表）v2 修订稿

> phase: `clklog-analytics-datatable-v1`
> 上游 PRD：`docs/product/prd-clklog-analytics-datatable-v1.md`（已同步改为 v1/v2 分期）
> 对标事实：`docs/product/research-clklog-analytics-dimension-table.md`
> 本文是**表结构、ID 契约、查询接入、API、写入与安全**的权威（SSOT 增量）。
> 状态：**实现中（2026-09-15）**。Gate 0 已实测；事件分析结果映射已在生产 17134 生效。本轮落地 §9 写入协议、绑定 `label_field`、三类分析装配层映射。
> 修订原因：Astra 评审 8 项 + 缓存项；逐条回应见 §0。生产对照与偏离见 §18。

---

## 0. 评审回应（逐条核实，含证据）

核实方式：只读代码/配置 + 生产实例只读探测（隧道 2223）。**未修改任何文件、未执行写操作。**

| # | 评审结论 | 核实结果 | 处置 |
|---|----------|----------|------|
| 1 | 相关标量子查询与 CH 23.2.1 不兼容风险 | **评审判断正确**：`docker-compose.yml.epp:6` = `clickhouse-server:23.2.1`，生产自报 `23.2.1.2537`；2026-09-14 生产只读探针**实证相关子查询在该版本不可用**（`Code 47 UNKNOWN_IDENTIFIER`，含最小反例与"列齐备"重测）。原稿"三个生成器零改动"的结论**不成立** | **重构**：v1 改为**不依赖任何 CH 跨表能力**（§4、§7）；跨表能力移入 v2，**路径 A 证否 → 走 B（字典，待 DDL 授权验证）或 C（JOIN，已实测可用）**（§4.3、`clklog-analytics-design-datatable-v2.md` §4） |
| 2 | 新属性名会被 DSL 校验拒绝 | **成立**：`dsl-validator.service.ts:28` `PROP_KEY_PATTERN = /^\$?[a-zA-Z_][a-zA-Z0-9_$.-]{0,63}$/`，不含 `@`，总长上限 65；前端属性选择器走 `prop_key`（`components/event-property-options.ts`） | **v1 不引入新属性 key**（映射不改 DSL 命名空间）；v2 若要引入，须新增专用正则 + 长度上限并同改 validator、前端选择器、看板筛选渲染（列为显式任务，§6.3） |
| 3 | 替换更新失败丢旧数据，补偿无法恢复 | **成立**：原稿是"先 DELETE 再 INSERT"，插入失败后旧数据已不存在 | **采纳**：改为**版本化快照 + 原子切换 + 延后清理**（§5、§9） |
| 4 | `importing` 标志不足以构成并发/崩溃协议 | **成立**：原稿未定义原子抢占、归属、超时接管、重启恢复 | **采纳**：MySQL 持久化租约（CAS 抢占 + 过期接管）+ pending 版本 + 清理任务（§9.3） |
| 5 | 主键/布尔类型契约未贯通 | **部分成立且原稿有错**：现有类型词表是 **`boolean`**（`attribute-resolver.service.ts:90-106` `extractSuffix`），原稿写 `bool` 是错的；数值/时间/布尔的规范化与未命中语义原稿确实没定义 | **采纳**：v1 把类型契约落在**应用层**（不跨 CH 比较，§6.2）；v2 才需要两侧 SQL 类型对齐 |
| 6 | 删除后"无残留"与"保留 invalid"自相矛盾 | **成立**：原稿两处写法冲突；且经核实 `attribute-resolver.service.ts:46-58`，虚拟属性非 `active` 时会**静默回退**到 `JSONExtract`，不能靠现状保证"卡片报可读错误" | **采纳**：删除/解绑**只置 `invalid`，不物理删除记录**；映射解析必须**显式失败**而非回退（§10） |
| 7 | 单次上传限额不能保证单表行数上限 | **成立**：原稿只校验文件行数 | **采纳**：改为校验 **pending 版本去重后总行数**（快照模型天然支持），并与导入互斥共用同一租约（§9.2） |
| 8 | CH 建表未接入实际发版路径 | **成立**：`scripts/` 目录内**无任何** `init-clickhouse` 调用（`grep -rl` 0 命中），`init-clickhouse.ts` 只能人工执行 | **采纳**：新增幂等迁移入口并在升级脚本中执行，失败即中止升级（§13） |
| 9 | 查询结果缓存 300s 未处理 | **成立**：`query-cache.service.ts:9` `ttlSeconds = 300`（前缀 `sa:query:`）；看板卡片缓存默认 300s（`report/card-cache.policy.ts:6`） | **采纳**：版本切换或绑定变更后**清该项目查询缓存**并失效相关卡片缓存（§10.3） |

**结论变化**：原方案的"小改动、低风险"结论撤回。改为**两段交付**：v1 只做**不依赖未验证能力**的部分（上传/管理/审计 + 结果集值映射），v2 才做跨表维度，并以 Gate 0 的实测结果定实现路径。

---

## 1. 阶段目标与范围

一句话：**让事件里的业务 ID 在分析结果里可读**（v1），**并最终可作为分析维度使用**（v2）。

| 能力 | v1（本次交付） | v2（Gate 0 之后另立 phase） |
|------|:----:|:----:|
| CSV 上传建表（三步向导）、列表、下载、清空、删除 | ✅ | — |
| 增量更新 / 替换更新（版本化快照，失败不影响线上） | ✅ | — |
| 关联属性：把表绑到「事件属性 / 事件名称 / 事件时间（粒度）」 | ✅ | — |
| **结果集值映射展示**：按 ID 分组的行显示"精铁"而不是 `10001`；CSV 导出同样可读 | ✅ | — |
| 筛选下拉显示 `名称（ID）`，**提交值仍是 ID** | ✅ | — |
| 审计（方式 / 行数 / 操作人 / 时间） | ✅ | — |
| 跨表维度：按维表字段**分组/筛选/聚合**（生成 `{属性}@{字段}` 维度表属性） | ❌ | ✅（路径见 §8） |

v1 的工程特征：**不改 SQL 生成器、不依赖 ClickHouse 版本能力、不新增 DSL 字段**；映射在服务端结果装配层完成（§7）。

## 2. 验收标准（门禁要素①）

v1：

- [ ] `datatable-csv.spec.ts`：BOM/分隔符/引号、空主键丢弃、类型推断、类型错误丢弃并带行号、文件内重复主键取后行、列顺序不一致拒绝、超限拒绝。
- [ ] `datatable-version.spec.ts`：**替换更新中断（模拟插入失败）后，`active_version` 未变、查询仍读到完整旧数据**；旧版本行在切换后由清理任务删除。
- [ ] `datatable-lease.spec.ts`：并发两次提交只有一次拿到租约（第二次 409）；租约过期后新请求可接管；进程重启后 `pending` 版本不生效且被清理。
- [ ] `datatable-limit.spec.ts`：19 万行表 + 2 万行增量 → 在 pending 阶段即被拒绝（不是上传时才拒）。
- [ ] `datatable-map.spec.ts`：结果装配层映射正确、未命中显示原值、`IN` 查询分批 ≤1000 且总批次上限生效、映射字段可选。
- [ ] 端到端 `apps/analytics-server/test/datatable/`（合成 ClickHouse）：PRD A1–A12 通过，含「删除数据表后卡片报可读错误、不静默回退」。
- [ ] **Gate 0 探针脚本**（§4.2）在测试库与生产实例上均可只读执行并留档结果（v2 开工前提，v1 不阻塞）。
- [ ] `python3 scripts/arch_ratchet.py` 通过；`modules/datatable/` 生产文件 ≤30 / 行 ≤8000。

## 3. 非目标（门禁要素②）

v1 不做：跨表维度（v2）、Excel、用户属性绑定、Open API / 定时更新、结构变更与发布、版本还原、联合主键、对象/列表字段、用户 SQL 直接查维表、表级数据权限、维度字典的独立产品面。

---

## 4. Gate 0：ClickHouse 查询能力前置验证（v2 开工前提）

### 4.1 为什么要先验

v2 的三条候选路径都依赖"23.2.1 上到底能不能这么写"。**先测再选**，不允许实现期边写边猜。

### 4.2 探针清单（只读、有界、可留档）

| 探针 | SQL 形态 | 判定 |
|---|---|---|
| P-A 相关标量子查询 | 结果列中出现引用外层 `sa_events` 的子查询，用于 `GROUP BY` 与 `WHERE` | 通过则路径 A 可用 |
| P-B 聚合参数内的相关子查询 | 同一子查询放进 `windowFunnel(...)` 参数（漏斗场景） | 通过则路径 A 覆盖漏斗/留存 |
| P-C `dictGet` | `CREATE DICTIONARY`（HASHED，`SOURCE(CLICKHOUSE(... WHERE ...))`）+ `dictGetString/OrDefault` + `SYSTEM RELOAD DICTIONARY` | 通过则路径 B 可用（需评审 DDL 与内存） |
| P-D 类型跨侧比较 | `JSONExtractFloat(...) = toFloat64(pk_text)`、`JSONExtractBool(...)`、`formatDateTime(log_time,'%Y-%m-%d','Asia/Shanghai')` | 确定类型规范化写法 |
| P-E 未命中语义 | 子查询/dict 未命中时的返回（空串 / NULL / 默认值） | 写入契约 |

执行约定：探针 SQL 只 SELECT、带 `stat_date` 与 `LIMIT`；在**测试库**先跑，生产只跑只读形态；结果（通过/失败 + 报错原文）留档到本文 §4.3。

### 4.3 实测记录（2026-09-14 完成，生产实例，只读）

环境：生产主机，ClickHouse `23.2.1.2537 (official build)`，账号 `sa_readonly`（只读），项目 `clklogapp`；全部探针带项目过滤 + 行数上限（5000 / 2000 / LIMIT 2），未执行任何写操作。口令未落盘、未回显。

| 探针 | 结果 | 关键证据 |
|---|---|---|
| 版本 | 确认 | `23.2.1.2537 (official build)` |
| **P-A 相关标量子查询（表名形式）** | **FAIL** | `Code: 47 UNKNOWN_IDENTIFIER Missing columns: 'sa_events.distinct_id' 'sa_events.project_name'` |
| **P-F 最小相关引用** | **FAIL** | `Missing columns: 'sa_events.project_name'` |
| **P-A5 列齐备后重测** | **FAIL** | `Missing columns: 'sa_events.distinct_id'`（内表有 `uid`，说明失败与缺列无关，是外列引用本身不被支持） |
| P-B windowFunnel 内相关子查询 | 未执行 | 与 P-A 同构造，结论由 P-A 覆盖 |
| P-C dictGet / Dictionary | 未执行 | 建字典属 DDL，本次仅授权只读探针 |
| P-D 类型构造 | PASS | `JSONExtractFloat`→0、`JSONExtractString`→''、`JSONExtractBool`→0、`formatDateTime(log_time,'%Y-%m-%d','Asia/Shanghai')`→`2025-10-21`、`toFloat64OrZero('100')`→100、`lower(toString(...))`→`0` |
| P-E 未命中语义 | PASS | 标量子查询无行 → **NULL**（`isNull`=1），`NULL = ''` → **NULL**（不是 true）；JSON 缺键 → 字符串 `''`、数值 `0`、布尔 `0` |
| **P-G LEFT JOIN（等值列）** | **PASS** | 5000 行结果，`read_rows` 344,497 |
| **P-H LEFT JOIN（表达式关联键 + 维表子查询）** | **PASS** | 2000 行结果，`read_rows` 123,595 |

**结论**：路径 A（相关标量子查询）在 23.2.1 上**不可用**；路径 C（JOIN）已实测可用（含表达式关联键这一真实形态）。

**同批附带发现（已登记 `CODE_HANDOVER.md` 2026-09-14 节，P1，未授权前不改码）**：

1. 生产 `sa_user_profiles` 实际只有 `distinct_id,user_key,properties,updated_at`，**没有 `project_name`**，与 `init-clickhouse.ts`、`attribute-resolver.service.ts:87`、`subject-expr.ts:36` 的假设不一致（表结构漂移）。
2. 由 1 + 相关子查询不被支持，`resolveUserProperty` 与 `subject-expr` 的 scope=user 分支在**生产**会报 missing columns；`clklog-user-property-join-v1` 的修复方向（补 `project_name` 关联）不成立，该方案已加修订说明待重开。

---

## 5. 数据模型（版本化快照）

### 5.1 设计要点：**每次导入都是一个完整版本，切换靠一个字段**

- 导入永远**先写新版本**，写完再原子切换 `active_version`，**旧版本延后清理**；
- 任何阶段失败 → 当前生效版本不变，线上查询不受影响（回应评审 3）；
- 增量更新 = 读旧版本 + 应用变更 + 全量写新版本（单表 ≤20 万行，代价可接受），换来"替换/增量/清空"三套语义统一；
- 版本内 `(project, datatable_key, version, pk)` 唯一 → 查询不需要 `FINAL` 去重，顺便解决原稿的 `FINAL` 性能问题。

### 5.2 ClickHouse（库 `clklog_sa`，`src/scripts/init-clickhouse.ts`）

```sql
CREATE TABLE IF NOT EXISTS clklog_sa.sa_datatable_rows
(
    `project_name`  LowCardinality(String),
    `datatable_key` String,                    -- = meta_datatable.id
    `version`       UInt64,                    -- 导入版本号，单调递增
    `batch_id`      String,                    -- dti_ 审计批次
    `pk`            String,                    -- 规范化主键文本
    `values`        String CODEC(ZSTD(3)),     -- {"quality":"Common","quantity":100}
    `created_at`    DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY version
ORDER BY (project_name, datatable_key, version, pk);
```

- 查询恒带 `AND version = {active_version}`（`{active_version}` 由服务端从 MySQL 读出后参数化注入，不接受 DTO 传值）。
- 清理：`ALTER TABLE ... DELETE WHERE project_name = ? AND datatable_key = ? AND version != ?`（切换成功后异步执行；失败重试，不影响正确性 —— 多一个旧版本最多多占存储）。
- 不建 `Dictionary`（v1 不需要；v2 由 Gate 0 决定，见 §8）。

### 5.3 MySQL（库 `clklog_sa_meta`）

```prisma
model MetaDatatable {
  id             String   @id            // dt_ + nanoid(10)
  project_name   String
  table_key      String                  // ^[a-z][a-z0-9_]{0,49}$
  remark         String?
  row_count      Int      @default(0)    // 当前生效版本的行数
  column_count   Int      @default(0)
  version_seq    Int      @default(0)    // 已分配的最大版本号
  active_version Int      @default(0)    // 生效版本；0 = 尚无数据
  pending_version Int?                   // 正在写入的版本
  import_owner   String?                 // 租约持有者（用户 id）
  lease_until    DateTime?               // 租约到期时间
  created_by     String
  updated_by     String
  created_at     DateTime @default(now())
  updated_at     DateTime @updatedAt
  @@unique([project_name, table_key])
}

model MetaDatatableColumn   { id String @id  // dtc_
  datatable_id String; field_key String; data_type String   // number|string|datetime|boolean
  display_name String?; is_primary Boolean @default(false); sort_order Int
  @@unique([datatable_id, field_key]) }

model MetaDatatableBinding  { id String @id  // dtb_
  datatable_id String; project_name String
  target_type String      // event_property | event_name | event_time
  target_prop String      // 属性 key；内置为 "#event_name" / "#event_time"
  key_column String       // 方案 B：join 键列，不必是主键
  label_field String?     // v1 单展示列；空则按 pickLabelField 默认
  field_mappings Json?    // v2 派生属性元数据，v1 查询不读
  granularity String?     // year|month|day|hour|minute|second（仅 event_time）
  status String @default("active")   // active | invalid
  created_by String; created_at DateTime @default(now())
  @@unique([datatable_id, target_type, target_prop]) }

model MetaDatatableImport   { id String @id  // dti_
  datatable_id String; project_name String
  mode String             // create | incr | replace | clear | delete
  from_version Int?; to_version Int?
  total_rows Int; success_rows Int; dropped_rows Int; dropped_json String?
  result String           // success | failed | rolled_back
  error String?
  operator String; created_at DateTime @default(now()) }
```

> 相较原稿：删掉 `import_status` 单标志（改租约）、删掉 `MetaDatatableProperty`（v2 才引入），新增版本号与租约字段。

---

## 6. ID、类型与命名契约

### 6.1 ID

| 实体 | 规则 |
|---|---|
| 数据表 | `dt_` + nanoid(10)（= CH `datatable_key`） |
| 字段 | `dtc_` + nanoid(10) |
| 绑定 | `dtb_` + nanoid(10) |
| 导入批次 | `dti_` + nanoid(10)（= CH `batch_id`） |
| 版本号 | `UInt64`，来自 `MetaDatatable.version_seq` |
| 维度表属性（**v2**） | `dtp_` + nanoid(10)；DSL 引用名 `{绑定属性}@{字段名}` |

`docs/architecture/clklog-analytics-design.md` §10 已登记；v2 行需标注"v2，未实现"。

### 6.2 类型与比较语义（v1：应用层，不跨 CH 比较）

v1 的映射是"结果值 → 维表行"的**应用层字符串匹配**，因此类型契约落在服务端：

| 声明类型 | 维表主键规范化 | 结果值规范化 | 未命中 |
|---|---|---|---|
| `string` | `trim` | `String(值).trim()` | 显示原值 |
| `number` | 去尾零/科学计数法统一（`Number(x).toString()`） | 同左（`Number.isFinite` 才参与匹配） | 显示原值 |
| `boolean` | `true`/`false`（**对齐现有词表 `boolean`**） | `true/false/1/0` → 归一 | 显示原值 |
| `datetime` | 按**绑定粒度**格式化（`#event_time`）或按声明格式 `trim`（属性绑定） | 同左 | 显示原值 |

- 时区：`#event_time` 统一 **`Asia/Shanghai`**（与 `shanghaiTodayYmd()`、`stat_date` 口径一致，容器 `TZ=Asia/Shanghai`），格式化在服务端做，不由 ClickHouse 承担（v1 不跨 CH）。
- **未命中一律显示原值**，不显示空、不伪造 0；命中但值为空字符串时显示空并在表格里可切换原始值。
- v1 **不做**"数值/时间在 ClickHouse 内的等值比较"，因此不存在隐式类型转换风险；v2 需要时按 Gate 0 P-D 的结论写。

### 6.3 v2 预留：属性名语法（本次不做，须先改校验器）

若 v2 引入 `{属性}@{字段}` 形态的属性 key，必须同批完成：

1. `dsl-validator.service.ts:28` 增加**专用分支**（不放宽通用正则）：`^(#[a-z][a-z0-9_]{0,49}|[a-zA-Z_][a-zA-Z0-9_$.-]{0,63})@[a-z][a-z0-9_]{0,49}$`，并把总长上限提到 130；
2. 前端属性选择器 `components/event-property-options.ts` 的分组/标记；
3. 三类分析（事件/漏斗/留存）的筛选、分组、聚合接口回归用例；
4. 校验器与生成器的注入用例（`@`、`#` 不引入引号/括号，仍不构成注入口）。

---

## 7. v1 查询接入：结果装配层值映射（零 CH 能力依赖）

### 7.1 位置

| 落点 | 说明 |
|---|---|
| `modules/query/event-query.service.ts:175 formatResult` | 事件分析结果装配：按 `query.groups[i]` 找出被绑定的属性，为该列附映射 |
| `funnel-query.service.ts` / `retention-query.service.ts` | 漏斗/留存结果装配，同一份 `DatatableMapService` |
| `modules/datatable/datatable-map.service.ts`（新） | 给定 `(project, 列属性, 结果值集合)` → 返回 `{ [raw]: { [field]: value } }` |

### 7.2 取数与有界性

v1 映射在应用层完成。因方案 B 允许 join 键不是首列，**不能**只按 CH `pk IN` 命中（`pk` 恒为首列）。实现读生效版本快照（恒带 `project_name` + `datatable_key` + `version` + `LIMIT`），再按 `key_column` 匹配。

- 走 **`readonlyClient`**，不碰写通道；
- 单次结果最多映射 **5 万** 个取值，超限则**跳过映射**并在列上返回 `truncated`（不静默、不拖垮查询）；
- 快照进程内缓存按 `(project, id, version)`，TTL 60s；版本切换后清该项目条目。

### 7.3 契约

- 结果列可选字段：`value_map: Record<raw, label>`（扁平，v1 单展示列）、`value_map_title`、`value_map_stats: { sampled, matched, truncated? }`。仅出现在被绑定的分组列。
- 前端：表格/图例显示所选展示列；列级「显示原始值」开关；CSV 同时输出展示名与原始值。
- 筛选：已绑定属性的等于/列表类算子下拉显示 `名称（ID）`，**提交仍是 ID**。
- 卡片/看板：DSL 未变；查询缓存 key 含数据表修订戳；版本/绑定变更后把该项目 event/funnel/retention 卡片 `refreshed_at` 置为过期。

---

## 8. v2 查询接入：跨表维度的候选路径（依赖 Gate 0）

| 路径 | 形态 | 优点 | 主要代价 |
|---|---|---|---|
| A 相关标量子查询 | resolver 生成 `(SELECT JSONExtract...(values,'col') FROM sa_datatable_rows FINAL WHERE project_name=... AND datatable_key=... AND version=... AND pk=<基底表达式> LIMIT 1)` | 复用现有 `resolveUserProperty` 写法；生成器零改动 | **23.2.1 已实测不可用**（`Code 47`，见 §4.3）——**排除** |
| B ClickHouse Dictionary | 每张数据表一个 `CREATE DICTIONARY`（HASHED，源为 `sa_datatable_rows` 的对应版本），resolver 生成 `dictGet*` | 普通标量函数；查找性能最好；未命中语义明确（`OrDefault`） | 需要 DDL 与 `SYSTEM RELOAD` 生命周期；内存随表数与行数增长；**同样需 Gate 0 验证** |
| C JOIN 改写 | 主查询 `LEFT JOIN` 维表 | 性能可预测 | 三个生成器的 FROM/聚合结构都要改，回归面最大 |

**2026-09-14 实测后定案**：A 在 23.2.1 上不可用（§4.3 证据）；C 已实测可用，含"表达式关联键 + 维表子查询"这一真实形态。因此 v2 在 **B 与 C 之间二选一**：

- **B（字典）**：生成器零改动，但需要一次 `CREATE DICTIONARY` 的 **DDL 授权**验证（建后即删），并解决字典 reload 与内存占用；
- **C（JOIN）**：已验证，但需改三个生成器的 FROM/JOIN 组装，回归面最大。

三条路径都仍需先补 §6.3 的属性名与校验器改造。决策与实现细节见 `docs/architecture/clklog-analytics-design-datatable-v2.md` §4。

---

## 9. 写入、版本切换、租约与审计

### 9.1 导入流程（v1）

```
1 解析校验（纯函数，不落库）           → 预览：字段/成功/丢弃行数
2 抢租约（CAS）                        → 失败 409
3 分配 version = version_seq + 1，写 pending_version
4 读旧版本（active）→ 应用增量/替换 → 写新版本行（batch_id）
5 校验：新版本去重总行数 ≤ 20 万、列数 ≤ 100      → 超限则放弃 pending（不切换）
6 原子切换：UPDATE ... SET active_version = pending, row_count = ?, pending_version = NULL
   WHERE id = ? AND pending_version = ?（CAS，失败则回滚 pending）
7 清查询缓存 / 失效相关卡片缓存（§10.3）
8 异步清理：删除 version != active_version 的行；写审计
9 释放租约
```

### 9.2 增量与替换的统一

| 请求方式 | 第 4 步的动作 |
|---|---|
| 增量 | `INSERT INTO ... SELECT` 旧版本全部行（`pk` 不在新文件中的）→ 再插入新文件行（同主键后行覆盖） |
| 替换 | 只插入新文件行 |
| 清空 | 只写一个空版本（切换后表空但结构/绑定保留） |

限额校验（评审 7）在**第 5 步**按新版本去重总行数执行，与导入共用同一把租约，不存在"两次并发各写一半"的缝隙。

### 9.3 并发与崩溃恢复（评审 4）

```sql
-- 抢占（影响行数 = 1 才算拿到）
UPDATE meta_datatable
   SET import_owner = ?, lease_until = NOW() + INTERVAL 5 MINUTE, pending_version = ?
 WHERE id = ? AND project_name = ?
   AND (lease_until IS NULL OR lease_until < NOW())
```

- **原子性**：由单条 `UPDATE` 的行锁保证，不依赖应用层判断；
- **归属**：`import_owner` 记录持有者，释放时按 `owner + version` 校验；
- **超时接管**：租约过期（5 分钟，导入期间心跳续租）即可被新请求抢占；
- **重启恢复**：进程重启后 `pending_version` 不为空但 `active_version` 未变 → 启动清理任务把 `pending_version` 置空并删除该 pending 版本的 CH 行；**生效版本永远不受影响**；
- **互斥**：清空、删除、结构变更与导入共用同一把租约（同一 `UPDATE` 语句），避免"删表进行中又被导入"。

### 9.4 审计

每次导入/清空/删除写 `MetaDatatableImport`（方式、from/to version、成功/丢弃行数、结果、错误、操作人、时间）；丢弃明细最多存 1000 条，其余只计数。表详情页可见、可导出（红线⑥）。

---

## 10. 删除、失效与缓存

### 10.1 删除策略（回应评审 6：统一为"只失效、不物理删"）

| 动作 | 数据表 | 绑定 | 后续 |
|---|---|---|---|
| 解绑 | 保留 | `status='invalid'` | 查询不再映射该属性（显示原值） |
| 清空数据 | 保留 | 保留 | 映射无命中 → 显示原值 |
| 删除数据表 | `status='deleted'`（不物理删） | 全部置 `invalid` | CH 行删除；元数据保留用于排查与同名重建 |

### 10.2 "失效必须显式失败"（不回退）

- v1 映射层：绑定 `invalid` → **不映射**（显示原值）并在响应里带 `warnings: [{prop, reason}]`，前端提示"该属性依赖的数据表已删除/解绑"。
- v2 维度表属性：解析到 `invalid` 的属性时**必须抛可读错误**（`BadRequestException('属性 xxx 依赖的数据表已失效')`），**禁止**沿用现状的静默回退（`attribute-resolver.service.ts:46-58` 对非 active 虚拟属性会回退到 `JSONExtract`，这是评审 6 指出的真实风险点，v2 必须显式覆盖该行为并加测试）。
- 同名重建：绑定创建时若命中已存在（`invalid`）的记录 → **复用该记录并置 `active`**（提示"已恢复同名绑定"）；若已有 `active` 记录则 409。v1 因绑定不含属性名，只需按 `(datatable_id, target_type, target_prop)` 复用。

### 10.3 缓存失效（回应评审 9）

| 缓存 | 位置 | 失效时机 |
|---|---|---|
| 查询结果缓存（300s，前缀 `sa:query:`） | `modules/query/query-cache.service.ts:9` | 版本切换、绑定增删改 → 清**该项目**的查询缓存键 |
| 卡片缓存（默认 300s） | `report/card-cache.policy.ts:6`、`card.cache.result_json` | 同上：清 `result_json`（或置 `refreshed_at` 为过期）使下次刷新重算 |
| 元数据/绑定缓存（新增） | `DatatableMapService` 内 | 由同一失效钩子清 |

生效时间写进 UI：绑定/更新提交成功后提示"结果将在下次查询生效；已缓存看板将在刷新后更新"。

---

## 11. API 契约

Base `sa/api/meta/datatables`，类级 `@RequirePermission('meta.view')`，写操作 `@RequirePermission('meta.edit')`（`iam/permission-catalog.ts:53-54`；写法参照 `meta-virtual-property.controller.ts`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/parse` | `{ file_name, csv_text }` → `{ columns[], preview_rows[≤20], success_rows, dropped_rows, dropped_detail[≤200] }`；不落库 |
| POST | `/` | 建表：`{ table_key, remark, columns[], csv_text }` |
| GET | `/` | 列表（含 `row_count`、`active_version`、`binding_summary`、更新人/时间） |
| GET | `/:id` | 详情：字段 + 绑定 + 最近审计 |
| GET | `/:id/download` | 导出 CSV（生效版本） |
| POST | `/:id/update/preview` | `{ mode, csv_text }` → `{ added, updated, dropped, dropped_detail }` |
| POST | `/:id/update` | `{ mode: 'incr'\|'replace', csv_text }` → 走 §9.1 全流程 |
| GET | `/:id/bindings` | 绑定列表（含 `status`） |
| POST | `/:id/bindings` | `{ target_type, target_prop, granularity? }` |
| PATCH | `/:id/bindings/:bindingId` | 改粒度（改后需重新校验主键格式） |
| DELETE | `/:id/bindings/:bindingId` | 解绑（置 `invalid`） |
| POST | `/:id/clear` | 清空（写空版本） |
| DELETE | `/:id` | 删表（置 `deleted` + 绑定 `invalid` + 删 CH 行） |
| GET | `/:id/usage` | 影响面：引用该表绑定的卡片/看板清单 |

错误码：`400` 校验、`403` 权限、`404` 不存在、`409` 表名重复 / 租约被占 / 已有生效绑定、`413` 超限。

---

## 12. 前端落点

| 文件 | 职责 |
|---|---|
| `pages/Meta/DataTablesPage.tsx` | 列表 + 搜索 + 行操作 |
| `features/meta/DataTableWizard.tsx` | 三步向导 |
| `features/meta/DataTableUpdateDialog.tsx` | 增量/替换 + 差异预览 |
| `features/meta/DataTableBindingDialog.tsx` | 关联属性（选属性 / 事件时间粒度 / 展示字段） |
| `features/meta/DataTableValueDisplay.tsx` | 结果展示：列级映射、显示原值开关 |
| `services/datatable.service.ts` | API 封装 |
| `routes.tsx`（`:200-207` 区）、`layouts/MainLayout.tsx`（`:85-101` 区）、`shell-menu.ts` | 菜单/路由，`hasPerm('meta.view')` |
| `components/FilterEditor.tsx`、`GroupEditor.tsx` | 筛选/分组下拉显示 `名称（ID）`（提交值不变） |

上传沿用 `CohortEditPage.tsx:297-321` 的 antd `Upload` + `FileReader.readAsText`（`.csv`）。

---

## 13. 迁移与发版路径（回应评审 8）

1. **Prisma**：新增 §5.3 四张表 + migration（纯新增）。
2. **ClickHouse 幂等迁移入口**（必须新增）：
   - 把 `init-clickhouse.ts` 的 DDL 抽为 `ensureClickhouseSchema()`（幂等 `CREATE TABLE IF NOT EXISTS`）；
   - 新增 CLI：`node dist/src/scripts/migrate-clickhouse.js`（读同一份 DDL，可重复执行，失败非 0 退出）；
   - 结论依据：`scripts/` 目录内**现在没有任何** `init-clickhouse` 调用，只改脚本文件不会让已有环境建表。
3. **升级脚本**：`scripts/server-upgrade.sh` 在 `prisma migrate deploy` 之后、重启服务之前插入该命令；**失败即中止升级**（不允许"服务起来了但表不存在"）。
4. **回归**：先在测试库执行；生产执行后核对 `system.tables` 中存在 `sa_datatable_rows`。
5. 文档：回写 `clklog-analytics-design.md` §10（v2 行标注未实现）；`INDEX.md` 无需新增文件。

---

## 14. 权限与安全

| 项 | 设计 |
|---|---|
| 权限 | 复用 `meta.view` / `meta.edit`，不新增权限码 |
| 写入 | `writeClient`（`default`），与用户 SQL 的 `sa_readonly` 隔离 |
| 读取（映射查表） | **`readonlyClient`**（`sa_readonly`，仅 `clklog_sa` SELECT） |
| 用户 SQL 白名单 | **不放宽**（仍只 `sa_events` / `sa_user_profiles`，`sql-ast-guard.service.ts:37/73-84`） |
| 有界 | 映射查询恒带 `project_name` + `datatable_key` + `version` + `pk IN` + 批次上限 |
| 注入 | 字段名/表名创建时正则白名单；`datatable_key`/`version` 来自服务端主键；进 SQL 前再断言 `[a-z0-9_]` |
| 密钥 | 无新增；沿用现有环境变量（部署期注入，不入库） |

## 15. 红线与门禁对照

| 红线 | 本方案 |
|---|---|
| ① 不侵入社区版 | 新表都在 `clklog_sa` / `clklog_sa_meta`，不动 `log_analysis` 与官方镜像 |
| ② 不破坏数据链路 | 纯新增表 + 查询期读取，不改 ingestor/receiver/Flink |
| ③ 密钥不入库 | 无新增密钥；本次探测也未读取生产口令 |
| ④ 只读且有界 | 映射读走只读账号、恒等值命中、批次上限；用户 SQL 白名单不变 |
| ⑤ 目录权限 | 不落服务器文件 |
| ⑥ 不静默改写、DDL 先演练 | 版本化写入 + 原子切换 + 审计 + 丢弃明细；CH 建表走幂等迁移入口，先测试库 |
| ⑦ 配置真相在 Puppet | 无新增配置键 |

架构硬门禁：新增包 `modules/datatable/`（不落 `common`/`utils`/`shared`）；交付前跑 `python3 scripts/arch_ratchet.py`。

## 16. 风险与演进

| 风险 | 对策 |
|---|---|
| 映射需要读维表 → 结果集很大时多次 IN 查询 | 批次上限 50、超出跳过并在响应提示；必要时改为异步预取或 dictGet（v2 一并评估） |
| 映射值多，前端渲染体积增大 | 只回传结果集中出现过的值（不是整表）；字段按需展开 |
| 两个 ID 映射到同名 | 不合并行；展示层保留原始值可切换 |
| 维表陈旧 | 列表突出更新时间与行数；审计可见；后续可加定时更新 |
| v2 三条路径都不可行 | v1 的映射能力已独立可用；v2 降级为"不做跨表维度"不阻塞任何已交付价值 |

## 17. 文件清单

后端新增 `apps/analytics-server/src/modules/datatable/`：`datatable.module.ts`、`datatable.controller.ts`、`datatable.service.ts`、`datatable-import.service.ts`（租约/版本切换）、`datatable-csv.ts`（纯解析，易测）、`datatable-rows.service.ts`（CH 读写与清理）、`datatable-map.service.ts`（映射查表与缓存）、`dto/datatable.dto.ts`。

改造：`modules/query/event-query.service.ts`（`formatResult` 附映射）、`funnel-query.service.ts`、`retention-query.service.ts`、`query-cache.service.ts`（按项目失效）、`report/card-cache*`（失效钩子）、`src/scripts/init-clickhouse.ts` + 新 `migrate-clickhouse.ts`、`scripts/server-upgrade.sh`、`prisma/schema.prisma`。

前端新增见 §12；测试 `modules/datatable/*.spec.ts` + `apps/analytics-server/test/datatable/`。

## 18. 修订记录

| 日期 | 变更 |
|------|------|
| 2026-09-14 | 首稿。 |
| 2026-09-14 | **v2 修订**（Astra 评审）：① v1 收敛为"结果集值映射"，不再依赖未验证的相关标量子查询；② 写入改版本化快照 + 原子切换 + 延后清理；③ 引入租约 CAS 与重启恢复；④ 类型契约统一 `boolean` 并落应用层；⑤ 删除统一为"只失效不物理删 + 失效显式失败不回退"；⑥ 限额改按 pending 版本去重总行数；⑦ 新增 CH 幂等迁移入口并接入升级脚本；⑧ 补查询缓存/卡片缓存失效；⑨ 新增 Gate 0 探针清单（v2 开工前提）。逐条回应见 §0。 |
| 2026-09-14 | **Gate 0 实测完成**（用户授权生产只读探针）：相关子查询在 23.2.1 **不可用**（`Code 47`，含最小反例与列齐备重测）→ 路径 A 排除；LEFT JOIN（含表达式关联键）**可用**；类型构造与未命中语义已实测（§4.3）。附带发现生产 `sa_user_profiles` 缺 `project_name` 列、用户属性路径在生产报 missing columns，已登记 `CODE_HANDOVER.md` 2026-09-14 节（未改码）。评审决议：映射值上限 5 万够用、增量取后行接受、v2 立项。 |
| 2026-09-15 | 状态改为实现中。§5.3 补 `key_column` / `label_field`；§7.2/§7.3 按方案 B 与扁平 `value_map` 对齐；本轮实现 §9 租约 CAS、展示列落库、漏斗/留存装配层映射。 |
