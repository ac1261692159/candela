import { describe, expect, it } from 'vitest';
import { formatRetentionCell, splitRetentionColumns } from './retention-tables';
import type { QueryColumn } from '../../types/dsl.types';

const columns: QueryColumn[] = [
  { key: 'cohort_date', title: '队列日期' },
  { key: 'cohort_size', title: '人数' },
  { key: 'n_1', title: 'D1' },
  { key: 'n_1_rate', title: 'D1 留存率' },
];

describe('retention-tables', () => {
  it('splits count columns from rate columns', () => {
    const { people, rates } = splitRetentionColumns(columns);
    expect(people.map((col) => col.key)).toEqual(['cohort_date', 'cohort_size', 'n_1']);
    expect(rates.map((col) => col.key)).toEqual(['cohort_date', 'n_1_rate']);
  });

  it('renders immature cells as dash', () => {
    expect(formatRetentionCell('n_1', null)).toBe('-');
    expect(formatRetentionCell('n_1_rate', null)).toBe('-');
    expect(formatRetentionCell('n_1_rate', 0.4)).toBe('40.0%');
  });
});
