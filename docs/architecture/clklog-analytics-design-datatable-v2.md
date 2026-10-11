# 实现方案：数据表（维度表）v2 —— 跨表维度

> phase: `clklog-analytics-datatable-v2`
> 上游 PRD：`docs/product/prd-clklog-analytics-datatable-v2.md`
> 前置设计：`docs/architecture/clklog-analytics-design-datatable-v1.md`（表结构 / 版本化快照 / 租约 / 审计 / Gate 0 探针）
> 本文是 **v2 的查询取数契约、属性名契约、接入点与性能门槛** 的权威。
> 状态：**实现中（2026-09-15）**。取数路径 **C（JOIN）** 已定案（§4.4）；查询侧接通 `{属性}@{字段}`。

---

## 1. 阶段目标与范围（门禁要素①）

把维表字段变成可分析维度：`item_info@quality` 这类**维度表属性**能进筛选、分组、聚合，覆盖事件 / 漏斗 / 留存三类分析。

范围：属性生成与命名、校验器与前端选择器改造、查询取数与类型契约、生命周期与缓存失效、性能门槛与回归。

## 2. 验收标准（门禁要素②）

- PRD §4 A1–A11 全部通过。
- 单测：属性名正则（含 `@`、`#`、超长、注入字符）、类型对齐（四类型 × 未命中）、生成 SQL 快照（按最终选定的 B 或 C 形态）。
- 对拍：**同一查询**用"维度表属性"与"手写 JOIN 维表的原生 SQL"结果完全一致（造数固定，A1）。
- 性能：A8 门槛达标，基线（同口径普通 JSON 属性查询）留档。
- 回归：事件 / 漏斗 / 留存 / 分析主体 / SQL 守卫既有 spec 全绿；`python3 scripts/arch_ratchet.py` 通过。
- 失效：删除数据表后引用卡片报可读错误，且**不回退**到原始 JSON 属性取值（现有 resolver 的静默回退必须先改）。

## 3. 非目标（门禁要素③）

同 PRD §5。工程侧另加：不做字典/预聚合的进一步优化（A8 达标即止）、不做维表多跳、不改 `sa_events` 表结构、不放宽用户 SQL 白名单。

---

## 4. 取数路径决策（本章未定则不开工）

### 4.1 已实测约束（2026-09-14，生产 23.2.1，只读）

| 构造 | 结果 | 证据 |
|---|---|---|
| 相关标量子查询（外列引用） | **不可用** | `Code 47 UNKNOWN_IDENTIFIER Missing columns: 'sa_events.distinct_id'`；最小反例与列齐备重测同样失败 |
| `LEFT JOIN`（等值列） | 可用 | 5000 行结果，`read_rows` 344,497 |
| `LEFT JOIN`（表达式关联键 + 维表子查询） | 可用 | 2000 行结果，`read_rows` 123,595 |
| 类型构造 / 未命中语义 | 可用 | 见 §7 定值 |

→ **路径 A（resolver 生成相关标量子查询）排除**；只剩 B、C。

### 4.2 路径 B：ClickHouse 字典

```sql
CREATE DICTIONARY clklog_sa.dt_<id>_dict
(
    pk      String,
    quality String,
    resource String
)
PRIMARY KEY pk
SOURCE(CLICKHOUSE(
    HOST 'localhost' PORT 9000 USER '<user>' PASSWORD '<pwd>' DB 'clklog_sa'
    TABLE 'sa_datatable_rows'
    WHERE 'project_name = ''<p>'' AND datatable_key = ''<id>'' AND version = <v>'
))
LAYOUT(HASHED()) LIFETIME(0);
```

- 属性表达式：`dictGetOrDefault('clklog_sa.dt_<id>_dict', 'quality', <基底表达式>, '')`
- **优点**：`resolveEventProperty` 只多一层函数生成，**三个生成器零改动**；查找是内存哈希，性能最好。
- **代价 / 待验证**（必须逐条实测，任一不过则转 C）：
  1. `SOURCE(CLICKHOUSE(... WHERE ...))` 在 23.2.1 是否支持 `WHERE`（若不支持 → 只能每表一个物理表）；
  2. 版本切换后 `SYSTEM RELOAD DICTIONARY` 是否即时生效（`LIFETIME(0)` 语义）；
  3. 字典内存占用（维表 ≤20 万行 × 列数 × 表数）与 cgroup 限制（当前 ClickHouse cgroup 12G）；
  4. `CREATE/DROP DICTIONARY` 需要 DDL 权限（写入账号 `default`），以及是否纳入"先测试库演练"（红线⑥）；
  5. **SQL 守卫**：`dictGet` 是函数调用，不引用表名 → 用户自定义 SQL / AI SQL 可能绕过表白名单直接读维表。必须在 `sql-ast-guard` / `ai-sql-guard` 增加 `dictGet*` 函数黑名单（或要求字典名以 `dt_` 前缀且用户 SQL 禁用）。
