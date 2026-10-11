# 实现方案：卡片与看板描述、名称唯一、列表信息降噪

> phase: `clklog-analytics-asset-description-v1`
> 帽子：架构（`docs/architecture/`）
> 上游需求：会话内用户提出（卡片描述 ≤200 字、看板描述 ≤500 字、名称唯一、列表悬停信息）
> 作用域：`apps/analytics-server/src/modules/report/`、`prisma/`、`apps/analytics-web/src/`

---

## 1. 阶段目标与范围

1. 卡片（`event` / `funnel` / `retention` / `sql`）与看板各增加一个可空 `description`：卡片 ≤200 字、看板 ≤500 字。
2. 卡片库列表悬停卡片名称显示描述；看板列表悬停看板名称显示描述。
3. 看板列表的「更新时间」不再单独占列，改为悬停「卡片数」时显示。
4. 同一项目内卡片名称、看板名称不得重复（创建 / 另存为 / 重命名均校验）。

不改：既有 DSL、缓存语义、RBAC 判定、看板布局协议、`text` 卡的正文。

## 2. 验收标准

- [ ] **DESC-1**：`Card.description`、`Dashboard.description` 为可空列，长度上限分别为 200 / 500 字，超长由 DTO 校验拒绝（400）。
- [ ] **DESC-2**：卡片设置（卡片库列表「设置」、另存为弹窗、SQL 页卡片设置）与看板设置抽屉都能编辑描述；留空即清空为 `null`，不会写入空串。
- [ ] **DESC-3**：卡片库列表悬停卡片名称显示描述；无描述时不显示空浮层。
- [ ] **DESC-4**：看板列表悬停看板名称显示描述；「卡片数」悬停显示更新时间（绝对时间）。
- [ ] **DESC-5**：同项目内创建 / 另存为 / 重命名时，名称与既有卡片（或看板）重复则在**校验时**返回 409 且前端提示；重命名时排除自身。
- [ ] **DESC-6**：`GET /sa/api/report/cards`、`GET /sa/api/report/dashboards`、详情与分享接口均返回 `description`。
- [ ] **DESC-7**：`python3 scripts/arch_ratchet.py` 通过；前后端 `tsc --noEmit` 通过；既有测试不回归。

## 3. 契约

### 3.1 数据列

| 表 | 列 | 类型 | 说明 |
|---|---|---|---|
| `card` | `description` | `VARCHAR(200) NULL` | 卡片描述，空值用 `null` |
| `Dashboard` | `description` | `VARCHAR(500) NULL` | 看板描述，空值用 `null` |

### 3.2 请求体

- `CreateCardDto` / `UpdateCardDto`：新增 `description?: string | null`，`@MaxLength(200)`。
- `SaveSqlReportDto`（`POST /report/sql/save`、`PUT /report/sql/:id`）：新增 `description?: string | null`，`@MaxLength(200)`。
- `CreateDashboardDto` / `UpdateDashboardDto`：新增 `description?: string | null`，`@MaxLength(500)`。

写入规则：`description?.trim()` 为空 → 存 `null`。

### 3.3 响应体

`AnalysisCard` / `DashboardSummary` / `DashboardDetail` / 分享详情新增 `description: string | null`。

### 3.4 名称唯一

判定键为 `(project_name, name)`，在 service 层校验（`CardService.create` / `CardService.update` / `SqlReportService.save` / `SqlReportService.update` / `DashboardService.create` / `DashboardService.update`），冲突抛 `ConflictException`（409，中文提示）。

不建数据库唯一索引：历史数据可能已存在同名行，加索引会让 `prisma migrate deploy` 在线上直接失败；应用层校验已满足「不可新建重名」的产品要求，并发窗口下的极少数绕过由后续人工修正。

## 4. 迁移

```sql
ALTER TABLE `card` ADD COLUMN `description` VARCHAR(200) NULL;
ALTER TABLE `Dashboard` ADD COLUMN `description` VARCHAR(500) NULL;
```

目录命名遵循既有规范：`prisma/migrations/<yyyyMMddHHmmss>_card_dashboard_description/migration.sql`。发版走 `prisma migrate deploy`。

## 5. 文件

| 路径 | 职责 |
|------|------|
| `prisma/schema.prisma`、`prisma/migrations/*_card_dashboard_description/` | 两列 |
| `report/dto/card.dto.ts`、`report/dto/sql-report.dto.ts`、`report/dto/dashboard.dto.ts` | 描述字段与长度校验 |
| `report/card.repository.ts`、`report/dashboard.repository.ts` | `findByName`（带自身排除） |
| `report/card.service.ts` | `toCard` 带 description、create/update 查重 |
| `report/sql-report.service.ts` | SQL 卡 save/update 查重与 description |
| `report/dashboard.service.ts` | `toSummary`/`toDetail` 带 description、create/update 查重 |
| `pages/Report/AnalysisCardsPage.tsx` | 「设置」弹窗（名称 + 描述）、名称悬停描述 |
| `pages/Report/DashboardListPage.tsx` | 名称悬停描述、卡片数悬停更新时间 |
| `features/query/SaveAsCardModal.tsx` | 另存为表单加描述 |
| `features/report/DashboardSettingsDrawer.tsx`、`pages/Report/DashboardPage.tsx` | 看板设置加描述并提交 |
| `pages/Report/SqlReportPage.tsx` | 卡片设置弹窗加描述 |
| `types/report.types.ts` | 类型补 `description` |

## 6. 非目标

不做描述富文本 / 换行渲染（按纯文本单段处理）；不做描述搜索；不把描述展示到看板卡面；不清理历史同名的存量数据；不给 `text` 卡正文加描述。
