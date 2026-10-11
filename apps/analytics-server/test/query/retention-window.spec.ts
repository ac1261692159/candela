import {
  addRetentionPeriods,
  asRetentionGranularity,
  isRetentionWindowImmature,
  maskImmatureRetentionRow,
} from '../../src/modules/query/retention-window';
import { ymdInTz } from '../../src/modules/time/calendar';

describe('retention-window', () => {
  it('treats today cohort D1 as immature on the same calendar day', () => {
    expect(addRetentionPeriods('2026-09-10', 1, 'day')).toBe('2026-09-11');
    expect(isRetentionWindowImmature('2026-09-10', 1, 'day', '2026-09-10')).toBe(true);
    expect(isRetentionWindowImmature('2026-09-09', 1, 'day', '2026-09-10')).toBe(false);
    expect(isRetentionWindowImmature('2026-09-04', 6, 'day', '2026-09-10')).toBe(false);
    expect(isRetentionWindowImmature('2026-09-04', 7, 'day', '2026-09-10')).toBe(true);
  });

  it('nulls count and rate for immature N', () => {
    const masked = maskImmatureRetentionRow(
      { cohort_date: '2026-09-10', cohort_size: 683, n_1: 0, n_1_rate: 0, n_2: 0, n_2_rate: 0 },
      [1, 2],
      'day',
      '2026-09-10',
    );
    expect(masked.n_1).toBeNull();
    expect(masked.n_1_rate).toBeNull();
    expect(masked.cohort_size).toBe(683);
  });

  it('formats platform-calendar dates as YYYY-MM-DD', () => {
    expect(ymdInTz('Asia/Shanghai', new Date('2026-09-10T16:30:00+08:00'))).toBe('2026-09-10');
    expect(ymdInTz('UTC', new Date('2026-09-10T16:30:00+08:00'))).toBe('2026-09-10');
    expect(ymdInTz('America/New_York', new Date('2026-09-10T16:30:00+08:00'))).toBe('2026-09-10');
  });

  it('narrows unexpected granularity to day', () => {
    expect(asRetentionGranularity('week')).toBe('week');
    expect(asRetentionGranularity('month')).toBe('month');
    expect(asRetentionGranularity('hour')).toBe('day');
    expect(asRetentionGranularity(undefined)).toBe('day');
  });
});
