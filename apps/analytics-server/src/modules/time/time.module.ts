import { Global, Module } from '@nestjs/common';
import { appConfig } from '../../config/configuration';
import { SharedModule } from '../shared/shared.module';
import { ProjectTimeRegistry } from './project-time-registry';
import { TimeScopeService } from './time-scope';
import { TIME_OPTIONS, TimezoneService, type TimeOptions } from './timezone.service';

@Global()
@Module({
  imports: [SharedModule],
  providers: [
    {
      provide: TIME_OPTIONS,
      useFactory: (): TimeOptions => ({ platformTz: appConfig.analytics?.timezone }),
    },
    TimezoneService,
    TimeScopeService,
    ProjectTimeRegistry,
  ],
  exports: [TimezoneService, TimeScopeService, ProjectTimeRegistry],
})
export class TimeModule {}
