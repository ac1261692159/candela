import { describe, expect, it } from 'vitest';
import { suggestAxisSplit, type AxisSplitCandidate } from './axis-suggest';

const metric = (key: string, name: string, values: Array<number | null>): AxisSplitCandidate => ({
  key,
  name,
  values,
});

describe('suggestAxisSplit', () => {
  it('实例数据：18641 / 190.214 / 98 三个指标，把小的两个拆到右轴', () => {
    const suggestion = suggestAxisSplit([
      metric('m_0', '消耗总量', [18641, 54, 10]),
      metric('m_1', '消耗用户数', [98, 8, 1]),
      metric('m_2', '消耗均值_人均', [190.214, 6.75, 10]),
    ]);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.keys).toEqual(['m_1', 'm_2']);
    expect(suggestion!.names).toEqual(['消耗用户数', '消耗均值_人均']);
    expect(suggestion!.axes).toEqual({ m_0: 'left', m_1: 'right', m_2: 'right' });
    expect(suggestion!.ratio).toBe(98);
  });

  it('量级相近时不建议', () => {
    expect(
      suggestAxisSplit([
        metric('m_0', 'A', [100, 120]),
        metric('m_1', 'B', [80, 90]),
        metric('m_2', 'C', [60, 70]),
      ]),
    ).toBeNull();
  });

  it('单指标、空指标、全 0 都不建议', () => {
    expect(suggestAxisSplit([metric('m_0', 'A', [1, 2])])).toBeNull();
    expect(suggestAxisSplit([])).toBeNull();
    expect(
      suggestAxisSplit([metric('m_0', 'A', [0, 0]), metric('m_1', 'B', [0, null])]),
    ).toBeNull();
  });

  it('已配置右轴时不再建议', () => {
    expect(
      suggestAxisSplit(
        [metric('m_0', 'A', [18641]), metric('m_1', 'B', [98])],
        { m_1: 'right' },
      ),
    ).toBeNull();
    // 全是左轴的显式配置仍可建议
    expect(
      suggestAxisSplit([metric('m_0', 'A', [18641]), metric('m_1', 'B', [98])], { m_0: 'left' }),
    ).not.toBeNull();
  });

  it('用断层而非中位数分界：指标多于三个时切在真正的量级断口', () => {
    // 量级梯队 1 / 1.2 / 200000 / 250000，断层在 1.2 与 200000 之间
    const suggestion = suggestAxisSplit([
      metric('m_0', 'A', [1]),
      metric('m_1', 'B', [1.2]),
      metric('m_2', 'C', [200_000]),
      metric('m_3', 'D', [250_000]),
    ]);
    expect(suggestion!.keys).toEqual(['m_0', 'm_1']);
  });

  it('负值与 null 按绝对值口径参与，null 被忽略', () => {
    const suggestion = suggestAxisSplit([
      metric('m_0', 'A', [-1000, null, 500]),
      metric('m_1', 'B', [null, 2, 3]),
    ]);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.keys).toEqual(['m_1']);
  });

  it('比率缺口不足阈值（49 倍）时不建议', () => {
    expect(
      suggestAxisSplit([metric('m_0', 'A', [4900]), metric('m_1', 'B', [100])]),
    ).toBeNull();
    expect(
      suggestAxisSplit([metric('m_0', 'A', [5000]), metric('m_1', 'B', [100])]),
    ).not.toBeNull();
  });
});
