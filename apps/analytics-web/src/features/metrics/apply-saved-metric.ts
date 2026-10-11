import type { FilterGroup, MetricItem } from '../../types/dsl.types';
import type { SavedMetric } from '../../types/meta.types';
import type { RetentionFormState } from '../../utils/dsl-builder';

const emptyFilters = (): FilterGroup => ({ logic: 'and', items: [] });

function asFilters(raw: unknown): FilterGroup {
  if (raw && typeof raw === 'object' && 'logic' in raw && 'items' in raw) {
    return raw as FilterGroup;
  }
  return emptyFilters();
}

export function metricFromSavedEvent(saved: SavedMetric, newId: string): MetricItem | null {
  if (saved.kind !== 'event') return null;
  const raw = saved.definition_json;
  const metric = (raw.metric && typeof raw.metric === 'object' ? raw.metric : raw) as MetricItem;
  if (!metric || metric.kind === 'formula') return null;
  return {
    ...metric,
    id: newId,
    kind: 'event',
    alias: saved.display_name || metric.alias,
    filters: metric.filters ? asFilters(metric.filters) : undefined,
  };
}

export function appendEventMetric(existing: MetricItem[], incoming: MetricItem): MetricItem[] {
  if (existing.length === 1 && existing[0].kind !== 'formula' && !existing[0].event) {
    return [{ ...incoming, id: existing[0].id }];
  }
  return [...existing, incoming];
}

export function applyRetentionDefinition(
  form: RetentionFormState,
  saved: SavedMetric,
): RetentionFormState | null {
  if (saved.kind !== 'retention') return null;
  const def = saved.definition_json;
  const start = (def.start_event ?? def.startEvent) as { event?: string; filters?: unknown } | undefined;
  const retain = (def.retain_event ?? def.retainEvent ?? def.return_event) as
    | { event?: string; filters?: unknown }
    | undefined;
  const startEvent = typeof start?.event === 'string' ? start.event : '';
  const returnEvent = typeof retain?.event === 'string' ? retain.event : '';
  if (!startEvent || !returnEvent) return null;
  const n = Number(def.n);
  const nList = Number.isInteger(n) && n >= 1 ? [...new Set([...form.nList, n])].sort((a, b) => a - b) : form.nList;
  return {
    ...form,
    startEvent,
    returnEvent,
    startFilters: asFilters(start?.filters),
    returnFilters: asFilters(retain?.filters),
    cohort: def.cohort === 'first_day' ? 'first_day' : 'all',
    granularity: def.granularity === 'week' || def.granularity === 'month' ? def.granularity : 'day',
    nList,
  };
}
