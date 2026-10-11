import { ANALYSIS_UID_EXPR, type FilterItem } from '../../types/dsl.types';
import { MISSING_COHORT_BATCH } from './cohort-member-sql';
import { TagBatchService } from './tag-batch.service';

type ParamCtx = {
  params: Record<string, unknown>;
  paramIndex: number;
  paramPrefix: string;
  uidExpr?: string;
  subjectId?: string;
};

function tagValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function tagMemberPredicate(args: {
  uidExpr?: string;
  projectParam: string;
  tagParam: string;
  batchParam: string;
  valuesParam: string;
  op: 'in' | 'not_in';
}): string {
  const uid = args.uidExpr ?? ANALYSIS_UID_EXPR;
  const inner = `${uid} IN (
  SELECT uid FROM clklog_sa.sa_tag_members
  WHERE project_name = {${args.projectParam}: String}
    AND tag_id = {${args.tagParam}: String}
    AND batch_id = {${args.batchParam}: String}
    AND tag_value IN {${args.valuesParam}: Array(String)}
)`;
  return args.op === 'not_in' ? `NOT (${inner})` : inner;
}

export function tagGroupJoin(args: {
  alias: string;
  uidExpr?: string;
  projectParam: string;
  tagParam: string;
  batchParam: string;
}): { joinSql: string; expr: string } {
  const uid = args.uidExpr ?? ANALYSIS_UID_EXPR;
  const joinSql = `LEFT JOIN (
  SELECT uid, tag_value
  FROM clklog_sa.sa_tag_members
  WHERE project_name = {${args.projectParam}: String}
    AND tag_id = {${args.tagParam}: String}
    AND batch_id = {${args.batchParam}: String}
) AS ${args.alias} ON ${args.alias}.uid = ${uid}`;
  const expr = `if(${args.alias}.tag_value = '' OR ${args.alias}.tag_value IS NULL, '未打标', ${args.alias}.tag_value)`;
  return { joinSql, expr };
}

export async function bindTagFilter(
  item: FilterItem,
  project: string,
  ctx: ParamCtx,
  batches: TagBatchService,
  warnings: string[],
): Promise<string | null> {
  if (item.scope !== 'tag') return null;
  const op = item.op === 'not_in' ? 'not_in' : 'in';
  const values = tagValues(item.value);
  const resolved = await batches.resolve(project, item.prop);
  const subjectMismatch = Boolean(
    ctx.subjectId && resolved.subject_id && resolved.subject_id !== ctx.subjectId,
  );
  if (!resolved.ready || subjectMismatch) {
    warnings.push(
      subjectMismatch ? `标签 ${item.prop} 与当前分析主体不一致，已按空集处理` : `标签 ${item.prop} 不可用，已按空集处理`,
    );
  }
  const tagParam = `${ctx.paramPrefix}tag_${ctx.paramIndex}`;
  const batchParam = `${ctx.paramPrefix}tbatch_${ctx.paramIndex}`;
  const projectParam = `${ctx.paramPrefix}tproj_${ctx.paramIndex}`;
  const valuesParam = `${ctx.paramPrefix}tvals_${ctx.paramIndex}`;
  ctx.paramIndex += 1;
  ctx.params[tagParam] = item.prop;
  ctx.params[batchParam] = subjectMismatch ? MISSING_COHORT_BATCH : resolved.batch_id;
  ctx.params[projectParam] = project;
  ctx.params[valuesParam] = values.length ? values : ['__no_tag_value__'];
  return tagMemberPredicate({ uidExpr: ctx.uidExpr, projectParam, tagParam, batchParam, valuesParam, op });
}

export async function bindTagGroup(
  tagId: string,
  project: string,
  ctx: ParamCtx,
  batches: TagBatchService,
  warnings: string[],
  alias: string,
): Promise<{ joinSql: string; expr: string }> {
  const resolved = await batches.resolve(project, tagId);
  const subjectMismatch = Boolean(
    ctx.subjectId && resolved.subject_id && resolved.subject_id !== ctx.subjectId,
  );
  if (!resolved.ready || subjectMismatch) {
    warnings.push(
      subjectMismatch ? `标签 ${tagId} 与当前分析主体不一致，已按空集处理` : `标签 ${tagId} 不可用，已按空集处理`,
    );
  }
  const tagParam = `${ctx.paramPrefix}gtag_${ctx.paramIndex}`;
  const batchParam = `${ctx.paramPrefix}gtbatch_${ctx.paramIndex}`;
  const projectParam = `${ctx.paramPrefix}gtproj_${ctx.paramIndex}`;
  ctx.paramIndex += 1;
  ctx.params[tagParam] = tagId;
  ctx.params[batchParam] = subjectMismatch ? MISSING_COHORT_BATCH : resolved.batch_id;
  ctx.params[projectParam] = project;
  return tagGroupJoin({ alias, uidExpr: ctx.uidExpr, projectParam, tagParam, batchParam });
}
