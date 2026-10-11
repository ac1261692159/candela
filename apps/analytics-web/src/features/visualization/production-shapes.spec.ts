import { describe, expect, it } from 'vitest';
import { recommendChart } from './chart-recommender';
import { profileColumns } from './column-profiler';
import { fxCountryCount, fxDayEventCount, fxErrorCode, fxOsUniq, fxPartyFunnel, fxRechargeDailyTrend, fxSingleRowMetrics, fxWideFunnel } from './chart.fixtures';

/**
 * 生产 45 张 SQL 卡的脱敏形状回归清单（CHART-AC31）。
 * 列名/类型来自模板与审计名称，不含 SQL 全文和筛选值。
 * 期望：默认视图、不得跨行累加 UV/比率。
 */
const shapes = [
  { id: 'trend', columns: fxDayEventCount.columns, rows: fxDayEventCount.rows, view: 'line', forbid: 'sum-across-rows' },
  { id: 'recharge-trend', columns: fxRechargeDailyTrend.columns, rows: fxRechargeDailyTrend.rows, view: 'line', forbid: 'mixed-units-from-recharge-uv' },
  { id: 'rank', columns: fxCountryCount.columns, rows: fxCountryCount.rows, view: 'bar', forbid: 'pie-default' },
  { id: 'uniq-bar', columns: fxOsUniq.columns, rows: fxOsUniq.rows, view: 'bar', forbid: 'pie-additive' },
  { id: 'kpi', columns: fxSingleRowMetrics.columns, rows: fxSingleRowMetrics.rows, view: 'number', forbid: 'sum-across-rows' },
  { id: 'funnel-wide', columns: fxWideFunnel.columns, rows: fxWideFunnel.rows, view: 'funnel', forbid: 'echarts-value-sort' },
  { id: 'funnel-party', columns: fxPartyFunnel.columns, rows: fxPartyFunnel.rows, view: 'funnel', forbid: 'first-row-or-sum-uv' },
  { id: 'error-code', columns: fxErrorCode.columns, rows: fxErrorCode.rows, view: 'bar', forbid: 'id-as-metric' },
];

describe('production SQL card shape checklist', () => {
  it('records expected default views and aggregation red lines', () => {
    for (const shape of shapes) {
      const inferred = recommendChart(profileColumns(shape.columns, shape.rows), shape.rows);
      expect(inferred.recommended?.chartType, shape.id).toBe(shape.view);
      if (shape.forbid === 'first-row-or-sum-uv') {
        expect(inferred.recommended?.config?.bindings.row_selector).toBeUndefined();
      }
      if (shape.forbid === 'id-as-metric') {
        expect(profileColumns(shape.columns, shape.rows).find((item) => item.key === 'error_code')?.role).toBe('dimension');
      }
    }
  });
});
