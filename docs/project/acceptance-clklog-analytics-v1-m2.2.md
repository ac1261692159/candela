# 验收记录：ClkLog 分析平台 v1 阶段 2.2（M2.2 埋点管理进阶）

> phase: clklog-analytics-v1
> 验收时间：2026-07-29
> 验收人：Agent（程序实现）
> 上游：`docs/product/prd-clklog-analytics-v1-m2.2.md`、`docs/architecture/clklog-analytics-design-m2.2.md`

---

## 1. 验收项与结果

| 编号 | 验收项 | 判定标准 | 结果 | 证据 |
|------|--------|---------|------|------|
| M2.2-A1 | 虚拟事件多事件 OR | 创建虚拟事件时可选择多个来源事件；保存后 definition.events 为数组 | ✅ 通过 | API 创建 `ve_612GHbn3jd`，definition.events = `["PageView", "Purchase"]` |
| M2.2-A2 | 虚拟事件全局筛选 | 虚拟事件定义支持全局事件属性筛选条件 | ✅ 通过 | 上述虚拟事件包含 `product_id = P1` 全局筛选 |
| M2.2-A3 | 虚拟事件在分析中可用 | 事件分析选择虚拟事件后 SQL 展开为 `event IN (...)` 并注入全局筛选 | ✅ 通过 | 查询返回 SQL 包含 `event IN {events: Array(String)} AND (JSONExtractString(properties, 'product_id') = ...)` |
| M2.2-A4 | 事件备注 | 元事件可更新 remark，列表关键词搜索可匹配备注；事件编辑抽屉包含备注字段 | ✅ 通过 | `PUT /meta/events/PageView` 更新 remark；`keyword=页面浏览测试备注` 可检索；事件详情抽屉包含「备注」输入框 |
| M2.2-A5 | 事件属性面板 | `/sa/meta/event-attributes` 可查询项目下全部属性，含关联事件数 | ✅ 通过 | 页面表格展示属性标识、数据类型、关联事件数、状态、备注、更新时间、操作列；数据类型下拉包含 文本/数值/布尔/时间/列表/对象/对象组 |
| M2.2-A6 | 属性备注可编辑 | 属性面板行内备注输入框失焦后保存，且提示「备注已保存」 | ✅ 通过 | 将 `keyword` 属性备注改为 "M2.2 属性备注测试"，列表与属性详情抽屉均同步 |
| M2.2-A7 | 属性数据类型扩展 | 支持 Object / ObjectGroup，ingestor 自动发现时识别 | ✅ 通过 | `MetaDiscoveryService.inferType` 已扩展对象/对象组 |
| M2.2-A8 | 列表表头筛选 | 事件列表支持状态/事件类型/可用状态/数据状态/连接状态列头下拉筛选 | ✅ 通过 | 浏览器中点击「事件类型」列头 filter，选择「虚拟事件」后表格仅展示虚拟事件；顶部筛选同步显示 |
| M2.2-A9 | 状态列 Tooltip | 「可用状态」「数据状态」「连接状态」列标题右上角问号 hover 显示说明 | ✅ 通过 | 鼠标悬停「可用状态」「数据状态」问号图标均出现黑色 Tooltip 说明 |
| R1 | SQL 项目过滤红线 | 所有分析查询继续强制注入 `project_name` 过滤 | ✅ 通过 | 虚拟事件查询 SQL 仍包含 `WHERE project_name = {project: String}` |
| R2 | 不改社区版表结构 | 虚拟属性/虚拟事件只存表达式/定义，不 ALTER `sa_events` | ✅ 通过 | 仅新增 MySQL 元数据表/字段 |

---

## 2. 关键环境信息

- 本地后端：`http://localhost:3100`，配置 `apps/analytics-server/config_dev.yaml`
- 本地前端：`http://localhost:8180/sa/`，Vite 代理 `/sa/api` → `:3100`
- ClickHouse：`localhost:18123`，库 `clklog_sa`
- MySQL：`localhost:13306`，库 `clklog_sa_meta`

---

## 3. 复现命令

### 3.1 创建多事件虚拟事件

```bash
curl -s -X POST 'http://localhost:3100/sa/api/meta/virtual-events' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{
    "display_name": "测试OR虚拟事件",
    "status": "visible",
    "definition_json": {
      "events": ["PageView", "Purchase"],
      "filters": {
        "logic": "and",
        "items": [{"scope": "event", "prop": "product_id", "op": "=", "value": "P1"}]
      }
    }
  }' | python3 -m json.tool
```

### 3.2 事件分析中使用虚拟事件

```bash
curl -s -X POST 'http://localhost:3100/sa/api/query/event' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{
    "event": "ve_612GHbn3jd",
    "time_range": {"start": "2026-07-20", "end": "2026-07-29", "timezone": "Asia/Shanghai"},
    "metrics": [{"id": "m1", "type": "count"}],
    "groups": [],
    "filters": {"logic": "and", "items": []}
  }' | python3 -m json.tool
```

### 3.3 事件备注与搜索

```bash
curl -s -X PUT 'http://localhost:3100/sa/api/meta/events/PageView' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{"remark": "页面浏览测试备注"}' | python3 -m json.tool

curl -s 'http://localhost:3100/sa/api/meta/events?keyword=页面浏览测试备注' \
  -H 'x-project-name: clklogapp' | python3 -m json.tool
```

### 3.4 事件属性面板

