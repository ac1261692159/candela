/**
 * SlowQueryService 单测（phase: clklog-analytics-ops-console-v1）。
 */
// clickhouse.service 顶层会加载 YAML 配置（需要 APP_CONFIG_PATH 与真实密钥），
// 单测里隔离掉，只保留本服务用到的字段。
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
  },
}));

import { Test } from '@nestjs/testing';
import { SlowQueryService, SLOW_QUERY_RETENTION_NOTE } from '../../src/modules/ops/slow-query.service';
import { ClickHouseService } from '../../src/modules/shared/clickhouse.service';

describe('SlowQueryService', () => {
  let service: SlowQueryService;
  let clickhouse: { querySlowQueries: jest.Mock };

  beforeEach(async () => {
    clickhouse = { querySlowQueries: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      providers: [SlowQueryService, { provide: ClickHouseService, useValue: clickhouse }],
    }).compile();
    service = moduleRef.get(SlowQueryService);
  });

  it('未传参数时使用默认窗口 24h / 5000ms / 100 条', async () => {
    await service.list({});
    const input = clickhouse.querySlowQueries.mock.calls[0][0];
    expect(input.status).toBe('all');
    expect(input.limit).toBe(100);
    expect(input.minDurationMs).toBe(5000);
    const hours = (Date.now() - input.since.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24, 1);
  });

  it('按传入的小时数换算 since', async () => {
    await service.list({ hours: 6 });
    const input = clickhouse.querySlowQueries.mock.calls[0][0];
    const hours = (Date.now() - input.since.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(6, 1);
  });

  it('透传状态与阈值', async () => {
    await service.list({ status: 'failed', min_duration_ms: 12000, limit: 20 });
    expect(clickhouse.querySlowQueries).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', minDurationMs: 12000, limit: 20 }),
    );
  });

  it('整形出参：type 映射为 status，空异常归 null', async () => {
    clickhouse.querySlowQueries.mockResolvedValue([
      {
        event_time: '2026-09-07 10:00:00',
        query_duration_ms: '8000',
        read_rows: '100',
        read_bytes: '2048',
        memory_usage: '4096',
        user: 'sa_readonly',
        type: 'ExceptionWhileProcessing',
        query: 'SELECT 1',
        exception: 'Timeout error.',
      },
      {
        event_time: '2026-09-07 10:01:00',
        query_duration_ms: 6000,
        read_rows: 2,
        read_bytes: 20,
        memory_usage: 30,
        user: 'default',
        type: 'QueryFinish',
        query: 'SELECT 2',
        exception: '',
      },
    ]);

    const res = await service.list({});
    expect(res.items).toHaveLength(2);
    expect(res.items[0]).toEqual({
      event_time: '2026-09-07 10:00:00',
      duration_ms: 8000,
      read_rows: 100,
      read_bytes: 2048,
      memory_usage: 4096,
      user: 'sa_readonly',
      status: 'failed',
      query: 'SELECT 1',
      exception: 'Timeout error.',
    });
    expect(res.items[1].status).toBe('success');
    expect(res.items[1].exception).toBeNull();
  });

  it('返回保留期说明，避免用户把日志过期误读为没有慢查询', async () => {
    const res = await service.list({ hours: 1 });
    expect(res.retention_note).toBe(SLOW_QUERY_RETENTION_NOTE);
    expect(res.window.hours).toBe(1);
  });
});
