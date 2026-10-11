# 实现方案：ClkLog 分析平台 v1 — M2.2 埋点管理进阶

> phase: clklog-analytics-v1
> 子阶段：M2.2
> 版本：v1.2（2026-07-29）｜ 上游：`docs/product/prd-clklog-analytics-v1-m2.2.md`、`docs/architecture/clklog-analytics-design.md`
> 本文档负责回答：如何稳定实现 M2.2 并验证？

---

## 1. 阶段目标与范围（门禁要素①）

实现 PRD M2.2 的三块能力：

1. **虚拟事件增强**：支持多来源事件 OR + 全局事件属性筛选，并在事件分析 SQL 中正确展开。
2. **事件备注**：为 `meta_event` 增加 `remark` 字段，支持编辑与搜索。
3. **事件属性面板**：新增全局事件属性聚合视图 `MetaEventAttribute`，支持备注、数据类型、关联事件数。
4. **事件编辑**：补齐事件基本信息编辑入口。

**非目标**：用户分群、维度表、用户属性面板、属性物化调度、社区版表改造。

---

## 2. 验收标准（门禁要素②）

- [ ] `meta_event` 表包含 `remark` 字段；`PUT /meta/events/:eventKey` 支持更新 `remark`。
- [ ] `MetaEventAttribute` 表可维护；`GET /meta/event-attributes` 返回按 `prop_key` 聚合的属性列表，含 `event_count`。
- [ ] 虚拟事件定义 schema 支持 `events: string[]` 与 `filters: FilterGroup`；保存时校验所有来源事件存在。
- [ ] 事件分析选择虚拟事件时，SQL 生成器展开为 `event IN (...)` 并注入全局筛选条件。
- [ ] 事件属性面板支持按数据类型筛选：数值/文本/时间/布尔/列表/对象/对象组。
- [ ] 所有查询继续强制带 `project_name` 过滤；不改 ClkLog 社区版表结构。

---

## 3. 数据模型变更

### 3.1 MySQL：`meta_event` 扩展备注

```sql
ALTER TABLE meta_event
  ADD COLUMN remark TEXT NULL COMMENT '事件备注，0~500字';
```

### 3.2 MySQL：新增 `meta_event_attribute`（全局事件属性）

```sql
CREATE TABLE meta_event_attribute (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  project_name  VARCHAR(64) NOT NULL,
  prop_key      VARCHAR(128) NOT NULL,
  display_name  VARCHAR(255),
  data_type     ENUM('string','number','boolean','datetime','list','object','object_group') NOT NULL DEFAULT 'string',
  remark        TEXT NULL,
  status        ENUM('pending','visible','hidden') NOT NULL DEFAULT 'pending',
  event_count   INT UNSIGNED DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_project_prop (project_name, prop_key),
  KEY idx_project_type (project_name, data_type),
  KEY idx_project_status (project_name, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='跨事件全局事件属性治理';
```

说明：
- `event_count` 表示该属性在多少事件中出现过，通过定时任务或近实时任务从 `meta_event_property` 聚合更新。
- `data_type` 为该属性的全局主类型；若不同事件中类型不一致，详情抽屉展示分布，用户可手动校准。

### 3.3 MySQL：`meta_event_property` 数据类型扩展

```sql
ALTER TABLE meta_event_property
  MODIFY COLUMN data_type ENUM('String','Number','Bool','Datetime','List','Object','ObjectGroup') NOT NULL DEFAULT 'String';
```

说明：
- 旧数据 `String/Number/Bool/Datetime/List` 保持不变。
- ingestor 自动发现时，根据 JSON 值类型推断新类型：
  - JSON object → `Object`
  - JSON array of objects → `ObjectGroup`
  - JSON array of primitives → `List`

### 3.4 MySQL：`meta_virtual_event` definition_json 升级

现有 `definition_json` 为自由 JSON。M2.2 统一 schema：

```json
{
  "events": ["UGC_design", "activity_reward"],
  "filters": {
    "logic": "and",
    "items": [
      { "scope": "event", "prop": "account_id", "op": "eq", "value": "xxx" }
    ]
  }
}
```

兼容性：
- 旧虚拟事件 `definition_json` 中若只有 `event: string`，读取时自动兼容为 `events: [event]`。
- 新创建/更新时统一写入新 schema。

