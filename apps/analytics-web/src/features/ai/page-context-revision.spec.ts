// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useAiContextStore } from '../../stores/ai-context.store';

describe('page proposal content revisions', () => {
  const sql = { page: 'sql' as const, route: '/report/sql', analysis: { mode: 'sql', sql: 'SELECT 1', time_range: { start: '2026-08-01', end: '2026-08-07' } } };
  beforeEach(() => useAiContextStore.getState().clearContext());
  it('does not conflict when only loading, result or local SQL counter changes', () => {
    const store = useAiContextStore.getState();
    store.publishContext(sql, 'a');
    const revision = useAiContextStore.getState().context?.revision;
    store.publishContext({ ...sql, revision: 0, analysis: { ...sql.analysis, loading: true }, result: { rows: [1] } }, 'a');
    expect(useAiContextStore.getState().context?.revision).toBe(revision);
  });
  it('advances for real edits, date changes, project changes and rebase', () => {
    const store = useAiContextStore.getState();
    store.publishContext(sql, 'a');
    let revision = useAiContextStore.getState().context!.revision!;
    store.publishContext({ ...sql, analysis: { ...sql.analysis, sql: 'SELECT 2' } }, 'a');
    expect(useAiContextStore.getState().context!.revision).toBe(revision + 1);
    store.publishContext(sql, 'b');
    expect(useAiContextStore.getState().context!.revision).toBeGreaterThan(revision + 1);
    store.rebaseRevision(10000);
    revision = useAiContextStore.getState().context!.revision!;
    store.publishContext({ ...sql, analysis: { ...sql.analysis, time_range: { start: '2026-08-02', end: '2026-08-07' } } }, 'b');
    expect(useAiContextStore.getState().context!.revision).toBe(revision + 1);
  });
  it('advances for manual chart bindings but not auto recommendations', () => {
    const store = useAiContextStore.getState();
    store.publishContext(sql, 'a');
    const revision = useAiContextStore.getState().context!.revision!;
    store.publishContext({
      ...sql,
      analysis: { ...sql.analysis, chart_config: { mode: 'auto', chart_type: 'table', bindings: { metrics: [] } } },
    }, 'a');
    expect(useAiContextStore.getState().context!.revision).toBe(revision);
    store.publishContext({
      ...sql,
      analysis: {
        ...sql.analysis,
        chart_config: {
          mode: 'manual',
          chart_type: 'line',
          roles: { d: 'time', 收入金额: 'metric' },
          bindings: { x: 'd', metrics: ['收入金额'] },
        },
      },
    }, 'a');
    expect(useAiContextStore.getState().context!.revision).toBe(revision + 1);
  });

  /**
   * 事件侧（phase: clklog-ai-event-chart-v1）：图表配置进版本，
   * 且**不分 auto/manual** —— AI 会基于当前绑定提案，绑定一变旧提案就该被拦下。
   */
  describe('事件分析的图表配置', () => {
    const event = {
      page: 'event' as const,
      route: '/analysis/event',
      analysis: {
        form: { event: '$AppStart', metrics: [], groups: [], timeRange: { start: '2026-08-01', end: '2026-08-07' } },
        chart_config: {
          mode: 'auto',
          chart_type: 'line',
          roles: { g_0: 'time', m_0: 'metric', m_1: 'metric' },
          bindings: { x: 'g_0', metrics: ['m_0', 'm_1'], ignored: [] },
          options: { units: { m_0: 'number' }, metric_axis: { m_1: 'left' } },
        },
        view: { event_layout: 'both', event_chart: 'line', duration_plain: false, stat_calcs: [], y_unit: 'number' },
      },
    };

    const publish = (patch: Record<string, unknown>) =>
      useAiContextStore.getState().publishContext(
        { ...event, analysis: { ...event.analysis, ...patch } },
        'a',
      );
    const revision = () => useAiContextStore.getState().context!.revision!;

    it('auto 模式下改绑定也换版本（与 SQL 分支的有意差异）', () => {
      publish({});
      const before = revision();
      publish({
        chart_config: { ...event.analysis.chart_config, bindings: { x: 'g_0', metrics: ['m_0'], ignored: [] } },
      });
      expect(revision()).toBe(before + 1);
    });

    it('改轴归属换版本，改单位也换版本', () => {
      publish({});
      const before = revision();
      publish({
        chart_config: { ...event.analysis.chart_config, options: { ...event.analysis.chart_config.options, metric_axis: { m_1: 'right' } } },
      });
      expect(revision()).toBe(before + 1);

      const afterAxis = revision();
      publish({
        chart_config: { ...event.analysis.chart_config, options: { ...event.analysis.chart_config.options, units: { m_0: 'percent_0_100' } } },
      });
      expect(revision()).toBe(afterAxis + 1);
    });

    it('改展示方式换版本', () => {
      publish({});
      const before = revision();
      publish({ view: { ...event.analysis.view, event_layout: 'chart' } });
      expect(revision()).toBe(before + 1);
    });

    it('结果与 loading 变化不换版本', () => {
      publish({});
      const before = revision();
      useAiContextStore.getState().publishContext(
        { ...event, result: { rows: [1, 2, 3] } },
        'a',
      );
      expect(revision()).toBe(before);
    });
  });
});
