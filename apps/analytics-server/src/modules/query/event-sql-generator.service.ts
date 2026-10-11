import { Injectable } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import { createHash } from 'crypto';
import {
  ANY_EVENT,
  EventAnalysisQuery,
  FilterGroup,
  FilterItem,
  Group,
  Metric,
  FilterScope,
  type AnalysisMethod,
} from '../../types/dsl.types';
import { asStringExtraction, booleanAwareBinding } from './boolean-filter-binding';
import { AttributeResolverService } from '../shared/attribute-resolver.service';
import { MetaVirtualEventService } from '../meta/meta-virtual-event.service';
import { isNumericAnalysisMethod, methodAllowedForDataType, normalizeMetric } from './metric-normalize';
import { buildTransformSql } from './metric-transform';
import { CohortBatchService } from './cohort-batch.service';
import { bindCohortFilter, bindCohortGroup } from './cohort-member-sql';
import { TagBatchService } from './tag-batch.service';
import { bindTagFilter, bindTagGroup } from './tag-member-sql';
import { SubjectService } from '../subject/subject.service';
import { subjectExpr, uniqExpr, uniqSubject } from '../subject/subject-expr';
import { JoinRegistry } from '../relation/join-registry';
import {
  bucketExpression,
  extractExpression,
  timeScopeFilter,
  TimeScopeService,
  type TimeScope,
} from '../time/time-scope';
import { TimezoneService } from '../time/timezone.service';

export interface SqlGenerationResult {
  sql: string;
  params: Record<string, unknown>;
  cacheKey: string;
  warnings?: string[];
}

interface GenContext {
  sql: string[];
  params: Record<string, unknown>;
  paramIndex: number;
  paramPrefix: string;
  uidExpr?: string;
  subjectId?: string;
}

interface GroupDef {
  alias: string;
  expr: string;
  fromJoin?: string;
  time?: boolean;
}

type ResolveContext = {
  project: string;
  event?: string;
  events?: string[];
  /** 跨表取数收集器：user scope 属性 / 主体解析时必填（modules/relation/join-registry.ts） */
  joins?: JoinRegistry;
};

@Injectable()
export class EventSqlGeneratorService {
  constructor(
    private readonly attributeResolver: AttributeResolverService,
    private readonly virtualEventService: MetaVirtualEventService,
    private readonly cohortBatches: CohortBatchService,
    private readonly tagBatches: TagBatchService,
    private readonly subjects: SubjectService,
    // 缺省构造兜底纯单测；生产由 DI 注入（TimeModule @Global）
    private readonly timeScope: TimeScopeService = new TimeScopeService(new TimezoneService(undefined)),
  ) {}

