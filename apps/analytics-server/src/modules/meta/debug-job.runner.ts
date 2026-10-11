import { Injectable, Logger } from '@nestjs/common';
import { DebugArchiveService, type ClaimedDebugJob } from './debug-archive.service';
import { DebugService, type RecentDebugQuery } from './debug.service';
import {
  QUERY_JOB_ERROR_QUERY_FAILED,
  QUERY_JOB_ERROR_TIMEOUT,
  QUERY_JOB_RUN_BUDGET_S,
  isClickHouseTimeout,
} from '../query-job/query-job.policy';
import type { ClaimedQueryJob, QueryJobRunner } from '../query-job/query-job.types';

/**
 * Debug 实时查询的异步执行器（kind = `debug`）。
 *
 * 管道（门禁/节奏/回收/轮转）在 `modules/query-job`；这里只管「按条件跑查询 + 写 Debug 留档」。
 */
@Injectable()
export class DebugJobRunner implements QueryJobRunner {
  readonly kind = 'debug';
  private readonly logger = new Logger(DebugJobRunner.name);

  constructor(
    private readonly archive: DebugArchiveService,
    private readonly debug: DebugService,
  ) {}

  reclaimStale(before: Date): Promise<number> {
    return this.archive.reclaimStale(before);
  }

  async claimNext(): Promise<ClaimedQueryJob | null> {
    const job = await this.archive.claimNextPending();
    return job ? { id: job.id, project: job.project_name, spec: debugSpecOf(job), createdAt: job.created_at } : null;
  }

  async run(job: ClaimedQueryJob): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`Debug 后台查询 ${job.id} 开始（项目=${job.project}）`);
    try {
      // 窗口以**提交时刻**为准，不因排队漂移
      const result = await this.debug.recent(job.spec as RecentDebugQuery, job.project, job.createdAt.getTime(), {
        maxExecutionTime: QUERY_JOB_RUN_BUDGET_S,
      });
      const { row_count: rowCount } = await this.archive.finishJob(job.id, result, Date.now() - startedAt);
      this.logger.log(
        `Debug 后台查询 ${job.id} 完成：命中 ${result.matched_total} 条、落档 ${rowCount} 行、用时 ${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      const code = isClickHouseTimeout(error) ? QUERY_JOB_ERROR_TIMEOUT : QUERY_JOB_ERROR_QUERY_FAILED;
      await this.archive.failJob(job.id, code);
      this.logger.warn(
        `Debug 后台查询 ${job.id} 失败（${code}）: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function debugSpecOf(job: ClaimedDebugJob): RecentDebugQuery {
  return {
    distinct_id: job.cond_distinct_id ?? undefined,
    user_key: job.cond_user_key ?? undefined,
    event: job.cond_event ?? undefined,
    window: job.window ?? undefined,
    limit: job.cond_limit,
  };
}
