import { type TFunction } from '../../i18n';

export type CohortTime =
  | { mode: 'last_n_days'; n: number }
  | { mode: 'static'; start: string; end: string };

export type CohortCondition =
  | {
      type: 'did_event';
      polarity: 'did' | 'did_not';
      event: string;
      metric: 'times';
      op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
      value: number;
      time: CohortTime;
    }
  | {
      type: 'sequence';
      polarity: 'did' | 'did_not';
      events: string[];
      time: CohortTime;
    }
  | {
      type: 'user_prop';
      prop: string;
      op: string;
      value?: unknown;
    };

export function defaultDidEvent(): CohortCondition {
  return {
    type: 'did_event',
    polarity: 'did',
    event: '',
    metric: 'times',
    op: 'gt',
    value: 0,
    time: { mode: 'last_n_days', n: 7 },
  };
}

export function defaultSequence(): CohortCondition {
  return {
    type: 'sequence',
    polarity: 'did',
    events: ['', ''],
    time: { mode: 'last_n_days', n: 7 },
  };
}

export function defaultUserProp(): CohortCondition {
  return { type: 'user_prop', prop: '', op: '=', value: '' };
}

export function stampNames(t: TFunction) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return { display_name: t('cohort:defaultName.cohort', { stamp }), name: `cohort_${stamp}` };
}
