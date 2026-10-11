import type { FunnelResult } from '../../types/dsl.types';
import { t as i18nT, type TFunction } from '../../i18n';
import { localizedColumnTitle } from './column-titles';

export type FunnelRateMode = 'conversion' | 'churn';
export type FunnelLayout = 'horizontal' | 'vertical';

export interface FunnelColorLevel {
  gte: number;
  lt: number;
  color: string;
}

export interface FunnelColorConfig {
  default: string;
  levels: FunnelColorLevel[];
}

export interface FunnelViewState {
  rate: FunnelRateMode;
  layout?: FunnelLayout;
  color: FunnelColorConfig;
  tableColChars: number;
}

export const DEFAULT_FUNNEL_COLOR: FunnelColorConfig = {
  default: '#1677ff',
  levels: [
    { gte: 80, lt: 90, color: '#faad14' },
    { gte: 50, lt: 80, color: '#ff4d4f' },
    { gte: 0, lt: 50, color: '#531dab' },
  ],
};

export function parseFunnelRateMode(raw: unknown): FunnelRateMode {
  return raw === 'churn' ? 'churn' : 'conversion';
}

export function parseFunnelLayout(raw: unknown): FunnelLayout | undefined {
  return raw === 'horizontal' || raw === 'vertical' ? raw : undefined;
}

export function parseHexColor(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(raw.trim());
  return m ? `#${m[1].toLowerCase()}` : fallback;
}

function parseLevel(raw: unknown, fallback: FunnelColorLevel): FunnelColorLevel {
  if (!raw || typeof raw !== 'object') return fallback;
  const row = raw as { gte?: unknown; lt?: unknown; color?: unknown };
  const gte = Number(row.gte);
  const lt = Number(row.lt);
  if (!Number.isFinite(gte) || !Number.isFinite(lt) || gte >= lt) return fallback;
  return {
    gte: Math.min(100, Math.max(0, gte)),
    lt: Math.min(100, Math.max(0, lt)),
    color: parseHexColor(row.color, fallback.color),
  };
}

export function parseFunnelColorConfig(raw: unknown): FunnelColorConfig {
  const fallback = DEFAULT_FUNNEL_COLOR;
  if (!raw || typeof raw !== 'object') return { ...fallback, levels: fallback.levels.map((l) => ({ ...l })) };
  const row = raw as { default?: unknown; levels?: unknown };
  const rawLevels = Array.isArray(row.levels) ? row.levels : null;
  const levels = rawLevels
    ? fallback.levels.map((base, i) => parseLevel(rawLevels[i], base))
    : fallback.levels.map((l) => ({ ...l }));
  return {
    default: parseHexColor(row.default, fallback.default),
    levels,
  };
}

function viewFromUnknown(dsl: unknown): {
  funnel_rate?: unknown;
  funnel_layout?: unknown;
  funnel_color?: unknown;
  funnel_table_col_chars?: unknown;
} {
  if (!dsl || typeof dsl !== 'object') return {};
  const view = (dsl as { _view?: Record<string, unknown> })._view;
  return view && typeof view === 'object' ? view : {};
}

export function funnelRateFromDsl(dsl: unknown): FunnelRateMode {
  return parseFunnelRateMode(viewFromUnknown(dsl).funnel_rate);
}

export function funnelLayoutFromDsl(dsl: unknown): FunnelLayout | undefined {
  return parseFunnelLayout(viewFromUnknown(dsl).funnel_layout);
}

export const MIN_FUNNEL_TABLE_COL_CHARS = 6;
export const MAX_FUNNEL_TABLE_COL_CHARS = 32;
export const DEFAULT_FUNNEL_TABLE_COL_CHARS = 6;
const FUNNEL_TABLE_CHAR_PX = 14;
const FUNNEL_TABLE_CELL_PAD_PX = 24;

export function parseFunnelTableColChars(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_FUNNEL_TABLE_COL_CHARS;
  return Math.min(MAX_FUNNEL_TABLE_COL_CHARS, Math.max(MIN_FUNNEL_TABLE_COL_CHARS, Math.round(n)));
}

export function funnelTableColCharsFromDsl(dsl: unknown): number {
  return parseFunnelTableColChars(viewFromUnknown(dsl).funnel_table_col_chars);
}

export function funnelTableColWidthPx(title: string, setting: number): number {
  const chars = Math.max(parseFunnelTableColChars(setting), [...title].length);
  return chars * FUNNEL_TABLE_CHAR_PX + FUNNEL_TABLE_CELL_PAD_PX;
}

export function funnelTableCellStyle(title: string, setting: number) {
  const width = funnelTableColWidthPx(title, setting);
  return { minWidth: width, width, whiteSpace: 'nowrap' as const };
}

