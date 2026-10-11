import type { ChartAxis, ChartOptions, ChartTypeV1, MetricUnit } from './chart.types';
import { currentLocale, t as i18nT, type TFunction } from '../../i18n';

/** 前后端共用的单位白名单（Grafana 子集，带量级换算）。 */
export const METRIC_UNITS = [
  'number',
  'percent_0_100',
  'ratio_0_1',
  'currency',
  'currency_cny',
  'currency_usd',
  'duration_sec',
  'duration_ms',
  'bytes',
  'bytes_iec',
] as const satisfies readonly MetricUnit[];

/**
 * 单位下拉的展示名（i18n `sql` 命名空间）。
 *
 * 取文案必须由调用方把 `t` 传进来——模块作用域取不到当前语言。
 */
export function metricUnitOptions(t: TFunction): { value: MetricUnit; label: string }[] {
  return [
    { value: 'number', label: t('sql:unit.number') },
    { value: 'percent_0_100', label: t('sql:unit.percent0To100') },
    { value: 'ratio_0_1', label: t('sql:unit.ratio0To1') },
    { value: 'currency_cny', label: t('sql:unit.cny') },
    { value: 'currency_usd', label: t('sql:unit.usd') },
    { value: 'duration_sec', label: t('sql:unit.durationSec') },
    { value: 'duration_ms', label: t('sql:unit.durationMs') },
    { value: 'bytes', label: t('sql:unit.bytesSi') },
    { value: 'bytes_iec', label: t('sql:unit.bytesIec') },
  ];
}


const UNIT_SET = new Set<string>(METRIC_UNITS);

export function isMetricUnit(value: unknown): value is MetricUnit {
  return typeof value === 'string' && UNIT_SET.has(value);
}

export function parseMetricUnit(value: unknown, fallback: MetricUnit = 'number'): MetricUnit {
  return isMetricUnit(value) ? value : fallback;
}

/** 旧卡 `currency` 与人民币同一套换算；下拉里只露出 currency_cny。 */
export function unitSelectValue(unit: MetricUnit | undefined): MetricUnit {
  if (!unit || unit === 'number') return 'number';
  return unit === 'currency' ? 'currency_cny' : unit;
}

export function chartHasYAxis(chartType: ChartTypeV1 | string): boolean {
  return chartType === 'line' || chartType === 'bar' || chartType === 'trend' || chartType === 'number';
}

/* ------------------------------------------------------------------ *
 * 轴内单位一致（phase: clklog-analytics-axis-unit-coherence-v1）
 *
 * 双轴之后「单位必须一致」的主语从整张图变成了**同一根轴**：左轴人民币 + 右轴百分比
 * 是正确用法，不该报错；而同一根轴里混两种单位时，那根轴的刻度只能有一种量纲，
 * 套错就是把计数标成百分号。判定与渲染共用下面这组规则，避免两处漂移。
 * ------------------------------------------------------------------ */

/** 指标 → 轴归属；未点名一律左轴。adapter 与判定都必须走这一份实现。 */
export function axisOfMetric(column: string, options?: ChartOptions): ChartAxis {
  return options?.metric_axis?.[column] ?? 'left';
}

/** 每根轴上的指标与单位（按左、右排列；单位去重保序）。 */
export interface AxisUnitGroup {
  axis: ChartAxis;
  columns: string[];
  units: MetricUnit[];
}

/**
 * 按轴分组。
 *
 * 调用方自己解析单位：判定侧用「显式 units → 列推断单位 → number」，
 * adapter 侧用同一份规则，保证「判定说混了」与「渲染认为混了」永远一致。
 */
export function groupMetricsByAxis(
  entries: { key: string; unit: MetricUnit }[],
  axisOf: (key: string) => ChartAxis = () => 'left',
): AxisUnitGroup[] {
  const build = (axis: ChartAxis): AxisUnitGroup => {
    const picked = entries.filter((entry) => axisOf(entry.key) === axis);
    return {
      axis,
      columns: picked.map((entry) => entry.key),
      units: [...new Set(picked.map((entry) => entry.unit))],
    };
  };
  return [build('left'), build('right')].filter((group) => group.columns.length > 0);
}