---

## 4. 虚拟事件增强设计

### 4.1 定义校验

新增/更新虚拟事件时：

1. `events` 必填且长度 ≥ 1。
2. 每个 `event_key` 在 `meta_event` 中存在且 `is_deleted=false`。
3. `filters` 可选；若存在，校验每个 `prop` 在对应来源事件中存在（或在全局属性中存在）。
4. 禁止循环：虚拟事件的 `events` 中不能包含其他虚拟事件（当前实现直接拒绝）。

### 4.2 SQL 展开

在 `event-sql-generator.service.ts` 的 `WHERE event = {event}` 之前，增加虚拟事件解析：

```ts
private async resolveVirtualEvent(eventKey: string, project: string): Promise<{ events: string[]; filterSql?: string } | null> {
  const ve = await this.virtualEventRepo.find(eventKey, project);
  if (!ve) return null;
  const def = JSON.parse(ve.definition_json);
  const events = Array.isArray(def.events) ? def.events : [def.event];
  let filterSql: string | undefined;
  if (def.filters?.items?.length > 0) {
    filterSql = await this.compileFilter(def.filters, { project, events });
  }
  return { events, filterSql };
}
```

生成 SQL 时替换原有 `event = {event}`：

```sql
-- 普通事件
WHERE ... AND event = {event: String}

-- 虚拟事件
WHERE ... AND event IN ({events: Array(String)})
  AND (global_filter_sql)
```

注意：
- 全局筛选中的属性引用需要 `event` 上下文；由于条件作用于多个事件，属性解析时若某属性未在来源事件中物化，统一走 `JSONExtract*`（与当前属性解析器一致）。
- 若全局筛选引用虚拟属性，按 M2.1 方式展开。

### 4.3 API 契约

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/sa/api/meta/virtual-events` | 列表（含 definition_json） |
| POST | `/sa/api/meta/virtual-events` | 创建；body 使用新 schema |
| PUT | `/sa/api/meta/virtual-events/:veId` | 更新；body 使用新 schema |
| DELETE | `/sa/api/meta/virtual-events/:veId` | 删除 |

---

## 5. 事件属性面板设计

### 5.1 数据聚合

两种方式可选，推荐 **方案 B（近实时聚合）**。

#### 方案 A：查询时实时聚合

```sql
SELECT
  project_name,
  prop_key,
  MAX(display_name) AS display_name,
  groupArray(DISTINCT data_type) AS data_types,
  COUNT(DISTINCT event_key) AS event_count,
  MAX(updated_at) AS updated_at
