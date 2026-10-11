import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  FilterGroup,
  FilterItem,
  FilterScope,
  RetentionEvent,
  RetentionQuery,
  TimeGranularity,
  isAnyEvent,
} from '../../types/dsl.types';
import { asStringExtraction, booleanAwareBinding } from './boolean-filter-binding';
import { AttributeResolverService } from '../shared/attribute-resolver.service';
import { MetaVirtualEventService } from '../meta/meta-virtual-event.service';
import { CohortBatchService } from './cohort-batch.service';
import { bindCohortFilter, bindCohortGroup } from './cohort-member-sql';
import { TagBatchService } from './tag-batch.service';
import { bindTagFilter, bindTagGroup } from './tag-member-sql';
import { SubjectService } from '../subject/subject.service';
import { subjectExpr } from '../subject/subject-expr';
import { JoinRegistry } from '../relation/join-registry';
import { addCalendarDays, epochOfDayEndExclusive } from '../time/calendar';
import { TimeScopeService, type TimeScope } from '../time/time-scope';
import { TimezoneService } from '../time/timezone.service';

export interface RetentionSqlResult {
  sql: string;
  params: Record<string, unknown>;
  cacheKey: string;
  nList: number[];
  warnings?: string[];
}

interface GenContext {
  params: Record<string, unknown>;
  paramIndex: number;
  paramPrefix: string;
  uidExpr?: string;
  subjectId?: string;
}

type ResolveContext = {
  project: string;
  event?: string;
  events?: string[];
  /** 跨表取数收集器：user scope 属性 / 主体解析时必填（modules/relation/join-registry.ts） */
  joins?: JoinRegistry;
};

@Injectable()
export class RetentionSqlGeneratorService {
  constructor(
    private readonly attributeResolver: AttributeResolverService,
    private readonly virtualEventService: MetaVirtualEventService,
    private readonly cohortBatches: CohortBatchService,
    private readonly tagBatches: TagBatchService,
    private readonly subjects: SubjectService,
    // 缺省构造兜底纯单测；生产由 DI 注入（TimeModule @Global）
    private readonly timeScope: TimeScopeService = new TimeScopeService(new TimezoneService(undefined)),
  ) {}

