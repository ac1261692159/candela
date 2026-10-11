import { BadRequestException, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { appConfig } from '../../config/configuration';
import { AlertAuditService } from './alert-audit.service';

/**
 * 告警数据保留策略（phase: clklog-analytics-alert-channels-v1）。
 *
 * 三张表可**分别**设置保留天数（`null` = 永久保留）：
 * - `events`        → `alertevent`（告警历史；删除会级联清掉其通知记录）
 * - `notifications` → `alertnotification`（通知记录）
 * - `audits`        → `ops_action_log` 中 `alert_*` 变更记录
 *
 * 默认：历史与通知记录各 1 年，变更记录永久。
 * 清理按批删除（每批 2000 行、单轮上限 50 批），带审计；只在 server 进程运行（background_workers）。
 */

export const RETENTION_SCOPES = ['events', 'notifications', 'audits'] as const;
export type RetentionScope = (typeof RETENTION_SCOPES)[number];

export const RETENTION_SCOPE_LABEL: Record<RetentionScope, string> = {
  events: '告警历史',
  notifications: '通知记录',
  audits: '变更记录',
};

/** 范围名的 i18n 资源键（前端优先用 key 渲染；key 值不与既有 retention.scope 冲突） */
export const RETENTION_SCOPE_LABEL_KEY: Record<RetentionScope, string> = {
  events: 'alerting:retention.scopeLabel.events',
  notifications: 'alerting:retention.scopeLabel.notifications',
  audits: 'alerting:retention.scopeLabel.audits',
};

const DEFAULT_DAYS: Record<RetentionScope, number | null> = {
  events: 365,
  notifications: 365,
  audits: null,
};

const CHECK_INTERVAL_MS = 6 * 60 * 60_000; // 每 6 小时检查一次（按天粒度，足够）
const BATCH_SIZE = 2_000;
const MAX_BATCHES = 50;
const MAX_DAYS = 3_650;

@Injectable()
export class AlertRetentionService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AlertRetentionService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AlertAuditService,
  ) {}

  onModuleInit(): void {
    if (!appConfig.background_workers) {
      this.logger.log('告警数据保留清理未启动（非 server 进程）');
      return;
    }
    this.timer = setInterval(() => void this.cleanup().catch(() => undefined), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 当前策略（缺行时返回默认值） */
  async list(): Promise<
    {
      scope: RetentionScope;
      label: string;
      label_key: string;
      retain_days: number | null;
      updated_by: string | null;
      updated_at: string | null;
    }[]
  > {
    const rows = await this.prisma.alertRetention.findMany();
    const byScope = new Map(rows.map((row) => [row.scope, row]));
    return RETENTION_SCOPES.map((scope) => {
      const row = byScope.get(scope);
      return {
        scope,
        label: RETENTION_SCOPE_LABEL[scope],
        label_key: RETENTION_SCOPE_LABEL_KEY[scope],
        retain_days: row ? row.retain_days : DEFAULT_DAYS[scope],
        updated_by: row?.updated_by ?? null,
        updated_at: row?.updated_at?.toISOString() ?? null,
      };
    });
  }

  async save(scope: string, retainDays: number | null, operator: string): Promise<{ ok: true }> {
    if (!(RETENTION_SCOPES as readonly string[]).includes(scope)) {
      // 冻结的 spec（test/alerting/alert-retention.spec.ts）断言 instanceof BadRequestException，
      // 不能用 i18n 的 DomainError 工厂；载荷按 DomainError 形状给（messageKey + params）。
      throw new BadRequestException({
        code: 'alerting.retention.scopeInvalid',
        message: `不支持的保留范围：${scope}`,
        messageKey: 'alerting:error.retention.scopeInvalid',
        params: { scope },
      });
    }
    if (retainDays !== null) {
      if (!Number.isInteger(retainDays) || retainDays < 1 || retainDays > MAX_DAYS) {
        // 同上：spec 冻结断言 instanceof BadRequestException
        throw new BadRequestException({
          code: 'alerting.retention.daysInvalid',
          message: `保留天数须为 1~${MAX_DAYS} 的整数，留空表示永久保留`,
          messageKey: 'alerting:error.retention.daysInvalid',
          params: { max: MAX_DAYS },
        });
      }
    }
    await this.prisma.alertRetention.upsert({
      where: { scope },
      create: { scope, retain_days: retainDays, updated_by: operator },
      update: { retain_days: retainDays, updated_by: operator },
    });
    await this.audit.write(
      'alert_retention_update',
      'alertretention',
      { scope, retain_days: retainDays },
      operator,
    );
    return { ok: true };
  }

  /**
   * 按策略清理过期数据。返回各 scope 删除行数（供手动触发与日志）。
   * 批删 + 上限，避免长事务与大范围删除（红线：有界操作）。
   */
  async cleanup(): Promise<Record<string, number>> {
    const policies = await this.list();
    const result: Record<string, number> = {};
    for (const policy of policies) {
      if (policy.retain_days === null) {
        result[policy.scope] = 0;
        continue;
      }
      const cutoff = new Date(Date.now() - policy.retain_days * 86_400_000);
      const deleted = await this.purge(policy.scope, cutoff);
      result[policy.scope] = deleted;
      if (deleted > 0) {
        this.logger.log(`告警数据保留清理 [${policy.scope}] 删除 ${deleted} 行（早于 ${cutoff.toISOString().slice(0, 10)}）`);
        await this.audit.write(
          'alert_retention_cleanup',
          'alertretention',
          { scope: policy.scope, retain_days: policy.retain_days, deleted, before: cutoff.toISOString() },
          'system',
        );
      }
    }
    return result;
  }

  private async purge(scope: RetentionScope, cutoff: Date): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const deleted = await this.purgeBatch(scope, cutoff);
      total += deleted;
      if (deleted < BATCH_SIZE) break;
    }
    return total;
  }

  private async purgeBatch(scope: RetentionScope, cutoff: Date): Promise<number> {
    if (scope === 'events') {
      const rows = await this.prisma.alertEvent.findMany({
        where: { fired_at: { lt: cutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      });
      if (rows.length === 0) return 0;
      // 删除事件会级联删除其通知记录（alertnotification.rule_code 关联 rule，不受影响）
      await this.prisma.alertNotification.deleteMany({ where: { event_id: { in: rows.map((row) => row.id) } } });
      const result = await this.prisma.alertEvent.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
      return result.count;
    }
    if (scope === 'notifications') {
      const rows = await this.prisma.alertNotification.findMany({
        where: { created_at: { lt: cutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      });
      if (rows.length === 0) return 0;
      const result = await this.prisma.alertNotification.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
      return result.count;
    }
    // audits：告警相关的变更记录（ops_action_log.action 以 alert_ 开头）
    const rows = await this.prisma.opsActionLog.findMany({
      where: { action: { startsWith: 'alert_' }, created_at: { lt: cutoff } },
      select: { id: true },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) return 0;
    const result = await this.prisma.opsActionLog.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    return result.count;
  }
}
