import type { QueryColumn } from '../../types/dsl.types';

export function splitRetentionColumns(columns: QueryColumn[]): {
  people: QueryColumn[];
  rates: QueryColumn[];
} {
  const identity = columns.filter(
    (col) => col.key === 'cohort_date' || col.key === 'group_col',
  );
  return {
    people: [
      ...identity,
      ...columns.filter((col) => col.key === 'cohort_size' || /^n_\d+$/.test(col.key)),
    ],
    rates: [...identity, ...columns.filter((col) => col.key.endsWith('_rate'))],
  };
}

export function formatRetentionCell(key: string, value: unknown): string {
  if (value == null || value === '') return '-';
  if (key.endsWith('_rate') && typeof value === 'number') {
    return `${(value * 100).toFixed(1)}%`;
  }
  return String(value);
}
