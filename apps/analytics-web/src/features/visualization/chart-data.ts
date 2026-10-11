import { PIE_TOP_N } from './chart.constants';
import { createIssue } from './chart-issues';
import { metricAggregation } from './chart-compatibility';
import type {
  ChartConfigV1,
  ChartIssue,
  ColumnProfile,
  NormalizedChartData,
  NormalizedPoint,
} from './chart.types';
import { parseStrictNumber, parseStrictTime } from './column-profiler';
import { t as translate } from '../../i18n';
export { formatChartNumber } from './metric-units';

export function conversionRate(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return current / previous;
}

function metricValue(row: Record<string, unknown>, key: string): number | null | 'unsafe' {
  return parseStrictNumber(row[key]);
}

function copyRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => ({ ...row }));
}

export function selectRows(
  rows: Record<string, unknown>[],
  selector?: ChartConfigV1['bindings']['row_selector'],
): { rows: Record<string, unknown>[]; issues: ChartIssue[] } {
  if (!selector) return { rows, issues: [] };
  const matched = rows.filter((row) => {
    const value = row[selector.column];
    if (selector.value === null) return value === null || value === undefined || value === '';
    return String(value) === String(selector.value);
  });
  if (matched.length === 0) return { rows: [], issues: [createIssue('ROW_SELECTOR_NO_MATCH')] };
  if (matched.length > 1) return { rows: [], issues: [createIssue('ROW_SELECTOR_NOT_UNIQUE')] };
  return { rows: matched, issues: [] };
}

export function normalizeChartData(
  config: ChartConfigV1,
  rows: Record<string, unknown>[],
  _profiles: ColumnProfile[],
): { data: NormalizedChartData; issues: ChartIssue[] } {
  const source = copyRows(rows);
  const selected = config.chart_type === 'number' || config.chart_type === 'funnel'
    ? selectRows(source, config.bindings.row_selector)
    : { rows: source, issues: [] };
  const issues = [...selected.issues];
  const working = selected.rows;
  const points: NormalizedPoint[] = working.map((row, originalIndex) => {
    const values: Record<string, number | null> = {};
    for (const metric of config.bindings.metrics) {
      const parsed = metricValue(row, metric);
      if (parsed === 'unsafe') {
        issues.push(createIssue('UNSAFE_INTEGER', 'error', { columns: [metric] }));
        values[metric] = null;
      } else {
        values[metric] = parsed;
      }
    }
    return {
      x: config.bindings.x ? (row[config.bindings.x] as string | number | null) : undefined,
      category: config.bindings.category != null ? (row[config.bindings.category] == null ? null : String(row[config.bindings.category])) : undefined,
      series: config.bindings.series != null ? (row[config.bindings.series] == null ? null : String(row[config.bindings.series])) : undefined,
      values,
      originalIndex,
    };
  });
  return {
    data: {
      points,
      originalRowCount: rows.length,
      displayedCount: points.length,
      transforms: [],
      selectedRow: working[0],
    },
    issues,
  };
}

function compareNullable(a: number | null, b: number | null, direction: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'desc' ? b - a : a - b;
}

export function applyVisibleTransforms(
  data: NormalizedChartData,
  config: ChartConfigV1,
  profiles: ColumnProfile[],
): NormalizedChartData {
  const points = data.points.map((point) => ({ ...point, values: { ...point.values } }));
  const transforms = [...data.transforms];

  if (config.chart_type === 'line' && config.bindings.x) {
    points.sort((a, b) => {
      const ta = parseStrictTime(a.x) ?? Number.POSITIVE_INFINITY;
      const tb = parseStrictTime(b.x) ?? Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
      return a.originalIndex - b.originalIndex;
    });
    transforms.push('time_asc');
  }

  if (config.chart_type === 'bar' || config.chart_type === 'pie') {
    const sortColumn = config.options.sort?.column ?? config.bindings.metrics[0];
    const direction = config.options.sort?.direction ?? 'desc';
    if (sortColumn) {
      points.sort((a, b) => {
        const byValue = compareNullable(a.values[sortColumn] ?? null, b.values[sortColumn] ?? null, direction);
        return byValue !== 0 ? byValue : a.originalIndex - b.originalIndex;
      });
      transforms.push(`sort:${sortColumn}:${direction}`);
    }
  }

  let displayed = points;
  if ((config.chart_type === 'bar' || config.chart_type === 'pie') && config.options.top_n && points.length > config.options.top_n) {
    if (config.chart_type === 'pie' && config.options.include_other) {
      const metric = config.bindings.metrics[0];
      const profile = profiles.find((item) => item.key === metric);
      const additive = profile ? metricAggregation(profile, config.options) === 'additive' : false;
      const head = points.slice(0, PIE_TOP_N);
      const rest = points.slice(PIE_TOP_N);
      if (additive && metric) {
        let other = 0;
        let otherHasValue = false;
        for (const point of rest) {
          const value = point.values[metric];
          if (value === null) continue;
          other += value;
          otherHasValue = true;
        }
        displayed = [
          ...head,
          {
            category: translate('sql:chart.other'),
            values: { [metric]: otherHasValue ? other : null },
            originalIndex: Number.MAX_SAFE_INTEGER,
          },
        ];
        transforms.push('top5_other');
      } else {
        displayed = head;
        transforms.push(`top_n:${config.options.top_n}`);
      }
    } else {
      displayed = points.slice(0, config.options.top_n);
      transforms.push(`top_n:${config.options.top_n}`);
    }
  }

  return {
    ...data,
    points: displayed,
    displayedCount: displayed.length,
    transforms,
  };
}

export interface PivotTable {
  timeDim: string;
  propDim: string;
  metric: string;
  propValues: string[];
  rows: Record<string, unknown>[];
}

export function buildPivotTable(
  rows: Record<string, unknown>[],
  timeDim: string,
  propDim: string,
  metric: string,
): PivotTable | null {
  const source = copyRows(rows);
  const propValues: string[] = [];
  const rowMap = new Map<string, Record<string, unknown>>();
  for (const row of source) {
    const pv = row[propDim] == null ? translate('sql:chart.emptySeries') : String(row[propDim]);
    if (!propValues.includes(pv)) propValues.push(pv);
    const tv = String(row[timeDim] ?? '');
    if (!rowMap.has(tv)) rowMap.set(tv, { [timeDim]: row[timeDim] });
    const parsed = parseStrictNumber(row[metric]);
    rowMap.get(tv)![pv] = parsed === 'unsafe' ? null : parsed;
  }
  const pivotRows = [...rowMap.values()].sort((a, b) => {
    const ta = parseStrictTime(a[timeDim]) ?? 0;
    const tb = parseStrictTime(b[timeDim]) ?? 0;
    return ta - tb;
  });
  return { timeDim, propDim, metric, propValues, rows: pivotRows };
}
