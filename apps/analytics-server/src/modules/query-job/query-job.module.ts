import { Module } from '@nestjs/common';
import { MetaModule } from '../meta/meta.module';
import { DebugJobRunner } from '../meta/debug-job.runner';
import { TimelineModule } from '../timeline/timeline.module';
import { TimelineJobRunner } from '../timeline/timeline-job.runner';
import { QueryJobWorker } from './query-job.worker';
import { QUERY_JOB_RUNNERS } from './query-job.types';

/**
 * 异步查询任务管道（phase: clklog-analytics-debug-async-query-v1，多 kind：clklog-analytics-user-timeline-v1）。
 *
 * 管道（门禁 / 节奏 / 卡死回收 / 轮转串行认领）在这里；各 kind 的查询与落库由各自的 runner 负责，
 * 由两个特性模块分别提供并导出，此处组装注入。
 */
@Module({
  imports: [MetaModule, TimelineModule],
  providers: [
    {
      provide: QUERY_JOB_RUNNERS,
      useFactory: (debug: DebugJobRunner, timeline: TimelineJobRunner) => [debug, timeline],
      inject: [DebugJobRunner, TimelineJobRunner],
    },
    QueryJobWorker,
  ],
})
export class QueryJobModule {}
