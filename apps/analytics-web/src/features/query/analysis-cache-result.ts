import type { FunnelResult, QueryColumn, QueryResult } from '../../types/dsl.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseColumns(raw: unknown): QueryColumn[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const columns: QueryColumn[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.key !== 'string' || !item.key) return null;
    const unit = item.unit;
    const valueMap = isRecord(item.value_map)
      ? (Object.fromEntries(
          Object.entries(item.value_map).filter(([, value]) => typeof value === 'string'),
        ) as Record<string, string>)
      : undefined;
    const titleKey = typeof item.title_key === 'string' && item.title_key ? item.title_key : undefined;
    const titleParams = isRecord(item.title_params) ? item.title_params : undefined;
    columns.push({
      key: item.key,
      title: typeof item.title === 'string' && item.title ? item.title : item.key,
      // 固定文案列名的文案键要随缓存一起还原，否则打开卡片后表头又被固化成中文（i18n-v1）
      ...(titleKey ? { title_key: titleKey } : {}),
      ...(titleKey && titleParams ? { title_params: titleParams } : {}),
      ...(unit === 'number' || unit === 'duration_sec' || unit === 'percent' ? { unit } : {}),
      // 值映射要随缓存一起还原，否则看板刷缓存后业务名会退回原始 ID
      ...(valueMap && Object.keys(valueMap).length > 0 ? { value_map: valueMap } : {}),
      ...(typeof item.value_map_title === 'string' && item.value_map_title
        ? { value_map_title: item.value_map_title }
        : {}),
      ...(isRecord(item.value_map_stats) &&
      typeof item.value_map_stats.sampled === 'number' &&
      typeof item.value_map_stats.matched === 'number'
        ? {
            value_map_stats: {
              sampled: item.value_map_stats.sampled,
              matched: item.value_map_stats.matched,
              ...(item.value_map_stats.truncated === true ? { truncated: true } : {}),
            },
          }
        : {}),
    });
  }
  return columns;
}

function parseRows(raw: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((row): row is Record<string, unknown> => isRecord(row));
}

/** 看板/卡片缓存 → 事件或留存查询结果。SQL 形（columns[].name）和截断包返回 null。 */
export function queryResultFromCache(result: unknown): QueryResult | null {
  if (!isRecord(result) || result.reason === 'cache_too_large') return null;
  const columns = parseColumns(result.columns);
  const rows = parseRows(result.rows);
  if (!columns || !rows) return null;
  return {
    columns,
    rows,
    elapsed_ms: typeof result.elapsed_ms === 'number' ? result.elapsed_ms : 0,
    sql: typeof result.sql === 'string' ? result.sql : undefined,
    from_cache: true,
  };
}

export function funnelResultFromCache(result: unknown): FunnelResult | null {
  const base = queryResultFromCache(result);
  if (!base || !isRecord(result)) return null;
  const steps = Array.isArray(result.steps)
    ? result.steps.flatMap((step) => {
        if (!isRecord(step) || typeof step.key !== 'string' || !step.key) return [];
        return [{ key: step.key, title: typeof step.title === 'string' && step.title ? step.title : step.key }];
      })
    : [];
  return { ...base, steps };
}
