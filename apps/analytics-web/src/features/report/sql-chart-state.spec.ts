import { describe, expect, it } from 'vitest';
import { fxDayEventCount, fxLegacyLine, fxPartyFunnel } from '../visualization/chart.fixtures';
import { recommendChart } from '../visualization/chart-recommender';
import { profileColumns } from '../visualization/column-profiler';
import { configAfterExecute, dashboardSqlPresentation, isV1ChartConfig } from './sql-chart-state';
import type { SqlExecuteResult } from '../../types/report.types';

function sqlResult(
  shape: { columns: SqlExecuteResult['columns']; rows: SqlExecuteResult['rows'] },
  extra?: Partial<SqlExecuteResult>,
): SqlExecuteResult {
  return {
    query_id: extra?.query_id ?? 'q1',
    columns: shape.columns,
    rows: shape.rows,
    row_count: extra?.row_count ?? shape.rows.length,
    truncated: extra?.truncated ?? false,
    elapsed_ms: extra?.elapsed_ms ?? 9,
    read_rows: extra?.read_rows ?? shape.rows.length,
    read_bytes: extra?.read_bytes ?? 32,
  };
}

describe('sql-chart-state', () => {
  it('seeds a recommended chart for a new query and keeps legacy cards on the table', () => {
    const result = sqlResult(fxDayEventCount);
    const seeded = configAfterExecute({
      result,
      current: null,
      legacyCardWithoutChart: false,
      openedWithSavedChart: false,
    });
    expect(seeded?.chart_type).toBe('line');
    expect(seeded?.preferred_view).toBe('chart');

    expect(
      configAfterExecute({
        result,
        current: null,
        legacyCardWithoutChart: true,
        openedWithSavedChart: false,
      }),
    ).toBeNull();
  });

  it('does not swap a saved auto config on refresh', () => {
    const result = sqlResult(fxDayEventCount);
    const saved = configAfterExecute({
      result,
      current: null,
      legacyCardWithoutChart: false,
      openedWithSavedChart: false,
    })!;
    const kept = configAfterExecute({
      result: sqlResult(fxPartyFunnel, { query_id: 'q2' }),
      current: saved,
      legacyCardWithoutChart: false,
      openedWithSavedChart: true,
    });
    expect(kept).toBe(saved);
  });

  it('keeps dashboard on table for missing, legacy, or stale configs', () => {
    expect(isV1ChartConfig(fxLegacyLine)).toBe(false);
    expect(
      dashboardSqlPresentation({
        columns: fxDayEventCount.columns,
        rows: fxDayEventCount.rows,
        savedConfig: undefined,
      }).mode,
    ).toBe('table');
    expect(
      dashboardSqlPresentation({
        columns: fxDayEventCount.columns,
        rows: fxDayEventCount.rows,
        savedConfig: fxLegacyLine,
      }).mode,
    ).toBe('table');

    const config = recommendChart(
      profileColumns(fxDayEventCount.columns, fxDayEventCount.rows),
      fxDayEventCount.rows,
    ).recommended!.config!;
    expect(
      dashboardSqlPresentation({
        columns: fxDayEventCount.columns,
        rows: fxDayEventCount.rows,
        savedConfig: config,
      }).mode,
    ).toBe('chart');
    expect(
      dashboardSqlPresentation({
        columns: fxDayEventCount.columns,
        rows: fxDayEventCount.rows,
        savedConfig: { ...config, bindings: { ...config.bindings, x: 'missing_col' } },
      }).mode,
    ).toBe('table');
    expect(
      dashboardSqlPresentation({
        columns: fxDayEventCount.columns,
        rows: fxDayEventCount.rows,
        savedConfig: config,
        overlayView: 'table',
      }).mode,
    ).toBe('table');
  });
});
