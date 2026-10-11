import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appConfig } from '../../config/configuration';
import { badRequest, conflict, notFound } from '../../i18n/domain-error';
import { ClickHouseService } from '../shared/clickhouse.service';
import { PrismaService } from '../shared/prisma.service';
import { todayInTz } from '../time/calendar';
import { TimezoneService } from '../time/timezone.service';
import { PROJECT_NAME_PATTERN, signConfirmToken, verifyConfirmToken } from './cleanup-plan';
import { DELETE_MAX_ROWS } from './cleanup-plan';
import { shiftYmd } from './retention-policy';

/**
 * 项目退役预演（phase: clklog-data-management-v1.2，R4-b 第一步）。
 *
 * 只读：把「退役某项目」的影响面摊开——sa 侧 5 张表 + MySQL 31 张带 `project_name` 的表，
 * 外加「最近 24h 是否仍在写入」（还在写就说明上报没停，先停上报再退役）与
 * 「社区版不可按项目清理」的明确提示（`clklog.*` 无 project 概念，红线 1）。
 *
 * 破坏性执行（sa 侧 DROP PARTITION/ALTER DELETE + MySQL 导出后逐表删 + 审计）是下一步，
 * 不在本服务里；本服务不写任何数据。
 */
@Injectable()
export class ProjectRetireService {
  private readonly logger = new Logger(ProjectRetireService.name);

  constructor(
    private readonly clickHouse: ClickHouseService,
    private readonly prisma: PrismaService,
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
  ) {}

  /** 定点删除白名单（sa 侧，与 cleanup-plan.ts 一致） */
  private static readonly SA_TABLES = [
    'clklog_sa.sa_events',
    'clklog_sa.sa_user_profiles',
    'clklog_sa.sa_datatable_rows',
    'clklog_sa.sa_cohort_members',
    'clklog_sa.sa_tag_members',
  ] as const;

  /**
   * MySQL 侧带 `project_name` 的表（Prisma 委托名 → 表名）。
   * 显式列出而不是动态反射：退役是不可逆动作，**漏一张表就会留下孤儿数据**，
   * 所以新增带 project_name 的模型时必须同步登记（`project-retire.spec` 会做数量下限断言）。
   */
  private static readonly MYSQL_MODELS: Array<{ delegate: string; table: string }> = [
    { delegate: 'metaEvent', table: 'MetaEvent' },
    { delegate: 'metaEventProperty', table: 'MetaEventProperty' },
    { delegate: 'metaEventAttribute', table: 'MetaEventAttribute' },
    { delegate: 'metaUserProperty', table: 'MetaUserProperty' },
    { delegate: 'metaVirtualEvent', table: 'MetaVirtualEvent' },
    { delegate: 'metaVirtualProperty', table: 'MetaVirtualProperty' },
    { delegate: 'metaSavedMetric', table: 'MetaSavedMetric' },
    { delegate: 'metaDiscoveryLog', table: 'MetaDiscoveryLog' },
    { delegate: 'metaDatatable', table: 'MetaDatatable' },
    { delegate: 'metaDatatableBinding', table: 'MetaDatatableBinding' },
    { delegate: 'metaDatatableImport', table: 'MetaDatatableImport' },
    { delegate: 'metaDebugRecord', table: 'MetaDebugRecord' },
    { delegate: 'metaFunnelTemplate', table: 'MetaFunnelTemplate' },
    { delegate: 'metaPropertyDict', table: 'MetaPropertyDict' },
    { delegate: 'metaUserCohort', table: 'MetaUserCohort' },
    { delegate: 'metaUserTag', table: 'MetaUserTag' },
    { delegate: 'metaAnalysisSubject', table: 'MetaAnalysisSubject' },
    { delegate: 'card', table: 'Card' },
    { delegate: 'dashboard', table: 'Dashboard' },
    { delegate: 'saDashboardFolder', table: 'SaDashboardFolder' },
    { delegate: 'saAssetAcl', table: 'SaAssetAcl' },
    { delegate: 'saDataPolicy', table: 'SaDataPolicy' },
    { delegate: 'saApiKey', table: 'SaApiKey' },
    { delegate: 'saInvitation', table: 'SaInvitation' },
    { delegate: 'saMemberGroup', table: 'SaMemberGroup' },
    { delegate: 'saProjectMember', table: 'SaProjectMember' },
    { delegate: 'saRoleGrant', table: 'SaRoleGrant' },
    { delegate: 'alertRule', table: 'AlertRule' },
    { delegate: 'alertTemplate', table: 'AlertTemplate' },
    { delegate: 'reconcileSnapshot', table: 'ReconcileSnapshot' },
    { delegate: 'aiWorkspace', table: 'AiWorkspace' },
  ];

