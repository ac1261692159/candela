import { t as currentT, type TFunction } from '../i18n';
import type { MetaEventProperty, MetaVirtualProperty } from '../types/meta.types';

export type EventPropertyOption = {
  prop_key: string;
  display_name?: string;
  data_type?: string;
};

function withSourceSuffix(name: string, source: string): string {
  const ascii = ` (${source})`;
  const wide = `（${source}）`;
  if (name.includes(ascii) || name.includes(wide)) return name;
  return `${name}${ascii}`;
}

/**
 * 维表字段选项。组件调用时传入订阅语言的 `t`；未传的旧调用方（含单测）
 * 走当前语言的一次性取值，行为与迁移前的中文标签一致。
 */
export function labeledDatatableProperties(
  extras?: EventPropertyOption[],
  t: TFunction = currentT,
): EventPropertyOption[] {
  return (extras ?? []).map((prop) => ({
    ...prop,
    display_name: withSourceSuffix(prop.display_name || prop.prop_key, t('common:eventProperty.datatableSource')),
  }));
}

/** 分组下拉：`goods_id@商品名称`（绑定属性 + 维表字段显示名） */
export function datatableGroupOptionLabel(propKey: string, displayName?: string): string {
  const at = propKey.indexOf('@');
  if (at < 0) return displayName?.trim() || propKey;
  const left = propKey.slice(0, at);
  const right = displayName?.trim() || propKey.slice(at + 1);
  return `${left}@${right}`;
}

export function isDatatableDimensionKey(prop?: string): boolean {
  return !!prop && prop.includes('@');
}

export function labeledEventProperties(
  pack?: {
    event: MetaEventProperty[];
    virtual: MetaVirtualProperty[];
  },
  datatable?: EventPropertyOption[],
  t: TFunction = currentT,
): EventPropertyOption[] {
  const virtualSuffix = t('common:eventProperty.virtualSuffix');
  const rows: EventPropertyOption[] = pack
    ? [
        ...pack.event,
        ...pack.virtual.map((vp) => ({
          prop_key: vp.prop_key,
          display_name: vp.display_name ? `${vp.display_name}${virtualSuffix}` : `${vp.prop_key}${virtualSuffix}`,
          data_type: vp.data_type,
        })),
      ]
    : [];
  const seen = new Set(rows.map((row) => row.prop_key));
  for (const prop of labeledDatatableProperties(datatable, t)) {
    if (seen.has(prop.prop_key)) continue;
    seen.add(prop.prop_key);
    rows.push(prop);
  }
  return rows;
}
