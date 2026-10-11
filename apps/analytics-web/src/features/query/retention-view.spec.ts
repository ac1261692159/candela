import { describe, expect, it } from 'vitest';
import {
  parseRetentionChartType,
  parseRetentionResultLayout,
  retentionCardChartType,
  retentionChartFromDsl,
  retentionLayoutFromDsl,
  retentionViewPayload,
} from './retention-view';

describe('retention-view', () => {
  it('maps legacy trend and daily_trend to nth_trend', () => {
    expect(parseRetentionResultLayout(undefined)).toBe('both');
    expect(parseRetentionResultLayout('trend')).toBe('chart');
    expect(parseRetentionChartType(undefined, 'trend')).toBe('nth_trend');
    expect(parseRetentionChartType('daily_trend')).toBe('nth_trend');
    expect(parseRetentionChartType('line')).toBe('nth_trend');
    expect(retentionLayoutFromDsl({ _view: { retention_layout: 'table' } })).toBe('table');
  });

  it('payload round-trips and card type follows layout', () => {
    expect(retentionViewPayload({ layout: 'chart', chart: 'nth_trend', statCalcs: [] })).toEqual({
      retention_layout: 'chart',
      retention_chart: 'nth_trend',
      stat_calcs: ['last', 'avg'],
    });
    expect(retentionCardChartType('table', 'nth_trend')).toBe('table');
    expect(retentionChartFromDsl({ _view: { retention_layout: 'trend' } }, 'line')).toBe('nth_trend');
  });
});
