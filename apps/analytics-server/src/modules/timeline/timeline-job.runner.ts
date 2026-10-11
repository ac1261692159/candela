import { Injectable, Logger } from '@nestjs/common';
import { TimelineRecordService, TIMELINE_KIND } from './timeline-record.service';
import { TimelineService, type UserTimelineSpec } from './timeline.service';
import {
  QUERY_JOB_ERROR_QUERY_FAILED,
  QUERY_JOB_ERROR_TIMEOUT,
  QUERY_JOB_RUN_BUDGET_S,
  isClickHouseTimeout,
} from '../query-job/query-job.policy';
import type { ClaimedQueryJob, QueryJobRunner } from '../query-job/query-job.types';

/**
 * 用户行为序列的异步执行器（kind = `user_timeline`）。
 *
 * 管道在 `modules/query-job`；这里只管「按规格跑查询 + 写时间线记录」。
 */
@Injectable()
export class TimelineJobRunner implements QueryJobRunner {
  readonly kind = TIMELINE_KIND;
  private readonly logger = new Logger(TimelineJobRunner.name);

  constructor(
    private readonly records: TimelineRecordService,
    private readonly timeline: TimelineService,
  ) {}

  reclaimStale(before: Date): Promise<number> {
    return this.records.reclaimStale(before);
  }

  async claimNext(): Promise<ClaimedQueryJob | null> {
    const job = await this.records.claimNext();
    return job ? { id: job.id, project: job.project_name, spec: job.spec, createdAt: job.created_at } : null;
  }

  async run(job: ClaimedQueryJob): Promise<void> {
    const startedAt = Date.now();
    this.logger.log(`行为序列后台查询 ${job.id} 开始（项目=${job.project}）`);
    try {
      const spec = job.spec as UserTimelineSpec;
      const overview = await this.timeline.overview(spec, job.project, { maxExecutionTime: QUERY_JOB_RUN_BUDGET_S });
      const { items, summary } = await this.timeline.query(spec, job.project, {
        maxExecutionTime: QUERY_JOB_RUN_BUDGET_S,
      });
      const outcome = await this.records.finishJob(job.id, summary, items, Date.now() - startedAt, overview);
      this.logger.log(
        `行为序列后台查询 ${job.id} 完成：命中 ${summary.matched_total} 条、落档 ${outcome.row_count} 行、用时 ${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      const code = isClickHouseTimeout(error) ? QUERY_JOB_ERROR_TIMEOUT : QUERY_JOB_ERROR_QUERY_FAILED;
      await this.records.failJob(job.id, code);
      this.logger.warn(
        `行为序列后台查询 ${job.id} 失败（${code}）: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
