import type { ChartConfigV1 } from '../visualization/chart.types';
import type { SqlExecuteResult } from '../../types/report.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseColumns(raw: unknown): SqlExecuteResult['columns'] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const columns: SqlExecuteResult['columns'] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name) return null;
    columns.push({ name: item.name, type: typeof item.type === 'string' ? item.type : 'String' });
  }
  return columns;
}

function parseRows(raw: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((row): row is Record<string, unknown> => isRecord(row));
}

/** 把卡片缓存 JSON 认成自定义 SQL 执行结果；截断包或事件分析结果返回 null。 */
export function sqlResultFromCache(result: unknown): SqlExecuteResult | null {
  if (!isRecord(result)) return null;
  if (result.reason === 'cache_too_large') return null;
  const columns = parseColumns(result.columns);
  const rows = parseRows(result.rows);
  if (!columns || !rows) return null;
  return {
    query_id: typeof result.query_id === 'string' && result.query_id ? result.query_id : 'card-cache',
    columns,
    rows,
    row_count: typeof result.row_count === 'number' ? result.row_count : rows.length,
    truncated: result.truncated === true,
    elapsed_ms: typeof result.elapsed_ms === 'number' ? result.elapsed_ms : 0,
    read_rows: typeof result.read_rows === 'number' ? result.read_rows : rows.length,
    read_bytes: typeof result.read_bytes === 'number' ? result.read_bytes : 0,
    applied_time_range:
      isRecord(result.applied_time_range) &&
      typeof result.applied_time_range.start === 'string' &&
      typeof result.applied_time_range.end === 'string'
        ? { start: result.applied_time_range.start, end: result.applied_time_range.end }
        : undefined,
    from_cache: true,
  };
}

/** 无缓存时仍能打开字段设置：用已存角色列做空结果。 */
export function placeholderSqlResult(config: ChartConfigV1): SqlExecuteResult {
  const names = Object.keys(config.roles);
  const fromBindings = [
    config.bindings.x,
    config.bindings.category,
    config.bindings.series,
    ...config.bindings.metrics,
  ].filter((name): name is string => Boolean(name));
  const columns = [...new Set(names.length ? names : fromBindings)].map((name) => ({
    name,
    type: 'Float64',
  }));
  return {
    query_id: 'card-placeholder',
    columns,
    rows: [],
    row_count: 0,
    truncated: false,
    elapsed_ms: 0,
    read_rows: 0,
    read_bytes: 0,
  };
}
