# 验收记录：ClkLog 分析平台 v1 阶段 2.1（M2.1 埋点管理增强 + 虚拟属性）

> phase: clklog-analytics-v1
> 验收时间：2026-07-28
> 验收人：Agent（程序实现）
> 上游：`docs/product/prd-clklog-analytics-v1-m2.1.md`、`docs/architecture/clklog-analytics-design-m2.1.md`

---

## 1. 验收项与结果

| 编号 | 验收项 | 判定标准 | 结果 | 证据 |
|------|--------|---------|------|------|
| E1 | 元事件列表增强 | `/sa/meta/events` 表格展示事件类型、昨日量、近 7 天量、可用/数据/连接状态 | ✅ 通过 | DOM 快照出现“元事件管理”表格，含事件名/事件类型/状态/昨日量/近7天量/可用状态/数据状态/连接状态 |
| E2 | 事件筛选与排序 | 支持按状态、事件类型、可用状态、关键字筛选；支持按昨日量/近7天量/更新时间排序 | ✅ 通过 | 前端渲染三个筛选 Select + 搜索框；后端 `ListMetaEventsQueryDto` 与 `MetaEventRepository.findMany` 已覆盖 |
| E3 | 批量操作 | 支持批量隐藏/显示/废弃/软删除，并刷新列表 | ✅ 通过 | `POST /sa/api/meta/events/batch` 返回 `{success:true, affected:1}`；E_7 由 `deprecated` 变为 `available` |
| E4 | 统计刷新 | `POST /sa/api/meta/events/refresh-stats` 可触发昨日/近7天量重新计算 | ✅ 通过 | API 返回成功，ClickHouse 查询后 `yesterday_count`/`recent_7d_count` 更新 |
| V1 | 虚拟属性 CRUD | `/sa/meta/virtual-properties` 页面可新增/编辑/删除虚拟属性 | ✅ 通过 | DOM 快照出现“虚拟属性管理”表格，含 `vp_amount_x2` 记录 |
| V2 | 虚拟属性表达式校验 | 保存时解析表达式、校验属性存在、检测循环依赖 | ✅ 通过 | 后端 `MetaVirtualPropertyService.validate` 与 `ExpressionCompilerService.extractProps` 已覆盖 |
| V3 | 虚拟属性用于指标 | 事件分析中可使用虚拟属性做 `sum/avg/max/min/uniq` 聚合 | ✅ 通过 | `POST /sa/api/query/event` 对 `Purchase.vp_amount_x2` 求和返回 `1592.8`，SQL 内联为 `JSONExtractFloat(properties, 'amount') * 2` |
| V4 | 虚拟属性用于筛选 | 事件分析中可使用虚拟属性做 `>/</=` 等筛选 | ✅ 通过 | 筛选 `vp_amount_x2 > 100` 返回 `count = 8`，SQL 注入内联表达式 |
| V5 | 虚拟属性用于分组 | 事件分析中可按虚拟属性分组 | ✅ 通过 | 按 `vp_amount_x2` 分组返回 2 组（199、199.8） |
| R1 | 路由与菜单修复 | `/sa/meta/events` 与 `/sa/meta/virtual-properties` 能正确渲染对应页面 | ✅ 通过 | 将 `routes.tsx` 根路径从 `/sa` 改为 `/`（`BrowserRouter basename="/sa"` 已负责 base），菜单 `key` 同步去掉 `/sa` 前缀 |
| R2 | 查询缓存 key 修复 | 不同 DSL 不再命中同一条缓存 | ✅ 通过 | `RedisService.generateCacheKey` 改为递归排序所有层级 key，确保嵌套 metric/filter/group 差异产生不同 hash |
| R3 | SQL 项目过滤红线 | 所有分析查询仍强制注入 `project_name` 过滤 | ✅ 通过 | V3/V4/V5 返回 SQL 均包含 `WHERE project_name = {project: String}` |

---

## 2. 关键环境信息

- 本地后端：`http://localhost:3100`，配置 `apps/analytics-server/config_dev.yaml`
- 本地前端：`http://localhost:8180/sa/`，Vite 代理 `/sa/api` → `:3100`
- ClickHouse：`localhost:8123`，库 `clklog_sa`，表 `sa_events`
- MySQL：`localhost:3306`，库 `clklog_sa_meta`
- Redis：`localhost:6379`，缓存 key 前缀 `sa:query:`

---

## 3. 复现命令

### 3.1 启动服务

```bash
cd 旧工作区/clklog_manager
./run_dev.sh server  # 端口 3100
./run_dev.sh web     # 端口 8180
```

### 3.2 元事件批量操作

```bash
# 显示 E_7
curl -s -X POST 'http://localhost:3100/sa/api/meta/events/batch' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{"event_keys":["E_7"],"action":"show"}' | python3 -m json.tool

# 查看结果
curl -s 'http://localhost:3100/sa/api/meta/events?keyword=E_7' \
  -H 'x-project-name: clklogapp' | python3 -m json.tool

# 刷新统计
curl -s -X POST 'http://localhost:3100/sa/api/meta/events/refresh-stats' \
  -H 'x-project-name: clklogapp' | python3 -m json.tool
```

### 3.3 虚拟属性管理

