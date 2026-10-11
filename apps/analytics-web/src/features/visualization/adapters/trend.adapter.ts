import type {
  ChartAdapterResult,
  ChartConfigV1,
  ColumnProfile,
  MetricUnit,
  NormalizedChartData,
  TrendOptions,
} from '../chart.types';
import { metricUnit } from '../chart-compatibility';
import { formatChartNumber } from '../chart-data';
import { parseStrictTime } from '../column-profiler';
import { axisOfMetric, axisTooltipFormatter, mixedUnitAxes, unitForSeriesName, yAxisWithUnit } from '../metric-units';
import { baseChartOption, formatByUnit, listJoin, transformsText } from './shared';
import { formatTimeAxisLabel } from '../../time-axis/format-label';
import { getPlatformTimeZone, ymdInTz } from '../../time-range/resolve';
import { forecast, sanitizePoints, type TrendPoint } from './trend-forecast';
import { t as translate } from '../../../i18n';

/**
 * 趋势图 adapter（phase: clklog-analytics-trend-chart-v1）。
 *
 * 与折线图（line）的关键差异：
 * - X 轴为 `time` 类型（等距），折线图是 category 轴，不等距时间点会失真；
 * - 在实测值之后追加**预测段**（虚线），并可选叠加回归拟合线与阈值线；
 * - 能回答「按当前增速，何时达到 / 跌破阈值」。
 *
 * 首期仅对主系列做预测；2026-09-09 用户决策改为**每个系列各自外推**
 * （系列数超过 8 时仅保留主系列，避免分组维度下虚线多到不可读）。
 */

const DEFAULT_TREND: TrendOptions = {
  forecast_points: 7,
  threshold: null,
  show_trend_line: false,
  show_threshold: true,
};

/** 最多对多少个系列做预测；超过则只预测主系列。 */
const FORECAST_MAX_SERIES = 8;

/** 把 X 值转成时间戳；无法解析时返回 null（该点不参与趋势计算） */
function toTimestamp(x: unknown): number | null {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (x instanceof Date) {
    const ms = x.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof x === 'string') return parseStrictTime(x);
  return null;
}

function isoDate(ms: number): string {
  // 预测交点日期按平台时区取日（phase: clklog-analytics-timezone-v1；原 UTC 取日会差一天）
  return ymdInTz(getPlatformTimeZone(), ms);
}

