// 纯函数测试：无需 jsdom。EventMetricCard 的组件交互通过浏览器手动验证。
import { describe, expect, it } from 'vitest';
import { nextAlias } from './EventMetricCard';
import type { MetricItem } from '../../../types/dsl.types';

const baseMetric: MetricItem = {
  id: 'm1',
  kind: 'event',
  event: 'AppStart',
  analysis: 'total_times',
  alias: '总次数',
};

describe('nextAlias', () => {
  it('当前 alias 等于旧自动值时改为新自动值', () => {
    // 初始 alias '总次数' 就是 'total_times' 的自动值；改 analysis 时跟随更新
    const next = nextAlias(baseMetric, 'distinct');
    expect(next).toBe('去重数');
  });

  it('当前 alias 是手动值（与旧自动值不同）则保留用户别名', () => {
    const custom: MetricItem = { ...baseMetric, alias: '我的关键指标' };
    expect(nextAlias(custom, 'distinct')).toBe('我的关键指标');
    expect(nextAlias(custom, 'percentile', 90)).toBe('我的关键指标');
  });

  it('当前 alias 为空时使用新自动值', () => {
    const empty: MetricItem = { ...baseMetric, alias: undefined };
    expect(nextAlias(empty, 'distinct')).toBe('去重数');
  });

  it('当前 alias 为纯空格视为空，使用新自动值', () => {
    const blank: MetricItem = { ...baseMetric, alias: '   ' };
    expect(nextAlias(blank, 'distinct')).toBe('去重数');
  });

  it('百分位变更时透传 percentile 到自动值', () => {
    const out = nextAlias(baseMetric, 'percentile', 99);
    expect(out).toBe('P99');
  });
});