/** 混了单位的轴（同一根轴出现两种以上单位）。 */
export function mixedUnitAxes(
  entries: { key: string; unit: MetricUnit }[],
  axisOf?: (key: string) => ChartAxis,
): AxisUnitGroup[] {
  return groupMetricsByAxis(entries, axisOf).filter((group) => group.units.length > 1);
}

/**
 * 「按单位拆轴」：把指标按单位分组落到左右两轴。
 *
 * 只有两组单位时，比较两种朝向，**选需要搬动的指标更少的那一种**——否则会出现
 * 「把百分比挪到右轴，而右轴本来就有一个数值指标」这种越拆越乱的结果。
 * 两组大小相同时按「指标列表里先出现的单位」留左轴（可预期，不随机）。
 *
 * 三组及以上时无法让两根轴都干净：指标最多的一组留左轴，其余进右轴，
 * 由调用方如实保留提示——双轴只有两根，不虚构第三根。
 */
export function splitMetricsByUnit(
  entries: { key: string; unit: MetricUnit }[],
  currentAxis: (key: string) => ChartAxis = () => 'left',
): Record<string, ChartAxis> {
  const byUnit = new Map<MetricUnit, string[]>();
  for (const entry of entries) {
    byUnit.set(entry.unit, [...(byUnit.get(entry.unit) ?? []), entry.key]);
  }
  const groups = [...byUnit.values()];
  if (groups.length <= 1) return {};

  const moves = (assignment: Record<string, ChartAxis>) =>
    Object.entries(assignment).filter(([key, axis]) => currentAxis(key) !== axis).length;
  const build = (left: string[], right: string[]) => {
    const assignment: Record<string, ChartAxis> = {};
    for (const key of left) assignment[key] = 'left';
    for (const key of right) assignment[key] = 'right';
    return assignment;
  };

  if (groups.length === 2) {
    const [first, second] = [...groups].sort((left, right) => right.length - left.length);
    const candidates: [string[], string[]][] = first.length === second.length
      ? [[first, second]]
      : [[first, second], [second, first]];
    return candidates
      .map(([left, right]) => build(left, right))
      .reduce((best, candidate) => (moves(candidate) < moves(best) ? candidate : best));
  }

  const [largest, ...rest] = groups.sort((left, right) => right.length - left.length);
  return build(largest, rest.flat());
}



function intlLocale(): string {
  return usesChineseScale() ? 'zh-CN' : 'en-US';
}