FROM meta_event_property
WHERE project_name = ?
GROUP BY project_name, prop_key
```

优点：无额外表；缺点：MySQL 聚合在属性多时可能慢，且备注无处存放。

#### 方案 B：维护 `meta_event_attribute`（推荐）

- **写入/更新时机**：
  1. ingestor `MetaDiscoveryService` 发现新属性时，upsert `meta_event_attribute`，`event_count` 加 1。
  2. 属性被隐藏/删除时，重新计算 `event_count`。
  3. 提供 `POST /sa/api/meta/event-attributes/refresh-counts` 手动刷新。
  4. 定时任务每日 02:00 全量校准。

- **event_count 计算**：
  ```sql
  UPDATE meta_event_attribute AS ma
  SET event_count = (
    SELECT COUNT(DISTINCT event_key)
    FROM meta_event_property AS mp
    WHERE mp.project_name = ma.project_name AND mp.prop_key = ma.prop_key
  )
  WHERE ma.project_name = ?;
  ```

- **data_type 主类型**：取 `meta_event_property` 中该 `prop_key` 出现次数最多的 `data_type`；若用户手动设置，以用户设置为准。

### 5.2 列表查询

`GET /sa/api/meta/event-attributes`：

| 参数 | 说明 |
|------|------|
| `data_type` | 多选，逗号分隔，如 `number,text` |
| `status` | `pending` / `visible` / `hidden` |
| `keyword` | 匹配 `prop_key` / `display_name` / `remark` |
| `page` / `pageSize` | 分页 |

### 5.3 备注编辑

`PUT /sa/api/meta/event-attributes/:propKey`：

```json
{
  "display_name": "",
  "data_type": "number",
  "remark": "",
  "status": "visible"
}
```

说明：
- 详情抽屉内编辑显示名/类型/备注，点「保存」才调用本接口；关闭抽屉不请求。
- 修改全局属性的 `remark` 后，不需要反向同步到 `meta_event_property` 的每一行（全局表作为 SSOT）。
- 若需要，事件详情抽屉的属性列表可展示全局备注。

### 5.4 属性详情抽屉

`GET /sa/api/meta/event-attributes/:propKey/events`：

返回该属性关联的所有事件及其在该事件下的具体元数据：

```json
{
  "prop_key": "account_id",
  "display_name": "账号 ID",
  "data_type": "string",
  "remark": "",
  "events": [
    { "event_key": "Login", "display_name": "登录", "data_type": "string", "status": "visible" },
    { "event_key": "Purchase", "display_name": "购买", "data_type": "string", "status": "visible" }
  ]
}
```

---

## 6. 事件备注与编辑设计

### 6.1 后端

- `UpdateMetaEventDto` 增加 `remark?: string`（`@MaxLength(500)`）。
- `MetaEventService.updateEvent` 允许更新 `display_name`、`status`、`owner`、`description`、`remark`。
- 列表关键词搜索扩展：
  ```ts
  where.OR = [
    { event_key: { contains: keyword } },
    { display_name: { contains: keyword } },
    { remark: { contains: keyword } },
  ];
  ```

### 6.2 前端

- `EventDetailDrawer` / `EventEditModal` 增加备注 TextArea。
- `EventList` 操作列增加「编辑」按钮；点击打开抽屉。
- 事件名 hover 展示备注摘要（`remark?.slice(0, 60)`）。

---

## 7. 前端改动

| 文件 | 改动 |
|------|------|
| `pages/Meta/VirtualEventsPage.tsx` | 虚拟事件列表增加「编辑」入口 |
| `features/meta/VirtualEventEditor.tsx` | 重写规则定义：多事件选择器 + 全局筛选；基本信息增加备注 |
| `pages/Meta/EventAttributesPage.tsx` | 新增事件属性面板页面 |
| `features/meta/EventAttributeDetailDrawer.tsx` | 新增属性详情抽屉 |
| `features/meta/EventList.tsx` | 增加编辑按钮、备注 hover、搜索提示、表头下拉筛选、状态列 Tooltip |
| `features/meta/EventDetailDrawer.tsx` | 增加备注字段、编辑模式 |
| `features/meta/EventListHeaderFilters.tsx` | 新增：封装 Ant Design Table `filteredValue` + `filters` 的表头筛选逻辑 |
| `services/meta.service.ts` | 新增/更新虚拟事件、事件属性面板、事件编辑 API |
| `components/FilterEditor.tsx` | 确保全局筛选可复用（当前已支持） |

---

## 8. 实施顺序

1. 后端：Prisma schema 变更（`meta_event.remark`、`meta_event_attribute`、`meta_event_property.data_type` 扩展）。
2. 后端：虚拟事件定义 schema 升级 + 校验 + CRUD。
3. 后端：事件分析 SQL 生成器支持虚拟事件展开。
4. 后端：`meta_event_attribute` 维护逻辑（发现时 upsert、定时校准、手动刷新 API）。
5. 后端：事件属性面板 API + 事件备注编辑/搜索。
6. 前端：虚拟事件编辑器升级（多事件 OR + 全局筛选）。
7. 前端：事件属性面板 + 属性详情抽屉。
8. 前端：事件备注与编辑能力补齐。
9. 集成测试与验收。

---

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| 旧虚拟事件 definition_json 不兼容新 schema | 读取时做兼容转换；写入时统一新 schema |
| 虚拟事件全局筛选中的属性不存在于所有来源事件 | 保存时校验；运行时缺失属性按 NULL 处理并在结果中提示 |
| `meta_event_attribute` 与 `meta_event_property` 数据不一致 | 定时校准 + 手动刷新 + 发现时 upsert |
| 属性备注跨事件同步歧义 | 明确全局表 SSOT；事件详情抽屉展示全局备注 |
| 事件备注搜索导致列表慢 | 列表关键词搜索仅匹配前 N 条；全文索引作为可选优化 |
