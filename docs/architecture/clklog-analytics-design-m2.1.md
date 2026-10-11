# 实现方案：ClkLog 分析平台 v1 — M2.1 埋点管理增强

> phase: clklog-analytics-v1
> 子阶段：M2.1
> 版本：v1.1（2026-07-28）｜ 上游：`docs/product/prd-clklog-analytics-v1-m2.1.md`、`docs/architecture/clklog-analytics-design.md`
> 本文档负责回答：如何稳定实现 M2.1 并验证？

---

## 1. 阶段目标与范围（门禁要素①）

实现 PRD M2.1 的两块能力：

1. 元事件管理增强：事件类型、昨日量、数据/连接/可用状态、批量操作。
2. 虚拟属性：基于已有属性表达式的运行时派生属性，在事件分析中即查即用。

**非目标**：维度表、用户分群、属性物化调度、社区版表改造。

---

## 2. 验收标准（门禁要素②）

- [ ] 元事件列表接口返回 `event_type / yesterday_count / availability_status / data_status / connection_status / updated_at`。
- [ ] `GET /meta/events` 支持 `status`、`event_type`、`availability_status`、`keyword`、`exclude_hidden` 筛选与排序；`pageSize` 上限 500。
- [ ] 批量隐藏/显示/废弃接口 `POST /meta/events/batch` 生效；删除为软删除。
- [ ] 虚拟属性 CRUD 接口 `POST /meta/virtual-properties`、`PUT /meta/virtual-properties/:id`、`DELETE /meta/virtual-properties/:id` 可用。
- [ ] 虚拟属性表达式保存时通过 AST 校验，禁止非白名单函数与非法属性引用。
- [ ] 事件分析使用虚拟属性做筛选/分组/agg 时，生成的 ClickHouse SQL 正确内联表达式。
- [ ] 所有查询继续强制带 `project_name` 过滤；虚拟属性不触发 `ALTER TABLE`。

---

## 3. 数据模型变更

### 3.1 MySQL：`meta_event` 扩展

```sql
ALTER TABLE meta_event
  ADD COLUMN event_type        ENUM('report', 'virtual', 'preset') NOT NULL DEFAULT 'report',
  ADD COLUMN yesterday_count   INT UNSIGNED DEFAULT 0,
  ADD COLUMN availability_status ENUM('available', 'no_data', 'hidden', 'deprecated') DEFAULT 'no_data',
  ADD COLUMN data_status       ENUM('normal', 'no_recent_data', 'abnormal') DEFAULT 'normal',
  ADD COLUMN connection_status ENUM('auto', 'virtual_from', 'preset') DEFAULT 'auto',
  ADD COLUMN is_deleted        TINYINT(1) DEFAULT 0,
  ADD COLUMN deleted_at        DATETIME NULL,
  ADD INDEX idx_meta_event_type_status (project_name, event_type, status),
  ADD INDEX idx_meta_event_availability (project_name, availability_status);
```

说明：
- `event_type`：上报事件、虚拟事件、预置事件。
- `availability_status`：由 `status` + 近7天数据存在性计算得出，不入库或定时刷新入库（推荐定时刷新，避免列表查询实时算）。
- `is_deleted`：软删除标志，删除时同时更新 `deleted_at`。

### 3.2 MySQL：新增 `meta_virtual_property`

```sql
CREATE TABLE meta_virtual_property (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  project_name  VARCHAR(64) NOT NULL,
  prop_key      VARCHAR(128) NOT NULL,              -- 唯一标识，建议 vp_ 前缀
  display_name  VARCHAR(255),
  data_type     ENUM('string','number','boolean','datetime') NOT NULL,
  expression    TEXT NOT NULL,                      -- 表达式文本
  event_key     VARCHAR(255) DEFAULT NULL,          -- NULL 表示全局，否则仅对指定事件
  description   TEXT,
  status        ENUM('active','invalid','hidden') DEFAULT 'active',
  invalid_reason VARCHAR(255) DEFAULT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_virtual_prop (project_name, prop_key),
  KEY idx_project_event (project_name, event_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

说明：
- 虚拟属性只存表达式，不建 ClickHouse 列，不预计算。
- `status=invalid`：当表达式引用的基础属性被隐藏/删除，或表达式语法校验失败时自动标记。

---

## 4. 元事件管理增强设计

### 4.1 状态计算逻辑

```text
availability_status =
  if is_deleted = 1                 -> hidden
  else if status = 'hidden'         -> hidden
  else if status = 'deprecated'     -> deprecated
  else if recent_7d_count = 0       -> no_data
  else                              -> available

data_status =
  if yesterday_count = 0 AND recent_7d_count > 0 -> abnormal
  else if recent_7d_count = 0                    -> no_recent_data
  else                                           -> normal

connection_status =
  if event_type = 'virtual'  -> virtual_from:{source_event_key}
  if event_type = 'preset'   -> preset
  else                       -> auto
