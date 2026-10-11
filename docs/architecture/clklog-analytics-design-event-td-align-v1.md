# 实现方案：事件分析靠拢数数

> phase: clklog-analytics-event-td-align-v1
> 上游：`docs/product/prd-clklog-analytics-event-td-align-v1.md`、`docs/product/gap-clklog-analytics-vs-thinkingdata.md` §2
> 覆盖：事件分析指标 DSL、选择器、SQL 生成、结果阶段汇总与时长展示
> 主对标：数数 ThinkingEngine 事件分析（计算方法逻辑说明 + 事件分析模型）。神策只作对照，不追预定义滚动窗、Session 规则。

---

## 1. 阶段目标与范围

把事件分析的「分析指标」改成数数同构：**事件 + 可选属性 + 计算方法**，或 **公式**。计算方法随属性类型展开；补人均值、任意事件、公式、按类型的布尔/列表算法、阶段汇总、分钟粒度。查询仍有界：`project_name` + 时间窗 + LIMIT/超时。

不把漏斗/留存/分布/间隔/Session 塞进本期。那些模型差异文档还是「未调研」。

分三刀，一次发版可以只切第一刀，但契约一次定完，避免 `MetricType` 再拆一次。

| 刀 | 做完用户能感到什么 |
|----|-------------------|
| A 选择器与口径 | 选事件 → 选方法；人数叫「触发用户数」；人均次数不再要属性；能选人均值；能选任意事件；最多 10 条指标 |
| B 类型与公式 | 数值分位/方差；布尔真假空；列表去重；Σ 公式；`$event_duration` 显示成时长 |
| C 表与时间 | 阶段汇总（总和/加权平均/合计去重）；粒度含合计与 1 分钟；时间属性可按时段汇总 |

---

## 2. 验收标准

### 刀 A

- [ ] TD-A1：选择器顺序为事件 →（可选属性）→ 计算方法。无属性时方法只有：总次数、触发用户数、人均次数。选中数值属性后出现总和/均值/最大/最小/人均值/去重数/分位（至少含现有 p50/p90/p99）。
- [ ] TD-A2：文案「触发次数」改为「总次数」；「独立用户数」改为「触发用户数」。旧卡片 DSL `type=count|uniq_user` 仍能跑，标题走新文案。
- [ ] TD-A3：人均次数 = `count() / uniqExact(分析主体)`，**不**要求 `prop`。旧 `per_user`+`func=count` 映射到此。
- [ ] TD-A4：人均值 = `sum(prop) / uniqExact(分析主体)`。无 `prop` 时校验 400。
- [ ] TD-A5：事件可选「任意事件」：SQL 不再 `AND event = ?`，仍有项目与时间过滤。
- [ ] TD-A6：指标上限 10。第 11 条不可加。校验器与前端同一常量。
- [ ] TD-A7：`per_user` + `func=uniq_user`（恒为 1）废弃：读取时当非法或改写成触发用户数；UI 不再出现。

### 刀 B

- [ ] TD-B1：数值方法补 P25、P75、方差、标准差。数数更密的分位（5/10/…）本期不做，方法列表留「自定义分位 1–100」一条即可。
- [ ] TD-B2：布尔属性方法：为真数、为假数、为空数、不为空数。非布尔选这些则 400。
- [ ] TD-B3：列表属性方法：列表去重数、元素去重数。集合去重数（先内层去重再比列表）本期可做就做，做不了记进差异文档，不堵发版。
- [ ] TD-B4：公式指标：引用本查询其它事件指标做 `+ - * /` 与括号、数值常量。不执行用户 SQL。除零展示空或 `—`，不 500。
- [ ] TD-B5：属性 key 匹配 `$event_duration` / `event_duration` 的总和/均值/人均值，结果按秒格式化（≥60 秒显示 `Xm Ys`），可在结果设置里改回纯数字。

### 刀 C

- [ ] TD-C1：时间粒度增加 `total`（合计，整段只一行）与 `minute`。`minute` 查询跨度 > 1 天则前端禁用并 400。
- [ ] TD-C2：每个指标可配阶段汇总：`sum` / `avg` / `weighted` / `max` / `min` / `uniq_total`。默认：次数与总和 → `sum`；人数/去重 → `uniq_total`；人均/比率 → `weighted`。
- [ ] TD-C3：`uniq_total` 用整段时间再跑一次去重，不把每日人数相加。超时走现有查询错误，不放宽红线。
- [ ] TD-C4：Datetime 分组可选 `raw` 或 `extract`（`hour_of_day` 0–23 / `day_of_month` 1–31 / `minute_of_hour` 0–59）。

