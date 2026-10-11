# 实现方案：看板工作室 v1

> phase: `clklog-analytics-dashboard-studio-v1`
> 版本：v1.0（2026-09-03）｜ 上游：`docs/product/prd-clklog-analytics-dashboard-studio-v1.md`
> 相关契约：`clklog-analytics-design.md`（ID）、`clklog-analytics-design-dashboard-sql-cards-v1.md`（refresh）
> 本文档是本期**实现与 API 契约**权威。产品交互见 PRD。

---

## 1. 阶段目标与范围（门禁要素①）

看板详情改为 Grafana 语义网格（`react-grid-layout`）；Dashboard 增加刷新/TTL/列数；新增 `CardCache` 与进程内温热循环；卡片类型增加 `text`；删除入口从列表/卡片 chrome 收回编辑面。不新开帽子。

## 2. 验收标准（门禁要素②）

与 PRD §8 **DS-1～DS-11** 一一对应。自动化至少覆盖：

- 12 列遗留坐标 → 24 列只读放大，且 `max(x+w)≤12` 才放大。
- 列数 24→12 按比例映射。
- 缓存过期判定：`now - refreshed_at > cache_ttl_sec`。
- worker 资格：跳过 `text` / `retention` / 无看板引用；多看板取 `min(cache_ttl_sec)`。
- `CardService.refresh` 对 `text` 返回 400；成功 refresh 写入 `CardCache`。
- 交付前 `python3 scripts/arch_ratchet.py` 退出码 0。

## 3. 非目标（门禁要素③）

与 PRD §9 相同。查询守卫、只读账号、`project_name` 过滤不改口。禁止向 `src/common/`、`src/utils/`、`src/modules/shared/` 新增生产文件。

---

## 4. 数据模型（Prisma SSOT）

`Dashboard` 新增：

| 列 | 类型 | 默认 | 含义 |
|----|------|------|------|
| `refresh_interval_sec` | Int | 0 | 0=关闭；允许 30 / 60 / 300 / 900 |
| `cache_ttl_sec` | Int | 300 | 允许 30 / 60 / 300 / 900 / 3600 |
| `grid_columns` | Int | 24 | 允许 12 / 16 / 24 |

`Card.type` 增加取值 `text`（注释更新，不改列类型）。

`CardCache`（表名 `cardcache`，`@@map("cardcache")`）：

| 列 | 含义 |
|----|------|
| `card_id` PK | 与 `Card` 1:1，`onDelete: Cascade` |
| `result_json` LongText? | refresh 的 `result` JSON；超 512KB 存截断对象 |
| `error` Text? | 最近一次失败信息；成功则 null |
| `row_count` Int | 便于列表/调试 |
| `refreshed_at` DateTime | 写入时刻 |

布局仍在 `DashboardCard.position_x/y`、`width`、`height`，语义改为 Grafana `x/y/w/h`（列单位，不是 Ant span）。

标签卡 `dsl_json`：

```json
{
  "body": "口径：UV 去重 distinct_id",
  "text_color": "#AD4E00",
  "background_color": "#FFF7E6",
  "font_size": 14
}
```

颜色必须为 `#RRGGBB`。无 SQL、不写缓存。

---

## 5. API 契约

既有路径不改。扩展字段：

### 5.1 看板

`PUT /sa/api/report/dashboards/:dbId` body 增加可选：

- `refresh_interval_sec` ∈ {0,30,60,300,900}
- `cache_ttl_sec` ∈ {30,60,300,900,3600}
- `grid_columns` ∈ {12,16,24}

`GET` 列表/详情/分享均回传上述三字段（缺省按表默认）。

`GET` 详情每张卡增加：

```ts
cache: null | {
  result: object | null;
  error: string | null;
  refreshed_at: string; // ISO
  row_count: number;
  stale: boolean; // age > 本看板 cache_ttl_sec
}
```

`stale` 按**当前看板** TTL 计算，不是全局 min。worker 用 min。

### 5.2 批量布局

`PUT /sa/api/report/dashboards/:dbId/layout`

```json
{ "items": [{ "card_id": "card_xxx", "position_x": 0, "position_y": 0, "width": 12, "height": 8 }] }
```

事务内逐条更新已存在的关联行；未知 `card_id` 忽略。RBAC 与详情相同。

默认新挂卡：`width = floor(grid_columns/2)`，`height = 6`（标签卡 3），`x=0`，`y = max(y+h)`。

### 5.3 卡片

`CreateCardDto.type` 允许 `text`。`refresh`：`text` → 400「标签卡无需刷新」；`retention` 保持现 400。成功路径 upsert `CardCache`（与用户 refresh、worker 共用 `computeResult`）。

结果 JSON 字节数 > 512 * 1024 时 `result_json` 存：

