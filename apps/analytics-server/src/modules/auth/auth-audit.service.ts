import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';

/**
 * 账号域审计（phase: clklog-analytics-account-lifecycle-v1）。
 * 复用 ops_action_log（告警/运维清理共用表），动作一律 `auth_` 前缀，
 * 动作枚举以 PRD §6 为权威；运维数据管理读取方已排除该前缀。
 * 写失败只告警不阻断主流程（与 alert-audit 同策略）。
 */
@Injectable()
export class AuthAuditService {
  private readonly logger = new Logger(AuthAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(
    action: string,
    operator: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.opsActionLog.create({
        data: {
          action,
          target_table: 'sauser',
          detail: detail as object,
          status: 'done',
          operator,
        },
      });
    } catch (error) {
      this.logger.warn(`账号审计写入失败 [${action}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 用户管理页审计查询：auth_ 前缀，时间倒序；v3.1 支持按 detail.project 过滤（服务端筛） */
  async list(limit: number, project?: string) {
    const take = Math.min(200, Math.max(1, limit));
    const rows = await this.prisma.opsActionLog.findMany({
      where: { action: { startsWith: 'auth_' } },
      orderBy: { created_at: 'desc' },
      take,
    });
    return rows
      .map((row) => ({
        id: String(row.id),
        action: row.action,
        detail: row.detail,
        operator: row.operator,
        created_at: row.created_at.toISOString(),
      }))
      .filter((row) => !project || (row.detail as Record<string, unknown> | null)?.project === project);
  }
}
