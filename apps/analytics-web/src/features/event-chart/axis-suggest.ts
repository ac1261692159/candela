/**
 * 双轴建议（phase: clklog-analytics-event-chart-binding-v1）。
 *
 * 单条 Y 轴上，量级差得多的指标会把小的那几条压成贴基线的直线——
 * 这正是事件分析最常被抱怨的显示问题。这里只**产出建议**：
 * 用户点「应用」才写入 `options.metric_axis`，不给任何配置就不能改变图形。
 */
import type { ChartAxis } from '../visualization/chart.types';
import { AXIS_SPLIT_RATIO } from '../visualization/chart.constants';

export interface AxisSplitCandidate {
  /** 指标列 key，写进 `options.metric_axis` */
  key: string;
  /** 展示名（已本地化），用于建议文案 */
  name: string;
  values: Array<number | null>;
}

export interface AxisSplitSuggestion {
  /** 量级倍数（四舍五入到整数），用于文案「差异 190×」 */
  ratio: number;
  /** 建议写入 `options.metric_axis` 的完整映射 */
  axes: Record<string, ChartAxis>;
  /** 建议移到右轴的指标展示名 */
  names: string[];
  /** 建议移到右轴的指标 key */
  keys: string[];
}

function scaleOf(values: Array<number | null>): number {
  let max = 0;
  for (const value of values) {
    if (value == null) continue;
    max = Math.max(max, Math.abs(value));
  }
  return max;
}

/**
 * 用「相邻比值最大的那道断层」找分界，而不是机械对半分：
 * 指标多于三个时，真正的量级断层未必在中间。
 *
 * 已配置过右轴（`current` 里有 `'right'`）时不再建议——用户已经做过选择。
 */
export function suggestAxisSplit(
  candidates: AxisSplitCandidate[],
  current?: Record<string, ChartAxis>,
): AxisSplitSuggestion | null {
  if (Object.values(current ?? {}).some((axis) => axis === 'right')) return null;

  const scaled = candidates
    .map((item) => ({ ...item, scale: scaleOf(item.values) }))
    .filter((item) => item.scale > 0);
  if (scaled.length < 2) return null;

  const sorted = [...scaled].sort((a, b) => a.scale - b.scale);
  let splitAt = -1;
  let widest = 0;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const gap = sorted[i + 1].scale / sorted[i].scale;
    if (gap > widest) {
      widest = gap;
      splitAt = i;
    }
  }
  if (splitAt < 0 || widest < AXIS_SPLIT_RATIO) return null;

  const lower = sorted.slice(0, splitAt + 1);
  const axes: Record<string, ChartAxis> = {};
  for (const item of scaled) axes[item.key] = 'left';
  for (const item of lower) axes[item.key] = 'right';

  return {
    ratio: Math.round(widest),
    axes,
    names: lower.map((item) => item.name),
    keys: lower.map((item) => item.key),
  };
}
