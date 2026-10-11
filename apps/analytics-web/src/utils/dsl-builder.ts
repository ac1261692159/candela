import type {
  EventAnalysisQuery,
  FunnelQuery,
  RetentionQuery,
  MetricItem,
  FilterGroup,
  GroupItem,
  TimeRange,
} from '../types/dsl.types';
import { MAX_EVENT_METRICS, MAX_FUNNEL_STEPS, MIN_FUNNEL_STEPS } from '../types/dsl.types';
import { materializeTimeRange } from '../features/time-range/resolve';
import { t } from '../i18n';

function liveTimeRange(range?: TimeRange): TimeRange {
  if (!range || (!range.start && !range.end && !range.relative)) {
    throw new Error(t('errors:validation.selectTimeRange'));
  }
  return materializeTimeRange(range);
}

export interface EventAnalysisFormState {
  /** 旧卡片快照可能有；查询以 metrics[].event 为准 */
  event?: string;
  metrics: MetricItem[];
  filters: FilterGroup;
  groups: GroupItem[];
  timeRange: TimeRange;
  subjectId?: string;
  approx?: boolean;
}

function mapLegacyMetric(item: MetricItem): MetricItem {
  if (item.kind === 'formula') return { ...item, kind: 'formula' };
  if (item.analysis) return { ...item, kind: 'event' };
  if (item.type === 'uniq_user') return { ...item, kind: 'event', analysis: 'trig_user_num' };
  if (item.type === 'per_user') {
    return {
      ...item,
      kind: 'event',
      analysis: item.func === 'uniq_user' ? 'trig_user_num' : 'per_capita_times',
    };
  }
  if (item.type === 'agg') {
    const func = item.func;
    if (func === 'uniq') return { ...item, kind: 'event', analysis: 'distinct' };
    if (func === 'p50') return { ...item, kind: 'event', analysis: 'percentile', percentile: 50 };
    if (func === 'p90') return { ...item, kind: 'event', analysis: 'percentile', percentile: 90 };
    if (func === 'p99') return { ...item, kind: 'event', analysis: 'percentile', percentile: 99 };
    if (func === 'sum' || func === 'avg' || func === 'max' || func === 'min') {
      return { ...item, kind: 'event', analysis: func };
    }
  }
  return { ...item, kind: 'event', analysis: 'total_times' };
}

