import { describe, expect, it } from 'vitest';
import {
  preferredViewFromSqlLayout,
  sqlLayoutFromPreferredView,
  sqlLayoutShowsChart,
  sqlLayoutShowsTable,
} from './sql-result-layout';

describe('sql-result-layout', () => {
  it('defaults chart configs to 图表+表格 like other analysis pages', () => {
    expect(sqlLayoutFromPreferredView('chart')).toBe('both');
    expect(sqlLayoutFromPreferredView(undefined)).toBe('table');
    expect(sqlLayoutFromPreferredView('table')).toBe('table');
    expect(sqlLayoutFromPreferredView('pivot')).toBe('pivot');
  });

  it('persists both/chart as preferred_view chart so dashboard cards stay charts', () => {
    expect(preferredViewFromSqlLayout('both')).toBe('chart');
    expect(preferredViewFromSqlLayout('chart')).toBe('chart');
    expect(preferredViewFromSqlLayout('table')).toBe('table');
    expect(preferredViewFromSqlLayout('pivot')).toBe('pivot');
  });

  it('shows chart and table together only for both', () => {
    expect(sqlLayoutShowsChart('both')).toBe(true);
    expect(sqlLayoutShowsTable('both')).toBe(true);
    expect(sqlLayoutShowsChart('chart')).toBe(true);
    expect(sqlLayoutShowsTable('chart')).toBe(false);
    expect(sqlLayoutShowsChart('table')).toBe(false);
    expect(sqlLayoutShowsTable('table')).toBe(true);
    expect(sqlLayoutShowsChart('pivot')).toBe(false);
    expect(sqlLayoutShowsTable('pivot')).toBe(false);
  });
});
