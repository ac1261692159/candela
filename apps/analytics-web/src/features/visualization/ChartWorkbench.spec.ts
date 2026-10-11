import { describe, expect, it, vi } from 'vitest';
import { resolveVisualization } from './chart-pipeline';
import { fxDayEventCount, fxOsUniq, fxPartyFunnel, fxCountryCount } from './chart.fixtures';

vi.mock('echarts-for-react', () => ({
  default: () => null,
}));

describe('ChartWorkbench pipeline', () => {
  it('exposes auto reason, compatible pie as non-default, and restore-auto config', () => {
    const resolved = resolveVisualization({ columns: fxDayEventCount.columns, rows: fxDayEventCount.rows });
    expect(resolved.config?.mode).toBe('auto');
    expect(resolved.config?.chart_type).toBe('line');
    const os = resolveVisualization({ columns: fxOsUniq.columns, rows: fxOsUniq.rows });
    expect(os.inference.candidates.find((item) => item.chartType === 'pie')?.compatible).toBe(false);
    const restored = resolveVisualization({ columns: fxDayEventCount.columns, rows: fxDayEventCount.rows });
    expect(restored.config?.chart_type).toBe('line');
  });

  it('prefers a saved compatible config over a new recommendation', () => {
    const auto = resolveVisualization({ columns: fxCountryCount.columns, rows: fxCountryCount.rows });
    expect(auto.config?.chart_type).toBe('bar');
    const saved = {
      ...auto.config!,
      mode: 'manual' as const,
      chart_type: 'pie' as const,
      preferred_view: 'chart' as const,
      options: { ...auto.config!.options, donut: true, include_other: true, top_n: 5 },
    };
    const resolved = resolveVisualization({
      columns: fxCountryCount.columns,
      rows: fxCountryCount.rows,
      savedConfig: saved,
    });
    expect(resolved.config?.mode).toBe('manual');
    expect(resolved.config?.chart_type).toBe('pie');
  });

  it('keeps accessible summary text for screen readers', () => {
    const resolved = resolveVisualization({ columns: fxDayEventCount.columns, rows: fxDayEventCount.rows });
    expect(resolved.adapter?.summary).toContain('折线图');
  });

  it('does not crash when a multi-row funnel needs a selector', () => {
    const resolved = resolveVisualization({ columns: fxPartyFunnel.columns, rows: fxPartyFunnel.rows });
    expect(resolved.issues.some((issue) => issue.code === 'MULTI_ROW_FUNNEL_REQUIRES_SELECTION')).toBe(true);
  });
});