- 生命周期：建表/首次导入时建字典；版本切换后 reload；删表时 drop；字典 DDL 失败不能影响数据表可用性（降级为"属性不可用"而非整体失败）。

### 4.3 路径 C：主查询 JOIN

```sql
SELECT ...
FROM clklog_sa.sa_events
LEFT JOIN (
    SELECT pk, values
    FROM clklog_sa.sa_datatable_rows
    WHERE project_name = {p} AND datatable_key = {k} AND version = {v}
) AS dt_1 ON <基底表达式> = dt_1.pk
WHERE ...
```

- 属性表达式：`JSONExtract{Suffix}(dt_1.values, 'quality')`
- **优点**：已实测；不新增 CH 对象，无 reload/内存问题；`pk` 在版本内唯一 → 1:1 不放大行数。
- **代价**：改三个生成器的 FROM/JOIN 组装（事件 / 漏斗 / 留存）+ `listUsers`；查询里用到 N 张数据表就挂 N 个 JOIN（先去重）；`ON` 的基底表达式可能是物化列 / `JSONExtract` / `formatDateTime(log_time,…)`。
- 守卫：生成 SQL 需带 JOIN 到 `sa_datatable_rows`，而 `sql-ast-guard` 表白名单只允许 `sa_events`/`sa_user_profiles` → 必须区分"服务端生成的 SQL"与"用户 SQL"，只对后者保持严格白名单（并加测试防越权）。

### 4.4 决策（2026-09-14 定案）：**采用路径 C（JOIN）**

| 依据 | 说明 |
|---|---|
| B 的探针结果（§4.5） | 建得成、删得掉、无残留，但**一加载就 516 认证失败**：字典源连接需要凭证；凭证写进 `SOURCE(...)` 后会随 `SHOW CREATE DICTIONARY` 可读，触碰红线③ |
| B 的额外成本 | 每张数据表一个字典的生命周期（懒加载 / reload / 内存）→ 与 cgroup 12G 抢资源；`dictGet*` 不引表名，必须在守卫里新增函数黑名单，否则用户 SQL 可绕过表白名单直接读维表 |
| C 的额外成本 | 三个生成器的 FROM/JOIN 组装 —— 但这套 JOIN 注入**本来就必须做**：用户属性缺陷修复（`clklog-user-property-path-v1`）在 23.2.1 上只能靠 JOIN（相关子查询不可用、字典要嵌凭证），**一次实现两处受益** |
| 结论 | **v2 走 C**。用户属性修复先行交付 `JoinRegistry`，v2 直接复用（`clklog-analytics-design-user-property-path-v1.md` §6） |

### 4.5 路径验证记录（2026-09-14 生产实测，临时对象已清理）

探针脚本：建 → 查 → reload → 删 → 复查残留（只碰 `clklog_sa` 下自建临时字典 `__probe_dt_dict`；用户授权的一次性 DDL）。

| 项 | 结果 | 证据 |
|---|---|---|
| `CREATE DICTIONARY … SOURCE(CLICKHOUSE(DB/TABLE/WHERE))`（不带凭证） | **建得成**（字典懒加载，建时不连源） | `system.dictionaries` 出现该行 |
| 带凭证重复建 | `DICTIONARY_ALREADY_EXISTS`（预期，说明第 1 步已建成） | `Code: 387` |
| 字典元信息 | `status: NOT_LOADED`、`element_count: 0`、`bytes_allocated: 0` | 懒加载证据 |
| `dictGetOrDefault`（命中 / 未命中 / 表达式键 2000 行） | **FAIL** | `Code: 516 AUTHENTICATION_FAILED … While processing dictGetOrDefault(...)`（加载字典时连源认证失败） |
| `SYSTEM RELOAD DICTIONARY` | **FAIL** | 同 516 |
| `DROP DICTIONARY` + 复查 | **PASS** | `system.dictionaries` 命中 **0**，生产无残留 |

**OVERRIDE-REASON**：红线⑥要求 DDL 先在测试库演练，但当前**没有测试 ClickHouse 实例**；本次为用户明确授权的**一次性临时字典**探针（建后即删、已确认零残留、未触碰任何业务表与数据），复盘记录见 `docs/project/retrospective-datatable-gate0-2026-09-14.md`。

→ 字典路径要把凭证写进对象定义才可用（`SHOW CREATE DICTIONARY` 可读出），**不采纳**。

