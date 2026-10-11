import { Injectable, Logger } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { badRequest, conflict, DomainError, notFound } from '../../i18n/domain-error';
import { ClickHouseService } from '../shared/clickhouse.service';
import { toQueryBudgetError } from '../query-budget/query-budget-error';
import { appConfig } from '../../config/configuration';
import { CardRepository } from './card.repository';
import { SqlAstGuardService } from './sql-ast-guard.service';
import { parseChartConfigV1, resolvedCardChartType, sanitizeStoredChartConfig } from './chart-config.validator';
import { ExecuteSqlDto, SaveSqlReportDto } from './dto/sql-report.dto';
import type { AuthUser } from '../auth/auth.service';
import { AssetPolicyService } from '../iam/asset-policy.service';
import { DataScopeService } from '../iam/data-scope.service';
import type { DataScope, IamContext } from '../iam/iam.types';
import { GROUPABLE_SYSTEM_COLUMNS } from './system-columns';
import { CohortBatchService } from '../query/cohort-batch.service';
import { TagBatchService } from '../query/tag-batch.service';
import { MISSING_COHORT_BATCH } from '../query/cohort-member-sql';
import { ANALYSIS_UID_EXPR } from '../../types/dsl.types';
import type { TimeRange } from '../../types/dsl.types';
import { bucketExpression, bucketParams, TimeScope, TimeScopeService } from '../time/time-scope';
import { SubjectService } from '../subject/subject.service';
import { uniqExactSubject } from '../subject/subject-expr';
import {
  builderDslHasCohort,
  collectCohortFunctionCalls,
  cohortGroupSqlExpression,
  cohortMemberSqlPredicate,
  expandSaInCohortFunctions,
} from './sql-cohort-filter';
import {
  builderDslHasTag,
  collectTagFunctionCalls,
  expandSaTagFunctions,
  tagGroupSql,
  tagMemberSqlPredicate,
} from './sql-tag-filter';

/**
 * 自定义 SQL 分析业务。
 * 2026-09 重设计：保存的 SQL 报表统一为 type='sql' 的全局分析卡片（不再用独立 SqlReport 表）。
 * 安全边界见 docs/architecture/clklog-analytics-design-sql-report.md §11。
 */
@Injectable()
export class SqlReportService {
  private readonly logger = new Logger(SqlReportService.name);
  private static readonly MAX_RANGE_DAYS = 90;

  constructor(
    private readonly clickHouse: ClickHouseService,
    private readonly cardRepo: CardRepository,
    private readonly guard: SqlAstGuardService,
    private readonly cohortBatches: CohortBatchService,
    private readonly tagBatches: TagBatchService,
    private readonly subjects: SubjectService,
    private readonly policy: AssetPolicyService,
    private readonly dataScope: DataScopeService,
    private readonly timeScopeService: TimeScopeService,
  ) {}

  /**
   * 按 SQL 卡片 dsl 执行（看板 refresh / 目录 execute 共用）。
   * 兼容误存的 `dsl.sql`；时间范围优先卡片内 `time_range`（含动态 relative），否则过去 7 天。
   */
  async executeFromCardDsl(
    dsl: Record<string, unknown>,
    project: string,
    overrides?: {
      time_range?: TimeRange;
      limit?: number;
      cohortTableFilter?: { cohortId: string; batchId: string; op: 'in' | 'not_in' };
      scope?: DataScope;
    },
  ) {
    const sqlText = String(dsl.sql_text ?? dsl.sql ?? '').trim();
    if (!sqlText) {
      throw badRequest({
        code: 'report.sqlReport.noSqlSaved',
        messageKey: 'report:error.sqlReport.noSqlSaved',
        message: '卡片未保存 SQL',
      });
    }
    const mode = dsl.mode === 'builder' && dsl.dsl ? 'builder' : 'sql';
    return this.execute(
      {
        mode,
        sql: sqlText,
        dsl: mode === 'builder' ? dsl.dsl : undefined,
        time_range: overrides?.time_range ?? this.timeRangeFromDsl(dsl),
        limit: overrides?.limit,
      },
      project,
      overrides?.cohortTableFilter,
      overrides?.scope,
    );
  }

