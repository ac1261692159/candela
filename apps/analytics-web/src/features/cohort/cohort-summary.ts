import { ANY_EVENT } from '../../types/dsl.types';
import type { TFunction } from '../../i18n';
import type { UserCohort } from '../../services/cohort.service';
import type { CohortCondition, CohortTime } from './cohort-condition';

/**
 * 列表「圈人规则」摘要：把 `definition_json` 渲染成一句人话。
 *
 * 渲染发生在**浏览器端**：接口只下发结构化定义，翻译不进载荷
 * （`AGENTS.md` G21/G25——服务端不下发译好的展示名）。
 * 事件名、属性名是用户自己起的标识，取不到显示名就原样显示，不翻译。
 */
export interface CohortSummaryLookups {
  eventLabel?: (key: string) => string | undefined;
  propLabel?: (key: string) => string | undefined;
}

export type CohortSummaryInput = Pick<UserCohort, 'kind' | 'definition_json'>;

const OP_KEY: Record<string, string> = {
  gt: 'cohort:condition.op.gt',
  gte: 'cohort:condition.op.gte',
  lt: 'cohort:condition.op.lt',
  lte: 'cohort:condition.op.lte',
  eq: 'cohort:condition.op.eq',
  '=': 'cohort:condition.op.eq',
  '!=': 'cohort:condition.op.ne',
  in: 'cohort:condition.op.in',
  not_in: 'cohort:condition.op.notIn',
  contains: 'cohort:condition.op.contains',
  not_contains: 'cohort:condition.op.notContains',
  regex: 'cohort:condition.op.regex',
  not_regex: 'cohort:condition.op.notRegex',
  is_set: 'cohort:condition.op.isSet',
  not_set: 'cohort:condition.op.notSet',
};

/** 结果分群的来源分析（复用侧栏菜单里已有的三处译名） */
const SOURCE_KEY: Record<string, string> = {
  event: 'shell:menu.event',
  funnel: 'shell:menu.funnel',
  retention: 'shell:menu.retention',
};

function opText(op: unknown, t: TFunction): string {
  const key = typeof op === 'string' ? OP_KEY[op] : undefined;
  return key ? t(key) : String(op ?? '');
}

function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (value === undefined || value === null) return '';
  return String(value);
}

function eventText(event: string, t: TFunction, lookups: CohortSummaryLookups): string {
  if (event === ANY_EVENT) return t('common:eventSelect.anyEvent');
  return lookups.eventLabel?.(event) || event;
}

function propText(prop: string, lookups: CohortSummaryLookups): string {
  return lookups.propLabel?.(prop) || prop;
}

function timeText(time: CohortTime | undefined, t: TFunction): string {
  if (!time) return '';
  if (time.mode === 'last_n_days') return t('cohort:summary.windowLastN', { n: time.n });
  return t('cohort:summary.windowStatic', { start: time.start, end: time.end });
}

function conditionText(condition: CohortCondition, t: TFunction, lookups: CohortSummaryLookups): string {
  if (condition.type === 'did_event') {
    const window = timeText(condition.time, t);
    const event = eventText(condition.event, t, lookups);
    if (condition.polarity === 'did_not') {
      return t('cohort:summary.didNotEvent', { window, event, polarity: t('cohort:condition.didNot') });
    }
    return t('cohort:summary.didEvent', {
      window,
      polarity: t('cohort:condition.did'),
      event,
      op: opText(condition.op, t),
      value: condition.value,
    });
  }
  if (condition.type === 'sequence') {
    const window = timeText(condition.time, t);
    const events = condition.events.map((event) => eventText(event, t, lookups)).join(' → ');
    return condition.polarity === 'did_not'
      ? t('cohort:summary.sequenceDidNot', {
          window,
          events,
          polarity: t('cohort:condition.sequenceDidNot'),
        })
      : t('cohort:summary.sequence', { window, events, polarity: t('cohort:condition.sequenceDid') });
  }
  return t('cohort:summary.userProp', {
    prop: propText(condition.prop, lookups),
    op: opText(condition.op, t),
    value: valueText(condition.value),
  });
}

export function cohortSummary(
  item: CohortSummaryInput,
  t: TFunction,
  lookups: CohortSummaryLookups = {},
): string {
  if (item.kind === 'id_upload') return t('cohort:summary.idUpload');
  if (item.kind === 'sql') return t('cohort:summary.sql');
  if (item.kind === 'result') {
    const source = String((item.definition_json as { source?: unknown })?.source ?? '');
    const sourceKey = SOURCE_KEY[source];
    return sourceKey
      ? t('cohort:summary.result', { source: t(sourceKey) })
      : t('cohort:summary.resultUnknown');
  }
  const conditions = (item.definition_json as { conditions?: CohortCondition[] })?.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0) return t('cohort:summary.empty');
  return conditions
    .map((condition) => conditionText(condition, t, lookups))
    .join(t('cohort:summary.and'));
}
