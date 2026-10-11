import { describe, expect, it } from 'vitest';
import { nextLegendIsolate, seriesNamesFromOption } from './legend-isolate';

describe('legend-isolate', () => {
  const names = ['收入金额', '首充金额', '复充金额'];

  it('clicking a series isolates it instead of hiding it', () => {
    const first = nextLegendIsolate(names, null, '首充金额');
    expect(first.isolatedName).toBe('首充金额');
    expect(first.selected).toEqual({ 收入金额: false, 首充金额: true, 复充金额: false });
  });

  it('clicking the isolated series restores all', () => {
    const restored = nextLegendIsolate(names, '首充金额', '首充金额');
    expect(restored.isolatedName).toBeNull();
    expect(restored.selected).toEqual({ 收入金额: true, 首充金额: true, 复充金额: true });
  });

  it('clicking another series while isolated switches isolate', () => {
    const next = nextLegendIsolate(names, '首充金额', '复充金额');
    expect(next.isolatedName).toBe('复充金额');
    expect(next.selected['复充金额']).toBe(true);
    expect(next.selected['首充金额']).toBe(false);
  });

  it('reads series names from an echarts option', () => {
    expect(seriesNamesFromOption({ series: [{ name: 'A' }, { name: 'A（预测）' }] })).toEqual(['A', 'A（预测）']);
  });
});
