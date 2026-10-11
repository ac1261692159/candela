// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { matchesCardSearch } from './CardConfigModal';

describe('matchesCardSearch', () => {
  const card = { name: '充值漏斗', type: 'sql' };

  it('按名称子串匹配中文', () => {
    expect(matchesCardSearch(card, '充')).toBe(true);
    expect(matchesCardSearch(card, '派对')).toBe(true);
    expect(matchesCardSearch(card, '漏斗')).toBe(true);
  });

  it('按类型中文名匹配', () => {
    expect(matchesCardSearch(card, '自定义')).toBe(true);
    expect(matchesCardSearch({ name: '曝光', type: 'event' }, '事件')).toBe(true);
  });

  it('无匹配时返回 false', () => {
    expect(matchesCardSearch(card, '留存')).toBe(false);
  });

  it('空查询展示全部', () => {
    expect(matchesCardSearch(card, '  ')).toBe(true);
  });
});
