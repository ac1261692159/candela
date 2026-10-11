import type { EventAnalysisFormState, FunnelFormState, RetentionFormState } from '../../utils/dsl-builder';
import { asEditorGroups } from '../../utils/dsl-builder';
import type { EventAnalysisQuery, FunnelQuery, RetentionQuery, FilterGroup } from '../../types/dsl.types';
import { t } from '../../i18n';

const empty = (): FilterGroup => ({ logic: 'and', items: [] });
function keys(dsl: Record<string, unknown>, allowed: string[]) {
  const unsupported = Object.keys(dsl).filter((key) => !allowed.includes(key) && !['project', 'project_name'].includes(key));
  if (unsupported.length) {
    throw new Error(t('ai:analysis.unsupportedFields', {
      fields: unsupported.join(t('ai:label.listSeparator')),
    }));
  }
}

export function eventForm(dsl: Record<string, unknown>): EventAnalysisFormState {
  keys(dsl, ['event', 'metrics', 'filters', 'groups', 'time_range', 'subject_id', 'approx']);
  const q = dsl as unknown as EventAnalysisQuery;
  if (!q.metrics?.length || !q.time_range?.start || !q.time_range?.end) throw new Error(t('ai:analysis.eventMissing'));
  return { event: q.event, metrics: q.metrics, filters: q.filters ?? empty(), groups: asEditorGroups(q.groups ?? []), timeRange: q.time_range, subjectId: q.subject_id, approx: q.approx === true ? true : undefined };
}

export function funnelForm(dsl: Record<string, unknown>): FunnelFormState {
  keys(dsl, ['steps', 'filters', 'groups', 'window_seconds', 'time_range', 'subject_id', 'limit_window_in_range', 'granularity']);
  const q = dsl as unknown as FunnelQuery;
  if (q.groups && q.groups.length > 1) throw new Error(t('ai:analysis.funnelOneGroup'));
  if (dsl.granularity && dsl.granularity !== 'total') throw new Error(t('ai:analysis.funnelGranularity'));
  if (!q.steps?.length || !q.time_range?.start || !Number.isFinite(q.window_seconds)
    || q.window_seconds < 86400 || q.window_seconds % 86400 !== 0) throw new Error(t('ai:analysis.funnelIncomplete'));
  return { steps: q.steps, timeRange: q.time_range, windowDays: q.window_seconds / 86400,
    filters: q.filters ?? empty(), group: q.groups?.[0] ? asEditorGroups([q.groups[0]])[0] : undefined, subjectId: q.subject_id, limitWindowInRange: q.limit_window_in_range };
}

export function retentionForm(dsl: Record<string, unknown>): RetentionFormState {
  keys(dsl, ['start_event', 'retain_event', 'cohort', 'granularity', 'n_list', 'time_range', 'filters', 'groups', 'subject_id']);
  const q = dsl as unknown as RetentionQuery;
  const group = q.groups?.[0];
  if ((q.groups?.length ?? 0) > 1 || (group && !['tag', 'cohort'].includes(group.scope))) {
    throw new Error(t('ai:analysis.retentionOneGroup'));
  }
  if (!q.start_event?.event || !q.retain_event?.event || !q.time_range?.start || !q.n_list?.length) throw new Error(t('ai:analysis.retentionIncomplete'));
  return { startEvent: q.start_event.event, returnEvent: q.retain_event.event,
    startFilters: q.start_event.filters ?? empty(), returnFilters: q.retain_event.filters ?? empty(),
    filters: q.filters ?? empty(), cohort: q.cohort, granularity: q.granularity,
    nList: q.n_list, timeRange: q.time_range, subjectId: q.subject_id,
    groupCohortId: group?.scope === 'cohort' ? group.prop : undefined,
    groupTagId: group?.scope === 'tag' ? group.prop : undefined };
}
