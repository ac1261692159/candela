import { FunnelSqlGeneratorService } from '../../src/modules/query/funnel-sql-generator.service';
import type { JoinRegistry } from '../../src/modules/relation/join-registry';
import type { FunnelQuery } from '../../src/types/dsl.types';

function makeQuery(patch: Partial<FunnelQuery> = {}): FunnelQuery {
  return {
    project: 'clklogapp',
    steps: [{ event: 'native_login_trigger' }, { event: '$AppStart' }],
    window_seconds: 7 * 86400,
    time_range: { start: '2026-08-01', end: '2026-09-04' },
    ...patch,
  };
}

describe('FunnelSqlGeneratorService', () => {
  const attributeResolver = {
    inferDataType: jest.fn().mockResolvedValue('string'),
    resolve: jest.fn(async (prop: string) => `JSONExtractString(properties, '${prop}')`),
  };
  const virtualEventService = {
    findDefinition: jest.fn().mockResolvedValue(null),
  };
  const cohortBatches = {
    resolve: jest.fn().mockResolvedValue({ batch_id: 'b1', ready: true }),
  };
  const service = new FunnelSqlGeneratorService(
    attributeResolver as never,
    virtualEventService as never,
    cohortBatches as never,
    { resolve: jest.fn().mockResolvedValue({ batch_id: 'b1', ready: true }) } as never,
    { resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_userxxxx', kind: 'preset' }) } as never,
  );

  it('keeps all funnel step events in the scan so windowFunnel can see step 2+', async () => {
    const { sql, params } = await service.generate(makeQuery());
    expect(sql).toContain('event IN {funnel_events: Array(String)}');
    expect(sql).toContain('windowFunnel({window: UInt32})');
    expect(sql).toContain('step_0');
    expect(sql).toContain('step_1');
    expect(sql).not.toMatch(/AND step_0\s*\)/);
    expect(params.funnel_events).toEqual(['native_login_trigger', '$AppStart']);
  });

  it('omits event IN and step event predicate for any-event steps', async () => {
    const { sql, params } = await service.generate(
      makeQuery({ steps: [{ event: '*' }, { event: '$AppStart' }] }),
    );
    expect(sql).not.toContain('event IN {funnel_events: Array(String)}');
    expect(sql).toContain('project_name = {project: String}');
    expect(sql).toContain('stat_date BETWEEN');
    expect(params.s1_event).toBe('$AppStart');
    expect(params.s0_event).toBeUndefined();
  });

  /**
   * A5：漏斗步骤用**维度表属性**筛选。
   *
   * 维度键走 `{属性}@{字段}`：resolver 注册 LEFT JOIN 取数（CH 23.2 不支持相关子查询），
   * 生成器须把 `joins.render()` 拼在 FROM 之后，步骤条件引用 join 别名。
   */
  it('supports datatable dimension property in a funnel step filter (A5)', async () => {
    const dimResolver = {
      inferDataType: jest.fn().mockResolvedValue('string'),
      resolve: jest.fn(
        async (prop: string, _scope: string, _type: string, ctx: { joins?: JoinRegistry }) => {
          if (!prop.includes('@')) return `JSONExtractString(properties, '${prop}')`;
          const alias = ctx.joins!.register({
            key: 'dtr_dt_goods_goods_id',
            subquery:
              "sa_datatable_rows WHERE datatable_key = 'dt_goods' AND version = 1",
            on: (a: string) =>
              `toString(JSONExtractString(sa_events.properties,'goods_id')) = toString(JSONExtractString(${a}.values,'goods_id'))`,
          });
          return `JSONExtractString(${alias}.values, 'goods_name')`;
        },
      ),
    };
    const dimService = new FunnelSqlGeneratorService(
      dimResolver as never,
      virtualEventService as never,
      cohortBatches as never,
      { resolve: jest.fn().mockResolvedValue({ batch_id: 'b1', ready: true }) } as never,
      { resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_userxxxx', kind: 'preset' }) } as never,
    );

    const { sql } = await dimService.generate(
      makeQuery({
        steps: [
          { event: 'native_login_trigger' },
          {
            event: '$AppStart',
            filters: {
              logic: 'and',
              items: [{ scope: 'event', prop: 'goods_id@goods_name', op: '=', value: '某商品' }],
            },
          },
        ],
      }),
    );

    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('sa_datatable_rows');
    expect(sql).toContain("JSONExtractString(dtr_dt_goods_goods_id_1.values, 'goods_name')");
    expect(dimResolver.resolve).toHaveBeenCalledWith(
      'goods_id@goods_name',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
