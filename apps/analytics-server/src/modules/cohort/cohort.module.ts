import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SharedModule } from '../shared/shared.module';
import { MetaModule } from '../meta/meta.module';
import { QueryModule } from '../query/query.module';
import { ReportModule } from '../report/report.module';
import { SubjectModule } from '../subject/subject.module';
import { IamModule } from '../iam/iam.module';
import { CohortController } from './cohort.controller';
import { CohortService } from './cohort.service';
import { CohortRepository } from './cohort.repository';
import { CohortMembersService } from './cohort-members.service';
import { CohortConditionSqlService } from './cohort-condition-sql.service';
import { CohortPreviewService } from './cohort-preview.service';
import { CohortSqlService } from './cohort-sql.service';
import { CohortComputeService } from './cohort-compute.service';
import { CohortComputeJob } from './cohort-compute.job';

@Module({
  imports: [SharedModule, MetaModule, QueryModule, ReportModule, SubjectModule, IamModule, ScheduleModule.forRoot()],
  controllers: [CohortController],
  providers: [
    CohortRepository,
    CohortMembersService,
    CohortConditionSqlService,
    CohortPreviewService,
    CohortSqlService,
    CohortComputeService,
    CohortComputeJob,
    CohortService,
  ],
  exports: [CohortConditionSqlService],
})
export class CohortModule {}
