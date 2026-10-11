import {
  ADDITIVE_NAME,
  BOOLEAN_NAME,
  CATEGORY_NAME,
  COUNT_UNIT_NAME,
  CURRENCY_NAME,
  DATE_ONLY,
  DATETIME_ISO,
  DATETIME_LOCAL,
  DURATION_MS_NAME,
  DURATION_SEC_NAME,
  ID_NAME,
  METRIC_NAME,
  NON_ADDITIVE_NAME,
  PERCENT_NAME,
  PROFILE_SAMPLE_LIMIT,
  RATIO_NAME,
  STRICT_NUMBER,
  TIME_NAME_EXACT,
} from './chart.constants';
import type {
  AggregationSemantics,
  BaseColumnType,
  BuilderDslLike,
  ColumnProfile,
  ColumnReasonCode,
  ColumnRole,
  Confidence,
  MetricUnit,
  ProfilerContext,
  QueryColumn,
} from './chart.types';

export function unwrapClickHouseType(raw: string): string {
  let current = raw.trim();
  let previous = '';
  while (current !== previous) {
    previous = current;
    const nullable = current.match(/^Nullable\((.*)\)$/i);
    if (nullable) {
      current = nullable[1].trim();
      continue;
    }
    const lowCard = current.match(/^LowCardinality\((.*)\)$/i);
    if (lowCard) {
      current = lowCard[1].trim();
      continue;
    }
    const simpleAgg = current.match(/^SimpleAggregateFunction\([^,]+,\s*(.*)\)$/i);
    if (simpleAgg) {
      current = simpleAgg[1].trim();
    }
  }
  return current;
}

export function classifyBaseType(clickhouseType: string): BaseColumnType {
  const inner = unwrapClickHouseType(clickhouseType);
  if (/^(DateTime64|DateTime|Date32|Date)\b/i.test(inner)) return 'time';
  if (/^(UInt|Int|Float|Decimal)/i.test(inner)) return 'number';
  if (/^(String|FixedString|UUID|IPv4|IPv6|Enum)/i.test(inner)) return 'string';
  if (/^Bool$/i.test(inner)) return 'boolean';
  if (/^Array\(/i.test(inner)) return 'array';
  if (/^(Tuple|Map|JSON|Object)/i.test(inner)) return 'object';
  return 'unknown';
}

export function parseStrictNumber(value: unknown): number | null | 'unsafe' {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      return 'unsafe';
    }
    return Number(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'unsafe';
    return value;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!STRICT_NUMBER.test(text)) return null;
  if (!/[.eE]/.test(text)) {
    try {
      const asBig = BigInt(text);
      if (asBig > BigInt(Number.MAX_SAFE_INTEGER) || asBig < BigInt(Number.MIN_SAFE_INTEGER)) {
        return 'unsafe';
      }
    } catch {
      return 'unsafe';
    }
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return 'unsafe';
  return parsed;
}

export function parseStrictTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!DATE_ONLY.test(text) && !DATETIME_LOCAL.test(text) && !DATETIME_ISO.test(text)) {
    return null;
  }
  const normalized = DATE_ONLY.test(text)
    ? `${text}T00:00:00`
    : DATETIME_LOCAL.test(text)
      ? text.replace(' ', 'T')
      : text;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

function sampleValues(rows: Record<string, unknown>[], key: string): unknown[] {
  const samples: unknown[] = [];
  for (const row of rows) {
    const value = row[key];
    if (value === null || value === undefined || value === '') continue;
    samples.push(value);
    if (samples.length >= PROFILE_SAMPLE_LIMIT) break;
  }
  return samples;
}

function builderRolesFromDsl(dsl?: BuilderDslLike): Record<string, Exclude<ColumnRole, 'pending'>> {
  const roles: Record<string, Exclude<ColumnRole, 'pending'>> = {};
  for (const group of dsl?.groups ?? []) {
    if (group.kind === 'time' && group.granularity) roles[group.granularity] = 'time';
    if ((group.kind === 'property' || group.kind === 'column') && group.prop) {
      roles[group.prop] = 'dimension';
    }
  }
  for (const metric of dsl?.metrics ?? []) {
    if (metric.fn === 'count') roles.event_count = 'metric';
    if (metric.fn === 'uniq') roles.uniq_users = 'metric';
    if (metric.fn === 'sum' && metric.prop) roles[`sum_${metric.prop}`] = 'metric';
    if (metric.fn === 'avg' && metric.prop) roles[`avg_${metric.prop}`] = 'metric';
  }
  return roles;
}

function inferUnit(name: string): MetricUnit {
  if (PERCENT_NAME.test(name)) return 'percent_0_100';
  if (DURATION_MS_NAME.test(name)) return 'duration_ms';
  if (DURATION_SEC_NAME.test(name)) return 'duration_sec';
  if (COUNT_UNIT_NAME.test(name)) return 'number';
  if (CURRENCY_NAME.test(name)) return 'currency';
  return 'number';
}

