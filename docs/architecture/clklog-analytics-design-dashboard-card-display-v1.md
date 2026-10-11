# 实现方案：看板卡片可点进入 + 位置级展示设置

> phase: clklog-analytics-dashboard-card-display-v1
> 帽子：架构（`docs/architecture/`）
> 上游：`docs/product/prd-clklog-analytics-dashboard-card-display-v1.md`

---

## 1. 阶段目标与范围

`DashboardCard` 增加可空 `display_json`；看板详情带回 `display`；新接口保存展示。前端标题可点进入；三点菜单设置抽屉按 `card.type` 多态。查询 DSL、ClickHouse、库卡 `chart_type` 语义不变。

## 2. 验收标准

- [ ] **ARCH-CD-1**：`DashboardCard.display_json` Text 可空；`saveLayouts` / `updateLayout` 只写坐标，不写 `display_json`。
- [ ] **ARCH-CD-2**：`PUT /sa/api/report/dashboards/:dbId/cards/:cardId/display` body `{ view }`；按类型白名单；多余键 400。
- [ ] **ARCH-CD-3**：看板详情与 `listByDashboard` 返回 `display`（无效 JSON 当缺省）。
- [ ] **ARCH-CD-4**：缺省回退：留存 `table`→`people_table`，`nth_trend`/`daily_trend`/`line`/`trend`→`nth_trend`；事件 `table` 或 `EventChartType`；漏斗 `table`→`table` 否则 `chart`；SQL 无 overlay 则沿用 `chart_config`。
- [ ] **ARCH-CD-5**：`CardWidget` 非 SQL 标题同样 `navigate`；菜单无刷新/编辑。
- [ ] **ARCH-CD-6**：`python3 scripts/arch_ratchet.py` 通过；不向 `shared/` / `utils/` 加生产文件。

## 3. 非目标

与 PRD §3 相同。不改 Prisma `Card` 列。禁止伪模块包。

## 4. 契约

### 4.1 列

`DashboardCard.display_json`：`{"view":"<白名单>"}` 或 null。

| type | view |
|------|------|
| retention | `nth_trend` \| `people_table` \| `rate_table` |
| event | `line` \| `trend` \| `bar` \| `stack` \| `cumulative` \| `distribution` \| `pie` \| `number` \| `table` |
| funnel | `chart` \| `table` |
| sql | `line` \| `trend` \| `bar` \| `pie` \| `number` \| `table` |

### 4.2 API

`PUT /sa/api/report/dashboards/:dbId/cards/:cardId/display`

```json
{ "view": "people_table" }
```

权限与改布局相同（`dashboard.edit`）。返回 `{ ok: true, display }`。

### 4.3 文件

| 路径 | 职责 |
|------|------|
| `report/card-display.ts`（server） | 白名单解析 |
| `features/report/card-display.ts` | 缺省回退与选项 |
| `features/report/CardDisplayDrawer.tsx` | 设置抽屉 |
| `CardWidget.tsx` | 标题链接、菜单、按 view 渲染 |

## 5. 迁移

Prisma migrate：`dashboardcard.display_json TEXT NULL`。发版走 `prisma migrate deploy`。