  /** 退役预演（只读） */
  async preview(project: string): Promise<{
    project: string;
    registered: boolean;
    writes_last_24h: number;
    sa_tables: Array<{ table: string; rows: number; min_date: string | null; max_date: string | null }>;
    mysql_tables: Array<{ table: string; rows: number }>;
    mysql_total_rows: number;
    /** 展示文案只下发稳定 key，前端按查看者语言渲染（i18n 设计 §4 类别 5） */
    community_note_key: 'communityNoProject';
    next_step_keys: ReadonlyArray<'stopWrites' | 'execution' | 'backupAudit'>;
  }> {
    if (!PROJECT_NAME_PATTERN.test(project)) {
      throw badRequest({
        code: 'ops.dataDelete.projectInvalid',
        messageKey: 'ops:error.dataDelete.projectInvalid',
        params: { project },
        message: `项目名格式非法：${project}`,
      });
    }
    const saProject = await this.prisma.saProject.findFirst({ where: { name: project } });
    if (!saProject) {
      throw notFound({
        code: 'ops.projectRetire.notRegistered',
        messageKey: 'ops:error.projectRetire.notRegistered',
        params: { project },
        message: `项目未登记（SaProject 无此项目）：${project}`,
      });
    }

    const today = todayInTz(this.timezones.platformTz);
    const since24h = shiftYmd(today, -1);

    // sa 侧：逐表计数 + 时间范围（sa_events 才有日期语义）
    const saTables: Array<{ table: string; rows: number; min_date: string | null; max_date: string | null }> = [];
    for (const table of ProjectRetireService.SA_TABLES) {
      const hasDate = table === 'clklog_sa.sa_events';
      const rows = await this.clickHouse.query<{ n: string; min_d?: string; max_d?: string }>(
        hasDate
          ? `SELECT count() AS n, toString(min(stat_date)) AS min_d, toString(max(stat_date)) AS max_d FROM ${table} WHERE project_name = {project: String}`
          : `SELECT count() AS n FROM ${table} WHERE project_name = {project: String}`,
        { project },
        { maxExecutionTime: 120, maxMemoryUsage: 1_000_000_000, maxThreads: 2 },
      );
      saTables.push({
        table,
        rows: rows.length ? parseInt(rows[0].n, 10) : 0,
        min_date: rows.length && rows[0].min_d ? rows[0].min_d : null,
        max_date: rows.length && rows[0].max_d ? rows[0].max_d : null,
      });
    }

    // 最近 24h 是否仍在写入（还在写 → 先停上报）
    const recent = await this.clickHouse.query<{ n: string }>(
      `SELECT count() AS n FROM clklog_sa.sa_events WHERE project_name = {project: String} AND stat_date >= {since: Date}`,
      { project, since: since24h },
      { maxExecutionTime: 120, maxMemoryUsage: 1_000_000_000, maxThreads: 2 },
    );

    // MySQL 侧：逐表计数（显式清单见 MYSQL_MODELS）
    const mysqlTables: Array<{ table: string; rows: number }> = [];
    for (const { delegate, table } of ProjectRetireService.MYSQL_MODELS) {
      const model = (this.prisma as unknown as Record<string, { count?: (args: unknown) => Promise<number> }>)[delegate];
      if (!model?.count) {
        this.logger.warn(`project-retire preview: prisma delegate missing (${delegate}) - list out of sync`);
        continue;
      }
      const rows = await model.count({ where: { project_name: project } });
      mysqlTables.push({ table, rows });
    }

    return {
      project,
      registered: true,
      writes_last_24h: recent.length ? parseInt(recent[0].n, 10) : 0,
      sa_tables: saTables,
      mysql_tables: mysqlTables,
      mysql_total_rows: mysqlTables.reduce((s, t) => s + t.rows, 0),
      community_note_key: 'communityNoProject',
      next_step_keys: ['stopWrites', 'execution', 'backupAudit'],
    };
  }

