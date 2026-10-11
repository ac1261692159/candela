# 实现方案：漏斗步骤插入排序与结果表两行

> phase: clklog-analytics-funnel-edit-table-v1
> 上游：`docs/product/prd-clklog-analytics-funnel-edit-table-v1.md`
> 覆盖：`clklog-analytics-design-result-settings-v1.md` 中「人数列 + 比率列并排」的漏斗表形态；`FunnelEditor` 底部整行添加。

---

## 1. 阶段目标与范围

配置轨步骤编辑与结果表展示。DSL / SQL 形状不变。步骤列 title 去掉「人数」后缀（展示契约，查询引擎仍返回 `step_N` 计数值与既有 `_conversion` / `_churn` 字段，表 UI 不再用后者做列）。

## 2. 验收标准

与 PRD FT-1～FT-6 对应。

- `funnel-editor-steps.ts`：插入、后插、移动；尊重 `MIN_FUNNEL_STEPS` / `MAX_FUNNEL_STEPS`。
- `FunnelEditor`：每步内一行两钮 + 标题区上移/下移/删除；无底部添加。
- `funnel-display.ts`：`buildFunnelTableModel` 产出两行；剥离 title 末尾 ` 人数`。
- `FunnelResult` / `CardWidget`（`type=funnel` 且表）共用该模型。
- `funnel-query.service.ts`：`columns[].title` = 步骤 alias/event，不拼接「人数」。
- 交付前 `python3 scripts/arch_ratchet.py` 通过。

## 3. 非目标

与 PRD §3 相同。不扩大 `utils/`。

## 4. 结构

| 文件 | 职责 |
|------|------|
| `features/query/funnel-editor-steps.ts` | 插入 / 后插 / 移动纯函数 |
| `FunnelEditor` | 步卡片操作入口 |
| `funnel-display.ts` | 两行表模型、去「人数」后缀 |
| `FunnelResult` / `CardWidget` | 渲染两行表 |
| `funnel-query.service.ts` | 步骤列 title 不再追加单位 |

## 5. 表模型

列：可选 `group_col`、固定 `_metric`（行名：数值 / 转化率 / 流失率）、各 `step_N`。

每个查询结果行展开为两行。比率用该行 `step_N` 计数值现场计算（相对上一步），不依赖列头单位。旧结果 `title` 以 ` 人数` 结尾时去掉再当列头。

tooltip 数值不再写死「人数」，改为「数值」。