---

## 5. 属性名与校验器契约（两条路径都必须同批改）

`{绑定属性}@{字段名}` 会进入 DSL 的 `prop` 字段，现被校验器拒绝：

| 落点 | 现状 | 改造 |
|---|---|---|
| `modules/query/dsl-validator.service.ts:28` | `PROP_KEY_PATTERN = /^\$?[a-zA-Z_][a-zA-Z0-9_$.-]{0,63}$/`（不含 `@`，总长 ≤65） | 增加**专用分支**（不放宽通用正则）：`^(#[a-z][a-z0-9_]{0,49}|[a-zA-Z_][a-zA-Z0-9_$.-]{0,63})@[a-z][a-z0-9_]{0,49}$`，并将组合属性名长度上限提到 130 |
| 前端属性选择器 | `components/event-property-options.ts` 只并 `event + virtual` | **筛选**并入维度表属性并标记`数据表`；**分组**独立「添加维度分组」，下拉只列维表字段，文案 `{绑定属性}@{字段显示名}`（如 `goods_id@商品名称`）。提交 DSL 仍是 `scope: event` + `prop: goods_id@goods_name`。结果表头用字段显示名（「商品名称」），不用内部 prop_key |
| 埋点事件属性面板 | 不含维度表属性 | 只读展示来源为"数据表"的属性（不可编辑、不可物化） |
| 卡片/看板 | DSL 存 prop 字符串 | 无需改动；但**属性失效**时要有可读错误（§8） |

安全：`@`/`#` 不引入引号与括号，属性名仍以单引号字面量进入 `JSONExtract(properties,'…')`；新正则必须拒绝 `'`、`"`、`)`、`;` 等字符（加注入用例）。

---

## 6. 接入点

| 组件 | 路径 B | 路径 C |
|---|---|---|
| `modules/shared/attribute-resolver.service.ts`（`resolveEventProperty` 优先级链） | 加一层"维度表属性 → `dictGetOrDefault(...)`" | 加一层"维度表属性 → `JSONExtract(dt_n.values,'col')`"，并把所需 JOIN 登记到查询上下文 |
| `event-sql-generator.service.ts` / `funnel-sql-generator.service.ts` / `retention-sql-generator.service.ts` | 不改 | 在 FROM 组装处注入 JOIN（按查询上下文去重） |
| `event-query.service.ts::listUsers` | 不改 | 同步注入 JOIN |
| `modules/query/sql-ast-guard.service.ts` / `ai-sql-guard.service.ts` | 增加 `dictGet*` 黑名单 | 区分服务端生成 SQL 与用户 SQL，用户侧白名单不变 |
| `DatatableMapService`（v1 已有） | 命中/未命中的展示逻辑复用 | 同左 |

漏斗 / 留存注意：两者的窗口函数与 `retention()` 聚合参数同样能容纳上述表达式（B 是普通函数；C 的 JOIN 在各自内层查询注入）。

---

## 7. 类型与未命中契约（实测定值）

依据 2026-09-14 探针 P-D / P-E：

| 声明类型 | 维表侧存储 | 查询侧表达式 | 两侧对齐方式 |
|---|---|---|---|
| `string` | `values` 中字符串 | `JSONExtractString(dim.values,'col')` | 直接比较 |
| `number` | JSON number | `JSONExtractFloat(dim.values,'col')` | 与数值比较（勿比字符串） |
| `boolean` | JSON bool | `JSONExtractBool(dim.values,'col')` | 与 0/1 比较 |
| `datetime` | 按粒度格式化文本 | `formatDateTime(log_time,'<fmt>','Asia/Shanghai')`（仅 `#event_time` 绑定） | 文本相等 |

未命中定值（实测）：

- 子查询/字典未命中 → **NULL**；`NULL = ''` 返回 **NULL**（不是 true）→ 因此：
  - `=` / `in` 筛选：未命中行**不命中**（符合预期）；
  - 「为空 / 不为空」筛选：需用 `isNull(...) OR ... = ''` 显式覆盖未命中；
- `JSONExtract` 缺键：字符串 `''`、数值 `0`、布尔 `0` → **数值维表字段缺失会显示 0 而不是空**，这一点必须在 PRD/UI 文案里写明，避免把 0 当真实值（沿用 `docs/architecture/reporting-protocol.md` 的既有口径）。

---

## 8. 生命周期与缓存（承接 v1 §10）

