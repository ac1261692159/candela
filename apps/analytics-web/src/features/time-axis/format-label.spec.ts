import { describe, expect, it } from 'vitest';
import { formatTimeAxisLabel } from './format-label';

describe('formatTimeAxisLabel', () => {
  it('prints calendar days as 月/日, not a bare day number', () => {
    expect(formatTimeAxisLabel('2026-09-03')).toBe('9月3日');
    expect(formatTimeAxisLabel('2026-09-05')).toBe('9月5日');
    expect(formatTimeAxisLabel('2026-09-06 00:00:00')).toBe('9月6日');
  });

  it('keeps clock time when the bucket is finer than a day', () => {
    expect(formatTimeAxisLabel('2026-09-06 14:30:00')).toBe('9月6日 14:30');
  });
});
