/**
 * 趋势图预测纯函数（phase: clklog-analytics-trend-chart-v1）。
 *
 * 与 ECharts / React 完全无关，便于单测与跨场景复用：
 * - 三个分析页（漏斗 / 留存 / 自定义 SQL）的趋势图
 * - 运维面板（ops-console）磁盘使用量预估
 *
 * 算法选取说明：一元线性回归（最小二乘）。磁盘增长、容量消耗这类场景
 * 近似线性，且结果确定、可单测、无外部依赖。不做季节性 / 指数平滑。
 */

export interface TrendPoint {
  /** 时间戳（毫秒） */
  t: number;
  /** 指标值 */
  v: number;
}

export interface TrendFit {
  /** 斜率，单位「值 / 毫秒」 */
  slope: number;
  /** 截距：t = 0 时的拟合值 */
  intercept: number;
  /** 拟合优度 r²，0~1；样本不足、时间重叠或值全相同时为 0 */
  r2: number;
  /** 参与拟合的有效点数（已过滤无效值） */
  pointCount: number;
}

export interface ForecastOptions {
  /** 外推点数，默认 7；0 表示不外推 */
  forecastPoints?: number;
  /** 阈值线；用于推演「何时达到 / 跌破」 */
  threshold?: number | null;
}

export interface ForecastResult {
  fit: TrendFit;
  /** 外推点（不含原始点），时间上接续最后一个原始点 */
  predicted: TrendPoint[];
  /** 与阈值交汇的时间戳（毫秒）；不相交 / 已越过 / 无法判断时为 null */
  thresholdCrossAt: number | null;
  /** 距交汇还有多少天（自 now 起算）；thresholdCrossAt 为 null 时为 null */
  daysToThreshold: number | null;
}

/**
 * 少于该点数不作预测。
 * PRD 决策 D1：漏斗「整体」模式只有 1 行结果，画趋势线会形成「单点假趋势」。
 */
export const MIN_POINTS_FOR_FORECAST = 3;

const DAY_MS = 86_400_000;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 过滤无效点（缺失值 / 非有限数）并按时间升序排序，返回新数组 */
export function sanitizePoints(points: readonly TrendPoint[]): TrendPoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((p): p is TrendPoint => Boolean(p) && Number.isFinite(p.t) && Number.isFinite(p.v))
    .map((p) => ({ t: p.t, v: p.v }))
    .sort((a, b) => a.t - b.t);
}

/** 相邻点平均时间间隔（毫秒）；点不足或时间无跨度时为 0 */
export function averageStep(points: readonly TrendPoint[]): number {
  const pts = sanitizePoints(points);
  if (pts.length < 2) return 0;
  const span = pts[pts.length - 1].t - pts[0].t;
  return span / (pts.length - 1);
}

/** 是否具备预测条件（供 UI 判断「样本积累中」） */
export function canForecast(pointCount: number): boolean {
  return pointCount >= MIN_POINTS_FOR_FORECAST;
}

/**
 * 一元线性回归（最小二乘）。
 *
 * - 有效点 < 2：退化为「水平线 = 均值/单点值」，r² = 0
 * - 所有点时间相同（无法求斜率）：同上
 * - 所有值相同（SST = 0）：r² = 0，避免 0/0
 */
export function fitLinear(points: readonly TrendPoint[]): TrendFit {
  const pts = sanitizePoints(points);
  const n = pts.length;

  if (n === 0) return { slope: 0, intercept: 0, r2: 0, pointCount: 0 };
  if (n === 1) return { slope: 0, intercept: pts[0].v, r2: 0, pointCount: 1 };

  let sumT = 0;
  let sumV = 0;
  for (const p of pts) {
    sumT += p.t;
    sumV += p.v;
  }
  const meanT = sumT / n;
  const meanV = sumV / n;

  let covariance = 0;
  let varianceT = 0;
  let totalVarianceV = 0;
  for (const p of pts) {
    const dt = p.t - meanT;
    const dv = p.v - meanV;
    covariance += dt * dv;
    varianceT += dt * dt;
    totalVarianceV += dv * dv;
  }

  // 所有点时间相同：斜率无定义，退化为水平线
  if (varianceT === 0) {
    return { slope: 0, intercept: meanV, r2: 0, pointCount: n };
  }

  const slope = covariance / varianceT;
  const intercept = meanV - slope * meanT;

  let residual = 0;
  for (const p of pts) {
    const expected = intercept + slope * p.t;
    residual += (p.v - expected) ** 2;
  }
  const r2 = totalVarianceV === 0 ? 0 : 1 - residual / totalVarianceV;

  return { slope, intercept, r2: clamp01(r2), pointCount: n };
}

/** 求拟合线与阈值线的交汇时间；无阈值、斜率为 0、已越过或反向时为 null */
export function solveThresholdCross(
  fit: TrendFit,
  threshold: number | null | undefined,
  afterT: number,
): number | null {
  if (threshold === null || threshold === undefined || !Number.isFinite(threshold)) return null;
  if (fit.slope === 0) return null;

  const t = (threshold - fit.intercept) / fit.slope;
  if (!Number.isFinite(t)) return null;
  // 交汇点必须落在最后一个观测点之后；否则视为「已越过」，由调用方依据当前值判断
  if (t <= afterT) return null;
  return t;
}

/**
 * 拟合 + 外推 + 阈值推演。
 *
 * 不预测的情形（predicted 为空、thresholdCrossAt 为 null）：
 * - 有效点 < 3（MIN_POINTS_FOR_FORECAST）
 * - forecastPoints = 0
 * - 时间跨度为 0（无法外推）
 */
export function forecast(
  points: readonly TrendPoint[],
  options: ForecastOptions = {},
  now: number = Date.now(),
): ForecastResult {
  const { forecastPoints = 7, threshold = null } = options;
  const pts = sanitizePoints(points);
  const fit = fitLinear(pts);

  const noForecast: ForecastResult = {
    fit,
    predicted: [],
    thresholdCrossAt: null,
    daysToThreshold: null,
  };

  if (!canForecast(pts.length) || forecastPoints <= 0) return noForecast;

  const step = averageStep(pts);
  if (step <= 0) return noForecast;

  const last = pts[pts.length - 1];
  const predicted: TrendPoint[] = [];
  for (let i = 1; i <= forecastPoints; i += 1) {
    const t = last.t + step * i;
    predicted.push({ t, v: fit.intercept + fit.slope * t });
  }

  const crossAt = solveThresholdCross(fit, threshold, last.t);
  if (crossAt === null) return { fit, predicted, thresholdCrossAt: null, daysToThreshold: null };

  const days = (crossAt - now) / DAY_MS;
  return {
    fit,
    predicted,
    thresholdCrossAt: crossAt,
    daysToThreshold: days > 0 ? days : 0,
  };
}