export function funnelColorFromDsl(dsl: unknown): FunnelColorConfig {
  return parseFunnelColorConfig(viewFromUnknown(dsl).funnel_color);
}

export function funnelViewFromDsl(dsl: unknown): FunnelViewState {
  return {
    rate: funnelRateFromDsl(dsl),
    layout: funnelLayoutFromDsl(dsl),
    color: funnelColorFromDsl(dsl),
    tableColChars: funnelTableColCharsFromDsl(dsl),
  };
}

export function funnelViewPayload(
  rate: FunnelRateMode,
  layout: FunnelLayout,
  color: FunnelColorConfig,
  tableColChars: number,
): Record<string, unknown> {
  return {
    funnel_rate: rate,
    funnel_layout: layout,
    funnel_table_col_chars: parseFunnelTableColChars(tableColChars),
    funnel_color: {
      default: color.default,
      levels: color.levels.map((l) => ({ gte: l.gte, lt: l.lt, color: l.color })),
    },
  };
}

export function defaultFunnelLayout(stepCount: number): FunnelLayout {
  return stepCount >= 10 ? 'vertical' : 'horizontal';
}

export function resolveFunnelLayout(saved: FunnelLayout | undefined, stepCount: number): FunnelLayout {
  return saved ?? defaultFunnelLayout(stepCount);
}

export function funnelSeriesFromResult(result: FunnelResult | null) {
  if (!result?.steps?.length || !result.rows.length) return [];
  const row = result.rows[0];
  return result.steps.map((step, index) => ({
    name: step.title,
    value: Number(row[step.key] ?? 0),
    stepNo: index + 1,
  }));
}

export function rebaseFunnelSeries<T>(series: T[], baseIndex: number): T[] {
  if (!series.length) return [];
  const start = Math.min(Math.max(0, baseIndex), series.length - 1);
  return series.slice(start);
}

export function nextFunnelBaseIndex(currentBase: number, clickedVisibleIndex: number): number {
  if (clickedVisibleIndex <= 0) return currentBase;
  return currentBase + clickedVisibleIndex;
}

export const FUNNEL_TABLE_METRIC_KEY = '_metric';

export function stripFunnelCountSuffix(title: string): string {
  return title.replace(/\s*人数$/, '');
}

export function isFunnelStepCountKey(key: string): boolean {
  return /^step_\d+$/.test(key);
}

export function buildFunnelTableModel(
  result: Pick<FunnelResult, 'columns' | 'rows'>,
  mode: FunnelRateMode,
  t: TFunction = i18nT,
): { columns: { key: string; title: string }[]; rows: Record<string, unknown>[] } {
  const sourceColumns = result.columns ?? [];
  const sourceRows = result.rows ?? [];
  // 「结果 → 视图」边界：列名按查看者语言映射一次（服务端固定文案列名带 title_key）
  const groupCol = sourceColumns.find((col) => col.key === 'group_col');
  const stepCols = sourceColumns
    .filter((col) => isFunnelStepCountKey(col.key))
    .map((col) => ({ key: col.key, title: stripFunnelCountSuffix(localizedColumnTitle(col, t)) }));
  const metricLabel = mode === 'conversion' ? t('analysis:funnel.conversion') : t('analysis:funnel.churn');
  const columns = [
    ...(groupCol ? [{ ...groupCol, title: localizedColumnTitle(groupCol, t) }] : []),
    { key: FUNNEL_TABLE_METRIC_KEY, title: '' },
    ...stepCols,
  ];
  const rows: Record<string, unknown>[] = [];
  sourceRows.forEach((row, rowIndex) => {
    const counts = stepCols.map((col) => Number(row[col.key] ?? 0));
    const valueRow: Record<string, unknown> = {
      _rowKey: `${rowIndex}-value`,
      [FUNNEL_TABLE_METRIC_KEY]: t('analysis:funnel.valueRow'),
    };
    const rateRow: Record<string, unknown> = {
      _rowKey: `${rowIndex}-rate`,
      [FUNNEL_TABLE_METRIC_KEY]: metricLabel,
    };
    if (groupCol) {
      valueRow.group_col = row.group_col;
      rateRow.group_col = row.group_col;
    }
    stepCols.forEach((col, index) => {
      const current = counts[index];
      valueRow[col.key] = Number.isFinite(current) ? current : (row[col.key] ?? '');
      if (index === 0) {
        rateRow[col.key] = formatRatePercent(mode === 'conversion' ? 1 : 0);
        return;
      }
      rateRow[col.key] = stepRateVsPrevious(current, counts[index - 1], mode);
    });
    rows.push(valueRow, rateRow);
  });
  return { columns, rows };
}

