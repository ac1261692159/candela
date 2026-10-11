/**
 * Debug 查询 SQL 与参数（phase: clklog-analytics-debug-query-v1 的 D2/D3/D4）。
 *
 * 三处判据都是「生产实测踩过的坑」：
 * ① 命中总数用 count() OVER ()（LIMIT 前求值），不得再多跑一次 count 查询；
 * ② 时间窗走 epoch 秒 + toDateTime()（naïve 字符串按 CH 服务端时区解释，曾偏 8 小时）；
 * ③ 补 stat_date 下界让分区裁剪生效（实测读行数 9800 万 → 2800 万）。
 *
 * 顶部 mock 掉 appConfig：import 链会拉到 clickhouse.service → configuration，
 * 后者在**没有 .env 的 CI 环境**（env -i）读 CLICKHOUSE_PASSWORD 直接抛错。
 */
jest.mock('../../config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { DebugService } from './debug.service';
import { DomainError } from '../../i18n/domain-error';

/** 2026-10-08 10:00（平台时区 Asia/Shanghai） */
const NOW = Date.parse('2026-10-08T02:00:00Z');

function build(rows: unknown[] = []) {
  const clickHouse = { query: jest.fn().mockResolvedValue(rows) };
  const timezones = { platformTz: 'Asia/Shanghai' };
  const service = new DebugService(clickHouse as never, timezones as never);
  return { service, clickHouse };
}

function lastCall(clickHouse: { query: jest.Mock }) {
  const [sql, params] = clickHouse.query.mock.calls[0] as [string, Record<string, unknown>];
  return { sql, params };
}

/** 取拒绝原因并断言类型（`.catch` 的联合类型在 strict 下不可直接用） */
async function captureError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('期望抛出 DomainError，但正常返回了');
}

describe('DebugService 查询形状', () => {
  it('命中总数走窗口函数，且不与 LIMIT 混为一谈', async () => {
    const { service, clickHouse } = build([{ matched_total: '27492' }]);

    const result = await service.recent({ event: 'fish_open' }, 'clklogapp', NOW);

    const { sql } = lastCall(clickHouse);
    expect(sql).toContain('count() OVER () AS matched_total');
    expect(sql).toContain('ORDER BY log_time DESC');
    expect(sql).toContain('LIMIT {limit: UInt32}');
    expect(result.matched_total).toBe(27492);
  });

  it('时间窗用 epoch 秒参数 + stat_date 下界（不再有 INTERVAL 7 DAY 字面量）', async () => {
    const { service, clickHouse } = build([{ matched_total: 4 }]);

    await service.recent({ event: 'fish_open' }, 'clklogapp', NOW);

    const { sql, params } = lastCall(clickHouse);
    expect(sql).toContain('log_time >= toDateTime({since: UInt32})');
    expect(sql).toContain('stat_date >= toDate({stat_from: String})');
    expect(sql).not.toContain('INTERVAL 7 DAY');
    expect(sql).toContain('project_name = {project: String}');
    expect(params).toMatchObject({
      project: 'clklogapp',
      event: 'fish_open',
      since: Math.floor(NOW / 1000) - 24 * 3600,
      // 窗口起点（上海 10-07）往前留 2 天余量
      stat_from: '2026-10-05',
      limit: 20,
    });
  });

  it('stat_date 下界从窗口起点算，7 天窗不能被截成「今天 - 余量」', async () => {
    // 回归：曾把下界写成「今天 - 2 天」，7 天窗实际只剩 2 天（生产实测 27492 → 8102 条）
    const { service, clickHouse } = build([{ matched_total: 4 }]);

    await service.recent({ event: 'fish_open', window: '7d' }, 'clklogapp', NOW);

    const { sql, params } = lastCall(clickHouse);
    expect(params.stat_from).toBe('2026-09-29'); // 窗口起点 10-01 前 2 天
    expect(sql).not.toContain('stat_date <= '); // 只加下界：设备时钟超前的行仍要可见
  });

  it('窗口三档与默认值', async () => {
    for (const [window, hours] of [
      ['1h', 1],
      ['24h', 24],
      ['7d', 24 * 7],
      [undefined, 24],
    ] as const) {
      const { service, clickHouse } = build([{ matched_total: 1 }]);
      const result = await service.recent({ event: 'e', window }, 'clklogapp', NOW);
      const { params } = lastCall(clickHouse);
      expect(params.since).toBe(Math.floor(NOW / 1000) - hours * 3600);
      expect(result.window).toBe(window ?? '24h');
    }
  });

  it('非法窗口 400（带稳定错误码），不落到 ClickHouse', async () => {
    const { service, clickHouse } = build();

    await expect(service.recent({ event: 'e', window: '30d' }, 'clklogapp', NOW)).rejects.toMatchObject({
      errorCode: 'meta.debug.invalidWindow',
      status: 400,
    });
    expect(clickHouse.query).not.toHaveBeenCalled();
  });

  it('limit 越界收敛到 [1,100]、缺省 20；小数截断', async () => {
    const cases: [number | undefined, number][] = [
      [undefined, 20],
      [0, 1],
      [-5, 1],
      [1000, 100],
      [7.9, 7],
    ];
    for (const [input, expected] of cases) {
      const { service, clickHouse } = build([{ matched_total: 0 }]);
      const result = await service.recent({ event: 'e', limit: input }, 'clklogapp', NOW);
      expect(result.limit).toBe(expected);
      expect(lastCall(clickHouse).params.limit).toBe(expected);
    }
  });

  it('只带给出的过滤条件', async () => {
    const { service, clickHouse } = build([{ matched_total: 0 }]);

    await service.recent({ distinct_id: '1_1', user_key: '1_1' }, 'clklogapp', NOW);

    const { sql, params } = lastCall(clickHouse);
    expect(sql).toContain('distinct_id = {distinct_id: String}');
    expect(sql).toContain('user_key = {user_key: String}');
    expect(sql).not.toContain('event = {event: String}');
    expect(params).not.toHaveProperty('event');
  });

  it('空结果命中数为 0', async () => {
    const { service } = build([]);
    await expect(service.recent({ event: 'e' }, 'clklogapp', NOW)).resolves.toMatchObject({
      items: [],
      matched_total: 0,
    });
  });

  it('ClickHouse 报错只给稳定错误码，不外泄引擎文本', async () => {
    const { service, clickHouse } = build();
    clickHouse.query.mockRejectedValue(new Error("Value nan cannot be parsed as UInt32 for query parameter 'limit'"));

    const error = await captureError(service.recent({ event: 'e' }, 'clklogapp', NOW));

    expect(error).toBeInstanceOf(DomainError);
    expect(error.errorCode).toBe('meta.debug.queryFailed');
    expect(error.getStatus()).toBe(500);
    expect(JSON.stringify(error.getResponse())).not.toContain('UInt32');
  });
});
