import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { MetaModule } from '../meta/meta.module';
import { SubjectModule } from '../subject/subject.module';
import { IamModule } from '../iam/iam.module';
import { DatatableModule } from '../datatable/datatable.module';
import { DslValidatorService } from './dsl-validator.service';
import { EventSqlGeneratorService } from './event-sql-generator.service';
import { FunnelSqlGeneratorService } from './funnel-sql-generator.service';
import { RetentionSqlGeneratorService } from './retention-sql-generator.service';
import { QueryCacheService } from './query-cache.service';
import { EventQueryController } from './event-query.controller';
import { MetricEvalController } from './metric-eval.controller';
import { MetricEvalService } from './metric-eval.service';
import { EventQueryService } from './event-query.service';
import { FunnelQueryController } from './funnel-query.controller';
import { FunnelQueryService } from './funnel-query.service';
import { RetentionQueryController } from './retention-query.controller';
import { RetentionQueryService } from './retention-query.service';
import { CohortBatchService } from './cohort-batch.service';
import { TagBatchService } from './tag-batch.service';

@Module({
  imports: [SharedModule, MetaModule, SubjectModule, IamModule, DatatableModule],
  controllers: [
    EventQueryController,
    MetricEvalController,
    FunnelQueryController,
    RetentionQueryController,
  ],
  providers: [
    DslValidatorService,
    EventSqlGeneratorService,
    FunnelSqlGeneratorService,
    RetentionSqlGeneratorService,
    QueryCacheService,
    EventQueryService,
    MetricEvalService,
    FunnelQueryService,
    RetentionQueryService,
    CohortBatchService,
    TagBatchService,
  ],
  exports: [
    EventQueryService,
    MetricEvalService,
    FunnelQueryService,
    RetentionQueryService,
    CohortBatchService,
    TagBatchService,
  ],
})
export class QueryModule {}
