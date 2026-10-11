import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { MetaModule } from '../meta/meta.module';
import { SubjectModule } from '../subject/subject.module';
import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { TimelineRecordService } from './timeline-record.service';
import { TimelineJobRunner } from './timeline-job.runner';

/**
 * 用户行为序列（phase: clklog-analytics-user-timeline-v1）。
 *
 * 依赖 MetaModule 只为两件事：项目级留档开关（与 Debug 共用）与既有的查询记录表服务；
 * 时间线自己的记录读写由 TimelineRecordService 独占（单一写入方）。
 */
@Module({
  imports: [SharedModule, MetaModule, SubjectModule],
  controllers: [TimelineController],
  providers: [TimelineService, TimelineRecordService, TimelineJobRunner],
  exports: [TimelineJobRunner, TimelineService],
})
export class TimelineModule {}
