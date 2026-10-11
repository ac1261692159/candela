import { badRequest } from '../../i18n/domain-error';
import { ANALYSIS_UID_EXPR } from '../../types/dsl.types';
import { sqlStringLiteral } from './sql-cohort-filter';

const TAG_IN_RE = /\b(sa_tag_in|sa_tag_not_in)\s*\(([^)]*)\)/gi;
const TAG_VALUE_RE = /\bsa_tag_value\s*\(\s*(['"])(tag_[A-Za-z0-9_-]+)\1\s*\)/gi;

function parseQuotedArgs(inner: string): string[] {
  const args: string[] = [];
  const re = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(inner)) !== null) {
    args.push(match[2]);
  }
  return args;
}

export function tagMemberSqlPredicate(args: {
  uidExpr?: string;
  project: string;
  tagId: string;
  batchId: string;
  values: string[];
  op?: 'in' | 'not_in';
}): string {
  const vals = (args.values.length ? args.values : ['__no_tag_value__']).map(sqlStringLiteral).join(', ');
  const uid = args.uidExpr ?? ANALYSIS_UID_EXPR;
  const inner = `${uid} IN (
  SELECT uid FROM clklog_sa.sa_tag_members
  WHERE project_name = ${sqlStringLiteral(args.project)}
    AND tag_id = ${sqlStringLiteral(args.tagId)}
    AND batch_id = ${sqlStringLiteral(args.batchId)}
    AND tag_value IN (${vals})
)`;
  return args.op === 'not_in' ? `NOT (${inner})` : inner;
}

export function tagGroupSql(args: {
  uidExpr?: string;
  project: string;
  tagId: string;
  batchId: string;
  alias: string;
}): { joinSql: string; expr: string } {
  const uid = args.uidExpr ?? ANALYSIS_UID_EXPR;
  const joinSql = `LEFT JOIN (
  SELECT uid, tag_value
  FROM clklog_sa.sa_tag_members
  WHERE project_name = ${sqlStringLiteral(args.project)}
    AND tag_id = ${sqlStringLiteral(args.tagId)}
    AND batch_id = ${sqlStringLiteral(args.batchId)}
) AS ${args.alias} ON ${args.alias}.uid = ${uid}`;
  const expr = `if(${args.alias}.tag_value = '' OR ${args.alias}.tag_value IS NULL, '未打标', ${args.alias}.tag_value)`;
  return { joinSql, expr };
}

export function collectTagFunctionCalls(sql: string): Array<{ tagId: string; values: string[]; op: 'in' | 'not_in' | 'value' }> {
  const found: Array<{ tagId: string; values: string[]; op: 'in' | 'not_in' | 'value' }> = [];
  const inRe = new RegExp(TAG_IN_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = inRe.exec(sql)) !== null) {
    const args = parseQuotedArgs(match[2]);
    if (args.length < 1) continue;
    found.push({
      tagId: args[0],
      values: args.slice(1),
      op: match[1].toLowerCase() === 'sa_tag_not_in' ? 'not_in' : 'in',
    });
  }
  const valueRe = new RegExp(TAG_VALUE_RE.source, 'gi');
  while ((match = valueRe.exec(sql)) !== null) {
    found.push({ tagId: match[2], values: [], op: 'value' });
  }
  return found;
}

export function expandSaTagFunctions(
  sql: string,
  resolved: Map<string, { project: string; batchId: string }>,
  uidExpr = ANALYSIS_UID_EXPR,
): string {
  let out = sql.replace(new RegExp(TAG_IN_RE.source, 'gi'), (full, fn: string, inner: string) => {
    const args = parseQuotedArgs(inner);
    const tagId = args[0];
    const hit = tagId ? resolved.get(tagId) : undefined;
    if (!hit || !tagId) {
      throw badRequest({
        code: 'report.sql.tagUnknown',
        messageKey: 'report:error.sql.tagUnknown',
        params: { tag: tagId ?? full },
        message: `标签函数引用了未知标签: ${tagId ?? full}`,
      });
    }
    return tagMemberSqlPredicate({
      uidExpr,
      project: hit.project,
      tagId,
      batchId: hit.batchId,
      values: args.slice(1),
      op: String(fn).toLowerCase() === 'sa_tag_not_in' ? 'not_in' : 'in',
    });
  });
  out = out.replace(new RegExp(TAG_VALUE_RE.source, 'gi'), (_full, _q: string, tagId: string) => {
    const hit = resolved.get(tagId);
    if (!hit) {
      throw badRequest({
        code: 'report.sql.tagUnknown',
        messageKey: 'report:error.sql.tagUnknown',
        params: { tag: tagId },
        message: `标签函数引用了未知标签: ${tagId}`,
      });
    }
    return `ifNull((
  SELECT tag_value FROM clklog_sa.sa_tag_members
  WHERE project_name = ${sqlStringLiteral(hit.project)}
    AND tag_id = ${sqlStringLiteral(tagId)}
    AND batch_id = ${sqlStringLiteral(hit.batchId)}
    AND uid = ${uidExpr}
  LIMIT 1
), '未打标')`;
  });
  return out;
}

export function tagValuesFromDefinition(raw: unknown): string[] {
  let def = raw;
  if (typeof raw === 'string') {
    try {
      def = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!def || typeof def !== 'object' || Array.isArray(def)) return [];
  const rec = def as { rules?: Array<{ value?: unknown }>; default_value?: unknown };
  const values: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    values.push(trimmed);
  };
  for (const rule of rec.rules ?? []) push(rule?.value);
  push(rec.default_value);
  return values;
}

export function builderDslHasTag(dsl: unknown): boolean {
  if (!dsl || typeof dsl !== 'object') return false;
  const rec = dsl as {
    groups?: Array<{ kind?: string; scope?: string }>;
    filters?: { items?: Array<{ scope?: string }> };
  };
  if ((rec.groups ?? []).some((g) => g.kind === 'tag' || g.scope === 'tag')) return true;
  return (rec.filters?.items ?? []).some((item) => item.scope === 'tag');
}