  async generate(query: EventAnalysisQuery, extraAnd?: string | null): Promise<SqlGenerationResult> {
    const warnings: string[] = [];
    const timeScope = this.timeScope.materialize(query.time_range);
    const resolved = await this.subjects.resolve(query.project, query.subject_id);
    const joins = new JoinRegistry();
    const uidExpr = subjectExpr(resolved, joins);
    const { defs: groupDefs, params: groupParams } = await this.buildGroupDefs(
      query,
      warnings,
      uidExpr,
      resolved.subject_id,
      joins,
      timeScope,
    );
    const metricDefs = (
      await Promise.all(
        query.metrics.map(async (metric, i) => {
          const normalized = normalizeMetric(metric);
          if (normalized.kind === 'formula') return null;
          const alias = `m_${i}`;
          const prefix = `m${i}_`;
          const { sql, params } = await this.buildMetricSubquery(
            normalized,
            query,
            groupDefs,
            alias,
            prefix,
            warnings,
            uidExpr,
            resolved.subject_id,
            extraAnd,
            joins,
            timeScope,
          );
          return { alias, sql, params };
        }),
      )
    ).filter((d): d is { alias: string; sql: string; params: Record<string, unknown> } => d != null);
    if (metricDefs.length === 0) {
      throw badRequest({
        code: 'analysis.dsl.eventMetricRequired',
        messageKey: 'analysis:error.dsl.eventMetricRequired',
        message: '至少需要一个事件指标',
      });
    }

    const limit = query.limit ?? query.group_limit ?? 1000;
    let sql: string;
    let params: Record<string, unknown> = {};

    if (metricDefs.length === 1) {
      sql = metricDefs[0].sql;
      params = { ...groupParams, ...metricDefs[0].params };
    } else if (groupDefs.length === 0) {
      const selects = metricDefs
        .map((d) => `${d.alias}.${d.alias} AS ${d.alias}`)
        .join(',\n  ');
      const from = metricDefs
        .map((d) => `(\n${d.sql}\n) AS ${d.alias}`)
        .join(' CROSS JOIN ');
      sql = `SELECT\n  ${selects}\nFROM ${from}`;
      params = this.mergeParams([groupParams, ...metricDefs.map((d) => d.params)]);
    } else {
      const joinKeys = groupDefs.map((g) => g.alias);
      const selectGroup =
        joinKeys.length > 0
          ? joinKeys
                .map(
                  (k) =>
                    `COALESCE(${metricDefs
                      .map((d) => `${d.alias}.${k}`)
                      .join(', ')}) AS ${k}`,
                )
                .join(',\n  ') + ',\n  '
          : '';
      const selectMetrics = metricDefs
        .map((d) => `${d.alias}.${d.alias} AS ${d.alias}`)
        .join(',\n  ');

      let from = `(\n${metricDefs[0].sql}\n) AS ${metricDefs[0].alias}`;
      for (let i = 1; i < metricDefs.length; i++) {
        const d = metricDefs[i];
        const cond = joinKeys
          .map((k) => `${metricDefs[0].alias}.${k} = ${d.alias}.${k}`)
          .join(' AND ');
        from += ` FULL OUTER JOIN (\n${d.sql}\n) AS ${d.alias} ON ${cond}`;
      }

      sql = `SELECT\n  ${selectGroup}${selectMetrics}\nFROM ${from}`;
      params = this.mergeParams([groupParams, ...metricDefs.map((d) => d.params)]);
    }

    if (metricDefs.length > 1) {
      sql += `\n${this.orderBySql(groupDefs, metricDefs[0].alias)}`;
      sql += `\nLIMIT {limit: UInt32}`;
      params.limit = limit;
    }

    params.project = query.project;
    const cacheKey = createHash('sha256')
      .update(sql + JSON.stringify(params))
      .digest('hex');

    return { sql, params, cacheKey, warnings };
  }

  private mergeParams(
    paramsList: Record<string, unknown>[],
  ): Record<string, unknown> {
    return paramsList.reduce((acc, p) => ({ ...acc, ...p }), {});
  }

  /** 有时间分组时按时间升序，避免折线横轴变成 6 号、4 号、7 号；维度排行仍按指标降序。 */
  private orderBySql(groupDefs: GroupDef[], metricAlias: string): string {
    const timeAliases = groupDefs.filter((group) => group.time).map((group) => group.alias);
    if (timeAliases.length) return `ORDER BY ${timeAliases.map((alias) => `${alias} ASC`).join(', ')}`;
    return `ORDER BY ${metricAlias} DESC`;
  }

  private async buildGroupDefs(
    query: EventAnalysisQuery,
    warnings: string[],
    uidExpr: string,
    subjectId: string,
    joins: JoinRegistry,
    timeScope: TimeScope,
  ): Promise<{ defs: GroupDef[]; params: Record<string, unknown> }> {
    const defs: GroupDef[] = [];
    const baseEvent = query.metrics.find((m) => m.kind !== 'formula')?.event ?? query.event;
    const baseVirtualDef =
      baseEvent && baseEvent !== ANY_EVENT
        ? await this.virtualEventService.findDefinition(baseEvent, query.project)
        : null;
    const baseResolveCtx = this.buildResolveContext(
      query.project,
      baseEvent,
      baseVirtualDef?.events,
      joins,
    );

    const groupCtx: GenContext = {
      sql: [],
      params: {},
      paramIndex: 0,
      paramPrefix: 'gg_',
      uidExpr,
      subjectId,
    };
    for (let i = 0; i < (query.groups ?? []).length; i++) {
      const group = query.groups![i];
      if (group.scope === 'time' && group.granularity === 'total') continue;
      const alias = `g_${i}`;
      if (group.scope === 'tag') {
        const bound = await bindTagGroup(
          group.prop || '',
          query.project,
          groupCtx,
          this.tagBatches,
          warnings,
          `tg_${i}`,
        );
        defs.push({ alias, expr: bound.expr, fromJoin: bound.joinSql });
        continue;
      }
      const expr = await this.buildGroupExpression(group, baseResolveCtx, query.project, groupCtx, warnings, timeScope);
      defs.push({ alias, expr, time: group.scope === 'time' });
    }
    if (!timeScope.isPlatformCalendar) groupCtx.params.display_tz = timeScope.tz;
    return { defs, params: groupCtx.params };
  }

