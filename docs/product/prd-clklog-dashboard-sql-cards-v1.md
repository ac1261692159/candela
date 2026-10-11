# PRD：看板 SQL 卡片 + 目录 API + Harness 静默拉数

> phase: clklog-dashboard-sql-cards-v1
> 版本：v1.0（2026-09-02）｜ 上游：`prd-clklog-analytics-sql-report-v1.md`、`prd-clklog-ai-analytics-v1.md`
> 下游：`docs/architecture/clklog-analytics-design-dashboard-sql-cards-v1.md`
> 本文档是本期**产品层**权威：看板 SQL 卡可见、目录/执行入口、自定义 SQL 保存覆盖、Harness 静默拉数与切卡。

---

## 1. 阶段目标与范围（门禁要素①）

看板详情里 `type=sql` 的卡片能刷新并展示表格（不再黄条空卡）；会话与 API Key 都能列出看板/卡片并对 SQL 卡执行；自定义 SQL 页去掉与卡片库重复的「已保存报表」，从卡片进入时显示名称并以覆盖方式保存；Harness 可静默拉目录与执行 SQL 卡，并在 SQL 页切卡（只加载、不执行）。

本期范围：

- 看板 SQL 卡 refresh、卡片名标题、表格渲染、点进 SQL 页。
- API Key 目录 + SQL 卡 execute（复用现有执行守卫）。
- 自定义 SQL 页保存交互改为「无卡则新建 / 有卡则覆盖」。
- Harness 工具：list/get/execute SQL 卡；Page Bridge `sql_load_card`。
- 用 API 全量测现有 SQL 卡：能修则覆盖写回，不能修的记入审计文档。

## 2. 验收标准（门禁要素②）

- [ ] **PRD-DSC1**：打开含 SQL 卡的看板（如「场景」），卡片标题为卡片名；卡片内出表，不再因「暂不支持刷新」黄条。
- [ ] **PRD-DSC2**：SQL 卡标题可进入 `/report/sql?card=<id>`；该页顶栏显示卡片名；保存覆盖该卡，不另建一张。
- [ ] **PRD-DSC3**：无 `?card=` 时「保存报表」仍新建卡片，文案指向卡片库，不再出现「已保存报表」下拉。
- [ ] **PRD-DSC4**：看板列表文案不再写「仅事件/漏斗」。
- [ ] **PRD-DSC5**：API Key 可 `GET` 看板/卡片目录，并对 `type=sql` 卡 `POST execute`；空 SQL 返回 400，不是 NotFound。
- [ ] **PRD-DSC6**：Harness 可静默 list/get/execute SQL 卡（不经浏览器确认，仍走只读守卫）；`sql_load_card` 只把 SQL 载入编辑器并更新 `?card=`，不执行。
- [ ] **PRD-DSC7**：错误文案区分无 SQL / 查询失败 / 超时；留存卡仍明确不支持看板刷新。
- [ ] **PRD-DSC8**：现有 SQL 卡经 API 全量执行，结果写入项目审计文档；可修的已覆盖，不可修的标明原因。

## 3. 非目标（门禁要素③）

- 事件 / 漏斗 / 留存卡片的「执行内容」本期不做（事件/漏斗 refresh 已有；留存仍保持明确不支持）。
- 不自动写回分析页、不绕过 SQL 守卫、不改社区版表。
- 不扩事件/漏斗 Page Bridge action。
- 不把供应商密钥或 `DATABASE_URL` 写入审计文档；不把 SQL 全文里的业务敏感过滤值写入审计。
