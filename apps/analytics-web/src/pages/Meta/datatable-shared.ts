import type { DatatableColumn, DatatableDataType } from '../../services/datatable.service';
import type { TFunction } from '../../i18n';

/** 数据类型显示名复用 meta 命名空间，与埋点管理的口径一致 */
const DATA_TYPE_LABEL_KEY: Record<string, string> = {
  number: 'meta:dataType.number',
  string: 'meta:dataType.string',
  datetime: 'meta:dataType.datetime',
  boolean: 'meta:dataType.boolean',
};

export function dataTypeOptions(t: TFunction): { label: string; value: DatatableDataType }[] {
  return (['number', 'string', 'datetime', 'boolean'] as DatatableDataType[]).map((value) => ({
    label: typeLabel(value, t),
    value,
  }));
}


export function granularityOptions(t: TFunction): { label: string; value: string }[] {
  return [
    { label: t('datatable:granularity.year'), value: 'year' },
    { label: t('datatable:granularity.month'), value: 'month' },
    { label: t('datatable:granularity.day'), value: 'day' },
    { label: t('datatable:granularity.hour'), value: 'hour' },
    { label: t('datatable:granularity.minute'), value: 'minute' },
    { label: t('datatable:granularity.second'), value: 'second' },
  ];
}

/**
 * 只回传后端 DTO 声明的字段：解析结果里带 `is_primary` / `sort_order` 回显，
 * 直接回传会被服务端 whitelist 校验拒绝（400）。
 */

export function toColumnPayload(columns: DatatableColumn[]): DatatableColumn[] {
  return columns.map(({ field_key, data_type, display_name }) => ({
    field_key,
    data_type,
    display_name,
  }));
}


export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;


export function typeLabel(value: string | undefined, t: TFunction): string {
  const key = value ? DATA_TYPE_LABEL_KEY[value] : undefined;
  return key ? t(key) : value ?? '-';
}

/**
 * join 键列与属性的类型兼容（对齐数数：文本可关联 文本/时间；数值只配数值；布尔只配布尔）。
 * 时间与文本互配是因为「时间」常以文本形式落在事件属性里。
 */

export function isCompatible(keyType: string | undefined, propType: string | undefined): boolean {
  if (!keyType || !propType || keyType === propType) return true;
  return (
    (keyType === 'string' && propType === 'datetime') ||
    (keyType === 'datetime' && propType === 'string')
  );
}

function isIdLikeColumn(column: DatatableColumn): boolean {
  if (column.is_primary) return true;
  return column.field_key === 'id' || /(^|_)id$/i.test(column.field_key);
}

/** 与后端 pickLabelField 对齐：默认展示列（绑定里可再改）。 */
export function pickDefaultLabelField(columns: DatatableColumn[], keyColumn: string): string | undefined {
  const others = columns.filter((column) => column.field_key !== keyColumn && !isIdLikeColumn(column));
  const nameish = others.find(
    (column) => column.data_type === 'string' && /(^|_)name$/i.test(column.field_key),
  );
  return (nameish ?? others.find((column) => column.data_type === 'string') ?? others[0])?.field_key;
}


export function propTargetType(propKey: string): 'event_property' | 'event_name' | 'event_time' {
  return BUILTIN_PROPS.find((item) => item.prop_key === propKey)?.targetType ?? 'event_property';
}

/** 上传页「数据表示例」用的样例数据：三个 ## 元数据行 + 两行数据 */

/** 对齐数数：下拉里的内置属性（不在属性注册表内，固定存在）；显示名按当前语言在 `builtinProps(t)` 里取 */
export const BUILTIN_PROPS: {
  prop_key: string;
  labelKey: string;
  data_type: DatatableDataType;
  targetType: 'event_property' | 'event_name' | 'event_time';
}[] = [
  {
    prop_key: '#account_id',
    labelKey: 'datatable:builtin.accountId',
    data_type: 'string',
    targetType: 'event_property',
  },
  {
    prop_key: '#distinct_id',
    labelKey: 'datatable:builtin.distinctId',
    data_type: 'string',
    targetType: 'event_property',
  },
  {
    prop_key: '#event_name',
    labelKey: 'datatable:builtin.eventName',
    data_type: 'string',
    targetType: 'event_name',
  },
  {
    prop_key: '#event_time',
    labelKey: 'datatable:builtin.eventTime',
    data_type: 'datetime',
    targetType: 'event_time',
  },
  {
    prop_key: '#te_event_id',
    labelKey: 'datatable:builtin.eventTableId',
    data_type: 'string',
    targetType: 'event_property',
  },
];

export interface PropOption {
  prop_key: string;
  label: string;
  data_type: string;
  targetType: 'event_property' | 'event_name' | 'event_time';
}

export function builtinProps(t: TFunction): PropOption[] {
  return BUILTIN_PROPS.map((item) => ({
    prop_key: item.prop_key,
    label: t(item.labelKey),
    data_type: item.data_type as string,
    targetType: item.targetType,
  }));
}
