import { Injectable } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import { ANALYSIS_UID_EXPR, ANY_EVENT, FilterGroup, FilterItem, FilterOp } from '../../types/dsl.types';
import { AttributeResolverService } from '../shared/attribute-resolver.service';
import { booleanAwareBinding } from '../query/boolean-filter-binding';
import { MetaVirtualEventService } from '../meta/meta-virtual-event.service';
import { SubjectService } from '../subject/subject.service';
import { subjectExpr, subjectForbidsNegativeUniverse, subjectProfileExpr } from '../subject/subject-expr';
import { JoinRegistry } from '../relation/join-registry';
import {
  CohortCondition,
  ConditionDefinition,
  countOpSql,
  DidEventCondition,
  resolveConditionTime,
  SequenceCondition,
  UserPropCondition,
} from './cohort-definition';

interface SqlPart {
  sql: string;
  params: Record<string, unknown>;
}

@Injectable()
export class CohortConditionSqlService {
  constructor(
    private readonly virtualEvents: MetaVirtualEventService,
    private readonly attributes: AttributeResolverService,
    private readonly subjects: SubjectService,
  ) {}

  async buildUidSet(
    project: string,
    conditions: CohortCondition[],
    computeDay: string,
    prefix: string,
    uidExpr = ANALYSIS_UID_EXPR,
    forbidNegative = false,
    joins?: JoinRegistry,
  ): Promise<SqlPart> {
    if (conditions.length === 0) {
      throw badRequest({
        code: 'cohort.condition.atLeastOne',
        messageKey: 'cohort:error.condition.atLeastOne',
        message: '条件至少一条',
      });
    }
    const parts: SqlPart[] = [];
    for (let i = 0; i < conditions.length; i++) {
      parts.push(
        await this.buildCondition(
          project,
          conditions[i],
          computeDay,
          `${prefix}c${i}_`,
          uidExpr,
          forbidNegative,
          joins,
        ),
      );
    }
    const head = `${prefix}c0`;
    let from = `(${parts[0].sql}) AS ${head}`;
    for (let i = 1; i < parts.length; i++) {
      from += ` INNER JOIN (${parts[i].sql}) AS ${prefix}c${i} ON ${head}.uid = ${prefix}c${i}.uid`;
    }
    const params = Object.assign({}, ...parts.map((part) => part.params));
    return { sql: `SELECT ${head}.uid AS uid FROM ${from} WHERE ${head}.uid != ''`, params };
  }

  /**
   * 试跑用的两条只读 SQL：人数与示例成员。
   *
   * 两者共用**同一次** `buildUidSet`（同一条集合 SQL，只是外层包装不同），
   * 否则主体解析与 JOIN 注册各跑一遍，人数与样例可能来自不同查询。
   * 不写成员表、不改分群状态。
   */
  async buildPreviewParts(
    project: string,
    conditions: CohortCondition[],
    computeDay: string,
    subjectId: string | undefined,
    limit: number,
  ): Promise<{ count: SqlPart; sample?: SqlPart }> {
    const resolved = await this.subjects.resolve(project, subjectId);
    const joins = new JoinRegistry();
    const set = await this.buildUidSet(
      project,
      conditions,
      computeDay,
      'preview_',
      subjectExpr(resolved, joins),
      subjectForbidsNegativeUniverse(resolved),
      joins,
    );
    const params = { project, ...set.params };
    const count = { sql: `SELECT count() AS c FROM (${set.sql})`, params };
    if (limit <= 0) return { count };
    return {
      count,
      sample: {
        sql: `SELECT uid FROM (${set.sql}) ORDER BY uid LIMIT {limit: UInt32}`,
        params: { ...params, limit },
      },
    };
  }

  async buildInsertSelect(
    project: string,
    cohortId: string,
    batchId: string,
    definition: ConditionDefinition,
    computeDay: string,
    subjectId?: string,
  ): Promise<SqlPart> {
    const resolved = await this.subjects.resolve(project, subjectId);
    const joins = new JoinRegistry();
    const set = await this.buildUidSet(
      project,
      definition.conditions,
      computeDay,
      '',
      subjectExpr(resolved, joins),
      subjectForbidsNegativeUniverse(resolved),
      joins,
    );
    const sql = `INSERT INTO clklog_sa.sa_cohort_members (project_name, cohort_id, batch_id, uid)
SELECT {project: String}, {cohort_id: String}, {batch_id: String}, uid
FROM (${set.sql})
LIMIT 1000000`;
    return { sql, params: { project, cohort_id: cohortId, batch_id: batchId, ...set.params } };
  }

