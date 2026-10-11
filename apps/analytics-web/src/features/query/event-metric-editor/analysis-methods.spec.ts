import { describe, expect, it } from 'vitest';
import { methodsForDataType, analysisLabel, defaultStageReduce } from './analysis-methods';

describe('analysis-methods', () => {
  it('only offers count methods when no property is selected', () => {
    expect(methodsForDataType(undefined)).toEqual(['total_times', 'trig_user_num', 'per_capita_times']);
  });

  it('offers per-capita value for numbers and boolean flags for bools', () => {
    expect(methodsForDataType('number')).toContain('per_capita_num');
    expect(methodsForDataType('string')[0]).toBe('distinct');
    expect(methodsForDataType('string')).toEqual(
      expect.arrayContaining(['sum', 'avg', 'per_capita_num', 'distinct', 'is_empty']),
    );
    expect(methodsForDataType('boolean')).toEqual(
      expect.arrayContaining(['true_num', 'false_num', 'is_empty']),
    );
    expect(methodsForDataType('list')).toEqual(
      expect.arrayContaining(['array_distinct', 'array_item_distinct']),
    );
  });

  it('labels percentiles and defaults user-count stage reduce to uniq_total', () => {
    expect(analysisLabel('percentile', 50)).toBe('中位数');
    expect(defaultStageReduce('trig_user_num')).toBe('uniq_total');
    expect(defaultStageReduce('per_capita_num')).toBe('weighted');
  });
});