  /**
   * 执行自定义 SQL。
   * `signal`：客户端断开时触发（HTTP 入口传入），用于取消 ClickHouse 侧查询，避免白跑。
   */
  async execute(
    dto: ExecuteSqlDto,
    project: string,
    cohortTableFilter?: { cohortId: string; batchId: string; op: 'in' | 'not_in' },
    scope?: DataScope,
    authUserTz?: string | null,
    signal?: AbortSignal,
  ) {
    // 时间范围校验（含展示时区解析；v2：含用户偏好→项目→平台链）
    const timeScope = this.normalizeRange(dto.time_range, authUserTz, project);

    const subjectId =
      dto.dsl && typeof dto.dsl === 'object' && typeof (dto.dsl as { subject_id?: unknown }).subject_id === 'string'
        ? (dto.dsl as { subject_id: string }).subject_id
        : undefined;
    const uidExpr = await this.subjects.expr(project, subjectId);

    // SQL 来源：Builder 模式用 dsl 生成（本期 Builder 暂只支持 event 简单计数，前端生成后传 sql）
    let sql = dto.sql;
    if (dto.mode === 'builder') {
      sql = await this.generateSqlFromDsl(dto.dsl, project, uidExpr, timeScope);
    }
    if (!sql || !sql.trim()) {
      throw badRequest({
        code: 'report.sqlReport.sqlRequired',
        messageKey: 'report:error.sqlReport.sqlRequired',
        message: '缺少 SQL',
      });
    }

    // 强制 LIMIT
    sql = this.applyLimit(sql, dto.limit ?? 1000);

    // 安全守卫（表名归一）+ additional_table_filters 注入 project + time
    // 异时区路径：stat_date 宽扫 ±1 天，log_time 用 epoch 精确裁切（恒等路径与历史逐字节一致）
    const bound = {
      project,
      from: timeScope.scanStartYmd,
      to: timeScope.scanEndYmd,
      eventsTimeExtra: timeScope.isPlatformCalendar
        ? undefined
        : `log_time >= fromUnixTimestamp64Milli(${timeScope.startEpochMs}) AND log_time < fromUnixTimestamp64Milli(${timeScope.endEpochMsExclusive})`,
    };
    const guarded = this.guard.guard(sql, bound);
    const expanded = await this.expandTagFunctions(
      await this.expandCohortFunctions(guarded, project, uidExpr),
      project,
      uidExpr,
    );
    const { extraAnd: scopeAnd } = this.dataScope.applyToEventsQuery(scope);
    const extraAnd = {
      events: [cohortTableFilter
        ? cohortMemberSqlPredicate({
            uidExpr,
            project,
            cohortId: cohortTableFilter.cohortId,
            batchId: cohortTableFilter.batchId,
            op: cohortTableFilter.op,
          })
        : null,
        scopeAnd,
      ]
        .filter(Boolean)
        .join(' AND ') || undefined,
      profiles: cohortTableFilter
        ? cohortMemberSqlPredicate({
            uidExpr,
            project,
            cohortId: cohortTableFilter.cohortId,
            batchId: cohortTableFilter.batchId,
            op: cohortTableFilter.op,
          })
        : undefined,
    };
    const hasExtra = extraAnd.events || extraAnd.profiles;
    // Builder 生成的桶表达式可能带 {display_tz:String} 参数；原始 SQL 模式不下发参数（保持现网形状）
    const queryParams = dto.mode === 'builder' ? bucketParams(timeScope) : undefined;
    let result: Awaited<ReturnType<ClickHouseService['querySql']>>;
    try {
      result = await this.clickHouse.querySql(
        expanded,
        queryParams,
        {
          additional_table_filters: this.guard.tableFilterSetting(bound, hasExtra ? extraAnd : undefined),
        },
        { signal },
      );
    } catch (error) {
      // 预算类失败换成可读文案 + 机器码（原文只留日志），其余错误照旧透传
      throw toQueryBudgetError(error, appConfig.query.maxExecutionTime) ?? error;
    }

    return {
      query_id: result.query_id,
      columns: result.columns,
      rows: result.rows,
      row_count: result.rows.length,
      truncated: result.rows.length >= (dto.limit ?? 1000),
      elapsed_ms: result.elapsed_ms,
      read_rows: result.read_rows,
      read_bytes: result.read_bytes,
      applied_time_range: { start: timeScope.startYmd, end: timeScope.endYmd, timezone: timeScope.tz },
    };
  }