function inferAggregation(name: string): AggregationSemantics {
  if (NON_ADDITIVE_NAME.test(name)) return 'non_additive';
  if (ADDITIVE_NAME.test(name)) return 'additive';
  return 'unknown';
}

function isAllStrictTime(samples: unknown[]): boolean {
  if (samples.length < 2) return false;
  return samples.every((value) => parseStrictTime(value) !== null);
}

function hasUnsafeInteger(samples: unknown[]): boolean {
  return samples.some((value) => parseStrictNumber(value) === 'unsafe');
}

const AGGREGATE_CALL =
  /\b(?:uniq\w*|count(?:If)?|sum(?:If)?|avg(?:If)?|min(?:If)?|max(?:If)?|quantile\w*|groupArray|anyLast|any)\s*\(/i;

/**
 * 从 SQL 的 SELECT 顶层列表里提取「聚合表达式 AS 别名」的别名集合。
 * 聚合结果列必然是指标——这个信号比名字正则可靠，用于数字列名字不匹配时的兜底
 * （如 DAU/DNU/DOU 这类自造缩写）。只扫描顶层 SELECT，跳过括号与引号内的逗号。
 */
export function aggregateAliasesFromSql(sql: string): Set<string> {
  const aliases = new Set<string>();
  if (!sql) return aliases;
  // 找到顶层（括号深度 0）的 SELECT…FROM 段，避开 CTE/子查询里的 SELECT。
  let start = -1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '`' || ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') { depth += 1; continue; }
    if (ch === ')') { depth -= 1; continue; }
    if (depth === 0 && /\s/i.test(ch)) {
      const word = sql.slice(i + 1).match(/^\s*(SELECT|FROM)\b/i);
      if (word) {
        if (word[1].toUpperCase() === 'SELECT' && start < 0) { start = i; }
        else if (word[1].toUpperCase() === 'FROM') {
          // SQL 以 SELECT 开头（前面无空白）时 start 仍是 -1，按 0 起算。
          if (start < 0 && /^\s*SELECT\b/i.test(sql)) start = 0;
          if (start >= 0) {
            splitTopLevel(sql.slice(start, i), aliases);
            return aliases;
          }
        }
      }
    }
  }
  // 无 FROM（如 SELECT 1）或异常形态：整段按顶层处理。
  if (start < 0 && /^\s*SELECT\b/i.test(sql)) start = 0;
  if (start >= 0) splitTopLevel(sql.slice(start), aliases);
  return aliases;
}