  private async buildMetricSubquery(
    metric: Metric,
    query: EventAnalysisQuery,
    groupDefs: GroupDef[],
    metricAlias: string,
    paramPrefix: string,
    warnings: string[],
    uidExpr: string,
    subjectId: string,
    extraAnd: string | null | undefined,
    joins: JoinRegistry,
    timeScope: TimeScope,
  ): Promise<{ sql: string; params: Record<string, unknown> }> {
    const ctx: GenContext = {
      sql: [],
      params: {},
      paramIndex: 0,
      paramPrefix,
      uidExpr,
      subjectId,
    };

    const eventKey = metric.event ?? query.event;
    const virtualDef =
      eventKey && eventKey !== ANY_EVENT
        ? await this.virtualEventService.findDefinition(eventKey, query.project)
        : null;
    const resolveCtx = this.buildResolveContext(
      query.project,
      eventKey,
      virtualDef?.events,
      joins,
    );

    ctx.sql.push('SELECT');

    const selects: string[] = [];
    for (const g of groupDefs) {
      selects.push(`${g.expr} AS ${g.alias}`);
    }
    const metricExpr = await this.buildMetricExpression(metric, resolveCtx, uidExpr, query.approx === true);
    selects.push(`${this.applyMetricTransform(metricExpr, metric)} AS ${metricAlias}`);
    ctx.sql.push(selects.join(',\n  '));

    ctx.sql.push('FROM clklog_sa.sa_events');
    const fromIndex = ctx.sql.length;
    for (const g of groupDefs) {
      if (g.fromJoin) ctx.sql.push(g.fromJoin);
    }
    ctx.sql.push('WHERE');

    ctx.sql.push(this.eqParam(ctx, 'project_name', 'project', 'String'));
    ctx.params[`${paramPrefix}project`] = query.project;

    if (virtualDef) {
      ctx.sql.push(`AND ${this.inParam(ctx, 'event', 'events', 'Array(String)')}`);
      ctx.params[`${paramPrefix}events`] = virtualDef.events;
      if (virtualDef.filters) {
        const vf = await this.buildFilterGroup(
          virtualDef.filters,
          query,
          ctx,
          0,
          resolveCtx,
          warnings,
        );
        if (vf) ctx.sql.push(`AND (${vf})`);
      }
    } else if (eventKey && eventKey !== ANY_EVENT) {
      ctx.sql.push(`AND ${this.eqParam(ctx, 'event', 'event', 'String')}`);
      ctx.params[`${paramPrefix}event`] = eventKey;
    }

    // 时间窗：恒等路径与历史逐字节一致；异时区宽扫 stat_date + epoch 精切（TimeScope）
    const tf = timeScopeFilter(timeScope, { paramPrefix });
    ctx.sql.push(`AND ${tf.where}`);
    Object.assign(ctx.params, tf.params);
    if (extraAnd) ctx.sql.push(`AND (${extraAnd})`);

    if (query.filters) {
      const f = await this.buildFilterGroup(
        query.filters,
        query,
        ctx,
        0,
        resolveCtx,
        warnings,
      );
      if (f) ctx.sql.push(`AND (${f})`);
    }

    if (metric.filters) {
      const f = await this.buildFilterGroup(
        metric.filters,
        query,
        ctx,
        0,
        resolveCtx,
        warnings,
      );
      if (f) ctx.sql.push(`AND (${f})`);
    }
    ctx.sql.push(`AND ${uidExpr} != ''`);

    if (groupDefs.length > 0) {
      ctx.sql.push(`GROUP BY ${groupDefs.map((g) => g.alias).join(', ')}`);
    }

    if (query.metrics.length === 1) {
      ctx.sql.push(this.orderBySql(groupDefs, metricAlias));
      const limit = query.limit ?? query.group_limit ?? 1000;
      ctx.sql.push(`LIMIT {${paramPrefix}limit: UInt32}`);
      ctx.params[`${paramPrefix}limit`] = limit;
    }

    // 分组 / 指标 / 筛选里的跨表 JOIN 在表达式全部构造完成后再统一插入 FROM 之后
    ctx.sql.splice(fromIndex, 0, ...joins.render());

    return { sql: ctx.sql.join('\n'), params: ctx.params };
  }

