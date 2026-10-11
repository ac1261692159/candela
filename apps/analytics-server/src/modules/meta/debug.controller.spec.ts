/**
 * Debug 控制器入口校验（phase: clklog-analytics-debug-query-v1 的 D4）。
 * limit 非整数一律 400（NaN 进 SQL 会被 CH 拒成 500，且回显引擎报错——生产已复现）；
 * 越界数值仍走 service 收敛，保持 GET /recent 的既有行为（0/-5 → 1、1000 → 100）。
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

import { DebugController } from './debug.controller';
import { QUERY_JOB_SYNC_BUDGET_S } from '../query-job/query-job.policy';
import { DomainError } from '../../i18n/domain-error';
import type { AuthUser } from '../auth/auth.service';
import { emptyIam } from '../iam/iam.types';

const USER = { id: 'u-1', username: 'analyst1', display_name: null, platform_role: 'none' } as AuthUser;

function build() {
  const result = { items: [{ log_time: 'x' }], matched_total: 4, window: '24h', limit: 20, since: 1 };
  const service = {
    recent: jest.fn().mockResolvedValue(result),
    normalizeWindow: jest.fn((w?: string) => w ?? '24h'),
    normalizeLimit: jest.fn((l?: number) => Math.min(100, Math.max(1, Math.trunc(l ?? 20)))),
  };
  const archive = {
    archive: jest.fn().mockResolvedValue({ archived: true, record_id: 'rec-1' }),
    enqueue: jest.fn().mockResolvedValue({ record_id: 'rec-job', reused: false }),
    isEnabled: jest.fn().mockResolvedValue(true),
    setEnabled: jest.fn().mockResolvedValue({ enabled: false }),
    list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    detail: jest.fn().mockResolvedValue({ id: 'rec-1' }),
    remove: jest.fn().mockResolvedValue({ deleted: true, record_id: 'rec-1' }),
  };
  const controller = new DebugController(service as never, archive as never);
  return { controller, service, archive };
}

describe('DebugController 入参校验', () => {
  it.each(['abc', '1.5', '1e3'])('limit=%p 判为非法 → 400 且不打库', async (raw) => {
    const { controller, service } = build();

    await expect(controller.recent('clklogapp', '1_1', undefined, undefined, undefined, raw)).rejects.toMatchObject({
      errorCode: 'meta.debug.invalidLimit',
      status: 400,
    });
    expect(service.recent).not.toHaveBeenCalled();
  });

  it('limit 缺省（undefined / 空串 / 纯空格）走默认值，不判非法', async () => {
    for (const raw of [undefined, '', '   ']) {
      const { controller, service } = build();
      await controller.recent('clklogapp', '1_1', undefined, undefined, undefined, raw);
      expect(service.recent.mock.calls[0][0].limit).toBeUndefined();
    }
  });

  it('limit 为整数（含负号）时透传，由 service 收敛', async () => {
    const { controller, service } = build();

    await controller.recent('clklogapp', '1_1', undefined, undefined, undefined, '-5');

    expect(service.recent).toHaveBeenCalledWith(expect.objectContaining({ limit: -5, distinct_id: '1_1' }), 'clklogapp');
  });

  it('三条件全空 → 400', async () => {
    const { controller } = build();
    await expect(controller.recent('clklogapp')).rejects.toMatchObject({
      errorCode: 'meta.debug.conditionRequired',
      status: 400,
    });
  });

  it('返回命中总数与窗口（不返回裸数组）', async () => {
    const { controller } = build();
    await expect(controller.recent('clklogapp', undefined, undefined, 'fish_open', '7d')).resolves.toMatchObject({
      matched_total: 4,
      window: '24h',
      limit: 20,
    });
  });
});

describe('DebugController 查询 + 留档', () => {
  it('把留档结果合并进响应（archived / record_id）', async () => {
    const { controller, archive } = build();

    const response = await controller.query('clklogapp', USER, { event: 'fish_open', window: '24h', limit: 20 });

    expect(response).toMatchObject({ archived: true, record_id: 'rec-1', matched_total: 4 });
    expect(archive.archive).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'clklogapp', user: USER, durationMs: expect.any(Number) }),
    );
  });

  it('非法窗口在 service 层被拦（400）', async () => {
    const { controller, service } = build();
    service.recent.mockRejectedValue(new DomainError(400 as never, { code: 'meta.debug.invalidWindow', messageKey: 'k' }));

    await expect(controller.query('clklogapp', USER, { event: 'e', window: '30d' as never })).rejects.toMatchObject({
      errorCode: 'meta.debug.invalidWindow',
    });
  });
});

describe('DebugController 两段式（超预算转后台）', () => {
  it('同步超时 → 登记后台任务并返回 running（不带 items）', async () => {
    const { controller, service, archive } = build();
    service.recent.mockRejectedValue(
      new DomainError(504 as never, { code: 'meta.debug.queryTimeout', messageKey: 'meta:error.debug.queryTimeout' }),
    );

    const response = await controller.query('clklogapp', USER, { distinct_id: '1_1', window: '7d', limit: 20 });

    expect(response).toEqual({
      status: 'running',
      record_id: 'rec-job',
      reused: false,
      window: '7d',
      limit: 20,
    });
    expect(archive.enqueue).toHaveBeenCalledWith({
      project: 'clklogapp',
      user: USER,
      query: expect.objectContaining({ distinct_id: '1_1' }),
      window: '7d',
      limit: 20,
    });
    expect(archive.archive).not.toHaveBeenCalled(); // 转后台时不再走同步落档
  });

  it('同步预算取 5 秒（超预算判据由 CH 执行时间给出）', async () => {
    const { controller, service } = build();

    await controller.query('clklogapp', USER, { event: 'e' });

    expect(service.recent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'e' }),
      'clklogapp',
      expect.any(Number),
      { maxExecutionTime: QUERY_JOB_SYNC_BUDGET_S },
    );
  });

  it('非超时错误照旧抛出（不转后台）', async () => {
    const { controller, service, archive } = build();
    service.recent.mockRejectedValue(
      new DomainError(500 as never, { code: 'meta.debug.queryFailed', messageKey: 'meta:error.debug.queryFailed' }),
    );

    await expect(controller.query('clklogapp', USER, { event: 'e' })).rejects.toMatchObject({
      errorCode: 'meta.debug.queryFailed',
    });
    expect(archive.enqueue).not.toHaveBeenCalled();
  });

  it('项目关闭留档时不转后台（任务本身就是一条留档，关了不留痕）', async () => {
    const { controller, service, archive } = build();
    archive.isEnabled.mockResolvedValue(false);
    service.recent.mockRejectedValue(
      new DomainError(504 as never, { code: 'meta.debug.queryTimeout', messageKey: 'meta:error.debug.queryTimeout' }),
    );

    await expect(controller.query('clklogapp', USER, { distinct_id: '1_1', window: '7d' })).rejects.toMatchObject({
      errorCode: 'meta.debug.queryTimeout',
    });
    expect(archive.enqueue).not.toHaveBeenCalled();
  });
});

describe('DebugController 留档管理', () => {  it('列表 / 详情 / 删除 / 开关状态转发到留档服务', async () => {
    const { controller, archive } = build();

    await controller.list('clklogapp', '2', '50');
    await controller.detail('clklogapp', 'rec-1');
    await controller.remove('clklogapp', USER, emptyIam(), 'rec-1');
    await expect(controller.archiveSetting('clklogapp')).resolves.toEqual({ enabled: true });
    await expect(controller.setArchiveSetting('clklogapp', USER, { enabled: false })).resolves.toEqual({ enabled: false });

    expect(archive.list).toHaveBeenCalledWith('clklogapp', 2, 50);
    expect(archive.detail).toHaveBeenCalledWith('clklogapp', 'rec-1');
    expect(archive.remove).toHaveBeenCalledWith('clklogapp', 'rec-1', USER, expect.anything());
    expect(archive.setEnabled).toHaveBeenCalledWith('clklogapp', false, 'analyst1');
  });
});
