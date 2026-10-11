import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';

/**
 * 告警配置变更审计（红线 6）：规则 / 联系人 / 屏蔽 / 模板的增删改都写 ops_action_log。
 * 抽成独立服务是因为告警域内多个服务都要写审计（alerting.service 与 alert-template.service），
 * 审计失败只记日志，不影响业务结果。
 */
@Injectable()
export class AlertAuditService {
  private readonly logger = new Logger(AlertAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async write(
    action: string,
    target: string,
    detail: Record<string, unknown>,
    operator: string,
  ): Promise<void> {
    try {
      await this.prisma.opsActionLog.create({
        data: { action, target_table: target, detail: detail as object, status: 'done', operator },
      });
    } catch (error) {
      this.logger.warn(`告警审计写入失败 [${action}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