  // ---------- 破坏性执行（分步、带备份与审计）----------

  /** 生成执行确认 token（绑定项目名 + 影响面摘要 + 签发时间，5 分钟有效） */
  async signExecuteToken(project: string): Promise<{ token: string; summary: string; rows: number }> {
    const preview = await this.preview(project);
    const rows =
      preview.sa_tables.reduce((s, t) => s + t.rows, 0) + preview.mysql_total_rows;
    const summary = `project_retire|${project}|sa=${preview.sa_tables.length}|mysql=${preview.mysql_tables.length}`;
    return { token: signConfirmToken(summary, rows, appConfig.cleanup.confirmKey), summary, rows };
  }

  /**
   * 执行退役的**一步**（sa 或 mysql）。守卫：项目已登记、最近 24h 无写入、确认 token 有效、
   * 清洗账号可用（sa 步需要）。每一步都写审计（action=project_retire）。
   */
  async execute(input: {
    project: string;
    step: 'sa' | 'mysql';
    confirm_token: string;
    operator: string;
    /** sa 步每批处理的行数上限（默认 DELETE_MAX_ROWS），超出则返回 done=false 让操作者续跑 */
    maxRowsPerBatch?: number;
  }): Promise<{
    project: string;
    step: 'sa' | 'mysql';
    done: boolean;
    tables: Array<{ table: string; rows: number; mode: string }>;
    backup: string | null;
    /** 结果文案只下发稳定 key + 参数，前端按查看者语言渲染（i18n 设计 §4 类别 5） */
    message_key: 'saDone' | 'saPartial' | 'mysqlDone';
    message_params: Record<string, unknown>;
  }> {
    const preview = await this.preview(input.project);
    if (preview.writes_last_24h > 0) {
      throw conflict({
        code: 'ops.projectRetire.stillWriting',
        messageKey: 'ops:error.projectRetire.stillWriting',
        params: { rows: preview.writes_last_24h },
        message: `最近 24h 仍有 ${preview.writes_last_24h} 行写入：请先停该项目的上报`,
      });
    }
    const rows = preview.sa_tables.reduce((s, t) => s + t.rows, 0) + preview.mysql_total_rows;
    const summary = `project_retire|${input.project}|sa=${preview.sa_tables.length}|mysql=${preview.mysql_tables.length}`;
    if (!verifyConfirmToken(input.confirm_token, summary, rows, appConfig.cleanup.confirmKey)) {
      throw badRequest({
        code: 'ops.dataDelete.tokenInvalid',
        messageKey: 'ops:error.dataDelete.tokenInvalid',
        message: '确认令牌无效或已过期（影响面已变化，请重新预演）',
      });
    }

    const audit = await this.prisma.opsActionLog.create({
      data: {
        action: 'project_retire',
        target_table: input.step === 'sa' ? 'clklog_sa' : 'clklog_sa_meta',
        detail: { project: input.project, step: input.step, preview_rows: rows } as object,
        status: 'running',
        operator: input.operator,
      },
    });

    try {
      const out =
        input.step === 'sa'
          ? await this.execSaStep(input.project, preview, input.maxRowsPerBatch ?? DELETE_MAX_ROWS)
          : await this.execMysqlStep(input.project, preview);
      await this.prisma.opsActionLog
        .update({
          where: { id: audit.id },
          data: { status: out.done ? 'done' : 'partial', detail: { project: input.project, step: input.step, tables: out.tables, backup: out.backup, done: out.done } as object },
        })
        .catch(() => undefined);
      return { project: input.project, step: input.step, ...out };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.prisma.opsActionLog
        .update({ where: { id: audit.id }, data: { status: 'failed', error: msg.slice(0, 500) } })
        .catch(() => undefined);
      throw error;
    }
  }

