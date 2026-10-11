import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR, APP_FILTER, APP_PIPE, APP_GUARD } from '@nestjs/core';
import loadConfig from './config/configuration';
import { AppController } from './app.controller';
import { SharedModule } from './modules/shared/shared.module';
import { IngestorModule } from './modules/ingestor/ingestor.module';
import { MetaModule } from './modules/meta/meta.module';
import { TimelineModule } from './modules/timeline/timeline.module';
import { QueryJobModule } from './modules/query-job/query-job.module';
import { QueryModule } from './modules/query/query.module';
import { ReportModule } from './modules/report/report.module';
import { AuthModule } from './modules/auth/auth.module';
import { IamModule } from './modules/iam/iam.module';
import { AiQueryModule } from './modules/ai-query/ai-query.module';
import { AiAssistantModule } from './modules/ai-assistant/ai-assistant.module';
import { CohortModule } from './modules/cohort/cohort.module';
import { TagModule } from './modules/tag/tag.module';
import { SubjectModule } from './modules/subject/subject.module';
import { OpsModule } from './modules/ops/ops.module';
import { AlertingModule } from './modules/alerting/alerting.module';
import { DatatableModule } from './modules/datatable/datatable.module';
import { TimeModule } from './modules/time/time.module';
import { ProjectInterceptor } from './common/interceptors/project.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './i18n/error-response.filter';
import { validationPipe } from './common/pipes/validation.pipe';
import { AuthGuard } from './modules/auth/auth.guard';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { IamGuard } from './modules/iam/iam.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [loadConfig],
    }),
    SharedModule,
    TimeModule,
    IngestorModule,
    MetaModule,
    TimelineModule,
    QueryJobModule,
    QueryModule,
    ReportModule,
    AuthModule,
    IamModule,
    AiQueryModule,
    AiAssistantModule,
    CohortModule,
    TagModule,
    SubjectModule,
    OpsModule,
    AlertingModule,
    DatatableModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ProjectInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_PIPE, useValue: validationPipe },
    // 顺序就是执行顺序。Query/Report 会先 import IamModule，若 IamGuard 登记在模块里会抢在 AuthGuard 前跑，CurrentIam 为空。
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: IamGuard },
  ],
})
export class AppModule {}