  async listUsers(
    query: EventAnalysisQuery,
    cell: { metric_id?: string; groups?: Record<string, unknown> },
    limit: number,
    extraAnd?: string | null,
  ): Promise<SqlGenerationResult> {
    const warnings: string[] = [];
    const resolved = await this.subjects.resolve(query.project, query.subject_id);
    const joins = new JoinRegistry();
    const uidExpr = subjectExpr(resolved, joins);
    const metric =
      query.metrics.find((item) => item.id === cell.metric_id) ??
      query.metrics.find((item) => normalizeMetric(item).analysis === 'trig_user_num') ??
      query.metrics.find((item) => item.kind !== 'formula');
    if (!metric || metric.kind === 'formula') {
      throw badRequest({
        code: 'analysis.event.cohortMetricRequired',
        messageKey: 'analysis:error.event.cohortMetricRequired',
        message: '结果分群需要人数类指标',
      });
    }
    const normalized = normalizeMetric(metric);
    const timeScope = this.timeScope.materialize(query.time_range);
    const { defs: groupDefs, params: groupParams } = await this.buildGroupDefs(
      query,
      warnings,
      uidExpr,
      resolved.subject_id,
      joins,
      timeScope,
    );
    const ctx: GenContext = {
      sql: [],
      params: { ...groupParams },
      paramIndex: 0,
      paramPrefix: 'lu_',
      uidExpr,
      subjectId: resolved.subject_id,
    };
    const eventKey = normalized.event ?? query.event;
    const virtualDef =
      eventKey && eventKey !== ANY_EVENT
        ? await this.virtualEventService.findDefinition(eventKey, query.project)
        : null;
    const resolveCtx = this.buildResolveContext(query.project, eventKey, virtualDef?.events, joins);
    ctx.sql.push(`SELECT DISTINCT ${uidExpr} AS uid`);
    ctx.sql.push('FROM clklog_sa.sa_events');
    const fromIndex = ctx.sql.length;
    for (const g of groupDefs) {
      if (g.fromJoin) ctx.sql.push(g.fromJoin);
    }
    ctx.sql.push('WHERE');
    ctx.sql.push(this.eqParam(ctx, 'project_name', 'project', 'String'));
    ctx.params.lu_project = query.project;
    if (virtualDef) {
      ctx.sql.push(`AND ${this.inParam(ctx, 'event', 'events', 'Array(String)')}`);
      ctx.params.lu_events = virtualDef.events;
      if (virtualDef.filters) {
        const vf = await this.buildFilterGroup(virtualDef.filters, query, ctx, 0, resolveCtx, warnings);
        if (vf) ctx.sql.push(`AND (${vf})`);
      }
    } else if (eventKey && eventKey !== ANY_EVENT) {
      ctx.sql.push(`AND ${this.eqParam(ctx, 'event', 'event', 'String')}`);
      ctx.params.lu_event = eventKey;
    }
    const tf = timeScopeFilter(timeScope, { paramPrefix: ctx.paramPrefix });
    ctx.sql.push(`AND ${tf.where}`);
    Object.assign(ctx.params, tf.params);
    if (extraAnd) ctx.sql.push(`AND (${extraAnd})`);
    if (query.filters) {
      const f = await this.buildFilterGroup(query.filters, query, ctx, 0, resolveCtx, warnings);
      if (f) ctx.sql.push(`AND (${f})`);
    }
    if (normalized.filters) {
      const f = await this.buildFilterGroup(normalized.filters, query, ctx, 0, resolveCtx, warnings);
      if (f) ctx.sql.push(`AND (${f})`);
    }
    for (const group of groupDefs) {
      const value = cell.groups?.[group.alias];
      if (value === undefined || value === null) continue;
      const name = `lu_${group.alias}`;
      ctx.params[name] = String(value);
      ctx.sql.push(`AND toString(${group.expr}) = {${name}: String}`);
    }
    ctx.sql.push(`AND ${uidExpr} != ''`);
    ctx.sql.push(`LIMIT {lu_limit: UInt32}`);
    ctx.params.lu_limit = limit;
    ctx.sql.splice(fromIndex, 0, ...joins.render());
    ctx.params.project = query.project;
    const sql = ctx.sql.join('\n');
    const cacheKey = createHash('sha256').update(sql + JSON.stringify(ctx.params)).digest('hex');
    return { sql, params: ctx.params, cacheKey, warnings };
  }

