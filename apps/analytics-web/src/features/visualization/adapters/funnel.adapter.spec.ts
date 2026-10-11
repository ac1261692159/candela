import { describe, expect, it } from 'vitest';
import { funnelAdapter } from './funnel.adapter';
import { profileColumns } from '../column-profiler';
import { normalizeChartData } from '../chart-data';
import { recommendChart } from '../chart-recommender';
import { fxNonMonotonic, fxPartyFunnel, fxWideFunnel } from '../chart.fixtures';
import { resolveVisualization } from '../chart-pipeline';

describe('funnel.adapter', () => {
  it('keeps numbered step order and does not sort by value', () => {
    const resolved = resolveVisualization({ columns: fxWideFunnel.columns, rows: fxWideFunnel.rows });
    const series = (resolved.adapter?.option.series as Array<{ sort: string; data: Array<{ name: string; value: number }> }>)[0];
    expect(series.sort).toBe('none');
    expect(series.data.map((item) => item.name)).toEqual(['加载开始', '加载成功', '进入房间', '退出房间']);
  });

  it('defaults to UV and can render PV after family switch', () => {
    const resolved = resolveVisualization({ columns: fxWideFunnel.columns, rows: fxWideFunnel.rows });
    expect(resolved.config?.bindings.funnel?.metric_family).toBe('uv');
    const pv = resolveVisualization({
      columns: fxWideFunnel.columns,
      rows: fxWideFunnel.rows,
      savedConfig: {
        ...resolved.config!,
        bindings: {
          ...resolved.config!.bindings,
          funnel: { ...resolved.config!.bindings.funnel!, metric_family: 'pv', steps: resolved.config!.bindings.funnel!.steps.map((step) => ({ ...step, column: step.column.replace('UV', 'PV') })) },
          metrics: resolved.config!.bindings.funnel!.steps.map((step) => step.column.replace('UV', 'PV')),
        },
      },
    });
    const first = (pv.adapter?.option.series as Array<{ data: Array<{ value: number }> }>)[0].data[0].value;
    expect(first).toBe(200);
  });

  it('requires a unique row selector and never takes the first scene', () => {
    const resolved = resolveVisualization({ columns: fxPartyFunnel.columns, rows: fxPartyFunnel.rows });
    expect(resolved.issues.some((issue) => issue.code === 'MULTI_ROW_FUNNEL_REQUIRES_SELECTION')).toBe(true);
    expect(resolved.adapter).toBeUndefined();
    const selected = resolveVisualization({
      columns: fxPartyFunnel.columns,
      rows: fxPartyFunnel.rows,
      savedConfig: {
        ...resolved.config!,
        bindings: { ...resolved.config!.bindings, row_selector: { column: '场景ID', value: 'scene_3' } },
      },
    });
    const first = (selected.adapter?.option.series as Array<{ data: Array<{ value: number }> }>)[0].data[0].value;
    expect(first).toBe(97);
  });

  it('warns on non-monotonic funnels and shows -- for zero denominators', () => {
    const profiles = profileColumns(fxNonMonotonic.columns, fxNonMonotonic.rows);
    const config = recommendChart(profiles, fxNonMonotonic.rows).recommended!.config!;
    const data = normalizeChartData(config, fxNonMonotonic.rows, profiles).data;
    const adapted = funnelAdapter(config, data, profiles);
    expect(adapted.issues.some((issue) => issue.code === 'NON_MONOTONIC_FUNNEL')).toBe(true);
    const zero = funnelAdapter(
      config,
      { ...data, selectedRow: { '1.开始UV': 0, '2.中间UV': 0, '3.结束UV': 0 } },
      profiles,
    );
    expect(zero.summary).toContain('--');
  });
});