  async buildIdUploadInsert(
    project: string,
    cohortId: string,
    batchId: string,
    uids: string[],
    subjectId?: string,
  ): Promise<SqlPart> {
    const resolved = await this.subjects.resolve(project, subjectId);
    const joins = new JoinRegistry();
    const uidExpr = subjectExpr(resolved, joins);
    const profileExpr = subjectProfileExpr(resolved);
    const joinsSql = joins.render().map((j) => `\n  ${j}`).join('');
    const sql = `INSERT INTO clklog_sa.sa_cohort_members (project_name, cohort_id, batch_id, uid)
SELECT {project: String}, {cohort_id: String}, {batch_id: String}, uid
FROM (
  SELECT ${uidExpr} AS uid
  FROM clklog_sa.sa_events${joinsSql}
  WHERE project_name = {project: String}
    AND ${uidExpr} IN {uids: Array(String)}
    AND ${uidExpr} != ''
  GROUP BY uid
  UNION DISTINCT
  SELECT ${profileExpr} AS uid
  FROM clklog_sa.sa_user_profiles
  WHERE project_name = {project: String}
    AND ${profileExpr} IN {uids: Array(String)}
    AND ${profileExpr} != ''
)
LIMIT 1000000`;
    return { sql, params: { project, cohort_id: cohortId, batch_id: batchId, uids } };
  }

  private async buildCondition(
    project: string,
    condition: CohortCondition,
    computeDay: string,
    prefix: string,
    uidExpr: string,
    forbidNegative: boolean,
    joins?: JoinRegistry,
  ): Promise<SqlPart> {
    if (condition.type === 'did_event') {
      return this.buildDidEvent(project, condition, computeDay, prefix, uidExpr, forbidNegative, joins);
    }
    if (condition.type === 'sequence') {
      return this.buildSequence(project, condition, computeDay, prefix, uidExpr, forbidNegative, joins);
    }
    return this.buildUserProp(project, condition, prefix, uidExpr, joins);
  }

  private async buildDidEvent(
    project: string,
    condition: DidEventCondition,
    computeDay: string,
    prefix: string,
    uidExpr: string,
    forbidNegative: boolean,
    joins?: JoinRegistry,
  ): Promise<SqlPart> {
    if (condition.polarity === 'did_not' && forbidNegative) {
      throw badRequest({
        code: 'cohort.condition.negativeUniverseUnsupported',
        messageKey: 'cohort:error.condition.negativeUniverseUnsupported',
        message: '事件属性主体无法定义「没做过」的宇宙，请改用做过或换用户属性主体',
      });
    }
    const { start, end } = resolveConditionTime(condition.time, computeDay);
    const params: Record<string, unknown> = {
      [`${prefix}start`]: start,
      [`${prefix}end`]: end,
      [`${prefix}value`]: condition.value,
    };
    const eventSql = await this.eventPredicate(project, condition.event, prefix, params, joins);
    const op = countOpSql(condition.op);
    const joinsSql = this.renderJoins(joins);
    const didSql = `SELECT ${uidExpr} AS uid
FROM clklog_sa.sa_events${joinsSql}
WHERE project_name = {project: String}
  AND stat_date BETWEEN {${prefix}start: String} AND {${prefix}end: String}
  AND ${uidExpr} != ''
  ${eventSql}
GROUP BY uid
HAVING count() ${op} {${prefix}value: Float64}`;
    if (condition.polarity === 'did') return { sql: didSql, params };
    const sql = `SELECT ${uidExpr} AS uid
FROM clklog_sa.sa_events${joinsSql}
WHERE project_name = {project: String}
  AND stat_date BETWEEN {${prefix}start: String} AND {${prefix}end: String}
  AND ${uidExpr} != ''
GROUP BY uid
EXCEPT
SELECT uid FROM (${didSql})`;
    return { sql, params };
  }