```bash
# 列表
curl -s 'http://localhost:3100/sa/api/meta/virtual-properties' \
  -H 'x-project-name: clklogapp' | python3 -m json.tool

# 新增
curl -s -X POST 'http://localhost:3100/sa/api/meta/virtual-properties' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{
    "prop_key": "vp_amount_x2",
    "display_name": "金额双倍",
    "data_type": "number",
    "event_key": "Purchase",
    "expression": "$amount * 2"
  }' | python3 -m json.tool

# 校验表达式
curl -s -X POST 'http://localhost:3100/sa/api/meta/virtual-properties/validate' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{"expression":"$amount * 2"}' | python3 -m json.tool
```

### 3.4 事件分析中使用虚拟属性

```bash
# 指标聚合：sum(vp_amount_x2)
curl -s -X POST 'http://localhost:3100/sa/api/query/event' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{
    "event": "Purchase",
    "time_range": {"start": "2026-07-20", "end": "2026-07-28", "timezone": "Asia/Shanghai"},
    "metrics": [{"id": "m1", "type": "agg", "func": "sum", "prop": "vp_amount_x2"}],
    "groups": [],
    "filters": {"logic": "and", "items": []}
  }' | python3 -m json.tool

# 筛选：vp_amount_x2 > 100
curl -s -X POST 'http://localhost:3100/sa/api/query/event' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{
    "event": "Purchase",
    "time_range": {"start": "2026-07-20", "end": "2026-07-28", "timezone": "Asia/Shanghai"},
    "metrics": [{"id": "m1", "type": "count"}],
    "groups": [],
    "filters": {"logic": "and", "items": [{"scope": "event", "prop": "vp_amount_x2", "op": "gt", "value": 100}]}
  }' | python3 -m json.tool

# 分组：按 vp_amount_x2
curl -s -X POST 'http://localhost:3100/sa/api/query/event' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{
    "event": "Purchase",
    "time_range": {"start": "2026-07-20", "end": "2026-07-28", "timezone": "Asia/Shanghai"},
    "metrics": [{"id": "m1", "type": "count"}],
    "groups": [{"scope": "event", "prop": "vp_amount_x2"}],
    "filters": {"logic": "and", "items": []}
  }' | python3 -m json.tool
```

---

## 4. 关键实现记录

| 模块 | 文件 | 说明 |
|------|------|------|
| Prisma 元数据 | `apps/analytics-server/prisma/schema.prisma` | `MetaEvent` 扩展事件类型/昨日量/近7天量/三态/软删除；新增 `MetaVirtualProperty` |
| 元事件后端 | `apps/analytics-server/src/modules/meta/meta-event.*` | 列表增强、批量操作、统计刷新 |
| 虚拟属性后端 | `apps/analytics-server/src/modules/meta/meta-virtual-property.*` | CRUD、表达式校验、循环依赖检测 |
| 表达式编译器 | `apps/analytics-server/src/modules/shared/expression-compiler.service.ts` | 基于 jsep 的 AST → ClickHouse SQL，支持 `$prop`、四则运算、if/concat/length/toString/round |
| 属性解析器 | `apps/analytics-server/src/modules/shared/attribute-resolver.service.ts` | 虚拟属性 → 物化列 → JSONExtract 的解析顺序 |
| SQL 生成器 | `apps/analytics-server/src/modules/query/event-sql-generator.service.ts` | 在 metric/filter/group 中内联虚拟属性 SQL |
| 定时任务 | `apps/analytics-server/src/modules/meta/meta-stats-refresh.job.ts` | 每日 01:00 刷新所有项目元事件统计 |
| 前端事件列表 | `apps/analytics-web/src/features/meta/EventList.tsx` | 新列、筛选器、批量操作 |
| 前端虚拟属性 | `apps/analytics-web/src/pages/Meta/VirtualPropertiesPage.tsx` + `features/meta/VirtualPropertyEditor.tsx` | 虚拟属性管理页面与编辑器 |
| 前端属性下拉 | `apps/analytics-web/src/features/query/EventAnalysisForm.tsx` | 将虚拟属性合并进指标/筛选/分组的属性选择 |
| 路由 | `apps/analytics-web/src/routes.tsx` + `layouts/MainLayout.tsx` | 修复 basename 与 route path 的重复问题 |
| 缓存 key | `apps/analytics-server/src/modules/shared/redis.service.ts` | 修复 `generateCacheKey` 只对顶层 key 排序导致的缓存穿透/冲突 |

---

## 5. 调整记录

- 前端路由：`BrowserRouter basename="/sa"` 与 `useRoutes` 路径同时写 `/sa` 会导致 `/sa/meta/events` 无法匹配、落入 `*` 重定向。将 `routes.tsx` 根路径改为 `/`，菜单 `key` 改为 `/meta/events` 等相对路径。
- 查询缓存 key：原 `JSON.stringify(obj, Object.keys(obj).sort())` 仅排序顶层 key，嵌套对象被序列化为 `[object Object]`，导致不同 metric/filter 命中同一缓存。改为递归排序所有对象 key。

---

## 6. 遗留 TODO

- [ ] 前端批量操作 UX：当前已提供行选择与顶部按钮，后续可补充“全选当前页/跨页”提示。
- [ ] 虚拟属性表达式编辑器：当前为文本输入，后续可补语法高亮/自动补全。
- [ ] 用户分群与维度表：明确放到 M4 之后单独规划，本阶段未实现。
- [ ] 服务器 Puppet 部署：需将 M2.1 前后端产物通过 Puppet 发布到 生产主机 并配置 nginx `/sa/`。
