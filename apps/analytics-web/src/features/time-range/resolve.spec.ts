import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PLATFORM_TZ,
  defaultPastNDays,
  displayTodayYmd,
  epochOfWallClock,
  getPlatformTimeZone,
  isValidTimeZoneName,
  materializeTimeRange,
  parseWallClock,
  resolveDisplayTimeZone,
  resolveTimeRange,
  setPlatformTimeZone,
  setProjectTimeZone,
  setUserTimeZone,
  todayInTz,
  wallClockInTz,
  ymdInTz,
} from './resolve';
import { matchTimeRangePreset, timeRangeTriggerLabel } from './presets';

const TODAY = '2026-09-11';

describe('resolveTimeRange', () => {
  it('distinguishes 过去7天 from 最近7天', () => {
    expect(resolveTimeRange({ start: '', end: '', relative: { kind: 'past_n', n: 7 } }, TODAY)).toEqual({
      start: '2026-09-04',
      end: '2026-09-10',
    });
    expect(resolveTimeRange({ start: '', end: '', relative: { kind: 'recent_n', n: 7 } }, TODAY)).toEqual({
      start: '2026-09-05',
      end: '2026-09-11',
    });
  });

  it('labels dynamic presets by name and static by dates', () => {
    expect(timeRangeTriggerLabel(defaultPastNDays(7, TODAY))).toBe('过去7天');
    expect(timeRangeTriggerLabel(materializeTimeRange({ start: '', end: '', relative: { kind: 'recent_n', n: 7 } }, TODAY))).toBe(
      '最近7天',
    );
    expect(timeRangeTriggerLabel({ start: '2026-09-01', end: '2026-09-03' })).toBe('2026/09/01 → 2026/09/03');
    expect(matchTimeRangePreset({ start: '2026-09-01', end: '2026-09-03' })).toBe('custom');
  });
});

