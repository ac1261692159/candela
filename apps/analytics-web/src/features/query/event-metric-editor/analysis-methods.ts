import type { AnalysisMethod, StageReduce } from '../../../types/dsl.types';
import { t as i18nT, type TFunction } from '../../../i18n';

/** 计算方法展示名的 i18n 键 */
const ANALYSIS_LABEL_KEYS: Record<AnalysisMethod, string> = {
  total_times: 'analysis:analysisMethod.totalTimes',
  trig_user_num: 'analysis:analysisMethod.trigUserNum',
  per_capita_times: 'analysis:analysisMethod.perCapitaTimes',
  sum: 'analysis:analysisMethod.sum',
  avg: 'analysis:analysisMethod.avg',
  per_capita_num: 'analysis:analysisMethod.perCapitaNum',
  max: 'analysis:analysisMethod.max',
  min: 'analysis:analysisMethod.min',
  distinct: 'analysis:analysisMethod.distinct',
  true_num: 'analysis:analysisMethod.trueNum',
  false_num: 'analysis:analysisMethod.falseNum',
  is_empty: 'analysis:analysisMethod.isEmpty',
  is_not_empty: 'analysis:analysisMethod.isNotEmpty',
  array_distinct: 'analysis:analysisMethod.arrayDistinct',
  array_item_distinct: 'analysis:analysisMethod.arrayItemDistinct',
  percentile: 'analysis:analysisMethod.percentile',
  variance: 'analysis:analysisMethod.variance',
  stddev: 'analysis:analysisMethod.stddev',
};


/** 全部计算方法展示名（`t` 缺省用当前语言） */
export function analysisMethodLabels(t: TFunction = i18nT): Record<AnalysisMethod, string> {
  return Object.fromEntries(
    (Object.keys(ANALYSIS_LABEL_KEYS) as AnalysisMethod[]).map((method) => [method, t(ANALYSIS_LABEL_KEYS[method])]),
  ) as Record<AnalysisMethod, string>;
}

const NO_PROP: AnalysisMethod[] = ['total_times', 'trig_user_num', 'per_capita_times'];
const NUMBER_METHODS: AnalysisMethod[] = [
  'sum',
  'avg',
  'per_capita_num',
  'max',
  'min',
  'distinct',
  'percentile',
  'variance',
  'stddev',
];
const BOOL_METHODS: AnalysisMethod[] = [
  'true_num',
  'false_num',
  'distinct',
  'is_empty',
  'is_not_empty',
];
const LIST_METHODS: AnalysisMethod[] = [
  'array_distinct',
  'array_item_distinct',
  'distinct',
  'is_empty',
  'is_not_empty',
];
const GENERIC: AnalysisMethod[] = ['distinct', 'is_empty', 'is_not_empty'];

export function methodsForDataType(dataType?: string): AnalysisMethod[] {
  if (!dataType) return NO_PROP;
  if (dataType === 'number') return NUMBER_METHODS;
  // 声明为 string 的数字（充值金额等）也可选数值聚合；默认仍给去重，避免把渠道名当成金额求和。
  if (dataType === 'string') {
    return ['distinct', ...NUMBER_METHODS.filter((method) => method !== 'distinct'), 'is_empty', 'is_not_empty'];
  }
  if (dataType === 'boolean') return BOOL_METHODS;
  if (dataType === 'list') return LIST_METHODS;
  return GENERIC;
}

export function analysisLabel(analysis: AnalysisMethod, percentile?: number, t: TFunction = i18nT): string {
  if (analysis === 'percentile') {
    if (percentile === 25) return 'P25';
    if (percentile === 50) return t('analysis:analysisMethod.median');
    if (percentile === 75) return 'P75';
    if (percentile === 90) return 'P90';
    if (percentile === 99) return 'P99';
    return percentile != null ? `P${percentile}` : t('analysis:analysisMethod.percentile');
  }
  return t(ANALYSIS_LABEL_KEYS[analysis]);
}

export function defaultStageReduce(analysis: AnalysisMethod): StageReduce {
  if (
    analysis === 'trig_user_num' ||
    analysis === 'distinct' ||
    analysis === 'array_distinct' ||
    analysis === 'array_item_distinct'
  ) {
    return 'uniq_total';
  }
  if (analysis === 'per_capita_times' || analysis === 'per_capita_num' || analysis === 'avg') {
    return 'weighted';
  }
  if (analysis === 'max') return 'max';
  if (analysis === 'min') return 'min';
  if (analysis === 'percentile' || analysis === 'variance' || analysis === 'stddev') return 'avg';
  return 'sum';
}

