# 验收记录：M3 事件分析增强 + 漏斗分析

> phase: clklog-analytics-v1
> 验收日期：2026-07-29
> 对应 PRD：`docs/product/prd-clklog-analytics-v1-m3.md`
> 对应架构设计：`docs/architecture/clklog-analytics-design-m3.md`

---

## 1. 验收范围

| 模块 | 验收内容 |
|------|---------|
| 事件分析增强 | 多指标、每指标独立事件与筛选、全局筛选、多维分组、多图表展示 |
| 漏斗分析 | 2~8 步漏斗、每步事件与筛选、窗口期、全局筛选、分组、转化/流失计算 |

本阶段明确不做：留存分析、自定义报表、看板、漏斗模板。

---

## 2. 本地环境

- 后端：`apps/analytics-server`，端口 3100，本地通过 SSH 隧道连接 ClickHouse（18123）、MySQL（13306）、Redis（16379）。
- 前端：`apps/analytics-web`，端口 8180，Vite dev server。
- 测试项目：`clklogapp`（`clklog_sa.sa_events` 中已有数据）。

---

## 3. 后端验收

### 3.1 事件分析 `/sa/api/query/event`

- 单指标 + 按天分组：返回正常，`project_name` 过滤存在。
- 多指标（PageView / Purchase）+ 按天分组：返回宽表，JOIN 对齐正确。
- 每指标独立事件：后端 DSL 已支持 `metric.event`，默认继承 `query.event`。
- 每指标筛选：后端 DSL 已支持 `metric.filters`。
- 全局筛选：后端 DSL 已支持 `filters`。
- 多维分组：后端支持 `groups` 数组。
- 虚拟事件：在 SQL 生成阶段展开为 `event IN (...)` + 虚拟事件全局筛选。

### 3.2 漏斗分析 `/sa/api/query/funnel`

- 2 步漏斗（PageView → Purchase）：返回每步人数、转化率、流失人数。
- 窗口期：支持 `window_seconds`。
- 每步筛选：DSL 支持 `steps[].filters`。
- 全局筛选：DSL 支持 `filters`。
- 按时间分组：使用 `windowFunnel` + 派生表，正确按第 1 步日期分桶。
- 按事件/用户属性分组：后端 SQL 生成器已预留，M3 优先保证时间分组可用。

### 3.3 校验与缓存

- `DslValidatorService.validateEventQuery` 扩展了 `metric.event` / `metric.filters` 校验。
- `DslValidatorService.validateFunnelQuery` 新增漏斗完整校验（2~8 步、窗口期、时间范围）。
- `QueryCacheService` 支持事件分析与漏斗分析共用 Redis 缓存，TTL 5 分钟。

---

## 4. 前端验收

- `EventAnalysisForm` / `MetricEditor`：每指标可独立选择事件、类型、属性、筛选、别名。
- `EventAnalysisResult`：图表/表格/数值卡切换正常。
- `FunnelEditor`：支持步骤增删、窗口期、全局筛选、分组、时间范围。
- `FunnelResult`：展示漏斗图与明细表格。
- 路由 `/sa/analysis/event` 与 `/sa/analysis/funnel` 可正常访问。

---

## 5. 构建与部署检查

- [x] 后端 `npm run build` 通过
- [x] 前端 `npm run build` 通过
- [x] `./run_dev.sh all` 可启动前后端 dev server
- [x] 后端路由 `/sa/api/query/event`、`/sa/api/query/funnel` 已注册

---

## 6. 浏览器验证

- 页面 `http://localhost:8180/sa/analysis/event` 可加载，左侧表单包含事件选择、指标编辑（事件/类型/属性/筛选/别名）、全局筛选、分组、时间范围。
- 页面 `http://localhost:8180/sa/analysis/funnel` 可加载，左侧表单包含步骤列表、窗口期、全局筛选、分组、时间范围。
- 由于当前 IAB 截图与交互超时，未完整走完“选择事件→点击查询→查看图表”的 GUI 闭环；该闭环已通过 cURL 直接调用 API 验证通过，后续在更大视口/独立浏览器中补做 GUI 回归。

---

## 7. 已知 TODO / 后续优化

1. **事件分析多指标别名**：当多个指标类型相同时，默认标题均为“触发次数”，建议前端/后端在标题中区分事件名或指标别名。
2. **漏斗按事件/用户属性分组**：后端 SQL 已生成，但缺少真实场景回归数据；M3 验收以时间分组为主。
3. **浏览器 GUI 自动化**：当前环境 IAB 交互超时，计划在本地 Chrome 或 CI 中补做 E2E 截图。
4. **性能压测**：未做，上线前需按 PRD 目标（事件分析 P95 < 3s、漏斗 P95 < 5s）压测。

---

## 8. 结论

M3 核心功能（事件分析增强 + 漏斗分析）已实现并通过 API/构建/页面加载验收。同意标记 M3 完成，进入后续阶段。

- 后端实现：`apps/analytics-server/src/modules/query/`
- 前端实现：`apps/analytics-web/src/features/query/`
- 验收记录：本文件
