import { badRequest } from '../../i18n/domain-error';

/** Harness 数据出口约束；查询本身仍复用 Query 模块的校验与权限。 */
export function assertHarnessDsl(value: unknown, depth = 0): void {
  if (depth > 12) {
    throw badRequest({
      code: 'ai.tool.dslTooDeep',
      messageKey: 'ai:error.tool.dslTooDeep',
      message: 'analysis_dsl_too_deep',
    });
  }
  if (Array.isArray(value)) { value.forEach((child) => assertHarnessDsl(child, depth + 1)); return; }
  if (!value || typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  if (object.scope === 'user') {
    throw badRequest({
      code: 'ai.tool.userPropertyUnavailable',
      messageKey: 'ai:error.tool.userPropertyUnavailable',
      message: 'user_property_query_unavailable: 用户属性关联查询待修复；请使用已核验的事件属性，不能反复换名试探',
    });
  }
  for (const [key, child] of Object.entries(object)) {
    if (/^(distinct_id|user_key|device_id)$/i.test(key)
      || (typeof child === 'string' && /^(distinct_id|user_key|device_id)$/i.test(child))) {
      throw badRequest({
        code: 'ai.tool.identityFieldForbidden',
        messageKey: 'ai:error.tool.identityFieldForbidden',
        message: 'analysis_identity_field_forbidden',
      });
    }
    assertHarnessDsl(child, depth + 1);
  }
}

export function pageSchema(schema: Record<string, unknown>, keyword: string, page: number): Record<string, unknown> & { pagination: Record<string, unknown> } {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw badRequest({
      code: 'ai.tool.schemaPageInvalid',
      messageKey: 'ai:error.tool.schemaPageInvalid',
      message: 'schema_page_invalid',
    });
  }
  const needle = keyword.trim().toLowerCase();
  const output: Record<string, unknown> = {};
  const pagination: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!Array.isArray(value)) continue;
    const matches = value.filter((item) => !needle || [item.event_key, item.prop_key, item.display_name, item.name]
      .some((field) => typeof field === 'string' && field.toLowerCase().includes(needle)));
    output[key] = matches.slice((page - 1) * 50, page * 50);
    pagination[key] = { total: matches.length, page, next_page: page * 50 < matches.length ? page + 1 : null };
  }
  return { ...output, pagination, fetched_at: new Date().toISOString() };
}
