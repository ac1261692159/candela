import { MetaStatsRefreshJob } from './meta-stats-refresh.job';

/**
 * phase: clklog-analytics-worker-singleton-v1 —— 01:00 的埋点元事件统计此前无守卫，
 * ingestor 复用 AppModule 导致生产环境两个进程各跑一遍。
 */
jest.mock('../../config/configuration', () => ({
  appConfig: { background_workers: false },
}));

describe('埋点元事件统计刷新的开工守卫', () => {
  it('后台调度未启用时不查库', async () => {
    const metaEventService = { refreshAll: jest.fn() };
    const prisma = { metaEvent: { groupBy: jest.fn() } };
    const job = new MetaStatsRefreshJob(metaEventService as never, prisma as never);

    await job.handleDailyRefresh();

    expect(prisma.metaEvent.groupBy).not.toHaveBeenCalled();
    expect(metaEventService.refreshAll).not.toHaveBeenCalled();
  });
});
