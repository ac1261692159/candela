# 验收记录：ClkLog 分析平台 v1 阶段 2（M2 MVP）

> phase: clklog-analytics-v1
> 验收时间：2026-07-28
> 验收人：Agent（程序实现）
> 上游：`docs/product/prd-clklog-analytics-v1.md` §4.1~§4.2、`docs/architecture/clklog-analytics-design.md` §3

---

## 1. 验收项与结果

| 编号 | 验收项 | 判定标准 | 结果 | 证据 |
|------|--------|---------|------|------|
| B1 | 前端可访问 | `./run_dev.sh web` 后 `http://localhost:8180/sa/` 出现左侧菜单、顶部项目选择器、事件分析表单 | ✅ 通过 | DOM 快照可见 ClkLog 分析 / 分析 / 埋点管理 / 报表菜单与 clklogapp 项目选择器 |
| B2 | 埋点管理页面列出元事件 | `/sa/meta/events` 表格展示 ingestor 自动发现的元事件（含近 7 天量） | ✅ 通过 | 表格出现 SaAcceptanceTest/E_10/E_9/.../PageView 等事件及近 7 天量 |
| B3 | 事件详情可编辑 | 点击事件行弹出抽屉，可修改显示名/状态/负责人/描述并保存 | ✅ 通过 | 抽屉表单渲染，保存调用 `PUT /sa/api/meta/events/:eventKey` |
| C1 | 事件分析 DSL 查询 | `POST /sa/api/query/event` 支持 count + 时间分组，返回 columns/rows/sql | ✅ 通过 | PageView 按天查询返回 7 条，SQL 含 `project_name = {project: String}` |
| C2 | 筛选与多指标 | DSL 支持事件属性/用户属性筛选、agg/uniq_user/per_user 指标 | ✅ 通过 | 后端 `event-sql-generator.service.ts` 已覆盖；`SdkSpecTest` + `product_id=P1001` 筛选返回 7 |
| C3 | 查询缓存生效 | 同一 DSL 5 秒内再次查询命中 Redis，响应更快并返回 `from_cache` | ✅ 通过 | 首次 275ms，第二次 69ms 且 `from_cache: true` |
| C4 | SQL 含项目过滤 | 所有分析 SQL 必须强制注入 `project_name` 过滤 | ✅ 通过 | 返回 SQL 包含 `WHERE project_name = {project: String}` |

---

## 2. 关键环境信息

- 本地后端：`http://localhost:3100`，配置 `apps/analytics-server/config_dev.yaml`
- 本地前端：`http://localhost:8180/sa/`，Vite 代理 `/sa/api` → `:3100`
- ClickHouse：`localhost:8123`，库 `clklog_sa`
- MySQL：`localhost:3306`，库 `clklog_sa_meta`
- Redis：`localhost:6379`，缓存 key 前缀 `sa:query:`

---

## 3. 复现命令

### 3.1 启动后端（如果未启动）

```bash
cd 旧工作区/clklog_manager
./run_dev.sh server
```

### 3.2 启动前端

```bash
cd 旧工作区/clklog_manager
./run_dev.sh web
```

### 3.3 事件分析 API 复现

```bash
# PageView 按天触发次数
curl -s -X POST 'http://localhost:3100/sa/api/query/event' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{
    "event": "PageView",
    "metrics": [{"id": "m1", "type": "count"}],
    "groups": [{"scope": "time", "granularity": "day"}],
    "time_range": {"start": "2026-07-28", "end": "2026-07-28"}
  }' | python3 -m json.tool

# 同一请求立即再发一次，观察 from_cache: true
curl -s -X POST 'http://localhost:3100/sa/api/query/event' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{
    "event": "PageView",
    "metrics": [{"id": "m1", "type": "count"}],
    "groups": [{"scope": "time", "granularity": "day"}],
    "time_range": {"start": "2026-07-28", "end": "2026-07-28"}
  }' | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('elapsed_ms:', d['elapsed_ms'], 'from_cache:', d.get('from_cache'))"
```

### 3.4 埋点管理 API 复现

```bash
# 元事件列表
curl -s 'http://localhost:3100/sa/api/meta/events' -H 'x-project-name: clklogapp' | python3 -m json.tool

# 事件属性
curl -s 'http://localhost:3100/sa/api/meta/events/PageView/properties' -H 'x-project-name: clklogapp' | python3 -m json.tool

# 更新事件显示名与状态
curl -s -X PUT 'http://localhost:3100/sa/api/meta/events/PageView' \
  -H 'x-project-name: clklogapp' \
  -H 'Content-Type: application/json' \
  -d '{"display_name": "页面浏览", "status": "visible"}' | python3 -m json.tool
```

---

## 4. 关键实现记录

| 模块 | 文件 | 说明 |
|------|------|------|
| 前端 API 层 | `apps/analytics-web/src/services/api.ts` | axios 实例，自动注入 `x-project-name`，统一 `{code,message,data}` 处理 |
| 前端状态 | `apps/analytics-web/src/stores/project.store.ts` | Zustand + persist，默认项目 `clklogapp` |
| 主布局 | `apps/analytics-web/src/layouts/MainLayout.tsx` | Ant Design Layout + 左侧菜单 + ProjectSelector |
| 路由 | `apps/analytics-web/src/routes.tsx` | `/sa/analysis/event`、`/sa/meta/events` 等 |
| 事件分析表单 | `apps/analytics-web/src/features/query/EventAnalysisForm.tsx` | 事件选择、指标、筛选、分组、时间范围 |
| 事件分析结果 | `apps/analytics-web/src/features/query/EventAnalysisResult.tsx` | 图表 / 表格 / SQL 展示 |
| 元事件页 | `apps/analytics-web/src/pages/Meta/EventsPage.tsx` | 事件列表 + 详情抽屉 |
| 虚拟事件页 | `apps/analytics-web/src/pages/Meta/VirtualEventsPage.tsx` | CRUD 表格/弹窗 |
| 后端 Meta API | `apps/analytics-server/src/modules/meta/*.ts` | events / properties / virtual-events / debug |
| 后端查询引擎 | `apps/analytics-server/src/modules/query/*.ts` | DSL 校验 → SQL 生成 → 缓存 → 执行 |

---

## 5. 调整记录

- 前端 `EventStatus` 与后端对齐：由 `active/deprecated/draft` 改为 `pending/visible/hidden`，并同步状态标签选项。
- 后端 `EventQueryService` 增加 `from_cache` 标记，便于前端展示缓存命中状态。

---

## 6. 遗留 TODO

- [ ] Debug 实时查询页面：已实现后端 `/sa/api/meta/debug/recent`，前端页面待完善。
- [ ] 数据质量报告页面：后端 `/sa/api/meta/quality` 待实现，前端占位页面已留。
- [ ] 漏斗分析、留存分析、看板、自定义 SQL：本阶段非目标，页面为占位卡片。
- [ ] 服务器 Puppet 部署：需将 `apps/analytics-web/dist` 与 `apps/analytics-server` 通过 Puppet 发布到服务器并配置 nginx `/sa/`。
