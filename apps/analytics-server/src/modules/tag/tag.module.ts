import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SharedModule } from '../shared/shared.module';
import { CohortModule } from '../cohort/cohort.module';
import { SubjectModule } from '../subject/subject.module';
import { IamModule } from '../iam/iam.module';
import { TagController } from './tag.controller';
import { TagService } from './tag.service';
import { TagRepository } from './tag.repository';
import { TagMembersService } from './tag-members.service';
import { TagComputeService } from './tag-compute.service';
import { TagComputeJob } from './tag-compute.job';

@Module({
  imports: [SharedModule, CohortModule, SubjectModule, IamModule, ScheduleModule.forRoot()],
  controllers: [TagController],
  providers: [TagRepository, TagMembersService, TagComputeService, TagComputeJob, TagService],
})
export class TagModule {}