/** 指标稳定 ID：创建后不随位置变化，公式引用不受增删/排序影响 */
export function newMetricId(prefix = 'm'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function hydrateEventForm(form: EventAnalysisFormState): EventAnalysisFormState {
  const mapped = form.metrics.map(mapLegacyMetric);
  const fallback = mapped.find((item) => item.event && item.kind !== 'formula')?.event || form.event?.trim() || '';
  const metrics = mapped.map((item) =>
    item.kind === 'formula' ? item : { ...item, event: item.event || fallback },
  );
  return {
    ...form,
    metrics,
    event: metrics.find((m) => m.kind !== 'formula')?.event || fallback,
    groups: asEditorGroups(form.groups),
  };
}

export function buildEventQuery(
  form: EventAnalysisFormState,
  projectName?: string,
): EventAnalysisQuery {
  const hydrated = hydrateEventForm(form);
  if (!hydrated.metrics || hydrated.metrics.length === 0) {
    throw new Error(t('errors:validation.atLeastOneMetric'));
  }
  if (hydrated.metrics.length > MAX_EVENT_METRICS) {
    throw new Error(t('errors:validation.tooManyMetrics', { max: MAX_EVENT_METRICS }));
  }
  const eventMetrics = hydrated.metrics.filter((item) => item.kind !== 'formula');
  if (eventMetrics.length === 0) {
    throw new Error(t('errors:validation.atLeastOneEventMetric'));
  }
  if (eventMetrics.some((item) => !item.event)) {
    throw new Error(t('errors:validation.metricEventRequired'));
  }
  if (eventMetrics.some((item) => item.analysis === 'per_capita_num' && !item.prop)) {
    throw new Error(t('errors:validation.perCapitaNeedsNumber'));
  }
  const timeRange = liveTimeRange(hydrated.timeRange);
  const minute = hydrated.groups?.some((g) => g.scope === 'time' && g.granularity === 'minute');
  if (minute) {
    const start = Date.parse(`${timeRange.start}T00:00:00Z`);
    const end = Date.parse(`${timeRange.end}T00:00:00Z`);
    if (Math.floor((end - start) / 86400000) + 1 > 1) {
      throw new Error(t('errors:validation.minuteSpanTooLong'));
    }
  }

  const filters = sanitizeFilterGroup(hydrated.filters);

  return {
    event: eventMetrics[0].event as string,
    metrics: hydrated.metrics,
    filters,
    groups: asApiGroups(hydrated.groups),
    time_range: timeRange,
    project_name: projectName,
    subject_id: hydrated.subjectId,
    ...(hydrated.approx ? { approx: true } : {}),
  };
}

function sanitizeFilterGroup(group?: FilterGroup): FilterGroup | undefined {
  if (!group) return undefined;
  const items = group.items
    .map((item) => {
      if ('logic' in item) {
        const inner = sanitizeFilterGroup(item as FilterGroup);
        return inner && inner.items.length > 0 ? inner : null;
      }
      const it = item as { prop?: string };
      return it.prop ? item : null;
    })
    .filter(Boolean) as FilterGroup['items'];
  return items.length > 0 ? { ...group, items } : undefined;
}

export interface FunnelFormState {
  steps: { event: string; alias?: string; filters?: FilterGroup }[];
  timeRange: TimeRange;
  windowDays: number;
  filters: FilterGroup;
  group?: GroupItem;
  limitWindowInRange?: boolean;
  subjectId?: string;
}

export function buildFunnelQuery(
  form: FunnelFormState,
  projectName?: string,
): FunnelQuery {
  if (!form.steps || form.steps.length < MIN_FUNNEL_STEPS) {
    throw new Error(t('errors:validation.funnelMinSteps', { min: MIN_FUNNEL_STEPS }));
  }
  if (form.steps.length > MAX_FUNNEL_STEPS) {
    throw new Error(t('errors:validation.funnelMaxSteps', { max: MAX_FUNNEL_STEPS }));
  }
  return {
    steps: form.steps.map((s) => ({
      event: s.event,
      alias: s.alias,
      filters: sanitizeFilterGroup(s.filters),
    })),
    time_range: liveTimeRange(form.timeRange),
    window_seconds: form.windowDays * 24 * 60 * 60,
    filters: sanitizeFilterGroup(form.filters),
    groups: form.group ? asApiGroups([form.group]) : undefined,
    limit_window_in_range: form.limitWindowInRange,
    project_name: projectName,
    subject_id: form.subjectId,
  };
}

export interface RetentionFormState {
  startEvent: string;
  returnEvent: string;
  startFilters: FilterGroup;
  returnFilters: FilterGroup;
  filters?: FilterGroup;
  groupCohortId?: string;
  groupTagId?: string;
  cohort: 'first_day' | 'all';
  granularity: 'day' | 'week' | 'month';
  nList: number[];
  timeRange: TimeRange;
  subjectId?: string;
}

export function buildRetentionQuery(
  form: RetentionFormState,
  projectName?: string,
): RetentionQuery {
  if (!form.startEvent) throw new Error(t('errors:validation.startEventRequired'));
  if (!form.returnEvent) throw new Error(t('errors:validation.returnEventRequired'));
  const timeRange = liveTimeRange(form.timeRange);
  if (!form.nList?.length) throw new Error(t('errors:validation.retentionPeriodRequired'));
  return {
    start_event: { event: form.startEvent, filters: sanitizeFilterGroup(form.startFilters) },
    retain_event: { event: form.returnEvent, filters: sanitizeFilterGroup(form.returnFilters) },
    cohort: form.cohort,
    granularity: form.granularity,
    n_list: [...form.nList].sort((a, b) => a - b),
    time_range: timeRange,
    filters: sanitizeFilterGroup(form.filters),
    groups: form.groupTagId
      ? [{ scope: 'tag' as const, prop: form.groupTagId }]
      : form.groupCohortId
        ? [{ scope: 'cohort' as const, prop: form.groupCohortId }]
        : undefined,
    project_name: projectName,
    subject_id: form.subjectId,
  };
}

/** 编辑器把维表分组显示为独立 scope；提交 DSL 时仍走 event（后端只认 @ 属性名） */
export function asEditorGroups(groups?: GroupItem[]): GroupItem[] {
  return (groups ?? []).map((group) =>
    group.scope === 'event' && group.prop?.includes('@')
      ? { ...group, scope: 'dimension' }
      : group,
  );
}

export function asApiGroups(groups?: GroupItem[]): GroupItem[] | undefined {
  if (!groups?.length) return groups;
  return groups.map((group) =>
    group.scope === 'dimension' ? { ...group, scope: 'event' as const } : group,
  );
}
