import { describe, expect, it } from 'vitest';
import {
  MIN_POINTS_FOR_FORECAST,
  averageStep,
  canForecast,
  fitLinear,
  forecast,
  sanitizePoints,
  solveThresholdCross,
  type TrendPoint,
} from './trend-forecast';

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');

/** 构造完全线性序列：v = 100 + 10 * i，时间按天递增 */
function linear(count: number, step = DAY, start = 100, delta = 10): TrendPoint[] {
  return Array.from({ length: count }, (_, i) => ({ t: T0 + i * step, v: start + i * delta }));
}

describe('sanitizePoints', () => {
  it('过滤缺失值与非有限数', () => {
    const out = sanitizePoints([
      { t: T0, v: 1 },
      { t: T0 + DAY, v: Number.NaN },
      { t: Number.NaN, v: 2 },
      { t: T0 + 2 * DAY, v: 3 },
    ] as TrendPoint[]);
    expect(out).toEqual([
      { t: T0, v: 1 },
      { t: T0 + 2 * DAY, v: 3 },
    ]);
  });

  it('按时间升序排序且不修改原数组', () => {
    const input: TrendPoint[] = [
      { t: T0 + 2 * DAY, v: 3 },
      { t: T0, v: 1 },
      { t: T0 + DAY, v: 2 },
    ];
    const out = sanitizePoints(input);
    expect(out.map((p) => p.v)).toEqual([1, 2, 3]);
    expect(input.map((p) => p.v)).toEqual([3, 1, 2]);
  });

  it('非数组输入返回空', () => {
    expect(sanitizePoints(undefined as unknown as TrendPoint[])).toEqual([]);
  });
});

describe('fitLinear', () => {
  it('完美线性数据时斜率与截距精确、r² 为 1', () => {
    const fit = fitLinear(linear(5));
    expect(fit.slope).toBeCloseTo(10 / DAY, 12);
    // t = T0 时 v 应为 100
    expect(fit.intercept + fit.slope * T0).toBeCloseTo(100, 6);
    expect(fit.r2).toBeCloseTo(1, 10);
    expect(fit.pointCount).toBe(5);
  });

  it('空输入退化为空拟合', () => {
    expect(fitLinear([])).toEqual({ slope: 0, intercept: 0, r2: 0, pointCount: 0 });
  });

  it('单点退化为该点值', () => {
    expect(fitLinear([{ t: T0, v: 42 }])).toEqual({ slope: 0, intercept: 42, r2: 0, pointCount: 1 });
  });

  it('值恒定（无增长）时斜率为 0 且 r² 为 0', () => {
    const fit = fitLinear(linear(5, DAY, 100, 0));
    expect(fit.slope).toBe(0);
    expect(fit.intercept).toBeCloseTo(100, 6);
    expect(fit.r2).toBe(0);
  });

  it('时间全部相同（无法求斜率）时退化为均值', () => {
    const fit = fitLinear([
      { t: T0, v: 10 },
      { t: T0, v: 20 },
    ]);
    expect(fit.slope).toBe(0);
    expect(fit.intercept).toBeCloseTo(15, 6);
    expect(fit.r2).toBe(0);
  });

  it('噪声数据的 r² 明显低于完美线性', () => {
    const noisy: TrendPoint[] = [
      { t: T0, v: 100 },
      { t: T0 + DAY, v: 130 },
      { t: T0 + 2 * DAY, v: 95 },
      { t: T0 + 3 * DAY, v: 140 },
    ];
    expect(fitLinear(noisy).r2).toBeLessThan(fitLinear(linear(4)).r2);
  });

  it('r² 落在 0~1 区间', () => {
    const fit = fitLinear(linear(6));
    expect(fit.r2).toBeGreaterThanOrEqual(0);
    expect(fit.r2).toBeLessThanOrEqual(1);
  });
});

describe('averageStep', () => {
  it('按日数据返回一天', () => {
    expect(averageStep(linear(5))).toBe(DAY);
  });

  it('按小时数据返回一小时', () => {
    expect(averageStep(linear(5, 3_600_000))).toBe(3_600_000);
  });

  it('不足两点时为 0', () => {
    expect(averageStep([{ t: T0, v: 1 }])).toBe(0);
  });
});

describe('canForecast', () => {
  it('少于 3 点不可预测', () => {
    expect(MIN_POINTS_FOR_FORECAST).toBe(3);
    expect(canForecast(2)).toBe(false);
    expect(canForecast(3)).toBe(true);
  });
});

