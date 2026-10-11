import { describe, expect, it } from 'vitest';
import { parseChartConfigV1, pruneStaleOptionRefs, readSavedConfig, ChartConfigError } from './chart-config';
import { profileColumns } from './column-profiler';
import { fxDayEventCount, fxLegacyLine } from './chart.fixtures';
import { recommendChart } from './chart-recommender';

describe('chart-config', () => {
  it('accepts a complete v1 config and rejects extra fields, dangerous keys and future versions', () => {
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
    const config = recommendChart(profiles, fxDayEventCount.rows).recommended!.config!;
    expect(parseChartConfigV1(config, ['day', 'event_count']).chart_type).toBe('line');
    expect(() => parseChartConfigV1({ ...config, option: {} }, ['day', 'event_count'])).toThrow(ChartConfigError);
    expect(() => parseChartConfigV1({ ...config, roles: { constructor: 'metric' } }, ['day', 'event_count'])).toThrow(ChartConfigError);
    const future = readSavedConfig({ ...config, schema_version: 2 }, profiles);
    expect(future.issues.some((issue) => issue.code === 'UNSUPPORTED_CONFIG_VERSION')).toBe(true);
  });

  it('marks missing columns as stale and treats legacy chart_type as a suggestion only', () => {
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
    const config = recommendChart(profiles, fxDayEventCount.rows).recommended!.config!;
    expect(() => parseChartConfigV1({ ...config, bindings: { ...config.bindings, x: 'missing' } }, ['day', 'event_count'])).toThrow(ChartConfigError);
    const legacy = readSavedConfig(fxLegacyLine, profiles);
    expect(legacy.config).toBeNull();
    expect(legacy.legacy?.chart_type).toBe('line');
  });

  it('pruneStaleOptionRefs：只丢弃指向已消失列的引用，其余保留', () => {
    const options = {
      orientation: 'vertical',
      donut: false,
      sort: { column: 'gone', direction: 'desc' },
      include_other: false,
      units: { keep: 'number', gone: 'percent' },
      aggregation: { keep: 'additive', gone: 'average' },
    } as unknown as Parameters<typeof pruneStaleOptionRefs>[0];
    const pruned = pruneStaleOptionRefs(options, ['keep']);
    expect(pruned.sort).toBeUndefined();
    expect(pruned.units).toEqual({ keep: 'number' });
    expect(pruned.aggregation).toEqual({ keep: 'additive' });
  });

  describe('域白名单（phase: clklog-analytics-event-chart-binding-v1）', () => {
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
    const columns = ['day', 'event_count'];
    const base = () => recommendChart(profiles, fxDayEventCount.rows).recommended!.config!;

    it('事件域接受 stack/cumulative/distribution，SQL 域拒绝', () => {
      for (const chartType of ['stack', 'cumulative', 'distribution']) {
        expect(parseChartConfigV1({ ...base(), chart_type: chartType }, columns, 'event').chart_type).toBe(chartType);
        // 缺省即 sql 域
        expect(() => parseChartConfigV1({ ...base(), chart_type: chartType }, columns)).toThrow(ChartConfigError);
        expect(() => parseChartConfigV1({ ...base(), chart_type: chartType }, columns, 'sql')).toThrow(ChartConfigError);
      }
    });

    it('SQL 域仍接受 funnel，事件域拒绝', () => {
      expect(parseChartConfigV1({ ...base(), chart_type: 'funnel' }, columns).chart_type).toBe('funnel');
      expect(() => parseChartConfigV1({ ...base(), chart_type: 'funnel' }, columns, 'event')).toThrow(ChartConfigError);
    });

    it('readSavedConfig 透传域参数，事件图型在事件域下可复现', () => {
      const stored = { ...base(), chart_type: 'stack', mode: 'manual' as const };
      expect(readSavedConfig(stored, profiles).config).toBeNull();
      expect(readSavedConfig(stored, profiles, 'event').config?.chart_type).toBe('stack');
    });
  });

  describe('metric_axis / x_label', () => {
    const profiles = profileColumns(fxDayEventCount.columns, fxDayEventCount.rows);
    const columns = ['day', 'event_count'];
    const base = () => recommendChart(profiles, fxDayEventCount.rows).recommended!.config!;

    it('metric_axis 只接受真实列与 left/right', () => {
      const parsed = parseChartConfigV1(
        { ...base(), options: { ...base().options, metric_axis: { event_count: 'right' } } },
        columns,
      );
      expect(parsed.options.metric_axis).toEqual({ event_count: 'right' });
      expect(() =>
        parseChartConfigV1(
          { ...base(), options: { ...base().options, metric_axis: { event_count: 'top' } } },
          columns,
        ),
      ).toThrow(ChartConfigError);
      expect(() =>
        parseChartConfigV1(
          { ...base(), options: { ...base().options, metric_axis: { missing: 'right' } } },
          columns,
        ),
      ).toThrow(ChartConfigError);
    });

    it('x_label 允许 null 与合法边界，拒绝越界与未知键', () => {
      const withLabel = (x_label: unknown) =>
        parseChartConfigV1({ ...base(), options: { ...base().options, x_label } }, columns);
      expect(withLabel(null).options.x_label).toBeNull();
      expect(withLabel({ rotate: 30, max_width: 96 }).options.x_label).toEqual({ rotate: 30, max_width: 96 });
      expect(withLabel({ rotate: null, max_width: null }).options.x_label).toEqual({
        rotate: null,
        max_width: null,
      });
      expect(() => withLabel({ rotate: 120, max_width: null })).toThrow(ChartConfigError);
      expect(() => withLabel({ rotate: 30, max_width: 4 })).toThrow(ChartConfigError);
      expect(() => withLabel({ rotate: 30, max_width: 96, width: 10 })).toThrow(ChartConfigError);
    });

    it('pruneStaleOptionRefs 丢弃指向已消失列的轴归属', () => {
      const options = {
        orientation: 'vertical',
        donut: false,
        include_other: false,
        units: {},
        aggregation: {},
        metric_axis: { keep: 'right', gone: 'left' },
      } as unknown as Parameters<typeof pruneStaleOptionRefs>[0];
      expect(pruneStaleOptionRefs(options, ['keep']).metric_axis).toEqual({ keep: 'right' });
    });
  });
});