```json
{ "truncated": true, "reason": "cache_too_large", "columns": [], "rows": [] }
```

并保留 `error` 为空（这是成功但裁切，不是查询失败）。

---

## 6. 布局算法

文件：`apps/analytics-web/src/features/report/grafana-layout.ts`（纯函数，单测锁行为）。

- 网格：`react-grid-layout` + `WidthProvider`；`cols = dashboard.grid_columns`；`rowHeight = 40`；`margin = [8,8]`；`compactType = 'vertical'`；`draggableHandle = .grafana-panel-drag`；`resizeHandles = ['se']`。
- **遗留 12 列检测**：若所有块 `w <= 6` 且 `x+w <= 12`（旧默认半宽 6），展示时只放大列坐标 `x' = x*2`，`w' = w*2`，**不加倍 `h`**（加倍后格子过高、内容仍固定高度会造成大块留白）。新 24 列半宽为 12，不会误放大。仅展示变换；落库发生在用户 drag/resize stop。
- 面板 DOM 必须 `height:100%` 填满 grid item；图表/表格按格子剩余高度铺满，禁止写死 240px 高度。
- 若一块看板里**多数卡** `h` 相同且 `h>=8`（工作室默认格），展示时那些卡收到 `h=6`；少数不同高度（如标签）不挡、也不改。用户把卡拉成互不相同的高度后不再自动收。
- `CreateCardDto.dsl` / `UpdateCardDto.dsl` 必须 `@Allow()`：ValidationPipe `forbidNonWhitelisted` 会拒绝无装饰字段，标签卡因此无法创建。
- **改列数**：`x' = round(x * to/from)`，`w' = max(1, round(w * to/from))`，然后 clamp `x+w <= to`。
- 持久化：`onDragStop` / `onResizeStop` 调批量 layout API（debounce 300ms 合并）。

后端不自动改写历史坐标。

---

## 7. 缓存写入方（单一写入口）

唯一写入 `CardCache` 的模块：`CardService.upsertCache`（由 `refresh` 与 `CardCacheWorker` 调用 `computeResult` 后写入）。禁止 controller / worker 直接 `prisma.cardCache.create`。

`CardCacheWorker`：`OnModuleInit` 起 `setInterval(30s)`，`OnApplicationShutdown`/`OnModuleDestroy` `clearInterval`。tick 重入锁（上一轮未完则跳过）。并发 2，复用与前端相同的闸门语义（简单 for + 2 槽）。查询走现有 `EventQueryService` / `FunnelQueryService` / `SqlReportService`，带 `project_name`。身份为系统任务，不套用户 RBAC（只扫已存在卡片）。

`main.ts` 已 `enableShutdownHooks()`。

---

## 8. 前端结构

| 文件 | 职责 |
|------|------|
| `DashboardGrid.tsx` | RGL 容器、布局保存 |
| `CardWidget.tsx` | 查询卡：缓存首屏 + 过期/强制刷新 |
| `TextPanel.tsx` | 标签卡展示 + 编辑弹层 |
| `DashboardSettingsDrawer.tsx` | 齿轮表单与删看板 |
| `grafana-layout.ts` | 坐标变换 |
| `DeleteCardButton.tsx` | 编辑面删除库卡片 |
| `DataDictionaryPanel.tsx` | Tree 去 indent/switcher |

`features/report/` 保持单目录 <30 文件。不新增 `utils/`。

打开路径：`getDashboard` → 把 `cache.result` 交给 widget → `stale` 或无缓存才 `refreshCard`。自动刷新提升 `refreshEpoch`，widget 强制 `refreshCard`。

面板菜单：刷新；`sql`→`/report/sql?card=`；`event`/`funnel`/`retention`→对应分析页；`text`→编辑弹层；从看板移除（Popconfirm）。

---

## 9. 红线

- 不改 `clklog.log_analysis` 及社区版 19 张表。
- ClickHouse 查询仍走现有 refresh/execute（项目过滤 + 时间 + LIMIT + 超时 + 只读账号）。
- 密钥不入库。
- PR 声明「红线未自动检：社区版表未改；CH 查询仍走既有 refresh」。
- 门禁未自动检：Grafana 拖拽手感、字典贴左、删除入口位置（浏览器验收）。

---

## 10. 迁移

`apps/analytics-server/prisma/migrations/20260903090000_dashboard_studio_v1/migration.sql`

- `ALTER TABLE Dashboard` 三列（表名与 init 的 `` `Dashboard` `` 一致）。
- `CREATE TABLE cardcache` + FK `card_id` → `Card.card_id` ON DELETE CASCADE。

发版：`prisma migrate deploy`（`scripts/server-upgrade.sh` 已包含）。
