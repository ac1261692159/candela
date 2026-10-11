import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  FunnelQuery,
  FunnelStep,
  FilterGroup,
  FilterItem,
  Group,
  FilterScope,
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
import { bucketExpression, timeScopeFilter, TimeScopeService, type TimeScope } from '../time/time-scope';
import { TimezoneService } from '../time/timezone.service';

export interface FunnelSqlResult {
  sql: string;
  params: Record<string, unknown>;
  cacheKey: string;
  stepCount: number;
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
export class FunnelSqlGeneratorService {
  constructor(
    private readonly attributeResolver: AttributeResolverService,
    private readonly virtualEventService: MetaVirtualEventService,
    private readonly cohortBatches: CohortBatchService,
    private readonly tagBatches: TagBatchService,
    private readonly subjects: SubjectService,
    // 缺省构造兜底纯单测；生产由 DI 注入（TimeModule @Global）
    private readonly timeScope: TimeScopeService = new TimeScopeService(new TimezoneService(undefined)),
  ) {}

  async generate(query: FunnelQuery, extraAnd?: string | null): Promise<FunnelSqlResult> {
    const project = query.project;
    // 时间窗：恒等路径与历史一致；异时区宽扫 stat_date + epoch 精切（TimeScope）
    const timeScope = this.timeScope.materialize(query.time_range);
    const tf = timeScopeFilter(timeScope, { paramPrefix: '' });
    const resolved = await this.subjects.resolve(project, query.subject_id);
    const joins = new JoinRegistry();
    const uidExpr = subjectExpr(resolved, joins);

    const baseEvent = query.steps[0].event;
    const baseVirtualDef = await this.virtualEventService.findDefinition(
      baseEvent,
      project,
    );

    const group = query.groups?.[0];
    const stepCtx: GenContext = {
      params: {},
      paramIndex: 0,
      paramPrefix: 's_',
      uidExpr,
      subjectId: resolved.subject_id,
    };

    // 构造每步的布尔条件（在派生表中物化为 step_i 列）
    const stepConditions: string[] = [];
    for (let i = 0; i < query.steps.length; i++) {
      const step = query.steps[i];
      const cond = await this.buildStepCondition(step, query, stepCtx, i, joins);
      stepConditions.push(cond);
    }

    // 全局筛选使用第 1 步的事件上下文解析事件属性
    const globalResolveCtx = this.buildResolveContext(
      project,
      baseEvent,
      baseVirtualDef?.events,
      joins,
    );
    const warnings: string[] = [];
    const globalCtx: GenContext = {
      params: {},
      paramIndex: 0,
      paramPrefix: 'g_',
      uidExpr,
      subjectId: resolved.subject_id,
    };
    let globalFilterSql = '';
    if (query.filters) {
      globalFilterSql = await this.buildFilterGroup(
        query.filters,
        query,
        globalCtx,
        globalResolveCtx,
        warnings,
      );
    }

    let groupSelect = '';
    let groupByOuter = '';
    let selectOuter = '';
    let tagJoin = '';
    if (group) {
      if (group.scope === 'tag') {
        const bound = await bindTagGroup(
          group.prop || '',
          query.project,
          globalCtx,
          this.tagBatches,
          warnings,
          'tg_0',
        );
        tagJoin = bound.joinSql;
        groupSelect = `  ${bound.expr} AS group_col,`;
      } else {
        const gExpr = await this.buildGroupExpression(
          group,
          globalResolveCtx,
          query.project,
          globalCtx,
          warnings,
          timeScope,
        );
        groupSelect = `  ${gExpr} AS group_col,`;
      }
      groupByOuter = 'group_col, ';
      selectOuter = 'group_col, ';
    }

    const params: Record<string, unknown> = {
      project,
      ...tf.params,
      window: query.window_seconds,
    };
    if (!timeScope.isPlatformCalendar) params.display_tz = timeScope.tz;
    Object.assign(params, stepCtx.params);
    Object.assign(params, globalCtx.params);

    const funnelEvents: string[] = [];
    let scanAllEvents = false;
    for (const step of query.steps) {
      if (isAnyEvent(step.event)) {
        scanAllEvents = true;
        continue;
      }
      const virtualDef = await this.virtualEventService.findDefinition(step.event, project);
      if (virtualDef?.events?.length) funnelEvents.push(...virtualDef.events);
      else funnelEvents.push(step.event);
    }
    params.funnel_events = [...new Set(funnelEvents)];

    const stepDefs = stepConditions
      .map((c, i) => `      (${c}) AS step_${i}`)
      .join(',\n');

    // 步骤条件 / 全局筛选 / 分组里的跨表 JOIN 统一拼到内层 FROM 之后
    const joinsSql = joins.render().map((j) => `\n    ${j}`).join('');

    const sql = `SELECT
  ${selectOuter}level,
  count() AS users
FROM (
  SELECT
    ${uidExpr} AS uid,
${groupSelect}
    windowFunnel({window: UInt32})(
      toUnixTimestamp(log_time),
${stepConditions.map((_, i) => `      step_${i}`).join(',\n')}
    ) AS level
  FROM (
    SELECT
      *,
${stepDefs}
    FROM clklog_sa.sa_events
    ${tagJoin}${joinsSql}
    WHERE project_name = {project: String}
      AND ${tf.where}
${scanAllEvents ? '' : '      AND event IN {funnel_events: Array(String)}\n'}${globalFilterSql ? `      AND (${globalFilterSql})` : ''}${extraAnd ? `\n      AND (${extraAnd})` : ''}
  )
  GROUP BY uid
  HAVING uid != ''
)
GROUP BY ${groupByOuter}level
ORDER BY ${groupByOuter}level`;

    const cacheKey = createHash('sha256')
      .update(sql + JSON.stringify(params))
      .digest('hex');

    return { sql, params, cacheKey, stepCount: query.steps.length, warnings };
  }

