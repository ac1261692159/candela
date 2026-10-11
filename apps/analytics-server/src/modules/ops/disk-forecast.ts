/**
 * 磁盘用尽外推（phase: clklog-analytics-alerting-v3）。
 *
 * 纯函数：采样点进、天数出，无 IO，便于单测。
 *
 * ⚠️ 算法与前端 `apps/analytics-web/src/features/visualization/adapters/trend-forecast.ts`
 * **同源但不同包**（前后端无法共享代码）：同一套一元线性回归（最小二乘）+ 阈值交汇。
 * 前端那版负责画图与文案，本版是**告警口径的唯一真相**；改任一处须同步另一处。
 */

export const MIN_FORECAST_POINTS = 3;
/** 无增长时返回的「天数」：用有限值表达「不会用尽」，便于与阈值比较和落库 */
export const NO_GROWTH_DAYS = 3650;

const DAY_MS = 86_400_000;

export interface DiskSamplePoint {
  /** 采样时间（毫秒时间戳） */
  t: number;
  /** 已用空间（字节） */
  v: number;
}

export type DiskForecastReason = 'ok' | 'insufficient_samples' | 'no_growth' | 'crossed';

export interface DiskForecast {
  /** 距用尽天数；null = 数据不足或参数无效（调用方本轮跳过） */
  daysToFull: number | null;
  /** 拟合增速（字节/天），可为负 */
  bytesPerDay: number;
  pointCount: number;
  reason: DiskForecastReason;
}

export function forecastDiskFull(
  samples: readonly DiskSamplePoint[],
  totalBytes: number,
  now: number = Date.now(),
): DiskForecast {
  const points = samples
    .filter((p): p is DiskSamplePoint => Boolean(p) && Number.isFinite(p.t) && Number.isFinite(p.v))
    .map((p) => ({ t: p.t, v: p.v }))
    .sort((a, b) => a.t - b.t);

  const insufficient: DiskForecast = {
    daysToFull: null,
    bytesPerDay: 0,
    pointCount: points.length,
    reason: 'insufficient_samples',
  };
  if (points.length < MIN_FORECAST_POINTS) return insufficient;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return insufficient;

  const n = points.length;
  let sumT = 0;
  let sumV = 0;
  for (const p of points) {
    sumT += p.t;
    sumV += p.v;
  }
  const meanT = sumT / n;
  const meanV = sumV / n;

  let covariance = 0;
  let varianceT = 0;
  for (const p of points) {
    covariance += (p.t - meanT) * (p.v - meanV);
    varianceT += (p.t - meanT) ** 2;
  }
  // 时间无跨度（同一时刻的多个点）：无法求斜率，按不预测处理
  if (varianceT === 0) return insufficient;

  const slope = covariance / varianceT; // 字节 / 毫秒
  const intercept = meanV - slope * meanT;
  const bytesPerDay = slope * DAY_MS;

  if (slope <= 0) {
    return { daysToFull: NO_GROWTH_DAYS, bytesPerDay, pointCount: n, reason: 'no_growth' };
  }

  const last = points[n - 1];
  if (last.v >= totalBytes) {
    return { daysToFull: 0, bytesPerDay, pointCount: n, reason: 'crossed' };
  }

  const crossAt = (totalBytes - intercept) / slope;
  if (!Number.isFinite(crossAt) || crossAt <= last.t) {
    return { daysToFull: 0, bytesPerDay, pointCount: n, reason: 'crossed' };
  }

  const days = (crossAt - now) / DAY_MS;
  return {
    daysToFull: days > 0 ? Math.round(days * 10) / 10 : 0,
    bytesPerDay,
    pointCount: n,
    reason: 'ok',
  };
}