  /** 覆盖已有 SQL 卡片（保留未传入的 dsl 字段） */
  async update(id: string, dto: SaveSqlReportDto, project: string, user: AuthUser, iam: IamContext) {
    const card = await this.cardRepo.findById(id);
    if (!card || card.project_name !== project || card.type !== 'sql') {
      throw notFound({
        code: 'report.sqlReport.notFound',
        messageKey: 'report:error.sqlReport.notFound',
        params: { id },
        message: `报表不存在: ${id}`,
      });
    }
    const asset = await this.policy.loadCard(project, id);
    await this.policy.assert(user.id, iam, 'update', asset);
    const existing = this.safeParse(card.dsl_json) ?? {};
    const chartConfig = dto.chart_config === undefined ? undefined : dto.chart_config === null ? null : parseChartConfigV1(dto.chart_config);
    const dsl = {
      ...existing,
      mode: dto.mode ?? existing.mode ?? 'sql',
      sql_text: dto.sql_text !== undefined ? dto.sql_text : existing.sql_text,
      dsl: dto.dsl !== undefined ? dto.dsl : existing.dsl,
      field_map: dto.field_map !== undefined ? dto.field_map : existing.field_map,
      chart_config: chartConfig !== undefined ? chartConfig : existing.chart_config,
      time_range: dto.time_range !== undefined ? dto.time_range : existing.time_range,
    };
    if (dto.name !== undefined && dto.name !== card.name) {
      const dup = await this.cardRepo.findByName(project, dto.name, id);
      if (dup) {
        throw conflict({
          code: 'report.card.nameExists',
          messageKey: 'report:error.card.nameExists',
          params: { name: dto.name },
          message: `已存在同名卡片「${dto.name}」，请换一个名称`,
        });
      }
    }
    await this.cardRepo.update(id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
      dsl_json: JSON.stringify(dsl),
      ...(chartConfig !== undefined ? { chart_type: resolvedCardChartType(chartConfig) } : {}),
    });
    const fresh = await this.cardRepo.findById(id);
    return this.cardToDetail(fresh!);
  }

  /** 保存为卡片（type='sql'，dsl 携带 sql_text/mode/field_map/chart_config） */
  async save(dto: SaveSqlReportDto, project: string, user: AuthUser) {
    const chartConfig = dto.chart_config == null ? null : parseChartConfigV1(dto.chart_config);
    if (await this.cardRepo.findByName(project, dto.name)) {
      throw conflict({
        code: 'report.card.nameExists',
        messageKey: 'report:error.card.nameExists',
        params: { name: dto.name },
        message: `已存在同名卡片「${dto.name}」，请换一个名称`,
      });
    }
    const card = await this.cardRepo.create({
      card_id: `card_${nanoid(10)}`,
      project_name: project,
      owner: user.id,
      name: dto.name,
      description: dto.description?.trim() || null,
      type: 'sql',
      dsl_json: JSON.stringify({
        mode: dto.mode,
        sql_text: dto.sql_text ?? '',
        dsl: dto.dsl ?? null,
        field_map: dto.field_map ?? null,
        chart_config: chartConfig,
        time_range: dto.time_range ?? null,
      }),
      chart_type: resolvedCardChartType(chartConfig),
      refresh_policy: 'manual',
    });
    return this.cardToSummary(card);
  }

  /** 已保存列表（= 卡片库 type='sql'，admin 看全部，其余看自己的） */
  async list(project: string, _user: AuthUser, iam: IamContext) {
    const rows = await this.cardRepo.findMany(project, 'sql');
    if (iam.permissions.has('dashboard.view_all') || iam.permissions.has('model.card_save')) {
      return rows.map((r) => this.cardToSummary(r));
    }
    return rows.filter((r) => r.owner === _user.id).map((r) => this.cardToSummary(r));
  }

  async get(id: string, project: string, user: AuthUser, iam: IamContext) {
    const card = await this.cardRepo.findById(id);
    if (!card || card.project_name !== project || card.type !== 'sql') {
      throw notFound({
        code: 'report.sqlReport.notFound',
        messageKey: 'report:error.sqlReport.notFound',
        params: { id },
        message: `报表不存在: ${id}`,
      });
    }
    const viewAll = iam.permissions.has('dashboard.view_all') || iam.permissions.has('model.sql');
    if (!viewAll && card.owner !== user.id) {
      const asset = await this.policy.loadCard(project, id);
      const can = await this.policy.canUpdate(user.id, iam, asset);
      if (!can) {
        throw notFound({
          code: 'report.sqlReport.notFound',
          messageKey: 'report:error.sqlReport.notFound',
          params: { id },
          message: `报表不存在: ${id}`,
        });
      }
    }
    return this.cardToDetail(card);
  }

  async remove(id: string, project: string, user: AuthUser, iam: IamContext) {
    const card = await this.cardRepo.findById(id);
    if (!card || card.project_name !== project || card.type !== 'sql') {
      throw notFound({
        code: 'report.sqlReport.notFound',
        messageKey: 'report:error.sqlReport.notFound',
        params: { id },
        message: `报表不存在: ${id}`,
      });
    }
    const asset = await this.policy.loadCard(project, id);
    await this.policy.assert(user.id, iam, 'delete', asset);

    await this.cardRepo.delete(id);
    return { deleted: 1 };
  }

  // ---------- 内部 ----------

  private timeRangeFromDsl(dsl: Record<string, unknown>): TimeRange | undefined {
    const raw = dsl.time_range;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const rec = raw as Record<string, unknown>;
    const start = typeof rec.start === 'string' ? rec.start : typeof rec.from === 'string' ? rec.from : '';
    const end = typeof rec.end === 'string' ? rec.end : typeof rec.to === 'string' ? rec.to : '';
    const relative = rec.relative && typeof rec.relative === 'object' && !Array.isArray(rec.relative)
      ? (rec.relative as TimeRange['relative'])
      : undefined;
    if (!relative && (!start || !end)) return undefined;
    const timezone = typeof rec.timezone === 'string' ? rec.timezone : undefined;
    return { start, end, relative, timezone };
  }

  /** 解析（含展示时区）并沿用 90 天上限守卫；恒等路径与历史行为一致 */
  private normalizeRange(
    timeRange?: {
      start?: string;
      end?: string;
      relative?: TimeRange['relative'];
      timezone?: string;
    },
    authUserTz?: string | null,
    project?: string,
  ): TimeScope {
    const source = timeRange?.relative || (timeRange?.start && timeRange?.end)
      ? timeRange
      : ({ start: '', end: '', relative: { kind: 'past_n', n: 7 }, timezone: timeRange?.timezone } as TimeRange);
    let scope: TimeScope;
    try {
      scope = this.timeScopeService.materialize(source as TimeRange, { authUserTz, projectName: project });
    } catch (err) {
      if (err instanceof DomainError) throw err; // timezone_invalid 自带契约
      throw badRequest({
        code: 'report.sqlReport.timeRangeInvalid',
        messageKey: 'report:error.sqlReport.timeRangeInvalid',
        message: err instanceof Error ? err.message : '时间范围格式错误',
      });
    }
    const days = (Date.parse(`${scope.endYmd}T00:00:00Z`) - Date.parse(`${scope.startYmd}T00:00:00Z`)) / 86400000;
    if (days < 0) {
      throw badRequest({
        code: 'report.sqlReport.rangeEndBeforeStart',
        messageKey: 'report:error.sqlReport.rangeEndBeforeStart',
        message: '时间范围结束早于开始',
      });
    }
    if (days > SqlReportService.MAX_RANGE_DAYS) {
      throw badRequest({
        code: 'report.sqlReport.rangeTooLong',
        messageKey: 'report:error.sqlReport.rangeTooLong',
        params: { days: SqlReportService.MAX_RANGE_DAYS },
        message: `时间范围最大 ${SqlReportService.MAX_RANGE_DAYS} 天`,
      });
    }
    return scope;
  }

  /** 强制 LIMIT：未写 LIMIT 自动追加，超上限拒绝 */
  private applyLimit(sql: string, limit: number): string {
    const trimmed = sql.trim().replace(/;+\s*$/, '');
    if (!/limit\s+\d+\s*$/i.test(trimmed)) {
      return `${trimmed} LIMIT ${limit}`;
    }
    return trimmed;
  }

  /**
   * Builder 模式：由 DSL 生成 SQL。
   * 本期 DSL 仅支持最简 event 计数 + 可选分群筛选/分组。
   */
  private async generateSqlFromDsl(
    dsl: unknown,
    project: string,
    uidExpr = ANALYSIS_UID_EXPR,
    timeScope?: TimeScope,
  ): Promise<string> {
    const d = (dsl ?? {}) as {
      event?: string;
      groups?: Array<
        | { kind: 'time'; granularity: string }
        | { kind: 'property'; prop: string }
        | { kind: 'column'; prop: string }
        | { kind: 'cohort'; prop: string }
        | { kind: 'tag'; prop: string }
      >;
      metrics?: Array<{ fn: string; prop?: string }>;
      filters?: { items?: Array<{ scope?: string; prop?: string; op?: string; value?: unknown }> };
    };
    const selects: string[] = [];
    const groups: string[] = [];
    const joins: string[] = [];
    const useUid = builderDslHasCohort(d) || builderDslHasTag(d);

    for (const g of d.groups ?? []) {
      if (g.kind === 'time') {
        const granularity = g.granularity ?? 'day';
        // 周统一 toMonday（ZQ-6 口径修正）；异时区按展示时区切桶（scope 缺省=恒等快路）
        const fn = timeScope
          ? bucketExpression(timeScope, 'log_time', (['day', 'hour', 'week', 'month'].includes(granularity)
              ? granularity
              : 'day') as 'day' | 'hour' | 'week' | 'month')
          : 'toStartOfDay(log_time)';
        selects.push(`${fn} AS \`${granularity}\``);
        groups.push(`\`${granularity}\``);
      } else if (g.kind === 'column') {
        if (!GROUPABLE_SYSTEM_COLUMNS.some((c) => c.name === g.prop)) {
          throw badRequest({
            code: 'report.sqlReport.systemColumnNotGroupable',
            messageKey: 'report:error.sqlReport.systemColumnNotGroupable',
            params: { prop: g.prop },
            message: `不支持按系统字段分组: ${g.prop}`,
          });
        }
        selects.push(`${g.prop} AS \`${g.prop}\``);
        groups.push(`\`${g.prop}\``);
      } else if (g.kind === 'cohort') {
        const resolved = await this.cohortBatches.resolve(project, g.prop);
        const expr = cohortGroupSqlExpression({
          uidExpr,
          project,
          cohortId: g.prop,
          batchId: resolved.batch_id,
        });
        selects.push(`${expr} AS \`用户分群\``);
        groups.push('`用户分群`');
      } else if (g.kind === 'tag') {
        const resolved = await this.tagBatches.resolve(project, g.prop);
        const bound = tagGroupSql({
          uidExpr,
          project,
          tagId: g.prop,
          batchId: resolved.batch_id,
          alias: `tg_${joins.length}`,
        });
        joins.push(bound.joinSql);
        selects.push(`${bound.expr} AS \`用户标签\``);
        groups.push('`用户标签`');
      } else {
        selects.push(`JSONExtractString(properties, '${g.prop}') AS \`${g.prop}\``);
        groups.push(`\`${g.prop}\``);
      }
    }

    for (const m of d.metrics ?? [{ fn: 'count' }]) {
      if (m.fn === 'count') selects.push('count() AS `event_count`');
      else if (m.fn === 'uniq') {
        selects.push(
          useUid ? `${uniqExactSubject(uidExpr)} AS \`uniq_users\`` : 'uniqExact(distinct_id) AS `uniq_users`',
        );
      } else if (m.fn === 'sum' && m.prop) selects.push(`sum(JSONExtractFloat(properties, '${m.prop}')) AS \`sum_${m.prop}\``);
      else if (m.fn === 'avg' && m.prop) selects.push(`avg(JSONExtractFloat(properties, '${m.prop}')) AS \`avg_${m.prop}\``);
    }

    let sql = `SELECT ${selects.join(', ')} FROM clklog_sa.sa_events${joins.length ? `\n${joins.join('\n')}` : ''}`;
    const wheres: string[] = [];
    if (d.event) wheres.push(`event = '${d.event.replace(/'/g, "\\'")}'`);
    for (const item of d.filters?.items ?? []) {
      if (item.scope === 'cohort' && item.prop) {
        const resolved = await this.cohortBatches.resolve(project, item.prop);
        wheres.push(
          cohortMemberSqlPredicate({
            uidExpr,
            project,
            cohortId: item.prop,
            batchId: resolved.batch_id,
            op: item.op === 'not_in' ? 'not_in' : 'in',
          }),
        );
      }
      if (item.scope === 'tag' && item.prop) {
        const resolved = await this.tagBatches.resolve(project, item.prop);
        const values = Array.isArray(item.value)
          ? item.value.map(String)
          : String(item.value ?? '')
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean);
        wheres.push(
          tagMemberSqlPredicate({
            uidExpr,
            project,
            tagId: item.prop,
            batchId: resolved.batch_id,
            values,
            op: item.op === 'not_in' ? 'not_in' : 'in',
          }),
        );
      }
    }
    if (wheres.length) sql += ` WHERE ${wheres.join(' AND ')}`;
    if (groups.length) sql += ` GROUP BY ${groups.join(', ')}`;
    return sql;
  }

  private async expandCohortFunctions(sql: string, project: string, uidExpr?: string): Promise<string> {
    const calls = collectCohortFunctionCalls(sql);
    if (calls.length === 0) return sql;
    const resolved = new Map<string, { project: string; batchId: string }>();
    for (const call of calls) {
      if (resolved.has(call.cohortId)) continue;
      const hit = await this.cohortBatches.resolve(project, call.cohortId);
      resolved.set(call.cohortId, { project, batchId: hit.batch_id || MISSING_COHORT_BATCH });
    }
    return expandSaInCohortFunctions(sql, resolved, uidExpr);
  }

  private async expandTagFunctions(sql: string, project: string, uidExpr?: string): Promise<string> {
    const calls = collectTagFunctionCalls(sql);
    if (calls.length === 0) return sql;
    const resolved = new Map<string, { project: string; batchId: string }>();
    for (const call of calls) {
      if (resolved.has(call.tagId)) continue;
      const hit = await this.tagBatches.resolve(project, call.tagId);
      resolved.set(call.tagId, { project, batchId: hit.batch_id || MISSING_COHORT_BATCH });
    }
    return expandSaTagFunctions(sql, resolved, uidExpr);
  }

  /** card 行 → 旧 SqlReport 形状摘要（前端类型兼容） */
  private cardToSummary(c: {
    card_id: string;
    name: string;
    description?: string | null;
    dsl_json: string;
    created_at: Date;
    updated_at: Date;
  }) {
    const dsl = this.safeParse(c.dsl_json);
    return {
      id: c.card_id,
      name: c.name,
      description: c.description ?? null,
      mode: (dsl?.mode as string) ?? 'sql',
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  /** card 行 → 旧 SqlReport 形状详情 */
  private cardToDetail(c: {
    card_id: string;
    name: string;
    description?: string | null;
    dsl_json: string;
    created_at: Date;
    updated_at: Date;
  }) {
    const dsl = this.safeParse(c.dsl_json) ?? {};
    const chartConfig = sanitizeStoredChartConfig(dsl.chart_config, (message) =>
      this.logger.warn(`card ${c.card_id} chart_config ignored: ${message}`),
    );
    return {
      id: c.card_id,
      name: c.name,
      description: c.description ?? null,
      mode: (dsl.mode as string) ?? 'sql',
      sql_text: (dsl.sql_text as string) ?? null,
      dsl: dsl.dsl ?? null,
      field_map: dsl.field_map ?? null,
      chart_config: chartConfig,
      schema_version: 1,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  private safeParse(json: string): Record<string, unknown> | null {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
}
