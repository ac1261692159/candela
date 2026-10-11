/**
 * 服务器状态 · 磁盘预估图纯函数（ops-console 缺陷修复）。
 * 无增长不画虚线；Y 轴钳在 [0, 总量]；长窗口按天抽样；外推最多 30 天。
 *
 * 文案由调用方传入的 `t` 构造（模块作用域取不到「当前语言」）；
 * `t` 默认走 i18n 实例取当前语言，同时保留 `(samples, diskTotal, trendDays, now)` 的既有调用签名。
 */
import { forecast, sanitizePoints, type TrendPoint } from '../../features/visualization/adapters/trend-forecast';
import { t as translate, type TFunction } from '../../i18n';

export const MAX_FORECAST_DAYS = 30;
export const DAILY_DOWNSAMPLE_DAYS = 30;

const HOUR_MS = 3_600_000;

export function downsampleDaily(points: readonly TrendPoint[]): TrendPoint[] {
  const ordered = sanitizePoints(points);
  const byDay = new Map<string, TrendPoint>();
  for (const point of ordered) {
    const date = new Date(point.t);
    const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    byDay.set(key, point);
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

export function clampPredicted(points: readonly TrendPoint[], min: number, max: number): TrendPoint[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return points.map((point) => ({ t: point.t, v: point.v }));
  }
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return points.map((point) => ({ t: point.t, v: Math.min(hi, Math.max(lo, point.v)) }));
}

export function forecastPointCount(trendDays: number, stepMs: number): number {
  const days = Math.min(MAX_FORECAST_DAYS, Math.max(1, trendDays));
  if (stepMs >= 20 * HOUR_MS) return days;
  return days * 24;
}

function formatGB(bytes: number): string {
  if (!Number.isFinite(bytes)) return '0';
  return `${(bytes / 1e9).toFixed(0)}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface DiskSample {
  sampled_at: string;
  value: number;
}

export interface DiskTrendView {
  option: Record<string, unknown> | null;
  forecastText: string;
  showPredicted: boolean;
}

export function buildDiskTrendView(
  samples: DiskSample[],
  diskTotal: number | null,
  trendDays: number,
  now = Date.now(),
  t: TFunction = translate,
): DiskTrendView {
  if (samples.length === 0) {
    return { option: null, forecastText: t('ops:diskTrend.noSamples'), showPredicted: false };
  }
  if (samples.length < 3) {
    return {
      option: buildOption(samples, [], diskTotal, trendDays, false, t),
      forecastText: t('ops:diskTrend.accumulating', { count: samples.length }),
      showPredicted: false,
    };
  }

  const actual = samples.map((sample) => ({ t: Date.parse(sample.sampled_at), v: sample.value }));
  const fitPoints = trendDays > DAILY_DOWNSAMPLE_DAYS ? downsampleDaily(actual) : actual;
  const stepMs = fitPoints.length >= 2 ? (fitPoints[fitPoints.length - 1].t - fitPoints[0].t) / (fitPoints.length - 1) : HOUR_MS;
  const result = forecast(fitPoints, {
    forecastPoints: forecastPointCount(trendDays, stepMs),
    threshold: diskTotal,
  }, now);

  const growing = result.fit.slope > 0;
  const capMax = diskTotal && diskTotal > 0 ? diskTotal : Number.POSITIVE_INFINITY;
  const predicted = growing ? clampPredicted(result.predicted, 0, capMax) : [];
  const showPredicted = growing && predicted.length > 0;

  let forecastText = t('ops:diskTrend.flat');
  if (showPredicted && result.thresholdCrossAt) {
    const date = new Date(result.thresholdCrossAt).toISOString().slice(0, 10);
    const days = Math.ceil(result.daysToThreshold ?? 0);
    forecastText = t('ops:diskTrend.forecast', { date, days });
  }

  return {
    option: buildOption(samples, predicted, diskTotal, trendDays, showPredicted, t),
    forecastText,
    showPredicted,
  };
}

function buildOption(
  samples: DiskSample[],
  predicted: TrendPoint[],
  diskTotal: number | null,
  trendDays: number,
  showPredicted: boolean,
  t: TFunction,
): Record<string, unknown> {
  const actual = samples.map((sample) => [Date.parse(sample.sampled_at), sample.value] as [number, number]);
  const series: Record<string, unknown>[] = [
    { name: t('ops:diskTrend.seriesUsed'), type: 'line', showSymbol: false, data: actual },
  ];
  if (showPredicted && predicted.length > 0 && actual.length > 0) {
    const last = actual[actual.length - 1];
    series.push({
      name: t('ops:diskTrend.seriesPredicted'),
      type: 'line',
      showSymbol: false,
      lineStyle: { type: 'dashed' },
      data: [[last[0], last[1]], ...predicted.map((p) => [p.t, p.v] as [number, number])],
    });
  }
  if (diskTotal) {
    series.push({
      name: t('ops:diskTrend.seriesTotal'),
      type: 'line',
      showSymbol: false,
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: { type: 'dashed' },
        data: [{ yAxis: diskTotal, label: { formatter: t('ops:diskTrend.totalMark') } }],
      },
      data: [],
    });
  }
  const tickCount = Math.max(4, Math.ceil(trendDays / 7));
  const yMax = diskTotal && diskTotal > 0 ? diskTotal : undefined;
  return {
    aria: { enabled: true },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) =>
        t('ops:diskTrend.tooltipValue', { size: formatBytes(Number(v)), gb: formatGB(Number(v)) }),
    },
    legend: { bottom: 0 },
    grid: { left: 12, right: 16, top: 28, bottom: 48, containLabel: true },
    xAxis: {
      type: 'time',
      axisLabel: {
        formatter: (v: number) => formatDate(v),
        hideOverlap: true,
      },
      splitNumber: tickCount,
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: yMax,
      scale: false,
      name: 'GB',
      axisLabel: { formatter: (v: number) => formatGB(v) },
    },
    series,
  };
}
