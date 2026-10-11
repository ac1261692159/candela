import { t as i18nT, type TFunction } from '../../i18n';

export type StatCalc = 'last' | 'avg' | 'max' | 'min' | 'first' | 'total';

/** 统计口径标签键（合计复用 common 的通用文案） */
const STAT_CALC_KEYS: Record<StatCalc, string> = {
  last: 'analysis:statCalc.last',
  avg: 'analysis:statCalc.avg',
  max: 'analysis:statCalc.max',
  min: 'analysis:statCalc.min',
  first: 'analysis:statCalc.first',
  total: 'common:label.total',
};

/** 单个统计口径的展示名（`t` 缺省用当前语言） */
export function statCalcLabel(calc: StatCalc, t: TFunction = i18nT): string {
  return t(STAT_CALC_KEYS[calc]);
}

/** 全部统计口径的展示名表（下拉与表头共用） */
export function statCalcLabels(t: TFunction = i18nT): Record<StatCalc, string> {
  return {
    last: statCalcLabel('last', t),
    avg: statCalcLabel('avg', t),
    max: statCalcLabel('max', t),
    min: statCalcLabel('min', t),
    first: statCalcLabel('first', t),
    total: statCalcLabel('total', t),
  };
}

export const ALL_STAT_CALCS: StatCalc[] = ['last', 'avg', 'max', 'min', 'first', 'total'];

const ALLOWED: Record<string, StatCalc[]> = {
  line: ['last', 'avg', 'max', 'min', 'first'],
  trend: ['last', 'avg', 'max', 'min', 'first'],
  nth_trend: ['last', 'avg', 'max', 'min', 'first'],
  daily_trend: ['last', 'avg', 'max', 'min', 'first'],
  bar: ['avg', 'max', 'min', 'last', 'total'],
  stack: ['avg', 'max', 'min', 'last', 'total'],
  cumulative: ['last', 'max', 'min', 'first'],
  distribution: ['avg', 'max', 'min'],
  pie: ['total', 'max'],
  number: ['last', 'avg', 'max', 'min', 'first', 'total'],
};

const DEFAULTS: Record<string, StatCalc[]> = {
  line: ['last', 'avg'],
  trend: ['last', 'avg'],
  nth_trend: ['last', 'avg'],
  daily_trend: ['last', 'avg'],
  bar: ['avg', 'max'],
  stack: ['avg', 'max'],
  cumulative: ['last'],
  distribution: ['avg', 'max'],
  pie: ['total'],
  number: ['last'],
};

export function allowedStatCalcs(kind: string): StatCalc[] {
  return ALLOWED[kind] ?? ALLOWED.line;
}

export function defaultStatCalcs(kind: string): StatCalc[] {
  return DEFAULTS[kind] ?? DEFAULTS.line;
}

export function parseStatCalcs(raw: unknown, kind: string): StatCalc[] {
  const allowed = new Set(allowedStatCalcs(kind));
  if (!Array.isArray(raw)) return defaultStatCalcs(kind);
  const seen = new Set<StatCalc>();
  const next: StatCalc[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !allowed.has(item as StatCalc) || seen.has(item as StatCalc)) continue;
    seen.add(item as StatCalc);
    next.push(item as StatCalc);
    if (next.length >= 6) break;
  }
  return next.length ? next : defaultStatCalcs(kind);
}

export function finiteValues(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

export function reduceSeries(values: Array<number | null | undefined>, calc: StatCalc): number | null {
  const numeric = finiteValues(values);
  if (!numeric.length) return null;
  if (calc === 'total') return numeric.reduce((sum, value) => sum + value, 0);
  if (calc === 'avg') return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
  if (calc === 'max') return Math.max(...numeric);
  if (calc === 'min') return Math.min(...numeric);
  if (calc === 'first') {
    const found = values.find((value) => typeof value === 'number' && Number.isFinite(value));
    return typeof found === 'number' ? found : null;
  }
  const reversed = [...values].reverse();
  const found = reversed.find((value) => typeof value === 'number' && Number.isFinite(value));
  return typeof found === 'number' ? found : null;
}

export interface SeriesPoints {
  name: string;
  values: Array<number | null>;
}

export type SeriesStatRow = { name: string } & Partial<Record<StatCalc, number | null>>;

export function seriesStats(series: SeriesPoints[], calcs: StatCalc[]): SeriesStatRow[] {
  return series.map((item) => {
    const row: SeriesStatRow = { name: item.name };
    for (const calc of calcs) {
      row[calc] = reduceSeries(item.values, calc);
    }
    return row;
  });
}
