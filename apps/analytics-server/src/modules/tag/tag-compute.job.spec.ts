import { TagComputeJob } from './tag-compute.job';

/**
 * phase: clklog-analytics-worker-singleton-v1 —— 02:30 的标签重算此前无守卫，
 * ingestor 复用 AppModule 导致生产环境两个进程各跑一遍。
 */
jest.mock('../../config/configuration', () => ({
  appConfig: { background_workers: false },
}));

describe('标签每日重算的开工守卫', () => {
  it('后台调度未启用时一行查询都不发', async () => {
    const repository = { listDaily: jest.fn() };
    const compute = { compute: jest.fn() };
    const job = new TagComputeJob(repository as never, compute as never);

    await job.handleDaily();

    expect(repository.listDaily).not.toHaveBeenCalled();
    expect(compute.compute).not.toHaveBeenCalled();
  });
});
