/**
 * 时区日历（phase: clklog-analytics-timezone-v1）。
 * 矩阵口径：同一 epoch 在不同时区的日历日、日界 epoch、DST 边界往返。
 * 本文件断言与进程时区无关（不读本地分量），在 TZ=UTC / TZ=Pacific/Auckland 下均须通过。
 */
import {
  addCalendarDays,
  calendarDaysInclusive,
  epochOfDayEndExclusive,
  epochOfDayStart,
  isValidTimeZoneName,
  materializeTimeRange,
  mondayOnOrBefore,
  resolveTimeRange,
  todayInTz,
  ymdInTz,
} from '../../src/modules/time/calendar';

const SHANGHAI = 'Asia/Shanghai';

describe('isValidTimeZoneName', () => {
  it('接受 IANA 名与 UTC/GMT', () => {
    for (const tz of ['Asia/Shanghai', 'UTC', 'GMT', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Honolulu', 'Etc/UTC']) {
      expect(isValidTimeZoneName(tz)).toBe(true);
    }
  });

  it('拒绝伪造/危险名', () => {
    for (const tz of ['', 'Beijing', 'Factory', 'Local', 'Asia/Shanghai/..', 'Asia Shanghai', `Asia/${'x'.repeat(80)}`]) {
      expect(isValidTimeZoneName(tz)).toBe(false);
    }
  });
});

describe('todayInTz / ymdInTz（同一 epoch 多时区）', () => {
  const epoch = new Date('2026-09-17T02:00:00Z');

  it('同一时刻不同时区可落在不同日历日', () => {
    expect(todayInTz(SHANGHAI, epoch)).toBe('2026-09-17');
    expect(todayInTz('UTC', epoch)).toBe('2026-09-17');
    expect(todayInTz('Pacific/Honolulu', epoch)).toBe('2026-09-16');
    expect(todayInTz('Pacific/Kiritimati', epoch)).toBe('2026-09-17');
    expect(todayInTz('America/New_York', epoch)).toBe('2026-09-16');
  });

  it('ymdInTz 与 todayInTz 同源', () => {
    expect(ymdInTz(SHANGHAI, epoch.getTime())).toBe('2026-09-17');
    expect(ymdInTz('Pacific/Honolulu', epoch)).toBe('2026-09-16');
  });
});

describe('epochOfDayStart', () => {
  it('各时区日界 epoch 精确', () => {
    expect(epochOfDayStart(SHANGHAI, '2026-09-17')).toBe(Date.parse('2026-09-16T16:00:00Z'));
    expect(epochOfDayStart('UTC', '2026-09-17')).toBe(Date.parse('2026-09-17T00:00:00Z'));
    expect(epochOfDayStart('Pacific/Honolulu', '2026-09-17')).toBe(Date.parse('2026-09-17T10:00:00Z'));
    expect(epochOfDayStart('Pacific/Kiritimati', '2026-09-17')).toBe(Date.parse('2026-09-16T10:00:00Z'));
  });

  it('纽约 DST 边界（2026-03-08 切夏令时 / 2026-11-01 切回）', () => {
    expect(epochOfDayStart('America/New_York', '2026-03-08')).toBe(Date.parse('2026-03-08T05:00:00Z')); // EST(-5)
    expect(epochOfDayStart('America/New_York', '2026-03-09')).toBe(Date.parse('2026-03-09T04:00:00Z')); // EDT(-4)
    expect(epochOfDayStart('America/New_York', '2026-11-01')).toBe(Date.parse('2026-11-01T04:00:00Z')); // EDT(-4)
    expect(epochOfDayStart('America/New_York', '2026-11-02')).toBe(Date.parse('2026-11-02T05:00:00Z')); // EST(-5)
  });

  it('往返一致：epochOfDayStart 后 ymdInTz 还原；endExclusive 跨日', () => {
    const tzs = [SHANGHAI, 'UTC', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Honolulu'];
    const dates = ['2026-01-01', '2026-03-08', '2026-09-17', '2026-11-02', '2026-12-31'];
    for (const tz of tzs) {
      for (const ymd of dates) {
        expect(ymdInTz(tz, epochOfDayStart(tz, ymd))).toBe(ymd);
        expect(ymdInTz(tz, epochOfDayEndExclusive(tz, ymd))).toBe(addCalendarDays(ymd, 1));
      }
    }
  });
});

describe('日历运算（时区无关分量）', () => {
  it('周一/月末/天数', () => {
    expect(mondayOnOrBefore('2026-09-17')).toBe('2026-09-14'); // 周四
    expect(mondayOnOrBefore('2026-09-14')).toBe('2026-09-14'); // 周一当天
    expect(mondayOnOrBefore('2026-09-20')).toBe('2026-09-14'); // 周日归本周
    expect(calendarDaysInclusive('2026-09-01', '2026-09-07')).toBe(7);
    expect(addCalendarDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('resolveTimeRange / materializeTimeRange（时区只经 today 注入）', () => {
  it('past_n / recent_n 锚定传入的今天', () => {
    expect(resolveTimeRange({ start: '', end: '', relative: { kind: 'past_n', n: 7 } }, '2026-09-17'))
      .toEqual({ start: '2026-09-10', end: '2026-09-16' });
    expect(resolveTimeRange({ start: '', end: '', relative: { kind: 'recent_n', n: 7 } }, '2026-09-17'))
      .toEqual({ start: '2026-09-11', end: '2026-09-17' });
  });

  it('静态范围原样返回；非法校验', () => {
    expect(resolveTimeRange({ start: '2026-09-01', end: '2026-09-02' }, '2026-09-17'))
      .toEqual({ start: '2026-09-01', end: '2026-09-02' });
    expect(() => resolveTimeRange({ start: '2026-09-03', end: '2026-09-02' }, '2026-09-17')).toThrow('结束早于开始');
    expect(() => resolveTimeRange({ start: '', end: '' }, '2026-09-17')).toThrow('必填');
  });

  it('materialize 保留 relative 与 timezone 字段', () => {
    const live = materializeTimeRange(
      { start: '', end: '', relative: { kind: 'today' }, timezone: 'UTC' },
      '2026-09-17',
    );
    expect(live).toEqual({ start: '2026-09-17', end: '2026-09-17', relative: { kind: 'today' }, timezone: 'UTC' });
  });
});
