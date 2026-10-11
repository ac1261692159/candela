# 四类分析操作手册

这是任务模板，事件名、属性、日期与数字均须按当前项目确认。完整 DSL 示例由 `clklog_get_analysis_capabilities` 返回，本文不另建字段权威。

## E：示例消耗

请求示例：“最近七个完整自然日，按天统计示例消耗额、次数和人数，填入事件分析。”

1. page_read → capabilities → list_cards(event/sql)，复用前查口径。
2. schema(keyword=currency/campaign)，翻页找目标；schema(event_key=实际消耗事件) 查属性。
3. 明确币种、金额字段/单位、活动归因值，区别余额、免费抽、购买/扣费成功。缺证据先返回具体问题。
4. 将能力示例中的事件、金额和归因值换成真实值，run_event 返回按日结果。
5. 再 read → propose_analysis(page=event) → 提案自动填入草稿（无需人工确认），核对日期、主体、分组、过滤后由用户点击计算。
6. 同条件 SQL 卡对拍。不能把每日人数相加当全期人数。

合成验收：同日 A 两次消耗 10/20，B 一次 5，非活动消耗 99 排除。目标金额 35、次数 3、人数 2；这些数字仅用于测试。

## F：购买→抽卡结果→展示

查三事件与覆盖，确认主体及严格顺序；steps 带各步过滤，window_seconds 明确窗口。表单以整天表达窗口，无法表达的参数应被拒绝。run_funnel 后 read → propose_analysis(page=funnel)，提案自动填入，用户点击计算。

合成验收：四人购买；A 完成三步，B 只购买，C 结果早于购买，D 展示超窗。人数 4→2→1，总转化 25%。独立计数不是严格漏斗。

## R：模块参与 D1/D3/D7

查初始/回访事件与模块属性，两边模块过滤一致；明确 cohort 含义、初始范围、观察期。参考能力示例 run_retention，再 read → propose_analysis(page=retention)，核对起始/回访过滤、周期和主体（提案自动填入）。

合成验收：D0 四人，D1 两人、D3 一人、D7 两人，留存 50%/25%/50%。跨模块回访排除。未成熟窗口或延迟上报单列限制。

## S：SQL 对拍

list_cards(type=sql) → get_card → execute_sql_card 读取已有 SQL 卡。任意 SQL 要到 SQL 页：read → propose_sql（自动写入编辑器）→ 再 read → request_sql_execution（自动执行，结果直接回执）。

按当前字典编写 ClickHouse SQL，日期和项目由受控 API 守卫限定。不能读取环境变量或自行连接数据库。与 E 对齐所有口径后对拍。确认前改 SQL/日期必须拒绝；纯结果更新不应拒绝。

自动推荐只有明细表、用户要看趋势时：page_read 取 `result_columns`，`clklog_propose_sql_chart` 指定 `chart_type=line`（或 trend）、`bindings.x` 为日期列、`metrics` 不超过 5 个，其余列放 `ignored`。写入字段设置不等于已保存卡片。

同一根轴上的指标必须同单位：单位不同就判 MIXED_UNITS，用 `options.metric_axis` 把不同单位的指标拆到另一根轴（`ratio_0_1` 渲染时 ×100，`percent_0_100` 不换算）。

用户问「现在这图绑了什么 / 分了几个轴 / 单位是什么」，或要改绑定与分轴时：page_read 的 `analysis.chart_config` 就是当前编排（图型、`bindings`、`options.metric_axis`、`options.units`），照读即可，不要靠猜。要改分轴就把读到的 `options.metric_axis` 改一处后**整份**提交——`options` 按整键替换、不逐项合并，只提交一个键会把其余指标挤回左轴。SQL 侧提案直接写入，不弹确认框。

## T：事件分析图表

用户说「这条线看不出变化」「指标量级差太多」时：page_read 看 `analysis.chart_config`（当前绑定与分轴）和 `analysis.result_columns`（列 key 与角色）。量级断层明显就用 `clklog_propose_event_chart` 把小的指标拆到右轴（`options.metric_axis`），`reason` 写清「为什么」——它**会显示给用户**，用户点「应用」才生效。

同一根轴上的指标必须同单位，不同单位用 `options.metric_axis` 拆开。

列名是结果列 key（`g_0`/`m_0`）不是列标题；X 轴一律 `bindings.x`（没有 `category`）。提案不生效时不要声称已改好：用户可能忽略了，也可能在 TTL 内没看到。

## 每次记录

在 `files/notes/` 记录目标、时间、已确认口径、工具、查询内容、执行状态、聚合结果、行数/裁剪和限制；交付用 `files/artifacts/`。不记录签名 URL、token 或未脱敏日志。

能力/属性不支持时报告具体缺口。401 停止依赖请求，重连后先读页；冲突重新读页，超时说明未填入；不重复重发有副作用操作。
