import { ANIMATION_MS } from '../chart.constants';
import type { MetricUnit } from '../chart.types';
import { EXPLORE_COLORS } from '../../explore-charts/explore-chart-option';
import { formatChartNumber } from '../metric-units';
import { t as translate } from '../../../i18n';

/** 列表连接符（中文顿号 / 英文逗号）：随语言的标点不在适配器里写死 */
export function listJoin(items: string[]): string {
  return items.join(translate('sql:chart.listSeparator'));
}

/** 已应用的变换列表：`time_asc、top_n:5`，无变换时按语言给「无 / none」 */
export function transformsText(transforms: string[]): string {
  return transforms.length ? listJoin(transforms) : translate('sql:chart.none');
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function baseChartOption(description: string, trigger: 'axis' | 'item' = 'axis'): Record<string, unknown> {
  const reduced = prefersReducedMotion();
  return {
    aria: { enabled: true, decal: { show: false }, description },
    color: EXPLORE_COLORS,
    animation: !reduced,
    animationDuration: reduced ? 0 : ANIMATION_MS,
    tooltip: {
      trigger,
      valueFormatter: (value: unknown) =>
        formatChartNumber(typeof value === 'number' ? value : Number(value), 'number'),
    },
    grid: { left: 12, right: 16, top: 28, bottom: 48, containLabel: true },
    legend: { bottom: 0, type: 'scroll', selectedMode: true },
  };
}

export function formatByUnit(value: number | null, unit: MetricUnit): string {
  return formatChartNumber(value, unit);
}

/** 预测/拟合仍可用虚线点线；实测系列一律实线纯色。 */
export const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export const LINE_SYMBOLS = ['circle', 'rect', 'triangle', 'diamond', 'emptyCircle'] as const;
