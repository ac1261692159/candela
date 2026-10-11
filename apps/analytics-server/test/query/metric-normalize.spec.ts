import { methodAllowedForDataType } from '../../src/modules/query/metric-normalize';

describe('methodAllowedForDataType', () => {
  it('allows numeric aggregations on string properties', () => {
    expect(methodAllowedForDataType('sum', 'string')).toBe(true);
    expect(methodAllowedForDataType('avg', 'string')).toBe(true);
    expect(methodAllowedForDataType('per_capita_num', 'string')).toBe(true);
  });

  it('still rejects boolean methods on strings', () => {
    expect(methodAllowedForDataType('true_num', 'string')).toBe(false);
    expect(methodAllowedForDataType('sum', 'boolean')).toBe(false);
  });
});