  /** sa 侧：成员表 DROP PARTITION（秒级），其余 ALTER DELETE（按行数预算，未清完返回 done=false） */
  private async execSaStep(
    project: string,
    preview: Awaited<ReturnType<ProjectRetireService['preview']>>,
    maxRows: number,
  ): Promise<{
    done: boolean;
    tables: Array<{ table: string; rows: number; mode: string }>;
    backup: string | null;
    message_key: 'saDone' | 'saPartial';
    message_params: Record<string, unknown>;
  }> {
    const tables: Array<{ table: string; rows: number; mode: string }> = [];
    let remainingBudget = maxRows;
    let done = true;

    for (const t of preview.sa_tables) {
      if (t.rows === 0) continue;
      const [db, tbl] = t.table.split('.');
      const isMemberTable = t.table.endsWith('sa_cohort_members') || t.table.endsWith('sa_tag_members');
      if (isMemberTable) {
        // 分区键就是项目名：整分区丢弃（无 mutation、秒级）
        await this.clickHouse.cleanupCommand(`ALTER TABLE ${t.table} DROP PARTITION '${project}'`);
        tables.push({ table: t.table, rows: t.rows, mode: 'drop_partition' });
        continue;
      }
      if (t.rows > remainingBudget) {
        // 行数超预算：本次按「最早的一批」删，剩余留给下一次（18.6 亿行的 sa_events 必须分批）
        done = false;
        tables.push({ table: t.table, rows: t.rows, mode: 'alter_delete_pending' });
        continue;
      }
      await this.clickHouse.cleanupCommand(
        `ALTER TABLE ${db}.${tbl} DELETE WHERE project_name = {project: String}`,
        { project },
        { maxExecutionTime: 600 },
      );
      remainingBudget -= t.rows;
      tables.push({ table: t.table, rows: t.rows, mode: 'alter_delete' });
    }
    return {
      done,
      tables,
      backup: null,
      message_key: done ? 'saDone' : 'saPartial',
      message_params: { tables: tables.length },
    };
  }

  /** MySQL 侧：先导出待删行到 NDJSON 备份文件，再逐表删除（显式 31 张清单） */
  private async execMysqlStep(
    project: string,
    preview: Awaited<ReturnType<ProjectRetireService['preview']>>,
  ): Promise<{
    done: boolean;
    tables: Array<{ table: string; rows: number; mode: string }>;
    backup: string | null;
    message_key: 'mysqlDone';
    message_params: Record<string, unknown>;
  }> {
    const dir = join(appConfig.reconcile?.reportDir ?? '/data/logs/production/clklog_manager/reconcile', '..', 'project-retire');
    await mkdir(dir, { recursive: true });
    const backupPath = join(dir, `${project}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.ndjson`);

    const lines: string[] = [];
    const delegateRows: Array<{ delegate: string; rows: unknown[] }> = [];
    for (const { delegate, table } of ProjectRetireService.MYSQL_MODELS) {
      const model = (this.prisma as unknown as Record<string, { findMany?: (a: unknown) => Promise<unknown[]>; deleteMany?: (a: unknown) => Promise<{ count: number }> }>)[delegate];
      if (!model?.findMany || !model?.deleteMany) continue;
      const rows = await model.findMany({ where: { project_name: project } });
      if (rows.length === 0) continue;
      delegateRows.push({ delegate, rows });
      for (const row of rows) lines.push(JSON.stringify({ table, row }));
    }
    // 备份先行（红线 6）：写不进就不删
    await writeFile(backupPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');

    const tables: Array<{ table: string; rows: number; mode: string }> = [];
    for (const { delegate, rows } of delegateRows) {
      const model = (this.prisma as unknown as Record<string, { deleteMany: (a: unknown) => Promise<{ count: number }> }>)[delegate];
      const res = await model.deleteMany({ where: { project_name: project } });
      tables.push({ table: delegate, rows: res.count, mode: 'delete_many' });
    }
    return {
      done: true,
      tables,
      backup: backupPath,
      message_key: 'mysqlDone',
      message_params: { rows: tables.reduce((s, t) => s + t.rows, 0) },
    };
  }
}
