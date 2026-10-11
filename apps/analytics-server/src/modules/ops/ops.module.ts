import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { IamModule } from '../iam/iam.module';
import { MetaModule } from '../meta/meta.module';
import { SlowQueryController } from './slow-query.controller';
import { SlowQueryService } from './slow-query.service';
import { ServerStatusController } from './server-status.controller';
import { ServerStatusService } from './server-status.service';
import { MetricSamplerService } from './metric-sampler.service';
import { LogCleanupService } from './log-cleanup.service';
import { DataMgmtController } from './data-mgmt.controller';
import { DataMgmtService } from './data-mgmt.service';
import { DataDeleteService } from './data-delete.service';
import { MetaReconcileService } from './meta-reconcile.service';
import { ProjectRetireService } from './project-retire.service';
import { RetentionService } from './retention.service';

/**
 * 运维面板后端（phase: clklog-analytics-ops-console-v1）+ 数据管理（v1）。
 * 告警检测与通知已迁至 alerting 包。
 */
@Module({
  // MetaModule：数据运维页「健康」与清理前置对拍复用 QualityService（quality-ops-v1）
  imports: [SharedModule, IamModule, MetaModule],
  controllers: [SlowQueryController, ServerStatusController, DataMgmtController],
  providers: [
    SlowQueryService,
    ServerStatusService,
    MetricSamplerService,
    DataMgmtService,
    DataDeleteService,
    MetaReconcileService,
    ProjectRetireService,
    RetentionService,
    LogCleanupService,
  ],
})
export class OpsModule {}
