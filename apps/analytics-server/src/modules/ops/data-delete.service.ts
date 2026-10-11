import { Injectable, Logger } from '@nestjs/common';
import { appConfig } from '../../config/configuration';
import { badRequest, conflict } from '../../i18n/domain-error';
import { ClickHouseService } from '../shared/clickhouse.service';
import { PrismaService } from '../shared/prisma.service';
import { todayInTz } from '../time/calendar';
import { shiftYmd } from './retention-policy';
import { TimezoneService } from '../time/timezone.service';
import {
  backupTableName,
  buildBackupSql,
  buildDeletePlan,
  DELETE_MAX_ROWS,
  DELETE_PREFLIGHT_COVERAGE_DAYS,
  DeletePlanError,
  signConfirmToken,
  verifyConfirmToken,
  type DeleteRequest,
} from './cleanup-plan';
import { RetentionService } from './retention.service';

/**
 * 定点删除（phase: clklog-data-management-v1.2，R4-a）。
 *
 * 流程（见 design-data-management-v1.2 §4）：
 * 预演（只读）→ 二次确认 token → 前置对拍 → 备份（bak 库）→ ALTER DELETE →
 * 写审计（ops_action_log）+ 清理登记（ops_cleanup_ledger）→ 由前端轮询 mutation 进度。
 *
 * 硬约束：
 * - 只允许 `cleanup-plan.ts` 白名单表/条件（无任意 SQL）；
 * - 破坏性动作一律走 `sa_cleanup`（未配置口令 → 拒绝，不回退高权账号）；
 * - 已有未完成 mutation 时拒绝新任务（IO 保护）；
 * - 影响行数超过上限 → 拒绝并建议分批。
 */
@Injectable()
export class DataDeleteService {
  private readonly logger = new Logger(DataDeleteService.name);

  constructor(
    private readonly clickHouse: ClickHouseService,
    private readonly prisma: PrismaService,
    private readonly retention: RetentionService,
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
  ) {}

  /** 把条件补上平台时区的「今天」，并翻译构造器的错误为 400 */
  private plan(input: Omit<DeleteRequest, 'today'>): ReturnType<typeof buildDeletePlan> {
    try {
      return buildDeletePlan({ ...input, today: todayInTz(this.timezones.platformTz) });
    } catch (error) {
      if (error instanceof DeletePlanError) {
        throw badRequest({
          code: error.code,
          messageKey: error.code.replace('ops.', 'ops:error.'),
          message: error.message,
        });
      }
      throw error;
    }
  }

  /** 预演：影响行数 + 日期范围 + 样例（只读，不写任何数据） */
  async preview(input: Omit<DeleteRequest, 'today'>): Promise<{
    table: string;
    plan_summary: string;
    rows: number;
    min_date: string | null;
    max_date: string | null;
    samples: Record<string, unknown>[];
    max_rows: number;
    max_rows_exceeded: boolean;
    backup_table: string;
    cleanup_enabled: boolean;
    preflight: Awaited<ReturnType<RetentionService['preflight']>>;
    confirm_token: string | null;
  }> {
    const plan = this.plan(input);

    const counts = await this.clickHouse.query<{ rows: string }>(plan.previewSql, plan.previewParams, {
      maxExecutionTime: 60,
      maxMemoryUsage: 1_000_000_000,
      maxThreads: 2,
    });
    const rows = counts.length ? parseInt(counts[0].rows, 10) : 0;

    // 日期范围（仅时间语义的表；用同一条件聚合，避免两次口径不一致）
    let minDate: string | null = null;
    let maxDate: string | null = null;
    if (plan.range !== null) {
      const span = await this.clickHouse.query<{ min_d: string; max_d: string }>(
        `SELECT toString(min(stat_date)) AS min_d, toString(max(stat_date)) AS max_d FROM ${plan.table}` +
          ` WHERE ${plan.previewSql.slice(plan.previewSql.indexOf(' WHERE ') + 7)}`,
        plan.previewParams,
        { maxExecutionTime: 60, maxMemoryUsage: 1_000_000_000, maxThreads: 2 },
      );
      if (span.length) {
        minDate = span[0].min_d || null;
        maxDate = span[0].max_d || null;
      }
    }

    const samples = rows
      ? await this.clickHouse.query<Record<string, unknown>>(plan.sampleSql, plan.previewParams, {
          maxExecutionTime: 30,
          maxResultRows: 5,
        })
      : [];

    // 前置对拍：要求覆盖「被删数据里最新的一天」（预演出来的真实 max_date，而不是条件里的 9999）
    const today = todayInTz(this.timezones.platformTz);
    const maxAffected = maxDate ?? today;
    // 覆盖要求的边界（与「超保留期」豁免同一原则：覆盖不到的窗口不能被永久拦住）
    //  ① kind=future：未来日期天然不可被快照覆盖 → 只要求新鲜通过快照；
    //  ② 早于「近 N 天」的历史窗口：对拍单次上限 3 天，近期快照不可能覆盖几个月前的某一天
    //     → 同样只要求新鲜通过快照（否则按事件清历史垃圾永远做不了）。
    const coverageWindowStart = shiftYmd(today, -(DELETE_PREFLIGHT_COVERAGE_DAYS - 1));
    const requireCoverage = input.kind === 'future' ? false : maxAffected >= coverageWindowStart;
    const preflight = await this.retention.preflight(maxAffected, undefined, { requireCoverage });

    const backupTable = backupTableName(plan.table, new Date());
    const maxExceeded = rows > DELETE_MAX_ROWS;

    return {
      table: plan.table,
      plan_summary: plan.summary,
      rows,
      min_date: minDate,
      max_date: maxDate,
      samples,
      max_rows: DELETE_MAX_ROWS,
      max_rows_exceeded: maxExceeded,
      backup_table: backupTable,
      cleanup_enabled: this.clickHouse.cleanupEnabled(),
      preflight,
      confirm_token:
        rows > 0 && !maxExceeded ? signConfirmToken(plan.summary, rows, this.confirmKey()) : null,
    };
  }

