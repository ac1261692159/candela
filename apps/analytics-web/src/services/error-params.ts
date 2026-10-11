/**
 * 错误插值参数里的「显示名」键解析（i18n v1 补交）。
 *
 * 约定：接口错误 `params` 里需要本地化的显示名以**成对**形式下发——
 * `field`（中文原文兜底）+ `field_key`（资源键，形如 `alerting:channelConfig.smtp.field.host`）。
 * 渲染前把 `*_key` 解析成当前语言的显示名，覆盖同名兜底值；
 * 缺翻译时保留服务端下发的中文兜底（不会把键名露出，也不会插出空串）。
 *
 * 这样字段名的唯一权威仍是界面语言资源（告警校验提示里的「SMTP 服务器」直接复用表单标签），
 * 服务端不需要再抄一份翻译；服务端产出的 `message` 仍是中文原文，老客户端行为不变。
 */
const KEY_SUFFIX = '_key';

export function resolveParamKeys(
  params: Record<string, unknown> | null | undefined,
  translate: (key: string) => string,
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  let resolved: Record<string, unknown> | undefined;
  for (const [name, value] of Object.entries(params)) {
    if (!name.endsWith(KEY_SUFFIX) || typeof value !== 'string' || !value.includes(':')) continue;
    const text = translate(value);
    if (!text || text === value) continue;
    resolved ??= { ...params };
    resolved[name.slice(0, -KEY_SUFFIX.length)] = text;
  }
  return resolved ?? params;
}