  private buildResolveContext(
    project: string,
    event: string,
    events?: string[],
    joins?: JoinRegistry,
  ): ResolveContext {
    return { project, event, events, joins };
  }

  private eqParam(
    ctx: GenContext,
    column: string,
    name: string,
    type: string,
  ): string {
    return `${column} = {${ctx.paramPrefix}${name}: ${type}}`;
  }

  private inParam(
    ctx: GenContext,
    column: string,
    name: string,
    type: string,
  ): string {
    return `${column} IN {${ctx.paramPrefix}${name}: ${type}}`;
  }

  private betweenParam(
    ctx: GenContext,
    column: string,
    startName: string,
    endName: string,
    type: string,
  ): string {
    return `${column} BETWEEN {${ctx.paramPrefix}${startName}: ${type}} AND {${ctx.paramPrefix}${endName}: ${type}}`;
  }

  private async buildGroupExpression(
    group: Group,
    resolveCtx: ResolveContext,
    project: string,
    ctx: GenContext,
    warnings: string[],
    timeScope: TimeScope,
  ): Promise<string> {
    if (group.scope === 'cohort') {
      return bindCohortGroup(group.prop || '', project, ctx, this.cohortBatches, warnings);
    }
    if (group.scope === 'time') {
      const granularity = group.granularity ?? 'day';
      const bucket = (['minute', 'hour', 'day', 'week', 'month'] as const).includes(granularity as never)
        ? (granularity as 'minute' | 'hour' | 'day' | 'week' | 'month')
        : 'day';
      return bucketExpression(timeScope, 'log_time', bucket);
    }

    const dataType = await this.attributeResolver.inferDataType(
      group.prop!,
      group.scope as FilterScope,
      resolveCtx,
    );
    const attr = await this.attributeResolver.resolve(
      group.prop!,
      group.scope as FilterScope,
      dataType,
      resolveCtx,
    );
    if (group.extract === 'hour_of_day') {
      return extractExpression(timeScope, 'toHour', `parseDateTime64BestEffortOrZero(toString(${attr}))`);
    }
    if (group.extract === 'day_of_month') {
      return extractExpression(timeScope, 'toDayOfMonth', `parseDateTime64BestEffortOrZero(toString(${attr}))`);
    }
    if (group.extract === 'minute_of_hour') {
      return extractExpression(timeScope, 'toMinute', `parseDateTime64BestEffortOrZero(toString(${attr}))`);
    }
    return attr;
  }

  /** 数值变换：四则运算后再保留小数位（在数据库聚合后应用，语义见 query/metric-transform.ts） */
  private applyMetricTransform(expr: string, metric: Metric): string {
    return buildTransformSql(expr, metric.transform);
  }