export function formatFunnelCell(value: unknown): string {
  return value == null ? '' : String(value);
}

export function formatRatePercent(rate01: number): string {
  if (!Number.isFinite(rate01)) return '--';
  return `${(rate01 * 100).toFixed(1)}%`;
}

export function stepRateVsPrevious(
  current: number,
  previous: number,
  mode: FunnelRateMode,
): string {
  if (!(previous > 0)) return '--';
  const conversion = current / previous;
  return formatRatePercent(mode === 'conversion' ? conversion : 1 - conversion);
}

export function stepRateVsFirst(current: number, first: number, mode: FunnelRateMode): string {
  if (!(first > 0)) return '--';
  const conversion = current / first;
  return formatRatePercent(mode === 'conversion' ? conversion : 1 - conversion);
}

export function stepToStepConversionPct(current: number, previous: number): number | null {
  if (!(previous > 0) || !Number.isFinite(current)) return null;
  return (current / previous) * 100;
}

export function colorForConversionPct(pct: number | null, color: FunnelColorConfig): string {
  if (pct == null || !Number.isFinite(pct)) return color.default;
  const sorted = [...color.levels].sort((a, b) => b.gte - a.gte);
  for (const level of sorted) {
    if (pct >= level.gte && pct < level.lt) return level.color;
  }
  return color.default;
}

export function colorForStep(
  index: number,
  series: { value: number }[],
  color: FunnelColorConfig,
): string {
  if (index <= 0) return color.default;
  const prev = series[index - 1]?.value ?? 0;
  return colorForConversionPct(stepToStepConversionPct(series[index]?.value ?? 0, prev), color);
}

export function churnBandLabel(level: FunnelColorLevel): string {
  const lo = 100 - (level.lt - 1);
  const hi = 100 - level.gte;
  if (level.gte <= 0) return `>${100 - level.lt}%`;
  return `${lo}% ~ ${hi}%`;
}

export function funnelChartPixelHeight(
  layout: FunnelLayout,
  stepCount: number,
  frameHeight?: number,
): number {
  if (layout === 'vertical') return Math.max(120, frameHeight ?? 360);
  const bySteps = Math.max(1, stepCount) * 36 + 24;
  if (frameHeight != null) return Math.max(frameHeight, bySteps);
  return Math.max(360, bySteps);
}

export const FUNNEL_LABEL_MIN_GAP_PX = 4;
const AXIS_LABEL_FONT = '12px sans-serif';

let axisMeasureCtx: CanvasRenderingContext2D | null | undefined;

export function measureFunnelAxisText(text: string): number {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (typeof document !== 'undefined' && !/jsdom/i.test(ua)) {
    try {
      if (axisMeasureCtx === undefined) {
        axisMeasureCtx = document.createElement('canvas').getContext('2d');
      }
      if (axisMeasureCtx) {
        axisMeasureCtx.font = AXIS_LABEL_FONT;
        const width = axisMeasureCtx.measureText(text).width;
        if (width > 0) return width;
      }
    } catch {
      axisMeasureCtx = null;
    }
  }
  let width = 0;
  for (const ch of text) {
    width += /[\u4e00-\u9fff]/.test(ch) ? 12 : 7;
  }
  return width;
}

export function buildHorizontalFunnelAxis(
  series: { name: string; value: number; stepNo?: number }[],
  mode: FunnelRateMode,
  first: number,
  measure: (text: string) => number = measureFunnelAxisText,
) {
  const rows = series.map((item, index) => ({
    name: `${item.stepNo ?? index + 1} ${item.name}`,
    pct: stepRateVsFirst(item.value, first, mode),
  }));
  const longest = rows.reduce(
    (max, row) => Math.max(max, measure(row.name) + FUNNEL_LABEL_MIN_GAP_PX + measure(row.pct)),
    0,
  );
  const rich: Record<string, { width: number; align?: 'left' | 'right'; overflow?: 'truncate' }> = {};
  const labels = rows.map((row, index) => {
    const gap = Math.max(FUNNEL_LABEL_MIN_GAP_PX, longest - measure(row.name) - measure(row.pct));
    rich[`n${index}`] = { width: Math.ceil(measure(row.name)), align: 'left', overflow: 'truncate' };
    rich[`g${index}`] = { width: Math.ceil(gap) };
    rich[`p${index}`] = { width: Math.ceil(measure(row.pct)), align: 'right' };
    return `{n${index}|${row.name}}{g${index}|}{p${index}|${row.pct}}`;
  });
  return { labels, rich, width: Math.ceil(longest) };
}