  private async buildSequence(
    project: string,
    condition: SequenceCondition,
    computeDay: string,
    prefix: string,
    uidExpr: string,
    forbidNegative: boolean,
    joins?: JoinRegistry,
  ): Promise<SqlPart> {
    if (condition.polarity === 'did_not' && forbidNegative) {
      throw badRequest({
        code: 'cohort.condition.negativeSequenceUnsupported',
        messageKey: 'cohort:error.condition.negativeSequenceUnsupported',
        message: '事件属性主体无法定义「没依次做过」的宇宙，请改用依次做过或换用户属性主体',
      });
    }
    const { start, end } = resolveConditionTime(condition.time, computeDay);
    const windowSeconds = Math.max(1, (dateDiffDays(start, end) + 1) * 86400);
    const params: Record<string, unknown> = {
      [`${prefix}start`]: start,
      [`${prefix}end`]: end,
      [`${prefix}window`]: windowSeconds,
      [`${prefix}level`]: condition.events.length,
    };
    const stepExprs: string[] = [];
    const scanEvents: string[] = [];
    let scanAll = false;
    for (let i = 0; i < condition.events.length; i++) {
      const eventKey = condition.events[i];
      if (eventKey === ANY_EVENT) {
        scanAll = true;
        stepExprs.push('1');
        continue;
      }
      const virtual = await this.virtualEvents.findDefinition(eventKey, project);
      if (virtual?.events?.length) {
        scanEvents.push(...virtual.events);
        const name = `${prefix}s${i}_events`;
        params[name] = virtual.events;
        stepExprs.push(`event IN {${name}: Array(String)}`);
      } else {
        scanEvents.push(eventKey);
        const name = `${prefix}s${i}_event`;
        params[name] = eventKey;
        stepExprs.push(`event = {${name}: String}`);
      }
    }
    params[`${prefix}events`] = [...new Set(scanEvents)];
    const eventIn = scanAll ? '' : `AND event IN {${prefix}events: Array(String)}`;
    const having =
      condition.polarity === 'did'
        ? `level >= {${prefix}level: UInt8}`
        : `level < {${prefix}level: UInt8}`;
    const universe =
      condition.polarity === 'did_not'
        ? `AND ${uidExpr} IN (
    SELECT ${uidExpr}
    FROM clklog_sa.sa_events${this.renderJoins(joins, '    ')}
    WHERE project_name = {project: String}
      AND stat_date BETWEEN {${prefix}start: String} AND {${prefix}end: String}
      AND ${uidExpr} != ''
  )`
        : '';
    const sql = `SELECT uid FROM (
  SELECT
    ${uidExpr} AS uid,
    windowFunnel({${prefix}window: UInt32})(
      toUnixTimestamp(log_time),
${stepExprs.map((expr) => `      ${expr}`).join(',\n')}
    ) AS level
  FROM clklog_sa.sa_events${this.renderJoins(joins, '  ')}
  WHERE project_name = {project: String}
    AND stat_date BETWEEN {${prefix}start: String} AND {${prefix}end: String}
    ${eventIn}
    ${universe}
  GROUP BY uid
)
WHERE ${having}`;
    return { sql, params };
  }

  private async buildUserProp(
    project: string,
    condition: UserPropCondition,
    prefix: string,
    uidExpr: string,
    joins?: JoinRegistry,
  ): Promise<SqlPart> {
    const resolveCtx = { project };
    const dataType = await this.attributes.inferDataType(condition.prop, 'user', resolveCtx);
    // 本条 SQL 的 FROM 就是 sa_user_profiles（profile 侧），直接取列，不注入 JOIN
    const profileAttr = this.attributes.resolveUserPropertyDirect(condition.prop, dataType);
    const params: Record<string, unknown> = {};
    const pred = this.userOpSql(condition.op, condition.value, prefix, params, profileAttr, dataType);
    if (uidExpr === ANALYSIS_UID_EXPR) {
      const sql = `SELECT ${uidExpr} AS uid
FROM clklog_sa.sa_user_profiles FINAL
WHERE project_name = {project: String}
  AND ${uidExpr} != ''
  AND (${pred})`;
      return { sql, params };
    }
    const sql = `SELECT ${uidExpr} AS uid
FROM clklog_sa.sa_events${this.renderJoins(joins)}
WHERE project_name = {project: String}
  AND ${uidExpr} != ''
  AND distinct_id IN (
    SELECT distinct_id FROM clklog_sa.sa_user_profiles FINAL
    WHERE project_name = {project: String}
      AND (${pred})
  )
GROUP BY uid`;
    return { sql, params };
  }