function splitTopLevel(selectClause: string, aliases: Set<string>): void {
  const fragments: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of selectClause) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '`' || ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { fragments.push(current); current = ''; continue; }
    current += ch;
  }
  fragments.push(current);
  for (const fragment of fragments) {
    const aliasMatch = fragment.match(/AS\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([^\s`,()]+))\s*$/iu);
    if (!aliasMatch) continue;
    const alias = aliasMatch[1] ?? aliasMatch[2] ?? aliasMatch[3] ?? aliasMatch[4];
    if (alias && AGGREGATE_CALL.test(fragment)) aliases.add(alias);
  }
}

function profileOne(
  column: QueryColumn,
  rows: Record<string, unknown>[],
  context: ProfilerContext,
  aggregateAliases: Set<string>,
): ColumnProfile {
  const key = column.name;
  const samples = sampleValues(rows, key);
  const baseType = classifyBaseType(column.type);
  let nullCount = 0;
  let nonNullCount = 0;
  const distinct = new Set<string>();
  for (const row of rows) {
    const value = row[key];
    if (value === null || value === undefined || value === '') {
      nullCount += 1;
    } else {
      nonNullCount += 1;
      if (distinct.size < PROFILE_SAMPLE_LIMIT) distinct.add(String(value));
    }
  }
  const reasons: ColumnReasonCode[] = [];
  const saved = context.savedRoles?.[key];
  if (saved) {
    return finishProfile(key, column.type, baseType, saved, 'certain', ['saved_role'], samples, nullCount, nonNullCount, distinct.size);
  }
  const builder = builderRolesFromDsl(context.builderDsl)[key];
  if (builder) {
    return finishProfile(key, column.type, baseType, builder, 'certain', ['builder_role'], samples, nullCount, nonNullCount, distinct.size);
  }
  if (baseType === 'time') {
    return finishProfile(key, column.type, baseType, 'time', 'certain', ['clickhouse_time'], samples, nullCount, nonNullCount, distinct.size);
  }
  if (baseType === 'array' || baseType === 'object' || baseType === 'unknown') {
    return finishProfile(key, column.type, baseType, 'pending', 'pending', ['insufficient_evidence'], samples, nullCount, nonNullCount, distinct.size);
  }
  if (baseType === 'string' || (baseType === 'boolean' && BOOLEAN_NAME.test(key))) {
    reasons.push('clickhouse_string');
    if (TIME_NAME_EXACT.test(key) && isAllStrictTime(samples)) {
      return finishProfile(key, column.type, 'time', 'time', 'probable', ['alias_time', 'strict_time_sample'], samples, nullCount, nonNullCount, distinct.size);
    }
    if (isAllStrictTime(samples)) {
      return finishProfile(key, column.type, 'time', 'time', 'probable', ['strict_time_sample'], samples, nullCount, nonNullCount, distinct.size);
    }
    return finishProfile(key, column.type, baseType, 'dimension', 'probable', [...reasons, CATEGORY_NAME.test(key) || ID_NAME.test(key) ? 'alias_category' : 'clickhouse_string'], samples, nullCount, nonNullCount, distinct.size);
  }
  if (baseType === 'number') {
    reasons.push('clickhouse_number');
    if (hasUnsafeInteger(samples)) {
      return finishProfile(key, column.type, baseType, 'pending', 'invalid', [...reasons, 'unsafe_integer'], samples, nullCount, nonNullCount, distinct.size, false);
    }
    // SQL 聚合别名是确定性信号：聚合结果列必然是指标，优先于名字正则。
    if (aggregateAliases.has(key)) {
      return finishProfile(key, column.type, baseType, 'metric', 'certain', [...reasons, 'sql_aggregate_alias'], samples, nullCount, nonNullCount, distinct.size);
    }
    if (ID_NAME.test(key) && !METRIC_NAME.test(key)) {
      return finishProfile(key, column.type, baseType, 'dimension', 'probable', [...reasons, 'alias_id'], samples, nullCount, nonNullCount, distinct.size);
    }
    if (METRIC_NAME.test(key) || RATIO_NAME.test(key)) {
      const metricReasons: ColumnReasonCode[] = [...reasons, 'alias_metric'];
      if (RATIO_NAME.test(key)) metricReasons.push('alias_ratio');
      if (NON_ADDITIVE_NAME.test(key)) metricReasons.push('alias_non_additive');
      return finishProfile(key, column.type, baseType, 'metric', 'probable', metricReasons, samples, nullCount, nonNullCount, distinct.size);
    }
    if (isAllStrictTime(samples)) {
      return finishProfile(key, column.type, 'time', 'time', 'probable', ['strict_time_sample'], samples, nullCount, nonNullCount, distinct.size);
    }
    return finishProfile(key, column.type, baseType, 'pending', 'pending', [...reasons, 'insufficient_evidence'], samples, nullCount, nonNullCount, distinct.size);
  }
  return finishProfile(key, column.type, baseType, 'pending', 'pending', ['insufficient_evidence'], samples, nullCount, nonNullCount, distinct.size);
}

function finishProfile(
  key: string,
  clickhouseType: string,
  baseType: BaseColumnType,
  role: ColumnRole,
  confidence: Confidence,
  reasons: ColumnReasonCode[],
  samples: unknown[],
  nullCount: number,
  nonNullCount: number,
  distinctSampleCount: number,
  safeNumber = true,
): ColumnProfile {
  const profile: ColumnProfile = {
    key,
    clickhouseType,
    baseType,
    role,
    confidence,
    reasons,
    nonNullCount,
    nullCount,
    distinctSampleCount,
  };
  if (role === 'metric' || (baseType === 'number' && role !== 'dimension' && role !== 'time')) {
    profile.metric = {
      unit: inferUnit(key),
      aggregation: inferAggregation(key),
      safeNumber: safeNumber && !hasUnsafeInteger(samples),
    };
  }
  if (reasons.includes('unsafe_integer') && profile.metric) {
    profile.metric.safeNumber = false;
  }
  return profile;
}

export function profileColumns(
  columns: QueryColumn[],
  rows: Record<string, unknown>[],
  context: ProfilerContext = {},
): ColumnProfile[] {
  const aggregateAliases = context.sql ? aggregateAliasesFromSql(context.sql) : new Set<string>();
  return columns.map((column) => profileOne(column, rows, context, aggregateAliases));
}

export function applyExplicitRoles(
  profiles: ColumnProfile[],
  roles?: Record<string, Exclude<ColumnRole, 'pending'>>,
): ColumnProfile[] {
  if (!roles) return profiles;
  return profiles.map((profile) => {
    const next = roles[profile.key];
    if (!next) return profile;
    return {
      ...profile,
      role: next,
      confidence: 'certain',
      reasons: ['saved_role', ...profile.reasons.filter((reason) => reason !== 'saved_role')],
      metric:
        next === 'metric'
          ? profile.metric ?? {
              unit: inferUnit(profile.key),
              aggregation: inferAggregation(profile.key),
              safeNumber: true,
            }
          : next === 'dimension' || next === 'time'
            ? undefined
            : profile.metric,
    };
  });
}

export function distinctCount(rows: Record<string, unknown>[], key: string): number {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row[key];
    if (value === null || value === undefined || value === '') continue;
    seen.add(String(value));
  }
  return seen.size;
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}