### 公共

- [ ] TD-R1：旧 DSL（`type=count|uniq_user|agg|per_user`）查询与已存卡片不 400；读时规范化成新 `analysis`。
- [ ] TD-R2：单测覆盖：人均值、任意事件、公式除零、旧 DSL 兼容、分钟跨度拒绝、阶段合计去重 ≠ 每日人数之和。
- [ ] TD-R3：`python3 scripts/arch_ratchet.py` 通过。MetricEditor 若超 1200 行，选择器拆到 `features/query/` 语义包，不往 `components/` 或 `utils/` 堆。

---

## 3. 非目标

- 不改漏斗、留存、SQL 图、看板缓存协议。
- 不做 Session、间隔、分布、路径、归因、热力。
- 不做神策预定义指标（过去 7/30 天、当月人数）。
- 不做自定义分析主体切换（主体仍是 `if(user_key != '', user_key, distinct_id)`）。差异文档 §2.5 保留缺口。
- 不做累计图、主次 Y 轴、近似计算（HLL）。
- 不放开自定义 SQL 进事件分析。
- 不把 `$event_duration` 改成独立「时间指标」菜单；它就是数值属性上的总和/均值/人均值。

---

## 4. DSL 契约

权威写在本 phase 落地后的 `dsl.types.ts`。下面是目标形状；实现时前后端同一份字段名。

```ts
type EventRef = string; // 元事件名；'*' = 任意事件

type AnalysisMethod =
  | 'total_times'
  | 'trig_user_num'
  | 'per_capita_times'
  | 'sum'
  | 'avg'
  | 'per_capita_num'
  | 'max'
  | 'min'
  | 'distinct'
  | 'true_num'
  | 'false_num'
  | 'is_empty'
  | 'is_not_empty'
  | 'array_distinct'
  | 'array_item_distinct'
  | 'percentile'
  | 'variance'
  | 'stddev';

type StageReduce = 'sum' | 'avg' | 'weighted' | 'max' | 'min' | 'uniq_total';

interface EventMetric {
  id: string;
  kind: 'event';
  event: EventRef;
  analysis: AnalysisMethod;
  prop?: string;
  percentile?: number; // analysis=percentile 时 1–100；p50 写成 50
  alias?: string;
  filters?: FilterGroup;
  stage_reduce?: StageReduce;
}

interface FormulaMetric {
  id: string;
  kind: 'formula';
  expression: FormulaExpr; // 见下，禁止字符串 eval
  alias?: string;
  format?: 'number' | 'percent' | 'decimal2' | 'decimal3';
  stage_reduce?: StageReduce;
}

type Metric = EventMetric | FormulaMetric;
```

`FormulaExpr` 只允许：引用本查询 `metrics[].id`、数字字面量、`+ - * /`、括号。后端递归求值，先算出各事件指标列再算公式列。

### 2026-09-10 增补（用户反馈驱动，phase: clklog-ai-workspace-v1 验收外溢）

- **指标稳定 ID**：编辑器新建指标用时间戳 ID（`m_<ts>`/`f_<ts>`），不再依赖位置；公式引用不受增删/排序影响。引用已删除指标时校验报可读错误（含原 ID 与「可能已被删除，请重新选择」）。默认表单的位置 ID（m_0/m_1）保持原样以维持 AI 提案确定性——删除被引用的默认指标后公式引用仍会失效，属数据不可恢复，由可读错误提示用户重选。
- **隐藏指标（眼睛开关）**：`metrics[].hidden=true` 时该指标照常计算（供公式引用），但不进结果列（服务端列组装过滤）。
- **步骤内数值变换**：`metrics[].transform={factor,decimals}`——先乘系数（|factor|≤1e6）再 `round(…,decimals)`（0..6），在数据库聚合后应用；校验拒绝越界与未知键。
- **步骤排序**：指标卡加上移/下移；公式编辑器的引用下拉**只允许排在公式之前的指标**（流水线语义），配合稳定 ID 排序不破坏引用。服务端不限制前向引用（全 JOIN 语义本就支持）。

时间粒度：

```ts
type TimeGranularity = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'total';
```

季/年本期不做。

### 4.1 旧字段映射（只读兼容）

