// 顶层加载 YAML 配置的模块（clickhouse/card 服务等）在单测里隔离，CI 无密钥也能跑
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { FunnelQueryService } from '../../src/modules/query/funnel-query.service';
import { DslValidatorService } from '../../src/modules/query/dsl-validator.service';

describe('funnel result shaping', () => {
  it('derives cumulative 4 -> 2 -> 1 counts from mutually exclusive levels', async () => {
    const service = new FunnelQueryService(new DslValidatorService(),
      { generate: async () => ({ sql: 'fixture', params: {}, stepCount: 3 }) } as never,
      { get: async () => null, set: async () => undefined } as never,
      { query: async () => [{ level: 1, users: 2 }, { level: 2, users: 1 }, { level: 3, users: 1 }] } as never,
      { assertEvents() {}, applyToEventsQuery: () => ({}), cacheKey: () => 'fixture' } as never,
      { revision: async () => 'dt0', attachToColumns: async (_project: string, columns: unknown) => columns } as never,
      { dimensionDisplayNames: async () => new Map() } as never);
    const result = await service.analyze({ project: 'fixture', steps: [{ event: 'buy' }, { event: 'draw' }, { event: 'show' }],
      window_seconds: 86400, time_range: { start: '2026-08-01', end: '2026-08-07' } }, 'fixture');
    expect(result.rows[0]).toMatchObject({ step_1: 4, step_2: 2, step_3: 1,
      step_2_conversion: 0.5, step_3_conversion: 0.5, step_2_churn: 2, step_3_churn: 1 });
  });
});