```bash
curl -s -X POST 'http://localhost:3100/sa/api/meta/event-attributes/refresh-counts' \
  -H 'x-project-name: clklogapp' | python3 -m json.tool

curl -s 'http://localhost:3100/sa/api/meta/event-attributes?data_type=string' \
  -H 'x-project-name: clklogapp' | python3 -m json.tool
```

---

## 4. 关键实现记录

| 模块 | 文件 | 说明 |
|------|------|------|
| Prisma schema | `apps/analytics-server/prisma/schema.prisma` | `MetaEvent` 增加 `remark`；新增 `MetaEventAttribute`；`MetaEventProperty.data_type` 扩展 Object/ObjectGroup |
| 虚拟事件后端 | `apps/analytics-server/src/modules/meta/meta-virtual-event.service.ts` | 新 schema（events 数组 + filters）、来源事件校验、自动同步 `meta_event` |
| SQL 生成器 | `apps/analytics-server/src/modules/query/event-sql-generator.service.ts` | 虚拟事件展开为 `event IN (...)` + 全局筛选；属性解析 fallback 到来源事件 |
| 属性解析器 | `apps/analytics-server/src/modules/shared/attribute-resolver.service.ts` | `ResolveContext` 增加 `events` 数组，用于虚拟事件属性推断 |
| 属性发现 | `apps/analytics-server/src/modules/ingestor/meta-discovery.service.ts` | 发现属性时 upsert `MetaEventAttribute` 并维护 `event_count` |
| 事件属性面板 API | `apps/analytics-server/src/modules/meta/meta-event-attribute.*` | 列表/详情/更新/刷新计数 |
| 事件备注 | `apps/analytics-server/src/modules/meta/meta-event.service.ts` + `dto` + `repository` | 支持 remark 编辑与搜索 |
| 前端虚拟事件 | `apps/analytics-web/src/features/meta/VirtualEventEditor.tsx` + `pages/Meta/VirtualEventsPage.tsx` | 多事件 OR + 全局筛选 UI |
| 前端事件列表 | `apps/analytics-web/src/features/meta/EventList.tsx` | 表头筛选、状态 Tooltip、备注展示 |
| 前端事件属性面板 | `apps/analytics-web/src/pages/Meta/EventAttributesPage.tsx` | 属性列表、数据类型筛选、备注编辑、属性详情抽屉 |

---

## 5. 调整记录

- `FilterOp` 未包含 `eq`，但外部/旧数据可能传入 `eq`。SQL 生成器增加 `normalizeFilterOp` 做别名映射（`eq→=`、`ne→!=`、`gt→>` 等），提高兼容性。
- 虚拟事件创建时同步写入 `meta_event` 表，使其出现在事件列表和事件分析选择器中；删除时同步软删除 `meta_event`。
- 事件属性面板的 `event_count` 在属性发现时近实时维护，并提供手动刷新与定时校准入口。
- 虚拟事件列表接口 `/sa/api/meta/virtual-events` 原返回数组，与前端 `ListResponse` 不一致；已改为 `{ items, total, page, pageSize }` 包装，页面可正常加载。
- 前后端虚拟事件定义字段统一为 `definition_json`（后端 `toResponse`、前端 `MetaVirtualEvent` 类型、VirtualEventsPage 与 VirtualEventEditor 均对齐），避免 `definition`/`definition_json` 混用导致 TypeScript 报错。

---

## 6. 浏览器验证记录

| 验证点 | 结果 | 说明 |
|--------|------|------|
| 事件列表页加载 | ✅ | 表格展示 20 条事件，含状态/事件类型/可用状态/数据状态/连接状态列头 filter 图标 |
| 可用状态 Tooltip | ✅ | hover 问号图标出现说明：「可用=有数据且可见；无数据=近7天无数据；已隐藏=被隐藏或删除；已废弃=状态为待确认或已废弃。」 |
| 数据状态 Tooltip | ✅ | hover 问号图标出现说明：「正常=昨天有数据；昨日无数据=近7天有数据但昨天无数据；近期无数据=近7天无数据。」 |
| 表头筛选生效 | ✅ | 选择「虚拟事件」后表格仅展示 `ve_612GHbn3jd` |
| 事件编辑抽屉 | ✅ | 点击「编辑」打开抽屉，基本信息 tab 包含「备注」输入框 |
| 虚拟事件管理页 | ✅ | 列表展示 `ve_612GHbn3jd`，来源事件渲染为 `PageView 或 Purchase` |
| 新增虚拟事件弹窗 | ✅ | 规则定义区含「事件」多选下拉与「全局筛选」编辑区，基本信息区含事件名/显示名/状态 |
| 事件属性面板 | ✅ | 表格含属性标识、数据类型、关联事件数、状态、备注、更新时间、操作列；顶部有数据类型/状态筛选 |
| 数据类型筛选 | ✅ | 选择「数值」无数据，选择「文本」展示全部 String 属性 |
| 属性备注行内编辑 | ✅ | 输入备注后失焦，顶部提示「备注已保存」，列表与属性详情抽屉同步 |
| 属性详情抽屉 | ✅ | 展示属性标识、显示名、全局数据类型、全局备注、关联事件列表 |

---

## 7. 遗留 TODO

- [ ] 前端事件属性面板：属性详情抽屉里的「全局数据类型/显示名」保存后需要刷新列表。
- [ ] 虚拟事件全局筛选的属性候选目前取第一个来源事件；多事件属性不一致时建议改为属性并集。
- [ ] 服务器 Puppet 部署：将 M2.2 前后端产物通过 Puppet 发布并配置 nginx `/sa/`。
