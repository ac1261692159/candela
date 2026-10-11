/**
 * 磁盘用尽外推（phase: clklog-analytics-alerting-v3）。
 *
 * 纯函数：与前端 trend-forecast 同源算法（最小二乘 + 阈值交汇），
 * 后端这版是告警口径的唯一真相。
 */
import { forecastDiskFull, MIN_FORECAST_POINTS, NO_GROWTH_DAYS } from '../../src/modules/ops/disk-forecast';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');

describe('forecastDiskFull', () => {
  it('采样点不足（<3）返回 null，调用方本轮跳过', () => {
    const samples = [
      { t: T0, v: 1e9 },
      { t: T0 + HOUR_MS, v: 2e9 },
    ];
    expect(MIN_FORECAST_POINTS).toBe(3);
    const result = forecastDiskFull(samples, 100e9, T0 + 2 * HOUR_MS);
    expect(result.daysToFull).toBeNull();
    expect(result.reason).toBe('insufficient_samples');
    expect(result.pointCount).toBe(2);
  });

  it('总量无效（0 或非有限）返回 null', () => {
    const samples = [
      { t: T0, v: 1e9 },
      { t: T0 + HOUR_MS, v: 2e9 },
      { t: T0 + 2 * HOUR_MS, v: 3e9 },
    ];
    expect(forecastDiskFull(samples, 0, T0).daysToFull).toBeNull();
    expect(forecastDiskFull(samples, Number.NaN, T0).daysToFull).toBeNull();
  });

  it('线性增长：按每小时 1GB 增长、总量 100GB、从最后采样点起算剩余 98 小时 ≈ 4.1 天', () => {
    const samples = [
      { t: T0, v: 0 },
      { t: T0 + HOUR_MS, v: 1e9 },
      { t: T0 + 2 * HOUR_MS, v: 2e9 },
    ];
    const result = forecastDiskFull(samples, 100e9, T0 + 2 * HOUR_MS);
    expect(result.reason).toBe('ok');
    expect(result.daysToFull).toBeCloseTo(4.1, 5);
    expect(result.bytesPerDay).toBeCloseTo(24e9, 0);
  });

  it('无增长（持平或下降）视为不会用尽，不触发可解除已有事件', () => {
    const flat = [
      { t: T0, v: 5e9 },
      { t: T0 + HOUR_MS, v: 5e9 },
      { t: T0 + 2 * HOUR_MS, v: 5e9 },
    ];
    expect(forecastDiskFull(flat, 100e9, T0).daysToFull).toBe(NO_GROWTH_DAYS);
    expect(forecastDiskFull(flat, 100e9, T0).reason).toBe('no_growth');

    const shrinking = [
      { t: T0, v: 5e9 },
      { t: T0 + HOUR_MS, v: 4e9 },
      { t: T0 + 2 * HOUR_MS, v: 3e9 },
    ];
    const result = forecastDiskFull(shrinking, 100e9, T0);
    expect(result.daysToFull).toBe(NO_GROWTH_DAYS);
    expect(result.bytesPerDay).toBeLessThan(0);
  });

  it('已越过总量视为 0 天（命中阈值），不再外推', () => {
    const samples = [
      { t: T0, v: 90e9 },
      { t: T0 + HOUR_MS, v: 99e9 },
      { t: T0 + 2 * HOUR_MS, v: 105e9 },
    ];
    const result = forecastDiskFull(samples, 100e9, T0 + 2 * HOUR_MS);
    expect(result.reason).toBe('crossed');
    expect(result.daysToFull).toBe(0);
  });

  it('过滤无效点并按时间排序，采样顺序颠倒也能算出同样的结果', () => {
    const asc = [
      { t: T0, v: 0 },
      { t: T0 + HOUR_MS, v: 1e9 },
      { t: T0 + 2 * HOUR_MS, v: 2e9 },
    ];
    const shuffled = [asc[2], { t: Number.NaN, v: 5 }, asc[0], asc[1]];
    const a = forecastDiskFull(asc, 100e9, T0 + 2 * HOUR_MS);
    const b = forecastDiskFull(shuffled, 100e9, T0 + 2 * HOUR_MS);
    expect(b.pointCount).toBe(3);
    expect(b.daysToFull).toBeCloseTo(a.daysToFull as number, 5);
  });

  it('跨天采样（每日一点）同样按天给出结论', () => {
    const samples = [
      { t: T0, v: 10e9 },
      { t: T0 + DAY_MS, v: 20e9 },
      { t: T0 + 2 * DAY_MS, v: 30e9 },
    ];
    // 每天 +10GB，总量 100GB，从最后一点起还需 7 天
    const result = forecastDiskFull(samples, 100e9, T0 + 2 * DAY_MS);
    expect(result.reason).toBe('ok');
    expect(result.daysToFull).toBe(7);
  });
});
