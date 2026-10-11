import type { BuilderDsl } from './GroupByPanel';

const TIME_FN: Record<string, string> = {
  day: 'toStartOfDay(log_time)',
  hour: 'toStartOfHour(log_time)',
  week: 'toStartOfWeek(log_time)',
  month: 'toStartOfMonth(log_time)',
};

const UID_EXPR = "if(user_key != '', user_key, distinct_id)";

function quoteList(values: unknown): string {
  const list = Array.isArray(values)
    ? values.map(String)
    : String(values ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  return list.map((item) => `'${item.replace(/'/g, "\\'")}'`).join(', ');
}

/**
 * Builder DSL → SQL 文本（回显到编辑器，可继续编辑后执行）。
 * 模板与后端 SqlReportService.generateSqlFromDsl 保持一致；
 * project_name 与时间范围条件由后端守卫在执行时注入，预览文本不含。
 * 分群用 sa_in_cohort()，标签用 sa_tag_in / sa_tag_value，执行层注入现网 batch_id。
 */
export function dslToSql(dsl: BuilderDsl): string {
  const selects: string[] = [];
  const groups: string[] = [];
  const hasCohort =
    (dsl.groups ?? []).some((g) => g.kind === 'cohort') || (dsl.filters?.items ?? []).some((item) => item.scope === 'cohort');
  const hasTag =
    (dsl.groups ?? []).some((g) => g.kind === 'tag') || (dsl.filters?.items ?? []).some((item) => item.scope === 'tag');
  const useUid = hasCohort || hasTag;

  for (const g of dsl.groups ?? []) {
    if (g.kind === 'time') {
      const granularity = g.granularity ?? 'day';
      selects.push(`${TIME_FN[granularity] ?? TIME_FN.day} AS \`${granularity}\``);
      groups.push(`\`${granularity}\``);
    } else if (g.kind === 'column') {
      selects.push(`${g.prop} AS \`${g.prop}\``);
      groups.push(`\`${g.prop}\``);
    } else if (g.kind === 'cohort') {
      selects.push(`if(sa_in_cohort('${g.prop}'), '属于', '不属于') AS \`用户分群\``);
      groups.push('`用户分群`');
    } else if (g.kind === 'tag') {
      selects.push(`sa_tag_value('${g.prop}') AS \`用户标签\``);
      groups.push('`用户标签`');
    } else {
      selects.push(`JSONExtractString(properties, '${g.prop}') AS \`${g.prop}\``);
      groups.push(`\`${g.prop}\``);
    }
  }

  for (const m of dsl.metrics ?? [{ fn: 'count' }]) {
    if (m.fn === 'count') selects.push('count() AS `event_count`');
    else if (m.fn === 'uniq') {
      selects.push(useUid ? `uniqExact(${UID_EXPR}) AS \`uniq_users\`` : 'uniqExact(distinct_id) AS `uniq_users`');
    } else if (m.fn === 'sum' && m.prop) selects.push(`sum(JSONExtractFloat(properties, '${m.prop}')) AS \`sum_${m.prop}\``);
    else if (m.fn === 'avg' && m.prop) selects.push(`avg(JSONExtractFloat(properties, '${m.prop}')) AS \`avg_${m.prop}\``);
  }

  let sql = `SELECT ${selects.join(', ')} FROM clklog_sa.sa_events`;
  const wheres: string[] = [];
  if (dsl.event) wheres.push(`event = '${dsl.event.replace(/'/g, "\\'")}'`);
  for (const item of dsl.filters?.items ?? []) {
    if (item.scope === 'cohort') {
      wheres.push(item.op === 'not_in' ? `sa_not_in_cohort('${item.prop}')` : `sa_in_cohort('${item.prop}')`);
    }
    if (item.scope === 'tag') {
      const args = [`'${item.prop}'`, quoteList(item.value)].filter((part) => part && part !== '').join(', ');
      wheres.push(item.op === 'not_in' ? `sa_tag_not_in(${args})` : `sa_tag_in(${args})`);
    }
  }
  if (wheres.length) sql += ` WHERE ${wheres.join(' AND ')}`;
  if (groups.length) sql += ` GROUP BY ${groups.join(', ')}`;
  return sql;
}
