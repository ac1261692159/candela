import { MetaReconcileService } from '../../src/modules/ops/meta-reconcile.service';
import { DataMgmtController } from '../../src/modules/ops/data-mgmt.controller';
import type { AuthUser } from '../../src/modules/auth/auth.service';
import { ClickHouseService } from '../../src/modules/shared/clickhouse.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';

/**
 * 数据 ↔ 元数据对账（phase: clklog-data-management-v1.2，R4-c）。
 * 覆盖：差集口径、未来日期标记、窗口过滤、截断标记、查询护栏。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: { query: { maxExecutionTime: 30 }, log: { level: 'info' }, background_workers: false },
}));

function harness(rows: Array<{ event: string; cnt: string; min_d: string; max_d: string; future: string }>, registered: string[]) {
  const clickHouse = { query: jest.fn(async () => rows) } as unknown as ClickHouseService;
  const prisma = {
    metaEvent: { findMany: jest.fn(async () => registered.map((event_key) => ({ event_key }))) },
  } as unknown as PrismaService;
  return { service: new MetaReconcileService(clickHouse, prisma), clickHouse: clickHouse as any, prisma: prisma as any };
}

describe('MetaReconcileService.unregisteredEvents', () => {
  it('差集：数据里有、元数据没有 → 未登记；元数据有、数据没有 → 幽灵登记', async () => {
    const { service } = harness(
      [
        { event: '$SignUp', cnt: '448923', min_d: '2026-07-28', max_d: '2026-11-08', future: '1200' },
        { event: 'Buy', cnt: '10', min_d: '2026-10-01', max_d: '2026-10-08', future: '0' },
      ],
      ['Buy', 'zz_cleanup_probe'],
    );
    const out = await service.unregisteredEvents('clklogapp', { today: '2026-10-09' });
    expect(out.unregistered).toEqual([
      { event: '$SignUp', rows: 448923, min_date: '2026-07-28', max_date: '2026-11-08', has_future: true },
    ]);
    expect(out.ghost_registered).toEqual(['zz_cleanup_probe']);
    expect(out.data_events).toBe(2);
    expect(out.registered_events).toBe(2);
    // 默认窗口 14 天（实测 ~27s 稳定；30 天会随 CH 负载波动被估算拒绝，可用选择器手动放大）
    expect(out.window_days).toBe(14);
    expect(out.window_from).toBe('2026-09-26');
  });

  it('ClickHouse 估算超限 → 翻译成可操作错误（建议缩小窗口 / 用脚本查历史）', async () => {
    const clickHouse = {
      query: jest.fn(async () => {
        throw new Error('Estimated query execution time (81.1 seconds) is too long. Maximum: 120.');
      }),
    } as unknown as ClickHouseService;
    const prisma = { metaEvent: { findMany: jest.fn(async () => []) } } as unknown as PrismaService;
    const service = new MetaReconcileService(clickHouse, prisma);
    await expect(service.unregisteredEvents('clklogapp', { today: '2026-10-09' })).rejects.toMatchObject({
      errorCode: 'ops.metaReconcile.windowTooWide',
    });
  });

  it('查询带护栏（300s / 1GB / 2 线程）且按项目过滤（红线）', async () => {
    const { service, clickHouse } = harness([], []);
    await service.unregisteredEvents('clklogapp', { today: '2026-10-09', windowDays: 7 });
    const [sql, params, options] = clickHouse.query.mock.calls[0];
    expect(sql).toContain('project_name = {project: String}');
    expect(sql).toContain('stat_date >= {from: Date}');
    expect(params).toMatchObject({ project: 'clklogapp', from: '2026-10-03', today: '2026-10-09' });
    expect(options).toMatchObject({ maxExecutionTime: 300, maxMemoryUsage: 1_000_000_000, maxThreads: 2 });
  });

  it('窗口与 limit 夹紧（窗口 1~30 天；limit 1~200 条），超量标 truncated', async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({
      event: `e${i}`, cnt: '1', min_d: '2026-10-01', max_d: '2026-10-01', future: '0',
    }));
    const { service } = harness(many, []);
    const out = await service.unregisteredEvents('clklogapp', { today: '2026-10-09', windowDays: 9999, limit: 1 });
    expect(out.window_days).toBe(30);
    expect(out.unregistered).toHaveLength(1);
    expect(out.truncated).toBe(true);

    // limit=0 → 夹到 1；3 条未登记 > 1 → 仍标 truncated（截断判定与夹紧后的 limit 比较）
    const clamped = await service.unregisteredEvents('clklogapp', { today: '2026-10-09', windowDays: 0, limit: 0 });
    expect(clamped.window_days).toBe(1);
    expect(clamped.truncated).toBe(true);
  });
});

describe('未登记事件接口的参数容错（controller）', () => {
  it('重复的 project query 参数取第一个（否则服务端收到 "a,a" 过滤不到任何行）', async () => {
    const calls: Array<[string, unknown]> = [];
    const metaReconcile = {
      unregisteredEvents: async (project: string, options: unknown) => {
        calls.push([project, options]);
        return {} as never;
      },
    };
    const controller = new DataMgmtController(
      {} as never,
      {} as never,
      metaReconcile as never,
      undefined as never,
    );
    const admin = { username: 'admin', platform_role: 'super_admin' } as unknown as AuthUser;
    await controller.unregisteredEvents(admin, ['clklogapp', 'clklogapp'], '30');
    expect(calls[0][0]).toBe('clklogapp');
    // 前端改用 params 后本不该再重复；这里保证「万一重复也不静默出错」
    expect((calls[0][1] as { windowDays?: number }).windowDays).toBe(30);
  });
});