describe('solveThresholdCross', () => {
  it('算出与阈值交汇的时间', () => {
    const fit = fitLinear(linear(5));
    // v = 200 时对应 i = 10
    expect(solveThresholdCross(fit, 200, T0 + 4 * DAY)).toBe(T0 + 10 * DAY);
  });

  it('无阈值时为 null', () => {
    const fit = fitLinear(linear(5));
    expect(solveThresholdCross(fit, null, T0)).toBeNull();
    expect(solveThresholdCross(fit, undefined, T0)).toBeNull();
  });

  it('斜率为 0（永不相交）时为 null', () => {
    const fit = fitLinear(linear(5, DAY, 100, 0));
    expect(solveThresholdCross(fit, 200, T0)).toBeNull();
  });

  it('已越过阈值的交汇点返回 null', () => {
    const fit = fitLinear(linear(5));
    // v = 120 时对应 i = 2，早于最后一个观测点（i = 4）
    expect(solveThresholdCross(fit, 120, T0 + 4 * DAY)).toBeNull();
  });

  it('下降趋势跌破下方可正常求交', () => {
    const fit = fitLinear(linear(5, DAY, 100, -10));
    // v = 100 - 10i，跌到 40 时 i = 6
    expect(solveThresholdCross(fit, 40, T0 + 4 * DAY)).toBe(T0 + 6 * DAY);
  });
});

describe('forecast', () => {
  it('外推点接续最后一个观测点，步长等于平均间隔', () => {
    const result = forecast(linear(5), { forecastPoints: 3 });
    expect(result.predicted).toHaveLength(3);
    expect(result.predicted.map((p) => p.t)).toEqual([
      T0 + 5 * DAY,
      T0 + 6 * DAY,
      T0 + 7 * DAY,
    ]);
    expect(result.predicted.map((p) => p.v)).toEqual([150, 160, 170]);
  });

  it('给出阈值交汇时间与剩余天数（自 now 起算）', () => {
    const now = T0 + 4 * DAY;
    const result = forecast(linear(5), { forecastPoints: 3, threshold: 200 }, now);
    expect(result.thresholdCrossAt).toBe(T0 + 10 * DAY);
    expect(result.daysToThreshold).toBeCloseTo(6, 6);
  });

  it('点数不足 3 时不外推（PRD：避免单点假趋势）', () => {
    const result = forecast(linear(2), { forecastPoints: 5, threshold: 200 });
    expect(result.predicted).toEqual([]);
    expect(result.thresholdCrossAt).toBeNull();
    expect(result.daysToThreshold).toBeNull();
    // 拟合结果仍然返回，供上层展示已有数据
    expect(result.fit.pointCount).toBe(2);
  });

  it('forecastPoints 为 0 时不外推', () => {
    expect(forecast(linear(5), { forecastPoints: 0 }).predicted).toEqual([]);
  });

  it('时间跨度为 0 时不外推', () => {
    const flat: TrendPoint[] = [
      { t: T0, v: 1 },
      { t: T0, v: 2 },
      { t: T0, v: 3 },
    ];
    const result = forecast(flat, { forecastPoints: 3 });
    expect(result.predicted).toEqual([]);
  });

  it('无增长（斜率 0）时不给出耗尽预测', () => {
    const result = forecast(linear(5, DAY, 100, 0), { forecastPoints: 3, threshold: 200 }, T0);
    expect(result.predicted.map((p) => p.v)).toEqual([100, 100, 100]);
    expect(result.thresholdCrossAt).toBeNull();
    expect(result.daysToThreshold).toBeNull();
  });

  it('阈值已越过时剩余天数为 0 而非负数', () => {
    const fit = fitLinear(linear(5));
    // 构造一个「未来但仍早于 now」的交汇：阈值 150 对应 i=5，now 设为 i=6
    const now = T0 + 6 * DAY;
    const result = forecast(linear(5), { forecastPoints: 3, threshold: 150 }, now);
    expect(result.thresholdCrossAt).toBe(T0 + 5 * DAY);
    expect(result.daysToThreshold).toBe(0);
    expect(fit.slope).toBeGreaterThan(0);
  });

  it('乱序输入也能正确拟合', () => {
    const shuffled: TrendPoint[] = [
      { t: T0 + 2 * DAY, v: 120 },
      { t: T0, v: 100 },
      { t: T0 + DAY, v: 110 },
    ];
    const result = forecast(shuffled, { forecastPoints: 2 });
    expect(result.predicted.map((p) => p.v)).toEqual([130, 140]);
  });

  it('按小时粒度数据按小时步长外推', () => {
    const result = forecast(linear(4, 3_600_000), { forecastPoints: 2 });
    expect(result.predicted.map((p) => p.t)).toEqual([T0 + 4 * 3_600_000, T0 + 5 * 3_600_000]);
  });

  it('不修改传入的点数组', () => {
    const points = linear(5);
    const snapshot = points.map((p) => ({ ...p }));
    forecast(points, { forecastPoints: 3, threshold: 200 });
    expect(points).toEqual(snapshot);
  });
});