  /** 把 JOIN 渲染为可直接拼在 `FROM clklog_sa.sa_events` 之后的片段 */
  private renderJoins(joins?: JoinRegistry, indent = ''): string {
    if (!joins || joins.size === 0) return '';
    return joins.render().map((j) => `\n${indent}${j}`).join('');
  }

  private userOpSql(
    op: FilterOp | UserPropCondition['op'],
    value: unknown,
    prefix: string,
    params: Record<string, unknown>,
    attr: string,
    dataType = 'string',
  ): string {
    const name = `${prefix}pval`;
    switch (op) {
      case '=':
      case '!=': {
        const { attr: bindAttr, value: bindValue } = booleanAwareBinding(dataType, attr, value ?? '');
        params[name] = bindValue;
        return `${bindAttr} ${op} {${name}: String}`;
      }
      case 'contains':
        params[name] = `%${String(value ?? '')}%`;
        return `like(${attr}, {${name}: String})`;
      case 'not_contains':
        params[name] = `%${String(value ?? '')}%`;
        return `notLike(${attr}, {${name}: String})`;
      case 'in':
      case 'not_in': {
        const values = Array.isArray(value)
          ? value.map(String)
          : String(value ?? '')
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
        params[name] = values;
        const expr = `has({${name}: Array(String)}, ${attr})`;
        return op === 'in' ? expr : `not(${expr})`;
      }
      case 'regex':
        params[name] = String(value ?? '');
        return `match(${attr}, {${name}: String})`;
      case 'not_regex':
        params[name] = String(value ?? '');
        return `not(match(${attr}, {${name}: String}))`;
      case 'gt':
        params[name] = Number(value);
        return `${attr} > {${name}: Float64}`;
      case 'gte':
        params[name] = Number(value);
        return `${attr} >= {${name}: Float64}`;
      case 'lt':
        params[name] = Number(value);
        return `${attr} < {${name}: Float64}`;
      case 'lte':
        params[name] = Number(value);
        return `${attr} <= {${name}: Float64}`;
      case 'is_set':
        return `${attr} != ''`;
      case 'not_set':
        return `${attr} = ''`;
      default:
        return '1';
    }
  }

  private async eventPredicate(
    project: string,
    eventKey: string,
    prefix: string,
    params: Record<string, unknown>,
    joins?: JoinRegistry,
  ): Promise<string> {
    if (eventKey === ANY_EVENT) return '';
    const virtual = await this.virtualEvents.findDefinition(eventKey, project);
    if (virtual?.events?.length) {
      params[`${prefix}events`] = virtual.events;
      let extra = '';
      if (virtual.filters) {
        extra = await this.virtualFilterSql(
          virtual.filters,
          project,
          eventKey,
          virtual.events,
          prefix,
          params,
          joins,
        );
      }
      return `AND event IN {${prefix}events: Array(String)}${extra ? ` AND (${extra})` : ''}`;
    }
    params[`${prefix}event`] = eventKey;
    return `AND event = {${prefix}event: String}`;
  }

  private async virtualFilterSql(
    group: FilterGroup,
    project: string,
    event: string,
    events: string[],
    prefix: string,
    params: Record<string, unknown>,
    joins?: JoinRegistry,
  ): Promise<string> {
    const parts: string[] = [];
    let index = 0;
    const walk = async (node: FilterGroup | FilterItem): Promise<string> => {
      if ('logic' in node) {
        const inner = await Promise.all(node.items.map((item) => walk(item)));
        const kept = inner.filter(Boolean);
        return kept.length ? kept.join(` ${node.logic.toUpperCase()} `) : '';
      }
      const item = node as FilterItem;
      if (item.scope === 'cohort' || item.scope === 'tag') return '';
      const ctx = { project, event, events, joins };
      const dataType = await this.attributes.inferDataType(item.prop, item.scope, ctx);
      const attr = await this.attributes.resolve(item.prop, item.scope, dataType, ctx);
      const pred = this.userOpSql(item.op, item.value, `${prefix}vf${index++}_`, params, attr, dataType);
      return pred;
    };
    const sql = await walk(group);
    if (sql) parts.push(sql);
    return parts.join(' AND ');
  }
}

function dateDiffDays(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}
