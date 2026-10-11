import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CohortComputeService } from './cohort-compute.service';
import { CohortRepository } from './cohort.repository';
import { PLATFORM_CRON_TIME_ZONE } from '../time/cron-timezone';
import { appConfig } from '../../config/configuration';

@Injectable()
export class CohortComputeJob {
  private readonly logger = new Logger(CohortComputeJob.name);

  constructor(
    private readonly repository: CohortRepository,
    private readonly compute: CohortComputeService,
  ) {}

  @Cron('0 0 2 * * *', { timeZone: PLATFORM_CRON_TIME_ZONE })
  async handleDaily() {
    // 与其余后台任务同一判据（phase: clklog-analytics-worker-singleton-v1）：
    // ingestor 复用 AppModule、本地开发经隧道连生产库，若不挡就会各跑一份。
    // 跳过时不打日志，答案在启动那一行的后台调度摘要里，避免每天三条噪声。
    if (!appConfig.background_workers) return;

    this.logger.log('开始每日分群重算');
    const items = await this.repository.listDaily();
    for (const item of items) {
      try {
        await this.compute.compute(item.cohort_id, item.project_name);
      } catch (error) {
        this.logger.error(`分群 ${item.cohort_id} 日更失败: ${(error as Error).message}`);
      }
    }
    this.logger.log('每日分群重算完成');
  }
}
