import { describe, expect, it } from 'vitest';
import {
  axisOfMetric,
  formatChartNumber,
  groupMetricsByAxis,
  isMetricUnit,
  mixedUnitAxes,
  parseMetricUnit,
  splitMetricsByUnit,
  unitForSeriesName,
  unitSelectValue,
} from './metric-units';

describe('metric-units', () => {
  it('rejects unknown grafana science units', () => {
    expect(isMetricUnit('humidity')).toBe(false);
    expect(isMetricUnit('watt')).toBe(false);
    expect(parseMetricUnit('nope')).toBe('number');
    expect(unitSelectValue('currency')).toBe('currency_cny');
  });

  it('auto-scales counts, money, duration and ratios', () => {
    expect(formatChartNumber(12000, 'number')).toContain('万');
    expect(formatChartNumber(1.2e8, 'number')).toContain('亿');
    expect(formatChartNumber(90, 'duration_sec')).toContain('分钟');
    expect(formatChartNumber(3600, 'duration_sec')).toContain('小时');
    expect(formatChartNumber(1500, 'duration_ms')).toContain('秒');
    expect(formatChartNumber(0.123, 'ratio_0_1')).toBe('12.3%');
    expect(formatChartNumber(12.3, 'percent_0_100')).toBe('12.3%');
    expect(formatChartNumber(12000, 'currency')).toMatch(/¥.*万/);
    expect(formatChartNumber(1500, 'currency_usd')).toMatch(/\$1\.5K/);
    expect(formatChartNumber(2048, 'bytes_iec')).toContain('KiB');
    expect(formatChartNumber(1500, 'bytes')).toContain('kB');
    expect(formatChartNumber(null, 'number')).toBe('--');
  });

  it('maps forecast series to the source metric unit', () => {
    const units = { 收入金额: 'currency_cny' as const };
    expect(unitForSeriesName('收入金额（预测）', units, 'number')).toBe('currency_cny');
    expect(unitForSeriesName('首充金额', units, 'number')).toBe('number');
  });
});

/**
 * 轴内单位一致（phase: clklog-analytics-axis-unit-coherence-v1）。
 * 判定与渲染共用这几个规则，所以在这里把规则本身钉死。
 */
describe('axis unit coherence', () => {
  it('轴归属默认左轴，显式命名才走右轴', () => {
    expect(axisOfMetric('a')).toBe('left');
    expect(axisOfMetric('b', { metric_axis: { b: 'right' } } as never)).toBe('right');
  });

  it('按轴分组：跨轴不同单位不算混', () => {
    const entries = [
      { key: 'revenue', unit: 'currency_cny' as const },
      { key: 'rate', unit: 'percent_0_100' as const },
    ];
    const axisOf = (key: string) => (key === 'rate' ? 'right' : 'left');
    expect(mixedUnitAxes(entries, axisOf)).toEqual([]);
    expect(groupMetricsByAxis(entries, axisOf).map((group) => group.axis)).toEqual(['left', 'right']);
  });

  it('同一根轴混两种单位才算混，并回哪个指标在哪根轴', () => {
    const entries = [
      { key: 'revenue', unit: 'currency_cny' as const },
      { key: 'count', unit: 'number' as const },
    ];
    const mixed = mixedUnitAxes(entries, () => 'left');
    expect(mixed).toHaveLength(1);
    expect(mixed[0].axis).toBe('left');
    expect(mixed[0].columns).toEqual(['revenue', 'count']);
    expect(mixed[0].units).toEqual(['currency_cny', 'number']);
  });

  it('按单位拆轴：最大的一组留左轴，其余进右轴', () => {
    const entries = [
      { key: 'a', unit: 'number' as const },
      { key: 'b', unit: 'number' as const },
      { key: 'c', unit: 'percent_0_100' as const },
    ];
    expect(splitMetricsByUnit(entries)).toEqual({ a: 'left', b: 'left', c: 'right' });
  });

  it('少搬动优先：已有一个数值指标在右轴时，把数值组留在右轴而不是硬把百分比挪过去', () => {
    // 使用者截图里的真实配置：人均(数值,左)、用户数(数值,右)、总量(百分比,左)。
    // 若只按「大组留左轴」，会得到右轴 = 数值 + 百分比（仍然混），等于没修。
    const entries = [
      { key: 'mean', unit: 'number' as const },
      { key: 'users', unit: 'number' as const },
      { key: 'total', unit: 'percent_0_100' as const },
    ];
    const current = (key: string) => (key === 'users' ? 'right' : 'left');
    expect(splitMetricsByUnit(entries, current)).toEqual({ total: 'left', mean: 'right', users: 'right' });
  });

  it('单位只有一种时不产生拆轴动作（按钮据此不显示）', () => {
    expect(splitMetricsByUnit([{ key: 'a', unit: 'number' as const }])).toEqual({});
    expect(splitMetricsByUnit([
      { key: 'a', unit: 'number' as const },
      { key: 'b', unit: 'number' as const },
    ])).toEqual({});
  });

  it('三组单位时右轴仍会混：只保证左轴干净，不虚构第三根轴', () => {
    const assignment = splitMetricsByUnit([
      { key: 'a', unit: 'number' as const },
      { key: 'b', unit: 'number' as const },
      { key: 'c', unit: 'percent_0_100' as const },
      { key: 'd', unit: 'currency_cny' as const },
    ]);
    expect(assignment).toEqual({ a: 'left', b: 'left', c: 'right', d: 'right' });
    expect(mixedUnitAxes(
      Object.entries(assignment).map(([key]) => ({
        key,
        unit: key === 'a' || key === 'b' ? 'number' : key === 'c' ? 'percent_0_100' : 'currency_cny',
      })) as never,
      (key: string) => assignment[key],
    )).toHaveLength(1);
  });
});
