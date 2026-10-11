import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SharedModule } from '../shared/shared.module';
import { MetaEventController } from './meta-event.controller';
import { MetaEventService } from './meta-event.service';
import { MetaEventRepository } from './meta-event.repository';
import { MetaPropertyController } from './meta-property.controller';
import { MetaPropertyService } from './meta-property.service';
import { MetaPropertyRepository } from './meta-property.repository';
import { MetaVirtualEventController } from './meta-virtual-event.controller';
import { MetaVirtualEventService } from './meta-virtual-event.service';
import { MetaEventAttributeController } from './meta-event-attribute.controller';
import { MetaEventAttributeService } from './meta-event-attribute.service';
import { MetaEventAttributeRepository } from './meta-event-attribute.repository';
import { MetaVirtualPropertyController } from './meta-virtual-property.controller';
import { MetaSavedMetricController } from './meta-saved-metric.controller';
import { MetaSavedMetricService } from './meta-saved-metric.service';
import { MetaSavedMetricRepository } from './meta-saved-metric.repository';
import { MetaVirtualPropertyService } from './meta-virtual-property.service';
import { MetaVirtualPropertyRepository } from './meta-virtual-property.repository';
import { DebugController } from './debug.controller';
import { DebugService } from './debug.service';
import { DebugArchiveService } from './debug-archive.service';
import { DebugJobRunner } from './debug-job.runner';
import { QualityController } from './quality.controller';
import { QualityService } from './quality.service';
import { MetaStatsRefreshJob } from './meta-stats-refresh.job';

@Module({
  imports: [SharedModule, ScheduleModule.forRoot()],
  controllers: [
    MetaEventController,
    MetaPropertyController,
    MetaVirtualEventController,
    MetaVirtualPropertyController,
    MetaSavedMetricController,
    MetaEventAttributeController,
    DebugController,
    QualityController,
  ],
  providers: [
    MetaEventService,
    MetaEventRepository,
    MetaPropertyService,
    MetaPropertyRepository,
    MetaVirtualEventService,
    MetaVirtualPropertyService,
    MetaVirtualPropertyRepository,
    MetaSavedMetricService,
    MetaSavedMetricRepository,
    MetaEventAttributeService,
    MetaEventAttributeRepository,
    DebugService,
    DebugArchiveService,
    DebugJobRunner,
    QualityService,
    MetaStatsRefreshJob,
  ],
  // QualityService：数据运维页「健康」与清理前置对拍复用同一份对拍结论（quality-ops-v1）
  exports: [MetaVirtualEventService, DebugJobRunner, DebugService, DebugArchiveService, QualityService],
})
export class MetaModule {}
