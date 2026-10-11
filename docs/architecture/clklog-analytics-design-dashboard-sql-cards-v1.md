# 实现方案：看板 SQL 卡片 + 目录 API + Harness 静默拉数

> phase: clklog-dashboard-sql-cards-v1
> 版本：v1.0（2026-09-02）｜ 上游：`docs/product/prd-clklog-dashboard-sql-cards-v1.md`
> 相关契约：`clklog-analytics-design-sql-report.md`（SQL 守卫）、`clklog-ai-analytics-design.md` §14（Harness 工具）
> 本文档是本期**实现与 API 契约**权威。产品交互见 PRD。

---

## 1. 阶段目标与范围（门禁要素①）

接通看板 SQL 卡 refresh（调用已有 `SqlReportService.execute`），补齐 API Key 目录与 execute，修正 SQL 页保存为覆盖，并为 Harness 增加静默目录/执行与 `sql_load_card`。不新开帽子。

## 2. 验收标准（门禁要素②）

- [ ] **DSC-1**：`CardService.refresh` 对 `type=sql` 解析 `dsl.sql_text`（兼容 `dsl.sql`），调用 `SqlReportService.execute`；空 SQL → 400；`retention` / 未知 type 明确 400，不再冒充 NotFound。
- [ ] **DSC-2**：refresh / catalog execute 返回 SQL 执行形状：`columns` / `rows` / `row_count` / `truncated`（外加既有 `query_id` 等）。时间范围优先 `dsl.time_range`，否则近 7 天。
- [ ] **DSC-3**：看板卡片标题用 `card.name`；`type=sql` 用表格渲染，不走事件分析 `ChartRenderer`。
- [ ] **DSC-4**：会话接口保留。新增 API Key 目录（`X-API-Key` / Bearer，与 `/sa/api/ai/query` 同一套）：
  - `GET /sa/api/catalog/dashboards`
  - `GET /sa/api/catalog/dashboards/:dbId`（卡片元数据，不含未执行结果）
  - `GET /sa/api/catalog/cards?type=sql`
  - `GET /sa/api/catalog/cards/:cardId`
  - `POST /sa/api/catalog/cards/:cardId/execute`（仅 sql；可选 `time_range`/`limit`）
- [ ] **DSC-5**：会话侧 `POST /sa/api/report/cards/:cardId/execute` 供 Harness internalApi 复用同一 `execute`（用户 token + 项目绑定）。
- [ ] **DSC-6**：`SqlReportService` 支持按 id 覆盖更新 dsl（`sql_text` / `mode` / `time_range`）；前端去掉「已保存报表」。
- [ ] **DSC-7**：Harness 工具 `clklog_list_dashboards` / `clklog_list_cards` / `clklog_get_card` / `clklog_execute_sql_card` / `clklog_load_sql_card`；Page Bridge action `sql_load_card`。
- [ ] **DSC-8**：`card.service.spec.ts` 覆盖 sql refresh 调用 execute、空 SQL、未知 type。交付前 `python3 scripts/arch_ratchet.py` 通过。

## 3. 非目标（门禁要素③）

- 不实现留存 refresh；不削弱 SQL AST 守卫（禁止库表、只读账号保持原状）。`max_bytes_to_read` 从 5GB 调到 50GB：5GB 无法覆盖高频事件 7 天 `properties` 列（约 45GB）。超时 2026-09-09 起随全局 `query.maxExecutionTime`=300s（原 30s，用户决策放宽）。
- 不复制查询逻辑到 catalog / gateway；不扩大 `common/` / `utils/` 杂项包。
- 不把事件/漏斗写回混进 Page Bridge。
- 审计文档不写密钥、不写 SQL 中的业务敏感过滤值。

---

## 4. refresh 与 execute

`CardService.refresh`：

| type | 行为 |
|------|------|
| event / funnel | 保持现有 QueryService |
| sql | `runSqlCard` → `SqlReportService.execute` |
| retention | `BadRequestException('retention 卡片暂不支持在此刷新')` |
| 其他 | `BadRequestException('未知卡片类型')` |

SQL 文本：`dsl.sql_text ?? dsl.sql`。缺省时间范围近 7 天。守卫、`project_name`、LIMIT、只读账号全部走现有 execute。

看板 refresh 仍校验看板归属；目录 / 会话 execute 只校验卡片项目 + RBAC，不要求卡片已挂到某块看板。

## 5. API Key 目录

API Key 当前无 `user_id`，只绑定 `project_name`。目录接口按 **key 绑定项目**列出该项目全部看板/卡片（合成 `role=admin` 的目录身份，仅用于 ownerFilter 豁免），不跨项目。执行仍强制 key 的 `project_name`，忽略请求头里的项目值。

会话接口继续按登录用户 RBAC。

## 6. Page Bridge `sql_load_card`

- 只允许当前绑定页为 `sql`。
- 事件携带 `sql`、`card_id`、`card_name`、`expected_revision`。
- 前端自动写入编辑器、更新 `?card=`、toast 卡片名、ACK `applied`；**不执行**。
- 批量调试用 `clklog_execute_sql_card` 静默 execute，切卡给人对着看。

## 7. 审计

结果写入 `docs/project/sql-card-audit-clklog-dashboard-sql-cards-v1.md`：card_id、名称、所属看板、错误分类。能修的覆盖写回卡片；禁止表、函数不存在仍不改 AST 黑名单。超时/字节：墙钟 300s（2026-09-09 起）、2GB 内存不放宽；字节上限见 SQL 报告架构 §11.3。