  async generate(query: RetentionQuery, extraAnd?: string | null): Promise<RetentionSqlResult> {
    const nList = query.n_list;
    const granularity = query.granularity;
    const resolved = await this.subjects.resolve(query.project, query.subject_id);
    const joins = new JoinRegistry();
    const uidExpr = subjectExpr(resolved, joins);
    const ctx: GenContext = {
      params: {},
      paramIndex: 0,
      paramPrefix: 'r_',
      uidExpr,
      subjectId: resolved.subject_id,
    };
    const warnings: string[] = [];
    // 时间窗：恒等路径与历史一致；异时区 stat_date 宽扫 ±1d + epoch 精切，桶按展示日历（TimeScope）
    const timeScope = this.timeScope.materialize(query.time_range);
    const maxN = Math.max(...nList);
    const scanEndRaw = extendDate(timeScope.endYmd, maxN, granularity);
    const bucketExpr = timeBucketExpression(timeScope, granularity);
    let scanStart = timeScope.startYmd;
    let scanEnd = scanEndRaw;
    let epochFilter = '';
    if (!timeScope.isPlatformCalendar) {
      scanStart = addCalendarDays(scanStart, -1);
      scanEnd = addCalendarDays(scanEnd, 1);
      epochFilter = `
        AND log_time >= fromUnixTimestamp64Milli({ret_start_ms:Int64})
        AND log_time < fromUnixTimestamp64Milli({ret_scanend_ms:Int64})`;
    }
    const retentionEvents = await this.collectEventNames(query);
    const scanAllEvents =
      isAnyEvent(query.start_event.event) || isAnyEvent(query.retain_event.event);
    const startPred = await this.eventPredicate(query.start_event, query, ctx, 'start', {
      firstDay: query.cohort === 'first_day',
    }, warnings, joins);
    const retainPred = await this.eventPredicate(query.retain_event, query, ctx, 'retain', {
      firstDay: false,
    }, warnings, joins);
    let globalFilterSql = '';
    if (query.filters) {
      const resolveCtx: ResolveContext = {
        project: query.project,
        event: query.start_event.event,
        joins,
      };
      globalFilterSql = await this.buildFilterGroup(query.filters, ctx, resolveCtx, warnings);
    }
    let groupExpr = '';
    let tagJoin = '';
    if (query.groups?.[0]?.scope === 'tag') {
      const bound = await bindTagGroup(
        query.groups[0].prop || '',
        query.project,
        ctx,
        this.tagBatches,
        warnings,
        'tg_0',
      );
      tagJoin = bound.joinSql;
      groupExpr = bound.expr;
    } else if (query.groups?.[0]?.scope === 'cohort') {
      groupExpr = await bindCohortGroup(
        query.groups[0].prop || '',
        query.project,
        ctx,
        this.cohortBatches,
        warnings,
      );
    }

    const offsetFn = offsetFunction(granularity);
    const retentionConds = [
      'stat_bucket = cohort_bucket',
      ...nList.map((n, i) => {
        const name = `n_${i}`;
        ctx.params[name] = n;
        return `stat_bucket = ${offsetFn}(cohort_bucket, {${name}: UInt16}) AND (${retainPred})`;
      }),
    ];

    const params: Record<string, unknown> = {
      project: query.project,
      scan_start: scanStart,
      scan_end: scanEnd,
      start: timeScope.startYmd,
      end: timeScope.endYmd,
      limit: 366,
      retention_events: retentionEvents,
      ...ctx.params,
    };
    if (!timeScope.isPlatformCalendar) {
      params.ret_start_ms = timeScope.startEpochMs;
      params.ret_scanend_ms = epochOfDayEndExclusive(timeScope.tz, scanEndRaw);
      params.display_tz = timeScope.tz;
    }

    const rateSelects = nList
      .map((n, i) => {
        const idx = i + 2;
        return `  sum(r[${idx}]) AS n_${n},\n  if(count() = 0, 0, round(sum(r[${idx}]) / count(), 4)) AS n_${n}_rate`;
      })
      .join(',\n');

    // 事件条件 / 全局筛选 / 分组里的跨表 JOIN 统一拼到内层 FROM 之后
    const joinsSql = joins.render().map((j) => `\n      ${j}`).join('');

    const sql = `SELECT
  cohort_date,
  ${groupExpr ? 'group_col,\n  ' : ''}count() AS cohort_size,
${rateSelects}
FROM (
  SELECT
    uid,
    cohort_bucket AS cohort_date,
    ${groupExpr ? 'group_col,\n    ' : ''}retention(
${retentionConds.map((c) => `      ${c}`).join(',\n')}
    ) AS r
  FROM (
    SELECT
      uid,
      stat_bucket,
      event,
      is_first_day,
      properties,
      user_key,
      distinct_id,
      ${groupExpr ? 'group_col,\n      ' : ''}minIf(stat_bucket, ${startPred}) OVER (PARTITION BY uid) AS cohort_bucket
    FROM (
      SELECT
        *,
        ${uidExpr} AS uid,
        ${bucketExpr} AS stat_bucket
        ${groupExpr ? `,\n        ${groupExpr} AS group_col` : ''}
      FROM clklog_sa.sa_events
      ${tagJoin}${joinsSql}
      WHERE project_name = {project: String}
        AND stat_date BETWEEN {scan_start: String} AND {scan_end: String}${epochFilter}
        ${scanAllEvents ? '' : 'AND event IN {retention_events: Array(String)}'}
        ${globalFilterSql ? `AND (${globalFilterSql})` : ''}
        ${extraAnd ? `AND (${extraAnd})` : ''}
    )
  )
  WHERE cohort_bucket >= toDate({start: String})
    AND cohort_bucket <= toDate({end: String})
    AND uid != ''
  GROUP BY uid, cohort_date${groupExpr ? ', group_col' : ''}
)
GROUP BY cohort_date${groupExpr ? ', group_col' : ''}
ORDER BY cohort_date
LIMIT {limit: UInt32}`;

    const cacheKey = createHash('sha256')
      .update(sql + JSON.stringify(params))
      .digest('hex');
    return { sql, params, cacheKey, nList, warnings };
  }