  /** 确认密钥来自配置（`config/` 是唯一允许读 env 的目录；棘轮约束） */
  private confirmKey(): string {
    return appConfig.cleanup.confirmKey;
  }

  /** 执行删除：token → 前置对拍 → 备份 → ALTER DELETE → 审计 + 登记 */
  async execute(input: {
    kind: DeleteRequest['kind'];
    table: string;
    project: string;
    event?: string;
    from?: string;
    to?: string;
    before?: string;
    confirm_table: string;
    confirm_token: string;
    operator: string;
  }): Promise<{
    table: string;
    rows_planned: number;
    backup_table: string | null;
    mode: 'drop_partition' | 'alter_delete';
    mutation_id: string | null;
    ledger_id: string | null;
  }> {
    if (input.confirm_table !== input.table) {
      throw badRequest({
        code: 'ops.dataDelete.tableConfirmMismatch',
        messageKey: 'ops:error.dataDelete.tableConfirmMismatch',
        params: { confirmed: input.confirm_table, table: input.table },
        message: `确认表名不匹配：输入 "${input.confirm_table}" ≠ 目标 "${input.table}"`,
      });
    }
    if (!this.clickHouse.cleanupEnabled()) {
      throw badRequest({
        code: 'ops.dataDelete.cleanupAccountMissing',
        messageKey: 'ops:error.dataDelete.cleanupAccountMissing',
        message: '清洗账号未配置（CLICKHOUSE_CLEANUP_PASSWORD 未注入），已拒绝执行',
      });
    }

    const plan = this.plan(input);
    const preview = await this.preview(input);
    if (preview.rows === 0) {
      throw badRequest({
        code: 'ops.dataDelete.nothingToDelete',
        messageKey: 'ops:error.dataDelete.nothingToDelete',
        message: '条件未命中任何行，无需执行',
      });
    }
    if (preview.max_rows_exceeded) {
      throw badRequest({
        code: 'ops.dataDelete.rowsExceeded',
        messageKey: 'ops:error.dataDelete.rowsExceeded',
        params: { rows: preview.rows, max: DELETE_MAX_ROWS },
        message: `预计影响 ${preview.rows} 行，超过单次上限 ${DELETE_MAX_ROWS}；请按事件或缩小时间范围分批执行`,
      });
    }
    if (!preview.confirm_token || !verifyConfirmToken(input.confirm_token, plan.summary, preview.rows, this.confirmKey())) {
      throw badRequest({
        code: 'ops.dataDelete.tokenInvalid',
        messageKey: 'ops:error.dataDelete.tokenInvalid',
        message: '确认令牌无效或已过期（条件或行数已变化，请重新预演）',
      });
    }
    if (!preview.preflight.ok) {
      throw badRequest({
        code: `ops.dataDelete.preflight.${preview.preflight.reason}`,
        messageKey: 'ops:error.dataDelete.preflight',
        params: {
          reason: preview.preflight.reason,
          required_to: preview.preflight.required_to,
        },
        message: `删除前需先通过对拍（覆盖 ${preview.preflight.required_to}）；当前快照状态：${preview.preflight.reason}`,
      });
    }
    if (await this.hasRunningMutation(plan.table)) {
      throw conflict({
        code: 'ops.dataDelete.mutationRunning',
        messageKey: 'ops:error.dataDelete.mutationRunning',
        params: { table: plan.table },
        message: `${plan.table} 上有未完成的 mutation，请等待完成后再发起删除（IO 保护）`,
      });
    }

    // 备份（红线 6：不可逆动作必须有备份）：失败即中止
    const backupTable = preview.backup_table;
    const backup = buildBackupSql(plan, backupTable);
    try {
      await this.clickHouse.cleanupCommand(backup.create);
      await this.clickHouse.cleanupCommand(
        backup.insert,
        plan.previewParams,
        { maxExecutionTime: 600 },
      );
      // ⚠️ 必须带 project_name：备份表与源表同构，而 `query()` 强制项目过滤（红线 4）——
      // 写 `WHERE 1 = 1` 会被守卫拦下并表现成「备份失败」（2026-10-09 端到端实测踩到）。
      const check = await this.clickHouse.query<{ rows: string }>(
        `SELECT count() AS rows FROM ${backupTable} WHERE project_name = {project: String}`,
        { project: plan.previewParams.project },
        { maxExecutionTime: 60 },
      );
      const backedUp = check.length ? parseInt(check[0].rows, 10) : 0;
      if (backedUp < preview.rows) {
        throw new Error(`备份行数不足：期望 ≥${preview.rows}，实际 ${backedUp}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`删除前备份失败，已中止：${msg}`);
      throw badRequest({
        code: 'ops.dataDelete.backupFailed',
        messageKey: 'ops:error.dataDelete.backupFailed',
        params: { message: msg.slice(0, 300) },
        message: `删除前备份失败，已中止（未删除任何数据）：${msg.slice(0, 300)}`,
      });
    }

    // 审计先落 running（长 mutation 中途断开也要留痕）
    const audit = await this.prisma.opsActionLog.create({
      data: {
        action: 'delete_rows',
        target_table: plan.table,
        detail: {
          summary: plan.summary,
          rows_planned: preview.rows,
          min_date: preview.min_date,
          max_date: preview.max_date,
          backup_table: backupTable,
          mode: plan.dropPartition ? 'drop_partition' : 'alter_delete',
        } as object,
        status: 'running',
        operator: input.operator,
      },
    });

    try {
      await this.clickHouse.cleanupCommand(plan.sql, plan.params, { maxExecutionTime: 600 });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.prisma.opsActionLog
        .update({ where: { id: audit.id }, data: { status: 'failed', error: msg.slice(0, 500) } })
        .catch(() => undefined);
      throw badRequest({
        code: 'ops.dataDelete.executeFailed',
        messageKey: 'ops:error.dataDelete.executeFailed',
        params: { message: msg.slice(0, 300) },
        message: `删除执行失败：${msg.slice(0, 300)}（备份表 ${backupTable} 可回滚）`,
      });
    }

    const mutationId = plan.dropPartition ? null : await this.latestMutationId(plan.table);

    // 清理区间登记：对拍据此把该区间标「已清理」而不是告警
    let ledgerId: string | null = null;
    if (plan.range) {
      ledgerId = await this.retention
        .recordLedger({
          target_db: plan.table.split('.')[0],
          target_table: plan.table.split('.')[1],
          scope_type: 'rows',
          range_from: preview.min_date ?? plan.range.from,
          range_to: preview.max_date ?? plan.range.to,
          action: 'delete_rows',
          detail: { summary: plan.summary, rows_planned: preview.rows, backup_table: backupTable },
          snapshot_id: preview.preflight.snapshot_id,
          operator: input.operator,
        })
        .catch((e) => {
          this.logger.warn(`清理登记失败：${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
    }

    await this.prisma.opsActionLog
      .update({
        where: { id: audit.id },
        data: { status: 'done', detail: { summary: plan.summary, rows_planned: preview.rows, backup_table: backupTable, mutation_id: mutationId, ledger_id: ledgerId } as object },
      })
      .catch(() => undefined);

    return {
      table: plan.table,
      rows_planned: preview.rows,
      backup_table: backupTable,
      mode: plan.dropPartition ? 'drop_partition' : 'alter_delete',
      mutation_id: mutationId,
      ledger_id: ledgerId,
    };
  }

  /**
   * 目标表上未完成的 mutation（IO 保护）。
   * 走 ClickHouseService 的受限系统表通道（`countPendingMutations`）：`query()` 会强制
   * `project_name`（红线 4），而 `system.mutations` 没有该列，复用会被守卫拦下并误判成「有任务」。
   */
  private async hasRunningMutation(table: string): Promise<boolean> {
    const [db, tbl] = table.split('.');
    try {
      return (await this.clickHouse.countPendingMutations(db, tbl)) > 0;
    } catch (error) {
      // 查不到进度时保守拒绝（宁可让运维等一等，也不要并发压 IO）
      this.logger.warn(`mutation 状态查询失败：${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
  }

  /** 最近一次 mutation id（用于前端轮询进度） */
  private async latestMutationId(table: string): Promise<string | null> {
    const [db, tbl] = table.split('.');
    try {
      return await this.clickHouse.latestMutationId(db, tbl);
    } catch {
      return null;
    }
  }
}
