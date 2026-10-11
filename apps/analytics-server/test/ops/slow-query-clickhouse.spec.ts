/**
 * 慢 SQL 通道的时间窗换算回归（phase: clklog-analytics-ops-console-v1）。
 *
 * 背景（CODE_HANDOVER AL-01）：旧实现把 Date 用 `toISOString()` 转成 **UTC 字符串**
 * 传给 `{since:DateTime}`，ClickHouse 按服务端时区（生产 Asia/Shanghai）解释字面量，
 * 时间窗整体偏 8 小时——「近 5 分钟」实际查了近 8 小时，`slow_query_spike` 规则因此
 * 连续误报 8 天。现改为 epoch 秒 + `toDateTime()`，与双方时区无关。
 * 本 spec 锁住这个机制，防止有人改回字符串传参。
 */

const mockQuery = jest.fn();

// clickhouse.service 顶层加载 YAML 配置（需真实密钥），CI 里没有——同 test/ops 其它 spec 隔离掉
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    clickhouse: {
      write: { protocol: 'http', host: '127.0.0.1', port: 8123, username: 'default', password: 'x', database: 'clklog_sa' },
      readonly: { protocol: 'http', host: '127.0.0.1', port: 8123, username: 'sa_readonly', password: 'x', database: 'clklog_sa' },
    },
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
  },
}));

jest.mock('@clickhouse/client', () => ({
  createClient: jest.fn(() => ({ query: mockQuery, close: jest.fn(async () => undefined) })),
}));

import { ClickHouseService, toClickHouseEpochSeconds } from '../../src/modules/shared/clickhouse.service';

describe('ClickHouseService.querySlowQueries 时间窗', () => {
  const since = new Date('2026-09-15T06:14:08Z');

  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ json: async () => [] });
  });

  function newService(): ClickHouseService {
    const service = new ClickHouseService();
    service.onModuleInit();
    return service;
  }

  it('时间下界用 epoch 秒传参，SQL 侧 toDateTime() 还原，不再出现 UTC 字符串', async () => {
    await newService().querySlowQueries({ since, minDurationMs: 5000, status: 'all', limit: 100 });

    const request = mockQuery.mock.calls[0][0];
    expect(request.query).toContain('event_time >= toDateTime({since:UInt32})');
    expect(request.query).not.toContain('{since:DateTime}');
    expect(typeof request.query_params.since).toBe('number');
    expect(request.query_params.since).toBe(toClickHouseEpochSeconds(since));
    expect(request.query).toContain('query_duration_ms >= {minDuration:UInt64}');
  });

  it('until 与 status 过滤同样生效，LIMIT 收敛到服务端上限', async () => {
    const until = new Date('2026-09-15T07:00:00Z');
    await newService().querySlowQueries({ since, until, minDurationMs: 0, status: 'failed', limit: 99_999 });

    const request = mockQuery.mock.calls[0][0];
    expect(request.query).toContain('event_time <= toDateTime({until:UInt32})');
    expect(request.query_params.until).toBe(toClickHouseEpochSeconds(until));
    expect(request.query).toContain("type = 'ExceptionWhileProcessing'");
    expect(request.query).toContain('LIMIT 1000');
  });

  it('epoch 是绝对时刻，不随进程时区变化', () => {
    expect(toClickHouseEpochSeconds(since)).toBe(Date.UTC(2026, 8, 15, 6, 14, 8) / 1000);
    // 毫秒被截断（ClickHouse DateTime 精度为秒）
    expect(toClickHouseEpochSeconds(new Date('2026-09-15T06:14:08.987Z'))).toBe(toClickHouseEpochSeconds(since));
  });
});