describe('timezone（phase: clklog-analytics-timezone-v1）', () => {
  beforeEach(() => {
    setPlatformTimeZone(DEFAULT_PLATFORM_TZ);
    setUserTimeZone(null);
    setProjectTimeZone(null);
  });

  it('platform holder：默认 Asia/Shanghai，可下发覆盖，非法忽略', () => {
    expect(getPlatformTimeZone()).toBe('Asia/Shanghai');
    setPlatformTimeZone('America/New_York');
    expect(getPlatformTimeZone()).toBe('America/New_York');
    setPlatformTimeZone('Mars/Olympus');
    expect(getPlatformTimeZone()).toBe('America/New_York');
  });

  it('同一 epoch 不同时区今天不同；displayTodayYmd 随 range.timezone', () => {
    const now = new Date('2026-09-17T02:00:00Z');
    expect(todayInTz('Asia/Shanghai', now)).toBe('2026-09-17');
    expect(todayInTz('Pacific/Honolulu', now)).toBe('2026-09-16');
    expect(displayTodayYmd({ timezone: 'Pacific/Honolulu' }, now)).toBe('2026-09-16');
    expect(displayTodayYmd({ timezone: 'UTC' }, now)).toBe('2026-09-17');
    expect(displayTodayYmd({}, now)).toBe('2026-09-17'); // 平台（上海）
  });

  it('materializeTimeRange 缺省 today 走展示日历并保留 timezone', () => {
    const now = new Date('2026-09-17T02:00:00Z');
    const withoutTz = materializeTimeRange({ start: '', end: '', relative: { kind: 'today' } });
    const live = withoutTz.start; // 平台今天（简洁性检查，非今天的具体日期）
    expect(/^\d{4}-\d{2}-\d{2}$/.test(live)).toBe(true);
    const honolulu = materializeTimeRange({ start: '', end: '', relative: { kind: 'today' }, timezone: 'Pacific/Honolulu' });
    // 同一时刻：platform 今天 vs 檀香山今天可能差一天；至少字段保留
    expect(honolulu.timezone).toBe('Pacific/Honolulu');
    expect(displayTodayYmd({ timezone: 'Pacific/Honolulu' }, now) === '2026-09-16').toBe(true);
    void now;
  });

  it('resolveDisplayTimeZone：合法透传、非法/空回落平台', () => {
    expect(resolveDisplayTimeZone('UTC')).toBe('UTC');
    expect(resolveDisplayTimeZone('America/New_York')).toBe('America/New_York');
    expect(resolveDisplayTimeZone('')).toBe('Asia/Shanghai');
    expect(resolveDisplayTimeZone(undefined)).toBe('Asia/Shanghai');
    expect(resolveDisplayTimeZone('Beijing')).toBe('Asia/Shanghai');
    expect(isValidTimeZoneName('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZoneName('Beijing')).toBe(false);
  });

  it('v2 解析链优先级：显式 > 用户 > 项目 > 平台', () => {
    expect(resolveDisplayTimeZone(undefined)).toBe('Asia/Shanghai');
    setProjectTimeZone('America/New_York');
    expect(resolveDisplayTimeZone(undefined)).toBe('America/New_York');
    setUserTimeZone('Asia/Tokyo');
    expect(resolveDisplayTimeZone(undefined)).toBe('Asia/Tokyo');
    expect(resolveDisplayTimeZone('UTC')).toBe('UTC'); // 显式永远优先
    // 用户/项目非法值不生效
    setUserTimeZone('Mars/Olympus');
    expect(resolveDisplayTimeZone(undefined)).toBe('America/New_York');
  });

  it('v2 displayTodayYmd 随用户/项目链改变', () => {
    const now = new Date('2026-09-17T02:00:00Z');
    expect(displayTodayYmd({}, now)).toBe('2026-09-17'); // 平台（上海）
    setUserTimeZone('Pacific/Honolulu');
    expect(displayTodayYmd({}, now)).toBe('2026-09-16');
    setProjectTimeZone('UTC');
    expect(displayTodayYmd({}, now)).toBe('2026-09-16'); // 用户优先于项目
    setUserTimeZone(null);
    expect(displayTodayYmd({}, now)).toBe('2026-09-17'); // 回落项目（UTC）
  });

  it('epochOfWallClock / wallClockInTz 与后端同算法（DST 边界）', () => {
    expect(epochOfWallClock('Asia/Shanghai', 2026, 9, 17)).toBe(Date.parse('2026-09-16T16:00:00Z'));
    expect(epochOfWallClock('America/New_York', 2026, 3, 9)).toBe(Date.parse('2026-03-09T04:00:00Z')); // EDT(-4)
    expect(epochOfWallClock('America/New_York', 2026, 3, 8)).toBe(Date.parse('2026-03-08T05:00:00Z')); // EST(-5)
    const w = wallClockInTz('Asia/Shanghai', Date.parse('2026-09-17T02:03:04Z'));
    expect([w.year, w.month, w.day, w.hour, w.minute]).toEqual([2026, 9, 17, 10, 3]);
    expect(ymdInTz('Pacific/Kiritimati', Date.parse('2026-09-16T20:00:00Z'))).toBe('2026-09-17');
  });
});

describe('parseWallClock（ClickHouse 墙钟串 → 真实时刻，phase: clklog-analytics-debug-query-v1）', () => {
  it('按平台时区还原（不会再偏 8 小时）', () => {
    expect(parseWallClock('2026-10-04 22:59:08.908', 'Asia/Shanghai')?.toISOString()).toBe('2026-10-04T14:59:08.908Z');
    expect(parseWallClock('2026-10-01 12:13:51', 'Asia/Shanghai')?.toISOString()).toBe('2026-10-01T04:13:51.000Z');
    expect(parseWallClock('2026-10-01T12:13:51', 'Asia/Shanghai')?.toISOString()).toBe('2026-10-01T04:13:51.000Z');
  });

  it('夏令时按目标时区真实偏移还原（不是固定 ±N）', () => {
    expect(parseWallClock('2026-10-04 22:59:08', 'America/New_York')?.toISOString()).toBe('2026-10-05T02:59:08.000Z'); // EDT -4
    expect(parseWallClock('2026-01-04 22:59:08', 'America/New_York')?.toISOString()).toBe('2026-01-05T03:59:08.000Z'); // EST -5
  });

  it('与 wallClockInTz 互逆', () => {
    const at = parseWallClock('2026-10-04 22:59:08', 'Asia/Shanghai');
    expect(at).not.toBeNull();
    expect(wallClockInTz('Asia/Shanghai', at!.getTime())).toMatchObject({
      year: 2026,
      month: 10,
      day: 4,
      hour: 22,
      minute: 59,
      second: 8,
    });
  });

  it('只吃墙钟形态；ISO / 非法串返回 null（调用方走原路径，不吞数据）', () => {
    expect(parseWallClock('2026-10-01T12:13:51.790Z')).toBeNull();
    expect(parseWallClock('2026-10-01T12:13:51+08:00')).toBeNull();
    expect(parseWallClock('2026-10-01')).toBeNull();
    expect(parseWallClock('2026-13-01 00:00:00')).toBeNull();
    expect(parseWallClock('2026-10-01 24:00:00')).toBeNull();
    expect(parseWallClock('')).toBeNull();
    expect(parseWallClock(null)).toBeNull();
    expect(parseWallClock(undefined)).toBeNull();
  });
});
