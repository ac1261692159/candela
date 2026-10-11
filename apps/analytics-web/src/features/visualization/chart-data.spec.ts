import { describe, expect, it } from 'vitest';
import { applyVisibleTransforms, normalizeChartData } from './chart-data';
import { profileColumns } from './column-profiler';
import { recommendChart } from './chart-recommender';
import { fxCountryCount, fxDayEventCount } from './chart.fixtures';

describe('chart-data', () => {
  it('does not mutate source rows and keeps NULL as NULL', () => {
    const original = fxDayEventCount.rows.map((row) => ({ ...row }));
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
    const recommended = recommendChart(profiles, fxDayEventCount.rows).recommended!.config!;
    const normalized = normalizeChartData(recommended, fxDayEventCount.rows, profiles);
    expect(fxDayEventCount.rows).toEqual(original);
    expect(normalized.data.points.find((point) => String(point.x).startsWith('2026-09-02'))?.values.event_count).toBeNull();
  });

  it('sorts time ascending without filling missing buckets', () => {
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
    const config = recommendChart(profiles, fxDayEventCount.rows).recommended!.config!;
    const normalized = normalizeChartData(config, fxDayEventCount.rows, profiles);
    const transformed = applyVisibleTransforms(normalized.data, config, profiles);
    expect(transformed.points.map((point) => String(point.x).slice(0, 10))).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(transformed.transforms).toContain('time_asc');
  });

  it('applies visible TopN on a copy and reports audit transforms', () => {
    const profiles = profileColumns(fxCountryCount.columns, fxCountryCount.rows);
    const config = recommendChart(profiles, fxCountryCount.rows).recommended!.config!;
    const normalized = normalizeChartData(config, fxCountryCount.rows, profiles);
    const transformed = applyVisibleTransforms(normalized.data, config, profiles);
    expect(transformed.displayedCount).toBe(20);
    expect(transformed.originalRowCount).toBe(22);
    expect(transformed.transforms.some((item) => item.startsWith('top_n'))).toBe(true);
    expect(fxCountryCount.rows).toHaveLength(22);
  });
});