export function trendAdapter(
  config: ChartConfigV1,
  data: NormalizedChartData,
  profiles: ColumnProfile[],
): ChartAdapterResult {
  const metricKeys = config.bindings.metrics;
  const unit = metricKeys[0]
    ? metricUnit(
        profiles.find((item) => item.key === metricKeys[0]) ?? profiles[0],
        config.options,
      )
    : 'number';
  const options: TrendOptions = { ...DEFAULT_TREND, ...(config.options.trend ?? {}) };

  const useSeries = Boolean(config.bindings.series);
  // 有系列时每个系列一条曲线（均取主指标）；无系列时每个指标一条曲线
  const seriesNames = useSeries
    ? [...new Set(data.points.map((point) => point.series ?? translate('sql:chart.emptySeries')))]
    : metricKeys;

  // 双轴（phase: clklog-analytics-sql-dual-axis-v1）：与折线 adapter 同语义。
  // 绑定 series 时所有曲线共用第一个指标，故轴归属只看它。
  const axisOf = (key: string) => axisOfMetric(key, config.options);
  const activeMetricKeys = useSeries ? metricKeys.slice(0, 1) : metricKeys;
  const leftKeys = activeMetricKeys.filter((key) => axisOf(key) === 'left');
  const rightKeys = activeMetricKeys.filter((key) => axisOf(key) === 'right');
  const hasRight = rightKeys.length > 0;
  const axisIndexOf = (metric: string) => (axisOf(metric) === 'right' ? 1 : 0);

  const actual = seriesNames.map((name) => {
    const points: TrendPoint[] = [];
    for (const point of data.points) {
      const t = toTimestamp(point.x);
      if (t === null) continue;
      if (useSeries && (point.series ?? translate('sql:chart.emptySeries')) !== name) continue;
      const value = point.values[useSeries ? metricKeys[0] : name];
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      points.push({ t, v: value });
    }
    return { name, points: sanitizePoints(points) };
  });

  const series: Record<string, unknown>[] = actual.map((entry) => ({
    name: entry.name,
    type: 'line',
    showSymbol: true,
    symbol: 'circle',
    lineStyle: { type: 'solid', width: 2 },
    data: entry.points.map((point) => [point.t, point.v]),
    ...(hasRight ? { yAxisIndex: axisIndexOf(useSeries ? metricKeys[0] : entry.name) } : {}),
  }));

  const description = translate('sql:chart.trendDescription', {
    x: config.bindings.x ?? '',
    metrics: listJoin(metricKeys),
  });
  const units = config.options.units ?? {};
  // 单位解析与判定侧同规则：显式 units → 该列自身推断的单位 → 主指标兜底
  const profileUnit = (key: string): MetricUnit =>
    metricUnit(profiles.find((item) => item.key === key) ?? profiles[0], config.options);
  const unitOfKey = (key: string) => unitForSeriesName(key, units, profileUnit(key));
  /**
   * 该轴刻度的单位：同轴混单位时退化为纯数字（phase: clklog-analytics-axis-unit-coherence-v1）。
   * 一根轴只能有一种量纲装饰，套错就是把计数标成百分号；各系列的真实单位由悬停提示按系列给出。
   */
  const axisUnit = (keys: string[], fallback: MetricUnit): MetricUnit => {
    if (mixedUnitAxes(keys.map((key) => ({ key, unit: unitOfKey(key) })), axisOf).length > 0) return 'number';
    return keys.length ? unitOfKey(keys[0]) : fallback;
  };
  const base = baseChartOption(description);
  const option: Record<string, unknown> = {
    ...base,
    // 多一条右轴要把右边距让出来，否则右轴刻度被容器裁掉
    ...(hasRight ? { grid: { ...(base.grid as Record<string, unknown>), right: 48 } } : {}),
    tooltip: {
      trigger: 'axis',
      formatter: axisTooltipFormatter((name) => unitForSeriesName(name, units, unit)),
      axisPointer: {
        label: { formatter: (params: { value?: unknown }) => formatTimeAxisLabel(params.value) },
      },
    },
    xAxis: {
      type: 'time',
      axisLabel: {
        hideOverlap: true,
        formatter: (value: number) => formatTimeAxisLabel(value),
      },
    },
    // 单轴分支保持改造前的原表达式，确保既有图逐字节不变（AC1）
    yAxis: hasRight
      ? [
          yAxisWithUnit(axisUnit(leftKeys, unit), { scale: true }),
          yAxisWithUnit(axisUnit(rightKeys, unit), { scale: true }),
        ]
      : yAxisWithUnit(axisUnit(activeMetricKeys, unit), { scale: true }),
    series,
  };

  // ---- 预测（每个系列各自外推；系列过多时仅主系列）----
  const primary = actual[0];
  const forecastTargets = actual.length <= FORECAST_MAX_SERIES ? actual : actual.slice(0, 1);
  const forecasts = forecastTargets.map((entry) => ({
    entry,
    result: forecast(entry.points, {
      forecastPoints: options.forecast_points,
      threshold: options.threshold,
    }),
  }));

  let forecastNote = translate('sql:chart.forecastOff');
  const primaryForecast = forecasts[0]?.result ?? null;
  if (forecasts.some((item) => item.result.predicted.length > 0)) {
    for (const { entry, result } of forecasts) {
      if (result.predicted.length === 0) continue;
      const last = entry.points[entry.points.length - 1];
      // 预测线从最后一个实测点接续，避免出现断线
      series.push({
        name: `${entry.name}${translate('sql:chart.forecastSuffix')}`,
        type: 'line',
        showSymbol: false,
        lineStyle: { type: 'dashed' },
        data: [[last.t, last.v], ...result.predicted.map((point) => [point.t, point.v])],
        ...(hasRight ? { yAxisIndex: axisIndexOf(useSeries ? metricKeys[0] : entry.name) } : {}),
      });

      if (options.show_trend_line) {
        const first = entry.points[0];
        const lastPredicted = result.predicted[result.predicted.length - 1];
        series.push({
          name: `${entry.name}${translate('sql:chart.fitSuffix')}`,
          type: 'line',
          showSymbol: false,
          lineStyle: { type: 'dotted', width: 1 },
          ...(hasRight ? { yAxisIndex: axisIndexOf(useSeries ? metricKeys[0] : entry.name) } : {}),
          data: [
            [first.t, result.fit.intercept + result.fit.slope * first.t],
            [lastPredicted.t, result.fit.intercept + result.fit.slope * lastPredicted.t],
          ],
        });
      }
    }

    const predictedCount = primaryForecast?.predicted.length ?? 0;
    forecastNote = translate('sql:chart.forecastOn', { count: predictedCount })
      + (forecasts.length > 1 ? translate('sql:chart.forecastSeries', { count: forecasts.length }) : '');
    if ((primaryForecast?.fit.r2 ?? 1) < 0.1) forecastNote += translate('sql:chart.forecastWeak');
  } else if (primary && primary.points.length > 0) {
    forecastNote = translate('sql:chart.forecastInsufficient');
  }

  // ---- 阈值线 ----
  let thresholdNote = '';
  if (options.show_threshold && options.threshold !== null && Number.isFinite(options.threshold)) {
    const threshold = options.threshold;
    const markLine: Record<string, unknown> = {
      silent: true,
      symbol: 'none',
      lineStyle: { type: 'dashed' },
      data: [
        {
          yAxis: threshold,
          label: { formatter: translate('sql:chart.thresholdLabel', { value: formatByUnit(threshold, unit) }) },
        },
      ],
    };
    // 标记在第一个系列上即可（markLine 作用于整个坐标系）
    (series[0] as Record<string, unknown>).markLine = markLine;

    if (primaryForecast?.thresholdCrossAt) {
      thresholdNote = translate('sql:chart.thresholdCross', {
        date: isoDate(primaryForecast.thresholdCrossAt),
        days: Math.ceil(primaryForecast.daysToThreshold ?? 0),
      });
      (markLine.data as Record<string, unknown>[]).push({
        xAxis: primaryForecast.thresholdCrossAt,
        label: { formatter: translate('sql:chart.thresholdDateLabel', { date: isoDate(primaryForecast.thresholdCrossAt) }) },
      });
    } else {
      // 区分「已越过」与「永不相交」：两者都没有未来交汇点，但含义相反
      const lastValue = primary?.points[primary.points.length - 1]?.v;
      const crossed =
        lastValue !== undefined && primaryForecast !== null && primaryForecast.fit.slope !== 0
          ? primaryForecast.fit.slope > 0
            ? lastValue >= threshold
            : lastValue <= threshold
          : false;
      thresholdNote = crossed
        ? translate('sql:chart.thresholdCrossed')
        : translate('sql:chart.thresholdNever');
    }
  }

  const totalPoints = actual.reduce((sum, entry) => sum + entry.points.length, 0);
  const summary = translate('sql:chart.trendSummary', {
    description,
    points: totalPoints,
    series: series.length,
    forecast: forecastNote,
    threshold: thresholdNote,
    transforms: transformsText(data.transforms),
  });

  return {
    option,
    summary,
    audit: {
      inputRows: data.originalRowCount,
      outputPoints: totalPoints + (primaryForecast?.predicted.length ?? 0),
      transforms: data.transforms,
    },
  };
}

/** 供图表摘要复用的数值格式化（保持与折线图一致） */
export function formatTrendValue(value: number | null, unit: Parameters<typeof formatByUnit>[1]): string {
  return formatChartNumber(value, unit);
}
