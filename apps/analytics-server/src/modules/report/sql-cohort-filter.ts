import { badRequest } from '../../i18n/domain-error';
import { ANALYSIS_UID_EXPR } from '../../types/dsl.types';

export const COHORT_ID_PATTERN = /^cohort_[A-Za-z0-9_-]{6,32}$/;
const COHORT_FN_RE = /\b(sa_in_cohort|sa_not_in_cohort)\s*\(\s*(['"])(cohort_[A-Za-z0-9_-]+)\2\s*\)/gi;

export type DashboardCohortFilter = { cohort_id: string; op: 'in' | 'not_in' };

export function parseDashboardCohortFilter(raw: unknown): DashboardCohortFilter | null {
  if (raw == null || raw === '') return null;
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw badRequest({
        code: 'report.sql.cohortFilterJsonInvalid',
        messageKey: 'report:error.sql.cohortFilterJsonInvalid',
        message: '看板分群筛选不是合法 JSON',
      });
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest({
      code: 'report.sql.cohortFilterNotObject',
      messageKey: 'report:error.sql.cohortFilterNotObject',
      message: '看板分群筛选必须是对象',
    });
  }
  const rec = value as Record<string, unknown>;
  if (rec.cohort_id == null && rec.op == null) return null;
  if (typeof rec.cohort_id !== 'string' || !COHORT_ID_PATTERN.test(rec.cohort_id)) {
    throw badRequest({
      code: 'report.sql.cohortFilterIdInvalid',
      messageKey: 'report:error.sql.cohortFilterIdInvalid',
      message: '看板分群筛选 cohort_id 不合法',
    });
  }
  const op = rec.op === 'not_in' ? 'not_in' : rec.op === 'in' ? 'in' : null;
  if (!op) {
    throw badRequest({
      code: 'report.sql.cohortFilterOpInvalid',
      messageKey: 'report:error.sql.cohortFilterOpInvalid',
      message: '看板分群筛选 op 必须是 in 或 not_in',
    });
  }
  return { cohort_id: rec.cohort_id, op };
}

export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function cohortMemberSqlPredicate(args: {
  uidExpr?: string;
  project: string;
  cohortId: string;
  batchId: string;
  op?: 'in' | 'not_in';
}): string {
  const uid = args.uidExpr ?? ANALYSIS_UID_EXPR;
  const inner = `${uid} IN (
  SELECT uid FROM clklog_sa.sa_cohort_members
  WHERE project_name = ${sqlStringLiteral(args.project)}
    AND cohort_id = ${sqlStringLiteral(args.cohortId)}
    AND batch_id = ${sqlStringLiteral(args.batchId)}
)`;
  return args.op === 'not_in' ? `NOT (${inner})` : inner;
}

export function cohortGroupSqlExpression(args: {
  uidExpr?: string;
  project: string;
  cohortId: string;
  batchId: string;
}): string {
  const uid = args.uidExpr ?? ANALYSIS_UID_EXPR;
  return `if(${uid} IN (
  SELECT uid FROM clklog_sa.sa_cohort_members
  WHERE project_name = ${sqlStringLiteral(args.project)}
    AND cohort_id = ${sqlStringLiteral(args.cohortId)}
    AND batch_id = ${sqlStringLiteral(args.batchId)}
), '属于', '不属于')`;
}

export function collectCohortFunctionCalls(sql: string): Array<{ fn: 'sa_in_cohort' | 'sa_not_in_cohort'; cohortId: string }> {
  const found: Array<{ fn: 'sa_in_cohort' | 'sa_not_in_cohort'; cohortId: string }> = [];
  const re = new RegExp(COHORT_FN_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const fn = match[1].toLowerCase() as 'sa_in_cohort' | 'sa_not_in_cohort';
    found.push({ fn, cohortId: match[3] });
  }
  return found;
}

export function expandSaInCohortFunctions(
  sql: string,
  resolved: Map<string, { project: string; batchId: string }>,
  uidExpr?: string,
): string {
  return sql.replace(new RegExp(COHORT_FN_RE.source, 'gi'), (_full, fn: string, _q: string, cohortId: string) => {
    const hit = resolved.get(cohortId);
    if (!hit) {
      throw badRequest({
        code: 'report.sql.cohortUnknown',
        messageKey: 'report:error.sql.cohortUnknown',
        params: { cohort: cohortId },
        message: `分群函数引用了未知分群: ${cohortId}`,
      });
    }
    return cohortMemberSqlPredicate({
      uidExpr,
      project: hit.project,
      cohortId,
      batchId: hit.batchId,
      op: fn.toLowerCase() === 'sa_not_in_cohort' ? 'not_in' : 'in',
    });
  });
}

export function builderDslHasCohort(dsl: unknown): boolean {
  if (!dsl || typeof dsl !== 'object') return false;
  const rec = dsl as {
    groups?: Array<{ kind?: string; scope?: string }>;
    filters?: { items?: Array<{ scope?: string }> };
  };
  if ((rec.groups ?? []).some((g) => g.kind === 'cohort' || g.scope === 'cohort')) return true;
  return (rec.filters?.items ?? []).some((item) => item.scope === 'cohort');
}

function hasSameCohortFilter(items: unknown[], cohortId: string): boolean {
  return items.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const rec = item as Record<string, unknown>;
    if (rec.scope === 'cohort' && rec.prop === cohortId) return true;
    if (Array.isArray(rec.items)) return hasSameCohortFilter(rec.items, cohortId);
    return false;
  });
}

/** 看板级分群 AND 进 DSL；已有同 cohort_id 则以卡片为准。 */
export function mergeDashboardCohortFilter(
  dsl: Record<string, unknown>,
  cardType: string,
  filter: DashboardCohortFilter | null,
): { dsl: Record<string, unknown>; handwrittenSql: boolean } {
  // text 无数据；metric 的筛选由指标自身条件组决定，看板分群筛选不适用（结果里带 cohort_applied=false）
  if (!filter || cardType === 'text' || cardType === 'metric') return { dsl, handwrittenSql: false };
  if (cardType === 'sql') {
    const mode = dsl.mode === 'builder' ? 'builder' : 'sql';
    if (mode === 'builder' && dsl.dsl && typeof dsl.dsl === 'object' && !Array.isArray(dsl.dsl)) {
      return {
        dsl: { ...dsl, dsl: mergeFilterIntoQuery(dsl.dsl as Record<string, unknown>, filter) },
        handwrittenSql: false,
      };
    }
    return { dsl, handwrittenSql: true };
  }
  return { dsl: mergeFilterIntoQuery(dsl, filter), handwrittenSql: false };
}

function mergeFilterIntoQuery(query: Record<string, unknown>, filter: DashboardCohortFilter): Record<string, unknown> {
  const existing = query.filters;
  const group =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as { logic?: string; items?: unknown[] })
      : { logic: 'and', items: [] };
  const items = Array.isArray(group.items) ? group.items : [];
  if (hasSameCohortFilter(items, filter.cohort_id)) return query;
  const cohortItem = { scope: 'cohort', prop: filter.cohort_id, op: filter.op };
  if (group.logic === 'and' || items.length === 0) {
    return { ...query, filters: { logic: 'and', items: [...items, cohortItem] } };
  }
  return {
    ...query,
    filters: { logic: 'and', items: [{ logic: group.logic ?? 'or', items }, cohortItem] },
  };
}
