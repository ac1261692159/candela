/**
 * 异步查询 worker 的管道行为（phase: clklog-analytics-debug-async-query-v1；
 * 多 kind 分派与轮转 —— phase: clklog-analytics-user-timeline-v1）。
 *
 * 管道负责：门禁、节奏、卡死回收、跨 kind 轮转串行认领；具体执行在 runner 里。
 *
 * 顶部 mock 掉 appConfig：import 链会拉到 clickhouse.service → configuration，
 * 后者在没有 .env 的 CI 环境（env -i）读 CLICKHOUSE_PASSWORD 直接抛错。
 */
jest.mock('../../config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { QueryJobWorker } from './query-job.worker';
import { QUERY_JOB_STALE_MS } from './query-job.policy';
import type { ClaimedQueryJob, QueryJobRunner } from './query-job.types';

const JOB = (id: string): ClaimedQueryJob => ({ id, project: 'clklogapp', spec: {}, createdAt: new Date() });

function runner(kind: string, hasJob = true): QueryJobRunner & { run: jest.Mock; claimNext: jest.Mock; reclaimStale: jest.Mock } {
  return {
    kind,
    reclaimStale: jest.fn().mockResolvedValue(0),
    claimNext: jest.fn().mockResolvedValue(hasJob ? JOB(`${kind}-job`) : null),
    run: jest.fn().mockResolvedValue(undefined),
  } as never;
}

describe('QueryJobWorker 管道', () => {
  it('每轮先回收各 kind 的卡死 running（cutoff ≈ 现在 - 10 分钟）', async () => {
    const a = runner('debug', false);
    const b = runner('user_timeline', false);
    const worker = new QueryJobWorker([a, b]);
    const before = Date.now();

    await worker.tick();

    for (const r of [a, b]) {
      const cutoff = r.reclaimStale.mock.calls[0][0] as Date;
      expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(QUERY_JOB_STALE_MS - 1000);
      expect(before - cutoff.getTime()).toBeLessThan(QUERY_JOB_STALE_MS + 5000);
    }
  });

  it('每轮最多执行 1 条任务（保护 ClickHouse）', async () => {
    const a = runner('debug', true);
    const b = runner('user_timeline', true);
    const worker = new QueryJobWorker([a, b]);

    await worker.tick();

    expect(a.run).toHaveBeenCalledTimes(1);
    expect(b.run).not.toHaveBeenCalled();
  });

  it('跨 kind 轮转：上一轮从 debug 取了任务，下一轮从时间线开始', async () => {
    const a = runner('debug', true);
    const b = runner('user_timeline', true);
    const worker = new QueryJobWorker([a, b]);

    await worker.tick(); // 从 debug 开始
    await worker.tick(); // 应轮到 user_timeline

    expect(a.run).toHaveBeenCalledTimes(1);
    expect(b.run).toHaveBeenCalledTimes(1);
  });

  it('前面的 runner 没有待办时顺延到下一个', async () => {
    const a = runner('debug', false);
    const b = runner('user_timeline', true);
    const worker = new QueryJobWorker([a, b]);

    await worker.tick();

    expect(b.run).toHaveBeenCalledTimes(1);
  });

  it('runner 执行抛异常只记日志，不中断管道', async () => {
    const a = runner('debug', true);
    a.run.mockRejectedValue(new Error('boom'));
    const worker = new QueryJobWorker([a]);

    await expect(worker.tick()).resolves.toBeUndefined();
    await expect(worker.tick()).resolves.toBeUndefined();
  });

  it('重入保护：执行中再触发 tick 不会重复认领', async () => {
    let release: (v: ClaimedQueryJob | null) => void = () => {};
    const a = runner('debug', true);
    a.claimNext.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const worker = new QueryJobWorker([a]);

    const first = worker.tick();
    await worker.tick();
    release(JOB('x'));
    await first;

    expect(a.claimNext).toHaveBeenCalledTimes(1);
  });

  it('回收自身异常不抛出，下一轮还能继续', async () => {
    const a = runner('debug', false);
    a.reclaimStale.mockRejectedValueOnce(new Error('db down'));
    const worker = new QueryJobWorker([a]);

    await expect(worker.tick()).resolves.toBeUndefined();
    await expect(worker.tick()).resolves.toBeUndefined();
  });

  it('没有 runner 时 tick 是空操作', async () => {
    const worker = new QueryJobWorker([]);
    await expect(worker.tick()).resolves.toBeUndefined();
  });
});
