import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { AuthModule } from '../auth/auth.module';
import { IamModule } from '../iam/iam.module';
import { MetaModule } from '../meta/meta.module';
import { QueryModule } from '../query/query.module';
import { AlertingController } from './alerting.controller';
import { AlertingService } from './alerting.service';
import { AlertAuditService } from './alert-audit.service';
import { AlertDetectorService } from './alert-detector.service';
import { AlertMetricEvalService } from './alert-metric-eval.service';
import { AlertNotifyService } from './alert-notify.service';
import { AlertTemplateService } from './alert-template.service';
import { AlertChannelConfigService } from './channels/channel-config.service';
import { AlertRetentionService } from './alert-retention.service';
import { ReconcileSchedulerService } from './reconcile-scheduler.service';

/**
 * 告警域（alerting-v1..v4）。
 * 指标告警的求值复用查询链路，因此依赖 QueryModule 导出的
 * EventQueryService / RetentionQueryService（口径与工作台一致）。
 * MetaModule：对拍定时复用 QualityService（单向 alerting → meta；meta 不反向依赖告警域）。
 */
@Module({
  imports: [SharedModule, IamModule, QueryModule, AuthModule, MetaModule],
  controllers: [AlertingController],
  providers: [
    AlertingService,
    AlertAuditService,
    AlertDetectorService,
    AlertMetricEvalService,
    AlertNotifyService,
    AlertTemplateService,
    AlertChannelConfigService,
    AlertRetentionService,
    // 对拍定时与告警编排（quality-ops-v1）：需要 meta 域的对拍 + 告警域的通知
    ReconcileSchedulerService,
  ],
})
export class AlertingModule {}