function compact(value: number): string {
  return value.toLocaleString(intlLocale(), { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

function withSign(value: number, body: string): string {
  return value < 0 ? `-${body}` : body;
}

function scaleZh(value: number, prefix = ''): string {
  const abs = Math.abs(value);
  if (abs >= 1e8) return withSign(value, `${prefix}${compact(abs / 1e8)}亿`);
  if (abs >= 1e4) return withSign(value, `${prefix}${compact(abs / 1e4)}万`);
  const digits = abs >= 100 ? 2 : 4;
  const body = `${prefix}${abs.toLocaleString(intlLocale(), { maximumFractionDigits: digits })}`;
  return withSign(value, body);
}

function scaleSi(value: number, prefix: string): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return withSign(value, `${prefix}${compact(abs / 1e9)}B`);
  if (abs >= 1e6) return withSign(value, `${prefix}${compact(abs / 1e6)}M`);
  if (abs >= 1e3) return withSign(value, `${prefix}${compact(abs / 1e3)}K`);
  return withSign(value, `${prefix}${abs.toLocaleString(intlLocale(), { maximumFractionDigits: 2 })}`);
}

/** 当前语言是否用中文量级（万 / 亿）；非中文走 SI（K / M / B） */
function usesChineseScale(): boolean {
  // 判据必须是**语言**而不是某条译文（早期版本用 `unit.minute !== 'min'` 判断，
  // 结果任何语言把「分钟」翻成别的词都会误判成中文量级——俄语首当其冲）。
  return currentLocale().startsWith('zh');
}

function durationFromSeconds(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 60) return withSign(seconds, i18nT('common:unit.second', { value: compact(abs) }));
  if (abs < 3600) return withSign(seconds, `${compact(abs / 60)} ${i18nT('common:unit.minute')}`);
  if (abs < 86400) return withSign(seconds, `${compact(abs / 3600)} ${i18nT('common:unit.hour')}`);
  return withSign(seconds, `${compact(abs / 86400)} ${i18nT('common:unit.day')}`);
}

function scaleBytes(value: number, base: 1000 | 1024, labels: string[]): string {
  const abs = Math.abs(value);
  if (abs < base) return withSign(value, `${Math.round(abs)} ${labels[0]}`);
  let n = abs;
  let index = 0;
  while (n >= base && index < labels.length - 1) {
    n /= base;
    index += 1;
  }
  return withSign(value, `${compact(n)} ${labels[index]}`);
}

export function formatChartNumber(value: number | null | undefined, unit: MetricUnit = 'number'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  switch (unit) {
    case 'percent_0_100':
      return `${value.toLocaleString(intlLocale(), { maximumFractionDigits: 2 })}%`;
    case 'ratio_0_1':
      return `${(value * 100).toLocaleString(intlLocale(), { maximumFractionDigits: 2 })}%`;
    case 'currency':
    case 'currency_cny':
      return usesChineseScale() ? scaleZh(value, '¥') : scaleSi(value, '¥');
    case 'currency_usd':
      return scaleSi(value, '$');
    case 'duration_sec':
      return durationFromSeconds(value);
    case 'duration_ms':
      return Math.abs(value) < 1000
        ? withSign(value, `${compact(Math.abs(value))} ${i18nT('common:unit.ms')}`)
        : durationFromSeconds(value / 1000);
    case 'bytes':
      return scaleBytes(value, 1000, ['B', 'kB', 'MB', 'GB', 'TB', 'PB']);
    case 'bytes_iec':
      return scaleBytes(value, 1024, ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']);
    default:
      return usesChineseScale() ? scaleZh(value) : scaleSi(value, '');
  }
}

/** 预测/拟合系列名的后缀（文案见 `sql:chart.forecastSuffix` / `sql:chart.fitSuffix`），中文与英文两种写法都要能剥掉 */
const FORECAST_SUFFIX = /（预测）$|（拟合）$|\s*\(forecast\)$|\s*\(fit\)$/i;

export function unitForSeriesName(
  seriesName: string,
  units: Record<string, MetricUnit> | undefined,
  fallback: MetricUnit = 'number',
): MetricUnit {
  if (!units) return fallback;
  if (units[seriesName]) return units[seriesName];
  const base = seriesName.replace(FORECAST_SUFFIX, '');
  return units[base] ?? fallback;
}

export function yAxisWithUnit(
  unit: MetricUnit,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'value',
    axisLabel: { formatter: (value: number) => formatChartNumber(value, unit) },
    ...extra,
  };
}

type TooltipDatum = {
  seriesName?: string;
  value?: unknown;
  marker?: string;
  axisValueLabel?: string;
  name?: string;
};

function numericOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (Array.isArray(value) && typeof value[1] === 'number') return value[1];
  return Number(value);
}

export function axisTooltipFormatter(getUnit: (seriesName: string) => MetricUnit) {
  return (params: TooltipDatum | TooltipDatum[]) => {
    const list = Array.isArray(params) ? params : [params];
    const head = String(list[0]?.axisValueLabel ?? list[0]?.name ?? '');
    const lines = list.map((item) => {
      const name = item.seriesName ?? '';
      return `${item.marker ?? ''}${name}  ${formatChartNumber(numericOf(item.value), getUnit(name))}`;
    });
    return [head, ...lines].filter(Boolean).join('<br/>');
  };
}
