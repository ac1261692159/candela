import { ANALYSIS_UID_EXPR, type FilterItem } from '../../types/dsl.types';
import { CohortBatchService } from './cohort-batch.service';

export const MISSING_COHORT_BATCH = '__missing__';

type ParamCtx = {
  params: Record<string, unknown>;
  paramIndex: number;
  paramPrefix: string;
  uidExpr?: string;
  subjectId?: string;
};

export function cohortMemberPredicate(args: {
  uidExpr?: string;
  projectParam: string;
  cohortParam: string;
  batchParam: string;
  op: 'in' | 'not_in';
}): string {
  const uid = args.uidExpr ?? ANALYSIS_UID_EXPR;
  const inner = `${uid} IN (
  SELECT uid FROM clklog_sa.sa_cohort_members
  WHERE project_name = {${args.projectParam}: String}
    AND cohort_id = {${args.cohortParam}: String}
    AND batch_id = {${args.batchParam}: String}
)`;
  return args.op === 'not_in' ? `NOT (${inner})` : inner;
}

export function cohortGroupExpression(args: {
  uidExpr?: string;
  projectParam: string;
  cohortParam: string;
  batchParam: string;
}): string {
  const uid = args.uidExpr ?? ANALYSIS_UID_EXPR;
  return `if(${uid} IN (
  SELECT uid FROM clklog_sa.sa_cohort_members
  WHERE project_name = {${args.projectParam}: String}
    AND cohort_id = {${args.cohortParam}: String}
    AND batch_id = {${args.batchParam}: String}
), '属于', '不属于')`;
}

export async function bindCohortFilter(
  item: FilterItem,
  project: string,
  ctx: ParamCtx,
  batches: CohortBatchService,
  warnings: string[],
): Promise<string | null> {
  if (item.scope !== 'cohort') return null;
  const op = item.op === 'not_in' ? 'not_in' : 'in';
  const resolved = await batches.resolve(project, item.prop);
  const subjectMismatch = Boolean(
    ctx.subjectId && resolved.subject_id && resolved.subject_id !== ctx.subjectId,
  );
  if (!resolved.ready || subjectMismatch) {
    warnings.push(
      subjectMismatch ? `分群 ${item.prop} 与当前分析主体不一致，已按空集处理` : `分群 ${item.prop} 不可用，已按空集处理`,
    );
  }
  const cohortParam = `${ctx.paramPrefix}cohort_${ctx.paramIndex}`;
  const batchParam = `${ctx.paramPrefix}batch_${ctx.paramIndex}`;
  const projectParam = `${ctx.paramPrefix}cproj_${ctx.paramIndex}`;
  ctx.paramIndex += 1;
  ctx.params[cohortParam] = item.prop;
  ctx.params[batchParam] = subjectMismatch ? MISSING_COHORT_BATCH : resolved.batch_id;
  ctx.params[projectParam] = project;
  return cohortMemberPredicate({ uidExpr: ctx.uidExpr, projectParam, cohortParam, batchParam, op });
}

export async function bindCohortGroup(
  cohortId: string,
  project: string,
  ctx: ParamCtx,
  batches: CohortBatchService,
  warnings: string[],
): Promise<string> {
  const resolved = await batches.resolve(project, cohortId);
  const subjectMismatch = Boolean(
    ctx.subjectId && resolved.subject_id && resolved.subject_id !== ctx.subjectId,
  );
  if (!resolved.ready || subjectMismatch) {
    warnings.push(
      subjectMismatch ? `分群 ${cohortId} 与当前分析主体不一致，已按空集处理` : `分群 ${cohortId} 不可用，已按空集处理`,
    );
  }
  const cohortParam = `${ctx.paramPrefix}gcohort_${ctx.paramIndex}`;
  const batchParam = `${ctx.paramPrefix}gbatch_${ctx.paramIndex}`;
  const projectParam = `${ctx.paramPrefix}gcproj_${ctx.paramIndex}`;
  ctx.paramIndex += 1;
  ctx.params[cohortParam] = cohortId;
  ctx.params[batchParam] = subjectMismatch ? MISSING_COHORT_BATCH : resolved.batch_id;
  ctx.params[projectParam] = project;
  return cohortGroupExpression({ uidExpr: ctx.uidExpr, projectParam, cohortParam, batchParam });
}
