import { describe, expect, it } from 'vitest';
import {
  buildDiskTrendView,
  clampPredicted,
  downsampleDaily,
  forecastPointCount,
  MAX_FORECAST_DAYS,
} from './disk-trend-chart';
import type { TrendPoint } from '../../features/visualization/adapters/trend-forecast';

const T0 = Date.parse('2026-09-01T00:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TOTAL = 3e12;

describe('downsampleDaily', () => {
  it('同一天只保留最后一个点', () => {
    const points: TrendPoint[] = [
      { t: T0, v: 1 },
      { t: T0 + 2 * HOUR, v: 2 },
      { t: T0 + DAY, v: 3 },
    ];
    const out = downsampleDaily(points);
    expect(out).toHaveLength(2);
    expect(out[0].v).toBe(2);
    expect(out[1].v).toBe(3);
  });
});

describe('clampPredicted', () => {
  it('钳到 [0, 总量]', () => {
    const out = clampPredicted(
      [
        { t: T0, v: -100 },
        { t: T0 + DAY, v: TOTAL * 2 },
        { t: T0 + 2 * DAY, v: 10 },
      ],
      0,
      TOTAL,
    );
    expect(out.map((p) => p.v)).toEqual([0, TOTAL, 10]);
  });
});

describe('forecastPointCount', () => {
  it('日粒度外推不超过 30 天', () => {
    expect(forecastPointCount(180, DAY)).toBe(MAX_FORECAST_DAYS);
  });
  it('小时粒度按 24 点/天，仍封顶 30 天', () => {
    expect(forecastPointCount(180, HOUR)).toBe(MAX_FORECAST_DAYS * 24);
    expect(forecastPointCount(7, HOUR)).toBe(7 * 24);
  });
});

describe('buildDiskTrendView', () => {
  it('斜率下降时不画预测虚线，Y 轴从 0 到总量', () => {
    const samples = Array.from({ length: 8 }, (_, i) => ({
      sampled_at: new Date(T0 + i * DAY).toISOString(),
      value: 500e9 - i * 20e9,
    }));
    const view = buildDiskTrendView(samples, TOTAL, 180, T0 + 8 * DAY);
    expect(view.showPredicted).toBe(false);
    expect(view.forecastText).toContain('暂不预测');
    const yAxis = (view.option as { yAxis: { min: number; max: number; scale: boolean } }).yAxis;
    expect(yAxis.min).toBe(0);
    expect(yAxis.max).toBe(TOTAL);
    expect(yAxis.scale).toBe(false);
    const series = (view.option as { series: { name: string }[] }).series;
    expect(series.some((s) => s.name.includes('预测'))).toBe(false);
  });

  it('斜率上升时画预测线且点不超过总量', () => {
    const samples = Array.from({ length: 8 }, (_, i) => ({
      sampled_at: new Date(T0 + i * DAY).toISOString(),
      value: 1e12 + i * 50e9,
    }));
    const view = buildDiskTrendView(samples, TOTAL, 30, T0 + 8 * DAY);
    expect(view.showPredicted).toBe(true);
    const series = (view.option as { series: { name: string; data: [number, number][] }[] }).series;
    const predicted = series.find((s) => s.name.includes('预测'));
    expect(predicted).toBeTruthy();
    for (const [, v] of predicted!.data) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(TOTAL);
    }
  });
});
