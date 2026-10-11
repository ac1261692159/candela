/**
 * 数值变换四则运算（phase: clklog-analytics-metric-v3）。
 *
 * 关键点：变换**只在 SQL 侧应用一次**（事件分析与指标求值共用同一条查询链路）。
 * 这里断言 SQL 片段、归一化与校验；旧定义的 `factor` 必须继续按乘法生效。
 */
import {
  buildTransformSql,
  describeTransform,
  isNoopTransform,
  resolveTransform,
  validateTransform,
} from '../../src/modules/query/metric-transform';

describe('四则运算：SQL 与 JS 语义一致', () => {
  it('乘以：SQL 包裹表达式', () => {
    expect(buildTransformSql('count()', { op: 'mul', value: 0.001 })).toBe('(count()) * 0.001');
  });

  it('除以：毫秒→秒这类换算；再套保留小数位', () => {
    expect(buildTransformSql('sum(x)', { op: 'div', value: 1000, decimals: 2 })).toBe(
      'round((sum(x)) / 1000, 2)',
    );
  });

  it('加上 / 减去：时区补正与剔除基线', () => {
    expect(buildTransformSql('count()', { op: 'add', value: 8 })).toBe('(count()) + 8');
    expect(buildTransformSql('count()', { op: 'sub', value: 1 })).toBe('(count()) - 1');
  });

  it('小数位包在四则运算外层（先算再舍入，SQL 单点完成）', () => {
    expect(buildTransformSql('count()', { op: 'div', value: 1000, decimals: 2 })).toBe(
      'round((count()) / 1000, 2)',
    );
    expect(buildTransformSql('sum(y)', { op: 'add', value: 8, decimals: 1 })).toBe('round((sum(y)) + 8, 1)');
  });

  it('无操作的四则运算不产生 SQL 包裹（乘/除 1，加/减 0）', () => {
    expect(buildTransformSql('count()', { op: 'mul', value: 1 })).toBe('count()');
    expect(buildTransformSql('count()', { op: 'add', value: 0 })).toBe('count()');
    expect(buildTransformSql('count()', { op: 'mul', value: 1, decimals: 1 })).toBe('round(count(), 1)');
  });
});

describe('旧定义兼容（factor = 乘以）', () => {
  it('factor 归一化为 op=mul', () => {
    expect(resolveTransform({ factor: 0.5 })).toEqual({ op: 'mul', value: 0.5 });
    expect(buildTransformSql('count()', { factor: 0.5 })).toBe('(count()) * 0.5');
  });

  it('op/value 与 factor 同时存在时以 op/value 为准', () => {
    expect(resolveTransform({ op: 'div', value: 2, factor: 0.5 })).toEqual({ op: 'div', value: 2 });
  });

  it('只写小数位时视为「不运算、只舍入」', () => {
    expect(resolveTransform({ decimals: 1 })).toEqual({ op: 'mul', value: 1, decimals: 1 });
    expect(buildTransformSql('count()', { decimals: 1 })).toBe('round(count(), 1)');
  });
});

describe('校验与展示', () => {
  it('除以 0 / 非法运算 / 越界数值 / 非法小数位 → 报错', () => {
    expect(validateTransform({ op: 'div', value: 0 })).toContain('不能除以 0');
    expect(validateTransform({ op: 'pow', value: 2 })).toContain('运算不合法');
    expect(validateTransform({ op: 'mul', value: 1e9 })).toContain('绝对值不能超过');
    expect(validateTransform({ op: 'mul', value: 2, decimals: 9 })).toContain('保留小数位');
    expect(validateTransform({ op: 'mul', value: 2, decimals: 2 })).toBeNull();
    expect(validateTransform(null)).toBeNull();
  });

  it('无操作变换被识别（保存时不写入定义）', () => {
    expect(isNoopTransform(resolveTransform({ factor: 1 }))).toBe(true);
    expect(isNoopTransform(resolveTransform({ op: 'add', value: 0 }))).toBe(true);
    expect(isNoopTransform(resolveTransform({ factor: 1, decimals: 2 }))).toBe(false);
    expect(isNoopTransform(resolveTransform({ op: 'div', value: 1000 }))).toBe(false);
  });

  it('展示文案与界面一致', () => {
    expect(describeTransform({ op: 'div', value: 1000, decimals: 2 })).toBe('÷1000，保留 2 位');
    expect(describeTransform({ factor: 0.001 })).toBe('×0.001');
    expect(describeTransform({ op: 'add', value: 8 })).toBe('+8');
    expect(describeTransform({ op: 'sub', value: 1 })).toBe('−1');
    expect(describeTransform(null)).toBe('');
  });
});
