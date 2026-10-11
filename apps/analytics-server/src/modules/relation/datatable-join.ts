import { badRequest } from '../../i18n/domain-error';
import { DEFAULT_PLATFORM_TZ } from '../time/calendar';
import {
  DATATABLE_JOIN_KEY_PREFIX,
  type JoinRequest,
} from './join-registry';

/**
 * 维度表属性名：`{绑定属性}@{字段}`。专用分支，不放宽通用 PROP_KEY 正则。
 * 契约：`docs/architecture/clklog-analytics-design-datatable-v2.md` §5。
 */
export const DATATABLE_DIMENSION_PROP_PATTERN =
  /^(#[a-z][a-z0-9_]{0,49}|[a-zA-Z_][a-zA-Z0-9_$.-]{0,63})@[a-z][a-z0-9_]{0,49}$/;
export const DATATABLE_DIMENSION_PROP_MAX_LEN = 130;
const DATATABLE_ID_PATTERN = /^dt_[A-Za-z0-9_-]{1,40}$/;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

/** 事件时间绑定粒度（#event_time 的 join 键格式化） */
export const EVENT_TIME_GRANULARITY_FORMAT: Record<string, string> = {
  year: '%Y',
  month: '%Y-%m',
  day: '%Y-%m-%d',
  hour: '%Y-%m-%d %H',
  minute: '%Y-%m-%d %H:%M',
  second: '%Y-%m-%d %H:%M:%S',
};

export interface DatatableDimensionProp {
  targetProp: string;
  fieldKey: string;
}

export function parseDatatableDimension(prop: string): DatatableDimensionProp | null {
  if (!prop || prop.length > DATATABLE_DIMENSION_PROP_MAX_LEN) return null;
  if (!DATATABLE_DIMENSION_PROP_PATTERN.test(prop)) return null;
  const at = prop.indexOf('@');
  return { targetProp: prop.slice(0, at), fieldKey: prop.slice(at + 1) };
}

export function assertSafeDatatableId(id: string): string {
  if (!DATATABLE_ID_PATTERN.test(id)) {
    throw badRequest({
      code: 'relation.datatable.tableIdInvalid',
      messageKey: 'cohort:error.relation.tableIdInvalid',
      message: '非法数据表标识',
    });
  }
  return id;
}

export function assertSafeFieldKey(fieldKey: string): string {
  if (!FIELD_KEY_PATTERN.test(fieldKey)) {
    throw badRequest({
      code: 'relation.datatable.fieldKeyInvalid',
      messageKey: 'cohort:error.relation.fieldKeyInvalid',
      params: { field: fieldKey },
      message: `非法数据表字段: ${fieldKey}`,
    });
  }
  return fieldKey;
}

function sqlAliasPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_');
}

export function datatableJoinKey(tableId: string, version: number, keyColumn: string): string {
  return `${DATATABLE_JOIN_KEY_PREFIX}_${sqlAliasPart(tableId)}_${version}_${sqlAliasPart(keyColumn)}`;
}

export function datatableFieldExpr(
  alias: string,
  fieldKey: string,
  primaryField: string,
  dataType: string,
): string {
  assertSafeFieldKey(fieldKey);
  if (fieldKey === primaryField) return `${alias}.pk`;
  const suffix = jsonExtractSuffix(dataType);
  return `JSONExtract${suffix}(${alias}.values, '${fieldKey}')`;
}

export function jsonExtractSuffix(dataType: string): string {
  switch (dataType) {
    case 'number':
      return 'Float';
    case 'boolean':
      return 'Bool';
    case 'datetime':
      return 'String';
    case 'list':
    case 'object':
    case 'object_group':
      return 'Raw';
    case 'string':
    default:
      return 'String';
  }
}

/**
 * tz 由调用方注入（平台时区，经 TimezoneService 白名单校验过），
 * 字面量内联不是注入面；默认 Asia/Shanghai 与历史口径一致。
 */
export function eventTimeJoinExpr(granularity?: string | null, tz: string = DEFAULT_PLATFORM_TZ): string {
  const fmt = EVENT_TIME_GRANULARITY_FORMAT[granularity || 'day'] ?? '%Y-%m-%d';
  return `formatDateTime(sa_events.log_time, '${fmt}', '${tz}')`;
}

export function datatableJoinRequest(opts: {
  tableId: string;
  version: number;
  keyColumn: string;
  primaryField: string;
  leftExpr: string;
}): JoinRequest {
  const tableId = assertSafeDatatableId(opts.tableId);
  const keyColumn = assertSafeFieldKey(opts.keyColumn);
  const primaryField = assertSafeFieldKey(opts.primaryField);
  if (!Number.isInteger(opts.version) || opts.version < 0 || opts.version > 1_000_000_000) {
    throw badRequest({
      code: 'relation.datatable.versionInvalid',
      messageKey: 'cohort:error.relation.versionInvalid',
      message: '非法数据表版本',
    });
  }
  const right = (alias: string) =>
    keyColumn === primaryField
      ? `${alias}.pk`
      : `JSONExtractString(${alias}.values, '${keyColumn}')`;
  return {
    key: datatableJoinKey(tableId, opts.version, keyColumn),
    subquery:
      `(SELECT pk, values FROM clklog_sa.sa_datatable_rows` +
      ` WHERE project_name = {project: String}` +
      ` AND datatable_key = '${tableId}'` +
      ` AND version = ${opts.version})`,
    on: (alias) => `toString(${opts.leftExpr}) = toString(${right(alias)})`,
  };
}
