/**
 * filter 比较符白名单与前端一致性（2026-09-15 验收 DT-EQ）。
 *
 * 生产实测：前端「正则不匹配」(`not_regex`) 在筛选器与分群条件句两个编辑器里都有、
 * 三个 SQL 生成器也都实现了，但校验器没收 —— 用户选它提交必然 400。
 * `eq` 同理（类型声明合法、生成器归一为 `=`）。
 *
 * 本 spec 把「前端提供的全部 op」钉在这里：任何一侧改动而另一侧没跟上，都会红。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    __specConfigMock: true,
  },
}));

import { DslValidatorService } from '../../src/modules/query/dsl-validator.service';

/** 与 apps/analytics-web/src/components/FilterEditor.tsx 的 OPERATORS 逐项对应 */
const FRONTEND_OPS = [
  '=', '!=', 'in', 'not_in', 'contains', 'not_contains', 'regex', 'not_regex',
  'gt', 'gte', 'lt', 'lte', 'is_set', 'not_set',
];

describe('filter op 白名单', () => {
  const service = new DslValidatorService();
  const base = {
    project: 'demo',
    event: 'e1',
    metrics: [{ id: 'm1', event: 'e1', type: 'count' }],
    time_range: { start: '2026-09-14', end: '2026-09-14' },
  } as never;

  it.each(FRONTEND_OPS)('前端提供的 op 全部被接受: %s', (op) => {
    const query = {
      ...(base as object),
      filters: { logic: 'and', items: [{ scope: 'event', prop: 'goods_id', op, value: op.startsWith('is_') || op === 'not_set' ? undefined : 'x' }] },
    };
    expect(() => service.validateEventQuery(query as never)).not.toThrow();
  });

  it('别名 eq 被接受（生成器归一为 =）', () => {
    const query = {
      ...(base as object),
      filters: { logic: 'and', items: [{ scope: 'event', prop: 'goods_id', op: 'eq', value: 'SGD1' }] },
    };
    expect(() => service.validateEventQuery(query as never)).not.toThrow();
  });

  it('真正非法的 op 仍被拒', () => {
    const query = {
      ...(base as object),
      filters: { logic: 'and', items: [{ scope: 'event', prop: 'goods_id', op: 'bogus_op', value: 'x' }] },
    };
    expect(() => service.validateEventQuery(query as never)).toThrow(/filter op 不合法/);
  });
});
