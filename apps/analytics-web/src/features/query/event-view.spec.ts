import { describe, expect, it } from 'vitest';
import {
  durationPlainFromDsl,
  eventCardChartType,
  eventChartFromDsl,
  eventLayoutFromDsl,
  eventViewPayload,
  eventYUnitFromDsl,
  parseEventChartType,
  parseEventResultLayout,
} from './event-view';

describe('event-view', () => {
  it('defaults layout to both and chart to line', () => {
    expect(parseEventResultLayout(undefined)).toBe('both');
    expect(parseEventChartType('nope')).toBe('line');
    expect(parseEventChartType('pie')).toBe('pie');
    expect(eventLayoutFromDsl({})).toBe('both');
    expect(eventChartFromDsl({}, 'table')).toBe('line');
  });

  it('reads saved _view and falls back to card chart_type', () => {
    expect(eventLayoutFromDsl({ _view: { event_layout: 'table' } })).toBe('table');
    expect(eventChartFromDsl({ _view: { event_chart: 'stack' } }, 'line')).toBe('stack');
    expect(eventChartFromDsl({}, 'number')).toBe('number');
    expect(durationPlainFromDsl({ _view: { duration_plain: true } })).toBe(true);
    expect(eventYUnitFromDsl({ _view: { y_unit: 'duration_sec' } })).toBe('duration_sec');
    expect(eventYUnitFromDsl({})).toBe('number');
  });

  it('payload round-trips into _view keys', () => {
    expect(eventViewPayload({ layout: 'chart', chart: 'bar', durationPlain: true, statCalcs: ['avg', 'max'], yUnit: 'currency_cny' })).toEqual({
      event_layout: 'chart',
      event_chart: 'bar',
      duration_plain: true,
      stat_calcs: ['avg', 'max'],
      y_unit: 'currency_cny',
    });
    expect(eventCardChartType('table', 'pie')).toBe('table');
    expect(eventCardChartType('both', 'cumulative')).toBe('cumulative');
  });
});