| 事件 | 动作 |
|---|---|
| 新建绑定 / 解绑 / 改粒度 | 重建该绑定的维度表属性（改粒度会改 `prop_key` 前缀，属**重命名**：旧 prop_key 置 `invalid`，新 key `active`，并在 UI 提示"已重命名，需重新引用"） |
| 数据表版本切换 | 清项目查询缓存（`sa:query:`）+ 失效相关卡片缓存；路径 B 追加 `SYSTEM RELOAD DICTIONARY` |
| 删除数据表 | 属性置 `invalid`；查询报 `BadRequestException('属性 xxx 依赖的数据表已失效')` |
| **禁止静默回退** | `attribute-resolver.service.ts:46-58` 现在对非 active 虚拟属性会回退 `JSONExtract`；维度表属性必须显式失败并加单测 |
| 同名重建 | 复用 `invalid` 记录置 `active`；存在 `active` 同名 → 409 |

---

## 9. 性能与限额

| 项 | 要求 |
|---|---|
| 基线 | 同口径取普通 JSON 属性的查询耗时（实测留档） |
| 门槛 | 带维度表属性的分组查询 P95 ≤ 基线 ×3（A8） |
| 维表规模 | 单表 ≤20 万行（v1 已限）；单查询引用 ≤3 张数据表（超出拒绝，避免 JOIN 爆炸） |
| 路径 C | JOIN 侧哈希表构建成本随维表行数线性；必要时把维表子查询加 `WHERE` 下推（按查询用到的 pk 集合无法预知，故只能整表） |
| 路径 B | 字典常驻内存；需在 cgroup 12G 内评估（§4.2 待验证） |
| 超时 | 沿用查询执行超时与 `max_execution_time`；不做隐式放宽 |

## 10. 迁移与发版

沿用 v1 §13 的幂等迁移入口（`migrate-clickhouse` 接入 `server-upgrade.sh`，失败中止升级）。路径 B 另加：字典 DDL 的创建/回收，同样走幂等入口并在测试库先演练（红线⑥）。

## 11. 红线与门禁

| 红线 | 本方案 |
|---|---|
| ① 不侵入社区版 | 只读 `sa_events` + 新表，无 ALTER |
| ② 不破坏链路 | 查询期特性，不碰 ingestor/receiver |
| ③ 密钥 | 路径 B 的字典 DDL 内含连接串 → **必须走配置参数化，不得硬编码** |
| ④ 只读且有界 | 用户 SQL 白名单不放宽（路径 B 还要额外禁 `dictGet*`）；生成查询带 `project_name` + 版本条件 |
| ⑥ DDL 先演练、有审计 | 字典建删纳入迁移入口与审计；结构变更仍非目标 |
| 架构门禁 | 属性解析仍在 `modules/shared` 既有服务内扩展（不新建杂项包）；测试随实现同包 |

## 12. 风险

| 风险 | 对策 |
|---|---|
| 路径 B 的字典能力在 23.2.1 不可用 | 先探针验证；不通过转 C（已实测） |
| 路径 C 改三个生成器，回归面大 | 生成器改动限定在"FROM/JOIN 组装"一处，配 SQL 快照测试 + 三类分析全量回归 |
| 维表字段缺失被当成 0 | §7 写明并在 UI 提示；必要时对数值维度默认显示"未匹配" |
| 同 prop_key 重命名导致存量卡片失效 | 提示 + 保留 `invalid` 记录便于排查；不做静默映射 |
| 查询引擎现状缺陷（用户属性路径在生产报错）干扰 v2 验证 | 已登记 `CODE_HANDOVER.md`；v2 验证用例避开 scope=user，或先修复该缺陷 |

## 13. 文件清单

后端：`modules/shared/attribute-resolver.service.ts`（加一层）、`modules/datatable/datatable-property.service.ts`（属性生成/失效/重命名）、`modules/datatable/datatable-dimension.service.ts`（B: 字典生命周期 / C: JOIN 上下文）、三个生成器（仅路径 C）、`sql-ast-guard.service.ts` / `ai-sql-guard.service.ts`、`dsl-validator.service.ts`。

前端：`components/event-property-options.ts`、`components/FilterEditor.tsx`、`components/GroupEditor.tsx`、`features/meta/DataTableBindingDialog.tsx`（属性显示名/粒度/重命名提示）。

测试：`datatable-property.spec.ts`、`dsl-validator.dimension.spec.ts`、生成器 SQL 快照、`test/datatable/v2-*.spec.ts`（对拍与性能基线）。

## 14. 更新记录

| 日期 | 变更 |
|------|------|
| 2026-09-14 | 立项首稿。基于 Gate 0 实测（相关子查询不可用、JOIN 可用）排除路径 A，给出 B（字典）/C（JOIN）对比与属性名、类型、未命中、生命周期、性能门槛契约；取数路径待 DDL 授权验证后定。 |