  private async collectEventNames(query: RetentionQuery): Promise<string[]> {
    const names = await Promise.all(
      [query.start_event.event, query.retain_event.event].map(async (eventName) => {
        if (isAnyEvent(eventName)) return [] as string[];
        const virtualDef = await this.virtualEventService.findDefinition(eventName, query.project);
        return virtualDef?.events?.length ? virtualDef.events : [eventName];
      }),
    );
    return [...new Set(names.flat())];
  }

  private async eventPredicate(
    spec: RetentionEvent,
    query: RetentionQuery,
    ctx: GenContext,
    prefix: string,
    opts: { firstDay: boolean },
    warnings: string[] = [],
    joins?: JoinRegistry,
  ): Promise<string> {
    const virtualDef = await this.virtualEventService.findDefinition(spec.event, query.project);
    const resolveCtx: ResolveContext = {
      project: query.project,
      event: spec.event,
      events: virtualDef?.events,
      joins,
    };
    const parts: string[] = [];
    if (virtualDef) {
      const name = `${prefix}_events`;
      ctx.params[name] = virtualDef.events;
      parts.push(`event IN {${name}: Array(String)}`);
      if (virtualDef.filters) {
        const vf = await this.buildFilterGroup(virtualDef.filters, ctx, resolveCtx, warnings);
        if (vf) parts.push(`(${vf})`);
      }
    } else if (!isAnyEvent(spec.event)) {
      const name = `${prefix}_event`;
      ctx.params[name] = spec.event;
      parts.push(`event = {${name}: String}`);
    }
    if (spec.filters) {
      const f = await this.buildFilterGroup(spec.filters, ctx, resolveCtx, warnings);
      if (f) parts.push(`(${f})`);
    }
    if (opts.firstDay) {
      parts.push(
        "(is_first_day = 1 OR JSONExtractString(properties, '$is_first_day') IN ('true', '1'))",
      );
    }
    return parts.join(' AND ') || '1';
  }

  private async buildFilterGroup(
    group: FilterGroup,
    ctx: GenContext,
    resolveCtx: ResolveContext,
    warnings: string[],
  ): Promise<string> {
    const parts: string[] = [];
    for (const item of group.items) {
      if ('logic' in item) {
        const inner = await this.buildFilterGroup(item as FilterGroup, ctx, resolveCtx, warnings);
        if (inner) parts.push(`(${inner})`);
      } else {
        const inner = await this.buildFilterItem(item as FilterItem, ctx, resolveCtx, warnings);
        if (inner) parts.push(inner);
      }
    }
    if (parts.length === 0) return '';
    return parts.join(` ${group.logic.toUpperCase()} `);
  }