```

### 4.2 定时刷新任务

新增 NestJS Schedule：`MetaStatsRefreshJob`

- 频率：每天 01:00（也可每小时，看性能）。
- 逻辑：
  1. 按 `project_name` + `event_key` 从 `sa_events` 统计昨日量、近7天量。
  2. 更新 `meta_event.yesterday_count`、`recent_7d_count`。
  3. 重新计算 `availability_status` 与 `data_status` 并写入。

SQL 示例：

```sql
SELECT project_name, event, countIf(stat_date = today() - 1) AS yc, count() AS rc
FROM clklog_sa.sa_events
WHERE stat_date >= today() - 7
GROUP BY project_name, event
```

### 4.3 批量操作 API

```
POST /sa/api/meta/events/batch
Body: { action: 'hide' | 'show' | 'deprecate' | 'delete', event_keys: string[] }
```

- `hide/show/deprecate`：更新 `status`。
- `delete`：软删除（`is_deleted=1, deleted_at=NOW()`）。
- 所有分析查询的事件选择器必须过滤 `is_deleted=0`。

---

## 5. 虚拟属性设计

### 5.1 表达式语法

为了安全，不直接暴露 SQL/JS 执行。定义受限表达式：

- 属性引用：`$prop_key` 或 `${prop_key}`。
- 常量：字符串 `'text'`、数字 `123`、布尔 `true/false`。
- 运算符：`+ - * / % == != > >= < <= && ||`。
- 白名单函数：`if(cond, a, b)`、`concat(a, b, ...)`、`length(s)`、`toString(n)`、`round(n, d)`。
- 不支持：用户自定义函数、子查询、SQL 关键字、ClickHouse 特定函数。

### 5.2 表达式解析器

自研轻量 AST 解析器或使用 `jsep` 类库，解析后做两件事：

1. **提取属性引用**：递归 AST，收集所有 `$prop_key` 节点，校验这些属性在 `meta_event_property` 中存在。
2. **生成 ClickHouse 表达式**：
   - 属性引用节点替换为 `attribute-resolver` 的输出（物化列或 `JSONExtract*`）。
   - 运算符与函数映射到 ClickHouse 对应函数。
   - 类型不匹配时根据 `data_type` 做 `toInt64 / toFloat64 / toString` 转换。

### 5.3 与属性解析器集成

扩展 `AttributeResolverService`：

```ts
async resolve(
  prop: string,
  scope: 'event' | 'user',
  dataType: string,
  context: { project: string; event?: string },
): Promise<string> {
  // 1. 先查虚拟属性
  const vp = await this.virtualPropertyRepo.find(prop, context.project, context.event);
  if (vp && vp.status === 'active') {
    return this.expressionCompiler.compile(vp.expression, scope, context);
  }
  // 2. 再走原有物化列 / JSONExtract 逻辑
  ...
}
```

### 5.4 SQL 生成示例

虚拟属性 `vp_total_amount`：

```
expression: "$amount * $quantity"
data_type: number
```

事件分析中用作筛选 `vp_total_amount > 100`：

```sql
WHERE ...
  AND (JSONExtractFloat(properties, 'amount') * JSONExtractFloat(properties, 'quantity')) > {p_0: Float64}
```

用作 agg 指标 `sum(vp_total_amount)`：

```sql
SELECT sum(JSONExtractFloat(properties, 'amount') * JSONExtractFloat(properties, 'quantity')) AS m_0
```

### 5.5 安全与红线

- 表达式编译后必须走 ClickHouse 参数化，禁止字符串拼接产生 SQL 注入。
- 函数白名单硬编码；未知函数直接拒绝保存。
- 虚拟属性不会触发 `ALTER TABLE`，也不写入 `sa_events`，保证社区版表结构不被改动。

---

## 6. API 契约

### 6.1 元事件增强

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/meta/events?status=&event_type=&availability_status=&keyword=&exclude_hidden=&pageSize=&sort_by=yesterday_count&sort_order=desc` | 增强列表；分析选择器传 `exclude_hidden=true`、`keyword` 远程搜；`pageSize` 默认 20、上限 500 |
| POST | `/meta/events/batch` | 批量操作 |

### 6.2 虚拟属性

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/meta/virtual-properties?event_key=` | 虚拟属性列表 |
| POST | `/meta/virtual-properties` | 创建 |
| PUT | `/meta/virtual-properties/:id` | 更新 |
| DELETE | `/meta/virtual-properties/:id` | 删除（物理删除即可，因不影响 CK） |
| POST | `/meta/virtual-properties/:id/validate` | 校验表达式并返回 ClickHouse 片段 |

---

## 7. 前端改动

| 文件 | 改动 |
|------|------|
| `EventsPage` / `EventList` | 增加筛选器、批量操作、新列展示 |
| `EventDetailDrawer` | 展示事件类型、昨日量、数据状态；属性页签区分真实/虚拟属性 |
| `VirtualPropertyEditor` | 新增弹窗/抽屉：表达式输入、属性引用选择、实时校验 |
| `FilterEditor` / `GroupEditor` / `MetricEditor` | 属性下拉框合并真实属性与虚拟属性 |
| `meta.service.ts` | 新增虚拟属性 API 与批量操作 API |

---

## 8. 实施顺序

1. 后端：扩展 `meta_event` 表 + 新增 `meta_virtual_property` 表 + Prisma schema 更新。
2. 后端：定时刷新任务 `MetaStatsRefreshJob`。
3. 后端：批量操作 API + 事件列表接口增强。
4. 后端：表达式解析器 + 虚拟属性 CRUD + 与 `AttributeResolverService` 集成。
5. 前端：事件列表增强 + 批量操作。
6. 前端：虚拟属性编辑器 + 在分析表单中可用。
7. 集成测试与验收。

---

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| 虚拟属性表达式编译错误导致分析查询失败 | 保存时强校验；运行时异常捕获并返回 `invalid` 状态 |
| 复杂虚拟属性拖慢查询 | 函数白名单 + 表达式深度限制；超时兜底 |
| 批量删除误删 | 软删除 + 二次确认；删除事件在分析选择器中不可见 |
| `meta_event` 表结构变更与线上数据兼容 | 使用可空字段 + 默认值；部署前在测试库演练 |