| 旧 | 新 |
|----|----|
| `type=count` | `kind=event, analysis=total_times` |
| `type=uniq_user` | `analysis=trig_user_num` |
| `type=agg, func=sum\|avg\|max\|min\|uniq` | `analysis=sum\|avg\|max\|min\|distinct` |
| `type=agg, func=p50\|p90\|p99` | `analysis=percentile, percentile=50\|90\|99` |
| `type=per_user, func=count` | `analysis=per_capita_times`，忽略 `prop` |
| `type=per_user, func=uniq_user` | 视为 `trig_user_num` |

写入新卡片只写新字段。查询入口同时认两套，规范化后再生成 SQL。

### 4.2 方法 × 属性类型（选择器唯一表）

| analysis | 属性 | ClickHouse 要点 |
|----------|------|-----------------|
| `total_times` | 无 | `count()` |
| `trig_user_num` | 无 | `uniqExact(subject)` |
| `per_capita_times` | 无 | `count()/uniqExact(subject)` |
| `sum/avg/max/min` | Number | 对应聚合 |
| `per_capita_num` | Number | `sum(prop)/uniqExact(subject)` |
| `distinct` | 任意 | `uniqExact(prop)` |
| `percentile` | Number | `quantileExact(p/100)` |
| `variance` / `stddev` | Number | `varPop` / `stddevPop` |
| `true_num` / `false_num` | Bool | `countIf(prop)` |
| `is_empty` / `is_not_empty` | 任意 | 空串/NULL 判定与现有 `is_set` 一致 |
| `array_distinct` | List | `uniqExact(prop)` 整列当值 |
| `array_item_distinct` | List | `uniqExact(arrayJoin(prop))` 或 JSON 数组展开 |

`subject` 本期写死现有表达式，不做成可配。

任意事件：`event='*'` → 生成器省略 `event =` 条件。虚拟事件仍展开为 `event IN (...) AND (条件)`，与任意事件互斥。

指标上限常量：`MAX_EVENT_METRICS = 10`，前后端共用。

---

## 5. UI

对标数数左栏「分析指标 / 全局筛选 / 分组项」，不新做一排「时间指标」。

- 分析指标标题右侧：`+` 加事件指标，`Σ` 加公式（刀 B）。
- 一行展示：`{事件显示名}.{方法名}`，有属性则为 `{事件}.{属性}.{方法}`，与截图同构。
- 方法列表按已选事件属性的 `data_type` 过滤，禁止给字符串提供总和。
- `$event_duration` 在属性列表里显示名「事件时长」，单位提示「秒」；不单独分组。
- 全局筛选、分组、指标级筛选沿用现有 FilterEditor / GroupEditor。
- 刀 C：结果表第一列或表头提供「阶段汇总」下拉；时间粒度 Select 增加「合计」「按分钟」。

`MetricEditor.tsx` 按方法表重写。超过行数上限则拆 `features/query/event-metric-editor/`（选择器、方法表、公式编辑各一文件），不要扩大 `src/components/` 杂项。

---

## 6. SQL 生成

仍走 `EventSqlGeneratorService`，禁止拼用户字符串进 SQL。公式在应用层用已查出的数值算，或同一 SELECT 里用列表达式（只引用本查询生成的 `m_i`）。

阶段汇总：

- `sum/avg/max/min`：对已有按日结果做二次聚合（便宜）。
- `weighted`：分子分母分别阶段求和再相除。因此 `per_capita_*` 生成器必须同时输出分子列（次数或 sum）与分母列（人数），或对整段重跑。
- `uniq_total`：去掉时间分组再跑一次 `uniqExact`（贵）。只对当前指标；超时不重试放大窗。

分钟：`toStartOfMinute(log_time)`。校验 `end-start <= 1 day`。

有界：现有 `project_name`、时间、LIMIT、只读账号不变。任意事件只是少一个 event 谓词，时间谓词不能少。

---

## 7. 风险

| 风险 | 处理 |
|------|------|
| 任意事件扫全项目事件 | 时间窗 + LIMIT + 超时；UI 提示「未限定事件，可能较慢」 |
| `uniq_total` 成本 | 默认人数类才用；可改成阶段总和（不精确） |
| 公式环引用 | 校验 DAG，禁止自引用 |
| 旧看板卡片 | 只读映射；不强制重存 |
| 列表属性 JSON 形态不统一 | 元素去重只支持已推断为 List 的 key；失败则空结果 + 提示，不 500 |

---

## 8. 与差异文档的关系

本期闭合 gap §2 缺口 1–7、9。故意留下：分析主体、预定义滚动窗、累计图、季/年粒度、数数全部分位、集合去重数（若刀 B 做不完）。

漏斗/留存/间隔/Session 等 §3–§8 更新差异文档后，另开 phase，不扩写本文。
