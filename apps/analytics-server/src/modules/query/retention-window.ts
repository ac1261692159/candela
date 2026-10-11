export type RetentionGranularity = 'day' | 'week' | 'month';

export function asRetentionGranularity(value: string | undefined): RetentionGranularity {
  return value === 'week' || value === 'month' ? value : 'day';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function utcYmd(year: number, monthIndex: number, day: number): string {
  const utc = new Date(Date.UTC(year, monthIndex, day));
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

/** 按日历加 N 个日/周/月，用 UTC 日期分量避免服务器时区把「今天」算错。 */
export function addRetentionPeriods(
  cohortYmd: string,
  n: number,
  granularity: RetentionGranularity,
): string {
  const [year, month, day] = cohortYmd.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return cohortYmd.slice(0, 10);
  if (granularity === 'week') return utcYmd(year, month - 1, day + n * 7);
  if (granularity === 'month') return utcYmd(year, month - 1 + n, day);
  return utcYmd(year, month - 1, day + n);
}

/** 观察日（入组日 + N）晚于 today 则窗口未到期。 */
export function isRetentionWindowImmature(
  cohortYmd: string,
  n: number,
  granularity: RetentionGranularity,
  todayYmd: string,
): boolean {
  return addRetentionPeriods(cohortYmd, n, granularity) > todayYmd;
}

export function maskImmatureRetentionRow(
  row: Record<string, unknown>,
  nList: number[],
  granularity: RetentionGranularity,
  todayYmd: string,
): Record<string, unknown> {
  const cohort = String(row.cohort_date ?? '').slice(0, 10);
  const next = { ...row };
  for (const n of nList) {
    if (!isRetentionWindowImmature(cohort, n, granularity, todayYmd)) continue;
    next[`n_${n}`] = null;
    next[`n_${n}_rate`] = null;
  }
  return next;
}
