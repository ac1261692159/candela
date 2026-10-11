/**
 * 事件图表配置的生命周期（读卡片 → 合成 → 会话内改动）。
 *
 * 归属放在**页面层**而不是结果组件：AI 快照要从页面发布 `analysis.chart_config`
 * （phase: clklog-ai-event-chart-v1），页面必须能拿到当前配置。
 * 单一写入方仍是同一个（从结果组件换成页面），不存在第二个写入者。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { QueryColumn } from '../../types/dsl.types';
import type { ChartConfigV1, ChartIssue, ChartTypeV1, MetricUnit } from '../visualization/chart.types';
import { readEventChartConfig } from './event-chart-config';

export interface EventChartConfigState {
  /** 当前生效的配置：会话内改动优先，其次是卡片已保存配置，最后是按结果自动合成 */
  chartConfig: ChartConfigV1;
  /** 读卡片配置时发现的问题（绑定过期、版本不支持等） */
  issues: ChartIssue[];
  /** true = 用的是卡片已保存配置；false = 本次按结果合成 */
  saved: boolean;
  /** 会话内改动；传 null 回到「按结果自动合成」（界面的「恢复自动」） */
  setOverride: (config: ChartConfigV1 | null) => void;
}

export function useEventChartConfig(args: {
  /** 卡片里的 `dsl.chart_config` 原文；没有卡片时为 null */
  raw: unknown;
  /** 本地化后的结果列；换结果 / 换语言都会变 */
  columns: QueryColumn[];
  /** `_view.event_chart` —— 图表类型以结果区设置为准，其余字段以 chart_config 为准 */
  chartType: ChartTypeV1;
  /** `_view.y_unit`，仅作旧卡的单位兼容 */
  legacyUnit?: MetricUnit;
  /** 变化即丢弃会话内改动（换卡片时用），回到该卡片自己的配置 */
  resetKey?: string | null;
}): EventChartConfigState {
  const { raw, columns, chartType, legacyUnit, resetKey = null } = args;
  const [override, setOverrideState] = useState<ChartConfigV1 | null>(null);

  const read = useMemo(
    () => readEventChartConfig({ raw, columns, chartType, legacyUnit }),
    [raw, columns, chartType, legacyUnit],
  );

  const chartConfig = useMemo<ChartConfigV1>(
    () => ({ ...(override ?? read.config), chart_type: chartType }),
    [override, read.config, chartType],
  );

  const setOverride = useCallback((config: ChartConfigV1 | null) => {
    setOverrideState(config);
  }, []);

  useEffect(() => {
    setOverrideState(null);
  }, [resetKey]);

  return { chartConfig, issues: read.issues, saved: read.saved, setOverride };
}
