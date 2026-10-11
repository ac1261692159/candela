import type { TimeRange } from '../../types/dsl.types';
import { defaultPastNDays } from '../time-range/resolve';

export function lastNDaysRange(days: number): TimeRange {
  return defaultPastNDays(days);
}

export function pickExampleEvents(events: { event_key: string; status?: string }[]): {
  first: string;
  second: string;
} {
  const keys = events
    .filter((item) => item.status !== 'hidden')
    .map((item) => item.event_key)
    .filter(Boolean);
  const preferred = ['$pageview', '$AppStart', 'AppLaunch', '$AppViewScreen', 'page_view'];
  const first = preferred.find((key) => keys.includes(key)) ?? keys[0] ?? '';
  const second = keys.find((key) => key !== first) ?? first;
  return { first, second };
}
