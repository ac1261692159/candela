import { describe, expect, it } from 'vitest';
import { fallbackDisplayView, resolveDisplayView, settingsDisplayView } from './card-display';

describe('card-display', () => {
  it('falls back retention table to people_table and trends to nth_trend', () => {
    expect(fallbackDisplayView('retention', 'table')).toBe('people_table');
    expect(fallbackDisplayView('retention', 'daily_trend')).toBe('nth_trend');
    expect(fallbackDisplayView('event', 'stack')).toBe('stack');
    expect(fallbackDisplayView('funnel', 'bar')).toBe('chart');
  });

  it('uses placement display when valid and ignores sql overlay when unset', () => {
    expect(
      resolveDisplayView({ type: 'retention', chart_type: 'nth_trend', display: { view: 'rate_table' } }),
    ).toBe('rate_table');
    expect(resolveDisplayView({ type: 'sql', chart_type: 'line', display: null })).toBeNull();
    expect(settingsDisplayView({ type: 'sql', chart_type: 'line', display: null })).toBe('line');
  });
});