  private async buildMetricExpression(
    metric: Metric,
    resolveCtx: ResolveContext,
    uidExpr: string,
    approx: boolean,
  ): Promise<string> {
    const subject = uidExpr;
    const analysis = metric.analysis as AnalysisMethod;
    if (analysis === 'total_times') return 'count()';
    if (analysis === 'trig_user_num') return uniqSubject(subject, approx);
    if (analysis === 'per_capita_times') return `count() / ${uniqSubject(subject, approx)}`;

    const dataType = await this.attributeResolver.inferDataType(metric.prop!, 'event', resolveCtx);
    if (!methodAllowedForDataType(analysis, dataType)) {
      throw badRequest({
        code: 'analysis.event.propTypeUnsupported',
        messageKey: 'analysis:error.event.propTypeUnsupported',
        params: { prop: metric.prop },
        message: `属性 ${metric.prop} 的类型不支持该方法`,
      });
    }
    const numeric = isNumericAnalysisMethod(analysis);
    let attr = await this.attributeResolver.resolve(
      metric.prop!,
      'event',
      numeric ? 'number' : dataType,
      resolveCtx,
    );
    if (numeric && dataType === 'string') {
      attr = `toFloat64OrZero(toString(${attr}))`;
    }
    const empty = `toString(${attr}) IN ('', '[]', 'null')`;
    switch (analysis) {
      case 'sum':
        return `sum(${attr})`;
      case 'avg':
        return `avg(${attr})`;
      case 'max':
        return `max(${attr})`;
      case 'min':
        return `min(${attr})`;
      case 'distinct':
      case 'array_distinct':
        return uniqExpr(attr, approx);
      case 'array_item_distinct':
        return uniqExpr(
          `arrayJoin(JSONExtractArrayRaw(properties, '${metric.prop!.replace(/'/g, '')}'))`,
          approx,
        );
      case 'per_capita_num':
        return `sum(${attr}) / ${uniqSubject(subject, approx)}`;
      case 'percentile':
        return `quantileExact(${(metric.percentile ?? 50) / 100})(${attr})`;
      case 'variance':
        return `varPop(${attr})`;
      case 'stddev':
        return `stddevPop(${attr})`;
      case 'true_num':
        return `countIf(${attr})`;
      case 'false_num':
        return `countIf(NOT ${attr})`;
      case 'is_empty':
        return `countIf(${empty})`;
      case 'is_not_empty':
        return `countIf(NOT (${empty}))`;
      default:
        throw badRequest({
          code: 'analysis.event.unknownAnalysis',
          messageKey: 'analysis:error.event.unknownAnalysis',
          params: { analysis },
          message: `未知 analysis: ${analysis}`,
        });
    }
  }

  private normalizeFilterOp(op: string): string {
    const map: Record<string, string> = {
      eq: '=',
      ne: '!=',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
      like: 'contains',
      not_like: 'not_contains',
    };
    return map[op] ?? op;
  }

  private async buildFilterGroup(
    group: FilterGroup,
    query: EventAnalysisQuery,
    ctx: GenContext,
    depth: number,
    resolveCtx: ResolveContext,
    warnings: string[],
  ): Promise<string> {
    const parts: string[] = [];
    for (const item of group.items) {
      if ('logic' in item) {
        const inner = await this.buildFilterGroup(
          item as FilterGroup,
          query,
          ctx,
          depth + 1,
          resolveCtx,
          warnings,
        );
        if (inner) parts.push(`(${inner})`);
      } else {
        const inner = await this.buildFilterItem(
          item as FilterItem,
          query,
          ctx,
          resolveCtx,
          warnings,
        );
        if (inner) parts.push(inner);
      }
    }
    if (parts.length === 0) return '';
    return parts.join(` ${group.logic.toUpperCase()} `);
  }

  private async buildFilterItem(
    item: FilterItem,
    query: EventAnalysisQuery,
    ctx: GenContext,
    resolveCtx: ResolveContext,
    warnings: string[],
  ): Promise<string> {
    const cohortSql = await bindCohortFilter(
      item,
      query.project,
      ctx,
      this.cohortBatches,
      warnings,
    );
    if (cohortSql) return cohortSql;
    const tagSql = await bindTagFilter(item, query.project, ctx, this.tagBatches, warnings);
    if (tagSql) return tagSql;
    const dataType = await this.attributeResolver.inferDataType(
      item.prop,
      item.scope,
      resolveCtx,
    );
    let attr = await this.attributeResolver.resolve(
      item.prop,
      item.scope,
      dataType,
      resolveCtx,
    );

    const op = this.normalizeFilterOp(item.op);
    const paramName = `${ctx.paramPrefix}p_${ctx.paramIndex++}`;
    // 布尔属性降级为字符串提取比较（存储形态有 JSON 布尔与字符串两种）
    if (dataType === 'boolean') attr = asStringExtraction(attr);

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
      case 'in': {
        const values = Array.isArray(item.value)
          ? item.value
          : String(item.value)
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean);
        if (values.length === 0) throw new Error(`in 操作符需要至少一个值`);
        ctx.params[paramName] = values;
        return `has({${paramName}: Array(String)}, ${attr})`;
      }
      case 'not_in': {
        const values = Array.isArray(item.value)
          ? item.value
          : String(item.value)
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean);
        if (values.length === 0) throw new Error(`not_in 操作符需要至少一个值`);
        ctx.params[paramName] = values;
        return `not(has({${paramName}: Array(String)}, ${attr}))`;
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
}
