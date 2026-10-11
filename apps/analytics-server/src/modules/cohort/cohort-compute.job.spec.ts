import { CohortComputeJob } from './cohort-compute.job';

/**
 * phase: clklog-analytics-worker-singleton-v1 —— 守卫目的是「非生产/ingestor 进程不跑每日重算」。
 * 这三个 @Cron 任务此前完全没有 background_workers 守卫，而 ingestor 复用同一个 AppModule，
 * 于是 02:00 的分群重算在生产环境被两个进程各跑一遍。
 */
jest.mock('../../config/configuration', () => ({
  appConfig: { background_workers: false },
}));

describe('分群每日重算的开工守卫', () => {
  it('后台调度未启用时一行查询都不发', async () => {
    const repository = { listDaily: jest.fn() };
    const compute = { compute: jest.fn() };
    const job = new CohortComputeJob(repository as never, compute as never);

    await job.handleDaily();

    expect(repository.listDaily).not.toHaveBeenCalled();
    expect(compute.compute).not.toHaveBeenCalled();
  });
});