  async listUsers(
    query: FunnelQuery,
    cell: { step?: number; group_col?: string },
    limit: number,
  ): Promise<{ sql: string; params: Record<string, unknown> }> {
    const generated = await this.generate(query);
    const start = generated.sql.indexOf('FROM (\n  SELECT');
    const end = generated.sql.lastIndexOf('\n)\nGROUP BY');
    if (start < 0 || end < 0) {
      throw new Error('漏斗 SQL 无法列出用户');
    }
    const uidGrain = generated.sql.slice(start + 'FROM ('.length, end);
    const step = Math.max(1, Number(cell.step ?? 1));
    const params: Record<string, unknown> = {
      ...generated.params,
      lu_step: step,
      lu_limit: limit,
    };
    let extra = '';
    if (cell.group_col !== undefined && cell.group_col !== null && String(cell.group_col) !== '__total__') {
      params.lu_group = String(cell.group_col);
      extra = ' AND toString(group_col) = {lu_group: String}';
    }
    const sql = `SELECT uid FROM (
${uidGrain}
) WHERE level >= {lu_step: UInt8}${extra}
LIMIT {lu_limit: UInt32}`;
    return { sql, params };
  }

  private buildResolveContext(
    project: string,
    event: string,
    events?: string[],
    joins?: JoinRegistry,
  ): ResolveContext {
    return { project, event, events, joins };
  }

  private async buildStepCondition(
    step: FunnelStep,
    query: FunnelQuery,
    ctx: GenContext,
    index: number,
    joins: JoinRegistry,
  ): Promise<string> {
    const eventKey = step.event;
    const virtualDef = await this.virtualEventService.findDefinition(
      eventKey,
      query.project,
    );
    const resolveCtx = this.buildResolveContext(
      query.project,
      eventKey,
      virtualDef?.events,
      joins,
    );

    const prefix = `s${index}_`;
    const parts: string[] = [];

    if (virtualDef) {
      const paramName = `${prefix}events`;
      ctx.params[paramName] = virtualDef.events;
      parts.push(`event IN {${paramName}: Array(String)}`);
      if (virtualDef.filters) {
        const vf = await this.buildFilterGroup(
          virtualDef.filters,
          query,
          ctx,
          resolveCtx,
          [],
        );
        if (vf) parts.push(`(${vf})`);
      }
    } else if (!isAnyEvent(eventKey)) {
      const paramName = `${prefix}event`;
      ctx.params[paramName] = eventKey;
      parts.push(`event = {${paramName}: String}`);
    }

    if (step.filters) {
      const sf = await this.buildFilterGroup(
        step.filters,
        query,
        ctx,
        resolveCtx,
        [],
      );
      if (sf) parts.push(`(${sf})`);
    }

    return parts.join(' AND ') || '1';
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
      const bucket = (['hour', 'day', 'week', 'month'] as const).includes(granularity as never)
        ? (granularity as 'hour' | 'day' | 'week' | 'month')
        : 'day';
      return bucketExpression(timeScope, 'minIf(log_time, step_0)', bucket);
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

    if (group.scope === 'user') {
      return attr;
    }

    // 事件属性取第 1 步事件上的值
    return `argMinIf(${attr}, log_time, step_0)`;
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
    query: FunnelQuery,
    ctx: GenContext,
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
    query: FunnelQuery,
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