  private async buildFilterItem(
    item: FilterItem,
    ctx: GenContext,
    resolveCtx: ResolveContext,
    warnings: string[],
  ): Promise<string> {
    const cohortSql = await bindCohortFilter(
      item,
      resolveCtx.project,
      ctx,
      this.cohortBatches,
      warnings,
    );
    if (cohortSql) return cohortSql;
    const tagSql = await bindTagFilter(item, resolveCtx.project, ctx, this.tagBatches, warnings);
    if (tagSql) return tagSql;
    const dataType = await this.attributeResolver.inferDataType(
      item.prop,
      item.scope,
      resolveCtx,
    );
    let attr = await this.attributeResolver.resolve(
      item.prop,
      item.scope as FilterScope,
      dataType,
      resolveCtx,
    );
    const op = item.op;
    // 布尔属性降级为字符串提取比较（存储形态有 JSON 布尔与字符串两种）
    if (dataType === 'boolean') attr = asStringExtraction(attr);
    const paramName = `${ctx.paramPrefix}p_${ctx.paramIndex++}`;
    switch (op) {
      case '=':
      case '!=': {
        const { attr: bindAttr, value: bindValue } = booleanAwareBinding(dataType, attr, item.value);
        ctx.params[paramName] = bindValue;
        return `${bindAttr} ${op} {${paramName}: String}`;
      }
      case 'contains':
        ctx.params[paramName] = `%${String(item.value)}%`;
        return `like(${attr}, {${paramName}: String})`;
      case 'not_contains':
        ctx.params[paramName] = `%${String(item.value)}%`;
        return `notLike(${attr}, {${paramName}: String})`;
      case 'in':
      case 'not_in': {
        const values = Array.isArray(item.value)
          ? item.value
          : String(item.value)
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean);
        if (values.length === 0) throw new Error(`${op} 操作符需要至少一个值`);
        ctx.params[paramName] = values;
        const expr = `has({${paramName}: Array(String)}, ${attr})`;
        return op === 'in' ? expr : `not(${expr})`;
      }
      case 'regex':
        ctx.params[paramName] = String(item.value);
        return `match(${attr}, {${paramName}: String})`;
      case 'not_regex':
        ctx.params[paramName] = String(item.value);
        return `not(match(${attr}, {${paramName}: String}))`;
      case 'gt':
        ctx.params[paramName] = Number(item.value);
        return `${attr} > {${paramName}: Float64}`;
      case 'gte':
        ctx.params[paramName] = Number(item.value);
        return `${attr} >= {${paramName}: Float64}`;
      case 'lt':
        ctx.params[paramName] = Number(item.value);
        return `${attr} < {${paramName}: Float64}`;
      case 'lte':
        ctx.params[paramName] = Number(item.value);
        return `${attr} <= {${paramName}: Float64}`;
      case 'is_set':
        return `${attr} != ''`;
      case 'not_set':
        return `${attr} = ''`;
      default:
        throw new Error(`暂不支持的 filter op: ${item.op}`);
    }
  }

  async listUsers(
    query: RetentionQuery,
    cell: { cohort_date?: string; n?: number; group_col?: string },
    limit: number,
  ): Promise<{ sql: string; params: Record<string, unknown> }> {
    const generated = await this.generate(query);
    const start = generated.sql.indexOf('FROM (\n  SELECT\n    uid,');
    const end = generated.sql.lastIndexOf('\n)\nGROUP BY');
    if (start < 0 || end < 0) {
      throw new Error('留存 SQL 无法列出用户');
    }
    const uidGrain = generated.sql.slice(start + 'FROM ('.length, end);
    const params: Record<string, unknown> = {
      ...generated.params,
      lu_date: String(cell.cohort_date ?? ''),
      lu_limit: limit,
    };
    const retainIdx = cell.n != null ? Number(cell.n) + 1 : 0;
    const retainPred = retainIdx > 0 ? ` AND r[${retainIdx}] = 1` : '';
    let groupPred = '';
    if (cell.group_col !== undefined && cell.group_col !== null) {
      params.lu_group = String(cell.group_col);
      groupPred = ' AND toString(group_col) = {lu_group: String}';
    }
    const sql = `SELECT uid FROM (
${uidGrain}
) WHERE toString(cohort_date) = {lu_date: String}${retainPred}${groupPred}
LIMIT {lu_limit: UInt32}`;
    return { sql, params };
  }
}

function timeBucketExpression(timeScope: TimeScope, granularity: TimeGranularity): string {
  if (timeScope.isPlatformCalendar) {
    switch (granularity) {
      case 'week':
        return 'toMonday(toDate(stat_date))';
      case 'month':
        return 'toStartOfMonth(toDate(stat_date))';
      default:
        return 'toDate(stat_date)';
    }
  }
  const displayDay = 'toDate(log_time, {display_tz:String})';
  switch (granularity) {
    case 'week':
      return `toMonday(${displayDay})`;
    case 'month':
      return `toStartOfMonth(${displayDay})`;
    default:
      return displayDay;
  }
}

function offsetFunction(granularity: TimeGranularity): string {
  switch (granularity) {
    case 'week':
      return 'addWeeks';
    case 'month':
      return 'addMonths';
    default:
      return 'addDays';
  }
}

export function extendDate(end: string, amount: number, granularity: TimeGranularity): string {
  const [year, month, day] = end.split('-').map(Number);
  if (granularity === 'month') {
    const shifted = new Date(Date.UTC(year, month - 1 + amount, 1));
    const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
    shifted.setUTCDate(Math.min(day, lastDay));
    return shifted.toISOString().slice(0, 10);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (granularity === 'week') date.setUTCDate(date.getUTCDate() + amount * 7);
  else date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
