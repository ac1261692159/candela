import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { appConfig } from '../../config/configuration';
import { QUERY_JOB_STALE_MS, QUERY_JOB_WORKER_INTERVAL_MS } from './query-job.policy';
import { QUERY_JOB_RUNNERS, type ClaimedQueryJob, type QueryJobRunner } from './query-job.types';

/**
 * 异步查询任务的后台执行器（phase: clklog-analytics-debug-async-query-v1，
 * 上移到 modules/query-job 并支持多 kind —— phase: clklog-analytics-user-timeline-v1）。
 *
 * 管道职责：门禁（`background_workers`）、轮询节奏、卡死回收、**跨 kind 轮转**串行认领（保护 ClickHouse）。
 * 具体查询与落库由各 runner 负责（见 query-job.types.ts）。
 */
@Injectable()
export class QueryJobWorker implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(QueryJobWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** 轮转游标：每轮从一个 runner 开始，避免某个 kind 饿死另一个 */
  private cursor = 0;

  constructor(@Inject(QUERY_JOB_RUNNERS) private readonly runners: QueryJobRunner[] = []) {}

  onModuleInit() {
    // 与其余后台任务同一判据（phase: clklog-analytics-worker-singleton-v1）：
    // ingestor 复用 AppModule、本地开发经隧道连生产库，不挡就会各跑一份。
    if (!appConfig.background_workers) {
      this.logger.log('异步查询 worker 未启动（非 server 进程）');
      return;
    }
    if (!this.runners.length) {
      this.logger.warn('异步查询 worker 未注册任何 runner，跳过启动');
      return;
    }
    this.timer = setInterval(() => void this.tick(), QUERY_JOB_WORKER_INTERVAL_MS);
    this.timer.unref();
    this.logger.log(
      `异步查询 worker 已启动（间隔 ${QUERY_JOB_WORKER_INTERVAL_MS}ms，串行执行；kind=${this.runners
        .map((r) => r.kind)
        .join(' / ')}）`,
    );
  }

  onModuleDestroy() {
    this.stop();
  }

  onApplicationShutdown() {
    this.stop();
  }

  private stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      // 先回收各 kind 卡死的 running（进程被杀 / 异常退出留下的），避免永久占位
      const cutoff = new Date(Date.now() - QUERY_JOB_STALE_MS);
      for (const runner of this.runners) {
        const reclaimed = await runner.reclaimStale(cutoff);
        if (reclaimed) this.logger.warn(`回收卡死的异步查询任务 ${reclaimed} 条（kind=${runner.kind}，判 timeout）`);
      }

      // 跨 kind 轮转：每轮最多执行 1 条
      for (let offset = 0; offset < this.runners.length; offset += 1) {
        const index = (this.cursor + offset) % this.runners.length;
        const runner = this.runners[index];
        const job = await runner.claimNext();
        if (!job) continue;
        this.cursor = (index + 1) % this.runners.length;
        await this.runJob(runner, job);
        break;
      }
    } catch (error) {
      this.logger.error(
        `异步查询 worker 轮询失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** 执行一个任务（成功的落库与失败的标记都在 runner 内完成，异常只记日志不中断轮询） */
  private async runJob(runner: QueryJobRunner, job: ClaimedQueryJob): Promise<void> {
    try {
      await runner.run(job);
    } catch (error) {
      this.logger.error(
        `异步查询任务 ${job.id}（kind=${runner.kind}）执行异常: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
