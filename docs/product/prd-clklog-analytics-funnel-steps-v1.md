# PRD：漏斗分析步骤上限

> phase: clklog-analytics-funnel-steps-v1
> 上游：`prd-clklog-analytics-v1.md` F1（一期 2~8）、`prd-clklog-analytics-v1-m3.md` M3-F1
> 下游：`docs/architecture/clklog-analytics-design-funnel-steps-v1.md`

---

## 1. 阶段目标与范围

漏斗分析（事件漏斗页 / 漏斗卡片刷新）步骤上限从 8 提到 **32**。`windowFunnel` 按条件个数展开，没有 8 步硬限制；8 是一期产品封顶，不够长路径（新手引导、支付链路）。

不上 64：左栏步骤卡、结果表列数、扫描条件都会变重；32 先覆盖当前缺口。自定义 SQL 漏斗图仍是 3～8 列，不在本期。

## 2. 验收标准

- [ ] FS-1：分析页可添加至 32 步；第 33 次添加不可用或提示已达上限。至少 2 步不变。
- [ ] FS-2：`POST` 漏斗查询 32 步通过校验；33 步返回 400，文案含 `2~32`。
- [ ] FS-3：SQL 图表漏斗绑定仍为 3～8 步，行为不变。
- [ ] FS-4：单测：校验器接受 32、拒绝 33。

## 3. 非目标

- 不改 windowFunnel 语义、窗口期、分组上限。
- 不把神策 64 步一次做到位。
- 不改自定义 SQL / 图表漏斗列数上限。
