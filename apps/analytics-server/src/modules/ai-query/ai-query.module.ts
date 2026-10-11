import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { AiQueryController } from './ai-query.controller';
import { AiQueryService } from './ai-query.service';
import { AiSqlGuardService } from './ai-sql-guard.service';

@Module({
  imports: [SharedModule],
  controllers: [AiQueryController],
  providers: [AiQueryService, AiSqlGuardService],
})
export class AiQueryModule {}