function coloredBars(
  series: { name: string; value: number }[],
  color: FunnelColorConfig,
) {
  return series.map((item, index) => ({
    value: item.value,
    name: item.name,
    itemStyle: { color: colorForStep(index, series, color) },
  }));
}

function tooltipFormatter(
  series: { name: string; value: number }[],
  mode: FunnelRateMode,
  t: TFunction,
) {
  return (params: { dataIndex: number }) => {
    const index = params.dataIndex;
    const item = series[index];
    if (!item) return '';
    const prev = index === 0 ? item.value : series[index - 1]?.value ?? 0;
    const label = mode === 'conversion' ? t('analysis:funnel.conversion') : t('analysis:funnel.churn');
    return `${item.name}<br/>${t('analysis:funnel.tooltipValue', { value: item.value })}<br/>${label} ${stepRateVsPrevious(item.value, prev, mode)}`;
  };
}

export interface FunnelChartOption {
  tooltip: { trigger: 'item'; formatter: (params: { dataIndex: number }) => string };
  grid?: Record<string, unknown>;
  xAxis?: {
    type: 'value' | 'category';
    min?: number;
    max?: number;
    data?: string[];
    axisLabel?: Record<string, unknown>;
  };
  yAxis?: {
    type: 'value' | 'category';
    min?: number;
    inverse?: boolean;
    data?: string[];
    axisLabel?: Record<string, unknown>;
  };
  series: Array<{
    type: 'bar' | 'funnel';
    stack?: string;
    silent?: boolean;
    tooltip?: { show: boolean };
    itemStyle?: { color?: string };
    left?: number | string;
    right?: number | string;
    top?: number;
    bottom?: number;
    min?: number;
    max?: number;
    minSize?: string;
    maxSize?: string;
    sort?: 'none' | 'ascending' | 'descending';
    gap?: number;
    funnelAlign?: 'left' | 'center' | 'right';
    labelLine?: { show: boolean };
    data: Array<number | { value: number; name: string; itemStyle: { color: string } }>;
    barMaxWidth?: number;
    cursor?: string;
    label: {
      show: boolean;
      position?: 'top' | 'left';
      fontSize?: number;
      formatter?: (params: { dataIndex: number }) => string;
      rich?: Record<string, { width: number; align?: 'left' | 'right'; overflow?: 'truncate' }>;
    };
  }>;
}

export function buildFunnelChartOption(
  series: { name: string; value: number; stepNo?: number }[],
  mode: FunnelRateMode,
  layout: FunnelLayout = 'horizontal',
  color: FunnelColorConfig = DEFAULT_FUNNEL_COLOR,
  t: TFunction = i18nT,
): FunnelChartOption {
  const first = series[0]?.value ?? 0;
  const data = coloredBars(series, color);
  const tooltip = {
    trigger: 'item' as const,
    formatter: tooltipFormatter(series, mode, t),
  };

  if (layout === 'vertical') {
    const rotate = series.length >= 10 ? 40 : 0;
    return {
      tooltip,
      grid: { left: 48, right: 24, top: 36, bottom: series.length >= 10 ? 96 : 56, containLabel: true },
      xAxis: {
        type: 'category' as const,
        data: series.map((item, index) => `${item.stepNo ?? index + 1} ${item.name}`),
        axisLabel: {
          interval: 0,
          rotate,
          hideOverlap: false,
          width: rotate ? 72 : 96,
          overflow: 'truncate' as const,
        },
      },
      yAxis: { type: 'value' as const, min: 0 },
      series: [
        {
          type: 'bar' as const,
          data,
          barMaxWidth: 48,
          cursor: 'pointer',
          label: {
            show: true,
            position: 'top' as const,
            formatter: (params: { dataIndex: number }) =>
              stepRateVsFirst(series[params.dataIndex]?.value ?? 0, first, mode),
          },
        },
      ],
    };
  }

  const axis = buildHorizontalFunnelAxis(series, mode, first);
  const labelWidth = Math.max(axis.width, 80);
  return {
    tooltip,
    series: [
      {
        type: 'funnel' as const,
        left: labelWidth + 20,
        right: 24,
        top: 12,
        bottom: 12,
        min: 0,
        max: first || 1,
        minSize: '0%',
        maxSize: '100%',
        sort: 'none',
        gap: 2,
        funnelAlign: 'center',
        cursor: 'pointer',
        labelLine: { show: false },
        data,
        label: {
          show: true,
          position: 'left',
          fontSize: 12,
          formatter: (params: { dataIndex: number }) => axis.labels[params.dataIndex] ?? '',
          rich: axis.rich,
        },
      },
    ],
  };
}
