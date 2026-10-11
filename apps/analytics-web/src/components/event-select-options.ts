import { t as currentT, type TFunction } from '../i18n';
import type { MetaVirtualEvent } from '../types/meta.types';
import type { EventOption } from './EventSelect';

/**
 * 虚拟事件选项。组件调用时传入订阅语言的 `t`；未传的旧调用方（含单测）
 * 走当前语言的一次性取值，行为与迁移前的中文标签一致。
 */
export function virtualEventToOption(ve: MetaVirtualEvent, t: TFunction = currentT): EventOption {
  return {
    value: ve.ve_id,
    label: `${ve.display_name || ve.ve_id}${t('common:eventSelect.virtualSuffix')}`,
  };
}

export function virtualEventMatches(ve: MetaVirtualEvent, keyword?: string): boolean {
  if (ve.status === 'hidden') return false;
  const q = keyword?.trim().toLowerCase();
  if (!q) return true;
  const sources = ve.definition_json?.events ?? [];
  return (
    ve.ve_id.toLowerCase().includes(q) ||
    (ve.display_name ?? '').toLowerCase().includes(q) ||
    (ve.event_key ?? '').toLowerCase().includes(q) ||
    sources.some((eventKey) => eventKey.toLowerCase().includes(q))
  );
}

export function mergeAnalysisEventOptions(
  reported: EventOption[],
  virtuals: MetaVirtualEvent[],
  keyword?: string,
  t: TFunction = currentT,
): EventOption[] {
  const virtualOpts = virtuals
    .filter((ve) => virtualEventMatches(ve, keyword))
    .map((ve) => virtualEventToOption(ve, t));
  const seen = new Set(virtualOpts.map((option) => option.value));
  return [...virtualOpts, ...reported.filter((option) => !seen.has(option.value))];
}
