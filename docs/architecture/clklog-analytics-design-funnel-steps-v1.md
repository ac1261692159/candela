# 实现方案：漏斗分析步骤上限

> phase: clklog-analytics-funnel-steps-v1
> 上游：`docs/product/prd-clklog-analytics-funnel-steps-v1.md`
> 覆盖：`clklog-analytics-design-m3.md`「漏斗最多 8 步」仅适用于分析漏斗查询，本期改为 32。

---

## 1. 阶段目标与范围

分析漏斗 `FunnelQuery.steps` 长度 2～32。生成器已按 `steps.length` 循环写 `windowFunnel` 条件，不改 SQL 形状。

## 2. 验收标准

与 PRD FS-1～FS-4 对应。

- 常量 `MAX_FUNNEL_STEPS = 32`、`MIN_FUNNEL_STEPS = 2`：后端 `dsl.types.ts` + `DslValidatorService`；前端 `dsl.types.ts` + `FunnelEditor` / `buildFunnelQuery`。
- `dsl-validator.funnel-steps.spec.ts`：32 不抛、33 抛 400。
- 交付前 `python3 scripts/arch_ratchet.py` 通过。

## 3. 非目标

与 PRD §3 相同。`FUNNEL_MAX_STEPS = 8`（`chart.constants.ts` / `chart-config.validator`）仍只约束 SQL 图表漏斗。

## 4. 风险

步数↑ → `event IN (...)` 与 windowFunnel 条件变多，长窗口可能更慢。超时/LIMIT 规则不放宽；超时仍走现有错误提示。
