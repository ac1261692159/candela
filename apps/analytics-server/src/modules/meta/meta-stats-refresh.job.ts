import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MetaEventService } from './meta-event.service';
import { PrismaService } from '../shared/prisma.service';
import { PLATFORM_CRON_TIME_ZONE } from '../time/cron-timezone';
import { appConfig } from '../../config/configuration';

@Injectable()
export class MetaStatsRefreshJob {
  private readonly logger = new Logger(MetaStatsRefreshJob.name);

  constructor(
    private readonly metaEventService: MetaEventService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM, { timeZone: PLATFORM_CRON_TIME_ZONE })
  async handleDailyRefresh() {
    // 与其余后台任务同一判据（phase: clklog-analytics-worker-singleton-v1）：
    // ingestor 复用 AppModule、本地开发经隧道连生产库，若不挡就会各跑一份。
    // 跳过时不打日志，答案在启动那一行的后台调度摘要里，避免每天三条噪声。
    if (!appConfig.background_workers) return;

    this.logger.log('开始每日元事件统计刷新');
    try {
      const projects = await this.prisma.metaEvent.groupBy({
        by: ['project_name'],
        where: { is_deleted: false },
      });

      for (const { project_name: projectName } of projects) {
        try {
          await this.metaEventService.refreshStats(projectName);
        } catch (error) {
          this.logger.error(`刷新项目 ${projectName} 失败: ${error.message}`);
        }
      }

      this.logger.log('每日元事件统计刷新完成');
    } catch (error) {
      this.logger.error(`元事件统计刷新任务失败: ${error.message}`, error.stack);
    }
  }
}
