/**
 * 指标「取值选择」（phase: clklog-analytics-metric-v2）。
 *
 * 把窗口内的日序列归并成一个值。默认（未设置）= 按计算方法推导 = **现状口径**，
 * 因此存量指标不设该字段时值不变；显式选择才改变归并方式。
 *
 * 与事件分析卡片的「阶段总和」是同一层概念（同值域），这里多出 `first_day` / `last_day`：
 * 它们只在指标求值时有意义，分析页按日序列展示，不受影响。
 */
import type { AnalysisMethod, StageReduce } from '../../types/dsl.types';
import { defaultStageReduce } from './metric-normalize';

export const VALUE_PICKS = [
  'sum',
  'avg',
  'max',
  'min',
  'uniq_total',
  'weighted',
  'first_day',
  'last_day',
] as const;

export type ValuePick = (typeof VALUE_PICKS)[number];

export const VALUE_PICK_LABEL: Record<ValuePick, string> = {
  sum: '累计',
  avg: '日均',
  max: '最大值',
  min: '最小值',
  uniq_total: '整段去重合计',
  weighted: '加权平均',
  first_day: '首日',
  last_day: '最新一天',
};

/** 界面上的说明文案：每种取值的口径与边界都写清楚，避免「值不对」的争议 */
export const VALUE_PICK_DESCRIPTION: Record<ValuePick, string> = {
  sum: '窗口内各日值相加；没有数据的日子按 0 计',
  avg: '各日值之和 ÷ 窗口天数；没有数据的日子按 0 计',
  max: '窗口内有数据的日子的最大值（完全无数据 → 本轮跳过）',
  min: '窗口内有数据的日子的最小值（完全无数据 → 本轮跳过）',
  uniq_total: '用整段时间整体求值，不按日相加（去重数/触发用户数唯一正确的取值）',
  weighted: '按分母加权（人均次数/人均值唯一正确的取值），用整段时间整体求值',
  first_day: '窗口内最早一个有数据的日子的值',
  last_day: '窗口内最近一个有数据的日子的值（常用于「今天到目前为止」）',
};

export function isValuePick(value: unknown): value is ValuePick {
  return typeof value === 'string' && (VALUE_PICKS as readonly string[]).includes(value);
}

/** 需要日序列才能算的取值（其余用整段查询结果） */
export function pickNeedsSeries(pick: ValuePick): boolean {
  return pick !== 'uniq_total' && pick !== 'weighted';
}

export interface SeriesPoint {
  date: string;
  /** null = 该日无数据 */
  value: number | null;
}

/** 未设置时的推荐取值（= 现状口径） */
export function resolveValuePick(raw: unknown, analysis: AnalysisMethod): ValuePick {
  if (isValuePick(raw)) return raw;
  return defaultStageReduce(analysis) as ValuePick;
}

/** 分析卡片的「阶段总和」→ 指标取值（应用回分析页时用；first_day/last_day 无对应，落到 sum） */
export function valuePickFromStageReduce(reduce: StageReduce | undefined, analysis: AnalysisMethod): ValuePick {
  if (reduce && isValuePick(reduce)) return reduce;
  return resolveValuePick(undefined, analysis);
}

/** 取值 → 分析卡片的阶段总和（反向映射，首日/最新一天在分析页没有对应，用累计保住「按日可看」） */
export function stageReduceFromValuePick(pick: ValuePick): StageReduce {
  if (pick === 'first_day' || pick === 'last_day') return 'sum';
  return pick;
}

/**
 * 归并日序列。`uniq_total` / `weighted` 不接受日序列（必须用整段查询结果），调用方需自行短路。
 * 返回 null 表示「本轮无值」——与既有约定一致，检测器会跳过本轮而不是当成 0。
 */
export function pickSeriesValue(pick: ValuePick, series: SeriesPoint[], windowDays: number): number | null {
  const values = series.map((point) => point.value).filter((value): value is number => value !== null);
  switch (pick) {
    case 'sum':
      return values.reduce((sum, value) => sum + value, 0);
    case 'avg':
      return windowDays > 0 ? values.reduce((sum, value) => sum + value, 0) / windowDays : null;
    case 'max':
      return values.length > 0 ? Math.max(...values) : null;
    case 'min':
      return values.length > 0 ? Math.min(...values) : null;
    case 'first_day':
      return values.length > 0 ? values[0] : null;
    case 'last_day':
      return values.length > 0 ? values[values.length - 1] : null;
    default:
      throw new Error(`取值 ${pick} 需要整段查询结果，不能按日序列归并`);
  }
}

/** 指标值 → 展示文案（告警模板、试算面板共用；从 alerting 侧移入以打通两个入口） */
export function formatMetricValue(value: number, unit: string, format?: string): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  const text = rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (format === 'percent') return `${text}%`;
  return unit ? `${text}${unit}` : text;
}