export function isDurationProp(prop?: string): boolean {
  if (!prop) return false;
  return prop.replace(/^\$/, '') === 'event_duration';
}

export function displayNameForProp(key: string, display?: string, t: TFunction = i18nT): string {
  if (display) return display;
  if (isDurationProp(key)) return t('analysis:metric.durationName');
  return key;
}

/** 阶段归并选项（`t` 缺省用当前语言） */
export function stageReduceOptions(t: TFunction = i18nT): { label: string; value: StageReduce }[] {
  return [
    { label: t('analysis:stageReduce.sum'), value: 'sum' },
    { label: t('analysis:stageReduce.avg'), value: 'avg' },
    { label: t('analysis:stageReduce.weighted'), value: 'weighted' },
    { label: t('analysis:stageReduce.max'), value: 'max' },
    { label: t('analysis:stageReduce.min'), value: 'min' },
    { label: t('analysis:stageReduce.uniqTotal'), value: 'uniq_total' },
  ];
}

/**
 * 兼容层（勿删）：`features/metrics/`（P2-C 批次）直接读取本常量；
 * 本域内部用 `percentilePresets(t)`。对方迁移后一并删除。
 */

/** 分位数预置（`t` 缺省用当前语言） */
export function percentilePresets(t: TFunction = i18nT): { label: string; value: number }[] {
  return [
    { label: 'P25', value: 25 },
    { label: t('analysis:analysisMethod.median'), value: 50 },
    { label: 'P75', value: 75 },
    { label: 'P90', value: 90 },
    { label: 'P99', value: 99 },
    { label: t('analysis:percentile.custom'), value: 0 },
  ];
}

/**
 * 兼容层（勿删）：`features/metrics/`（P2-C 批次）专用（取值选择属指标定义域）；
 * 待该批次把这些文案迁到 `analysis` 之外/之内的键后一并处理。
 *
 * 取值选择（clklog-analytics-metric-v2）：把窗口内的日序列归并成一个值。
 * 值域与「阶段总和」相同，另加 首日 / 最新一天（只在指标求值时有意义）。
 * 未设置 = 按计算方法推荐（= 存量告警口径），所以新增指标不必配置也能用。
 */


/** 需要日序列的取值（其余用整段查询；与后端 pickNeedsSeries 同口径） */
/** 取值选择选项与提示（i18n：文案在 `metrics:valuePick.*`；本函数按当前语言渲染） */
const VALUE_PICK_VALUES: (StageReduce | 'first_day' | 'last_day')[] = [
  'sum',
  'avg',
  'max',
  'min',
  'last_day',
  'first_day',
  'uniq_total',
  'weighted',
];

export function valuePickOptions(
  t: TFunction = i18nT,
): { label: string; value: StageReduce | 'first_day' | 'last_day'; hint: string }[] {
  return VALUE_PICK_VALUES.map((value) => ({
    value,
    label: t(`metrics:valuePick.label.${value}`),
    hint: t(`metrics:valuePick.hint.${value}`),
  }));
}

export function valuePickHint(
  pick: string | undefined | null,
  t: TFunction = i18nT,
): string | null {
  if (!pick || !VALUE_PICK_VALUES.includes(pick as StageReduce)) return null;
  return t(`metrics:valuePick.hint.${pick}`);
}

export function valuePickNeedsSeries(pick?: string | null): boolean {
  return Boolean(pick) && pick !== 'uniq_total' && pick !== 'weighted';
}

/** 不可加方法（去重/人均）对「按日相加」类取值的提示（兼容层：仅 features/metrics 调用） */
export function valuePickWarning(
  analysis: string | undefined,
  pick: string | undefined,
  t: TFunction = i18nT,
): string | null {
  if (!pick) return null;
  const nonAdditive = ['trig_user_num', 'distinct', 'array_distinct', 'array_item_distinct', 'per_capita_times', 'per_capita_num', 'avg'];
  const additive = ['sum', 'avg', 'max', 'min', 'first_day', 'last_day'];
  const needsOverall = ['uniq_total', 'weighted'];
  if (nonAdditive.includes(String(analysis)) && additive.includes(pick)) {
    return t('metrics:valuePick.warning.nonAdditivePickedAdditive');
  }
  if (!nonAdditive.includes(String(analysis)) && needsOverall.includes(pick)) {
    return t('metrics:valuePick.warning.additivePickedOverall');
  }
  return null;
}
