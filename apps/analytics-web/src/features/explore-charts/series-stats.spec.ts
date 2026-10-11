import { describe, expect, it } from 'vitest';
import {
  defaultStatCalcs,
  parseStatCalcs,
  reduceSeries,
  seriesStats,
} from './series-stats';

describe('series-stats', () => {
  it('skips nulls and returns null when a series is empty', () => {
    expect(reduceSeries([null, undefined], 'avg')).toBeNull();
    expect(reduceSeries([1, null, 3], 'avg')).toBe(2);
    expect(reduceSeries([null, 4, 8, null], 'last')).toBe(8);
    expect(reduceSeries([null, 4, 8], 'first')).toBe(4);
    expect(reduceSeries([1, 2, 3], 'total')).toBe(6);
  });

  it('defaults number cards to last, not total', () => {
    expect(defaultStatCalcs('number')).toEqual(['last']);
    expect(parseStatCalcs(['total', 'bogus', 'total'], 'pie')).toEqual(['total']);
    expect(parseStatCalcs(undefined, 'line')).toEqual(['last', 'avg']);
  });

  it('builds one row per series', () => {
    const rows = seriesStats(
      [
        { name: 'DAU', values: [10, 20] },
        { name: 'DNU', values: [1, 2] },
      ],
      ['last', 'avg'],
    );
    expect(rows[0]).toEqual({ name: 'DAU', last: 20, avg: 15 });
    expect(rows[1].last).toBe(2);
  });
});
