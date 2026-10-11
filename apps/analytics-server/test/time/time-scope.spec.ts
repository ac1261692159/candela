/**
 * 查询窗物化（phase: clklog-analytics-timezone-v1）。
 * 锁定两条路径：恒等路径与历史 SQL 逐字节一致（SC-6）；异时区路径宽扫+epoch 精切。
 */
import {
  bucketExpression,
  bucketParams,
  dateExpression,
  extractExpression,
  timeScopeFilter,
  TimeScopeService,
} from '../../src/modules/time/time-scope';
import { TimezoneService } from '../../src/modules/time/timezone.service';

function makeService(platformTz = 'Asia/Shanghai'): TimeScopeService {
  return new TimeScopeService(new TimezoneService({ platformTz }));
}

const NOW = new Date('2026-09-17T02:00:00Z'); // 上海 10:00 / 纽约前一日 22:00 / 檀香山前一日 16:00

describe('TimeScopeService.materialize', () => {
  it('恒等路径：scan = 起止日，isPlatformCalendar = true', () => {
    const scope = makeService().materialize(
      { start: '2026-09-10', end: '2026-09-16' },
      { now: NOW },
    );
    expect(scope).toMatchObject({
      tz: 'Asia/Shanghai',
      startYmd: '2026-09-10',
      endYmd: '2026-09-16',
      scanStartYmd: '2026-09-10',
      scanEndYmd: '2026-09-16',
      isPlatformCalendar: true,
    });
    expect(scope.startEpochMs).toBe(Date.parse('2026-09-09T16:00:00Z'));
    expect(scope.endEpochMsExclusive).toBe(Date.parse('2026-09-16T16:00:00Z'));
  });

  it('异时区路径：宽扫 ±1 天 + epoch 边界（檀香山今天 ≠ 上海今天）', () => {
    const scope = makeService().materialize(
      { start: '', end: '', relative: { kind: 'today' }, timezone: 'Pacific/Honolulu' },
      { now: NOW },
    );
    expect(scope.tz).toBe('Pacific/Honolulu');
    expect(scope.startYmd).toBe('2026-09-16'); // 檀香山还在 9-16
    expect(scope.scanStartYmd).toBe('2026-09-15');
    expect(scope.scanEndYmd).toBe('2026-09-17');
    expect(scope.isPlatformCalendar).toBe(false);
    expect(scope.startEpochMs).toBe(Date.parse('2026-09-16T10:00:00Z'));
    expect(scope.endEpochMsExclusive).toBe(Date.parse('2026-09-17T10:00:00Z'));
  });

  it('非法 timezone 透传 400', () => {
    expect(() =>
      makeService().materialize({ start: '2026-09-01', end: '2026-09-02', timezone: 'Mars' }, { now: NOW }),
    ).toThrow(/时区不合法/);
  });

  it('平台时区可配置：纽约平台下 relative 按纽约日历解析', () => {
    const scope = makeService('America/New_York').materialize(
      { start: '', end: '', relative: { kind: 'today' } },
      { now: NOW },
    );
    expect(scope.startYmd).toBe('2026-09-16');
    expect(scope.isPlatformCalendar).toBe(true);
    expect(scope.startEpochMs).toBe(Date.parse('2026-09-16T04:00:00Z'));
  });
});

describe('timeScopeFilter（参数化 WHERE）', () => {
  const px = 'ev_';

  it('恒等路径 SQL/参数与旧形态逐字节一致', () => {
    const scope = makeService().materialize({ start: '2026-09-10', end: '2026-09-16' }, { now: NOW });
    const { where, params } = timeScopeFilter(scope, { paramPrefix: px });
    expect(where).toBe('stat_date BETWEEN {ev_start:String} AND {ev_end:String}');
    expect(params).toEqual({ ev_start: '2026-09-10', ev_end: '2026-09-16' });
  });

  it('异时区路径：宽扫 + 双 epoch 边界', () => {
    const scope = makeService().materialize(
      { start: '2026-09-16', end: '2026-09-16', timezone: 'UTC' },
      { now: NOW },
    );
    const { where, params } = timeScopeFilter(scope, { paramPrefix: px });
    expect(where).toBe(
      'stat_date BETWEEN {ev_scan_start:String} AND {ev_scan_end:String}' +
        ' AND log_time >= fromUnixTimestamp64Milli({ev_start_ms:Int64})' +
        ' AND log_time < fromUnixTimestamp64Milli({ev_end_ms:Int64})',
    );
    expect(params).toEqual({
      ev_scan_start: '2026-09-15',
      ev_scan_end: '2026-09-17',
      ev_start_ms: Date.parse('2026-09-16T00:00:00Z'),
      ev_end_ms: Date.parse('2026-09-17T00:00:00Z'),
    });
  });

  it('自定义列名（log_analysis 等场景）', () => {
    const scope = makeService().materialize(
      { start: '2026-09-16', end: '2026-09-16', timezone: 'UTC' },
      { now: NOW },
    );
    const { where } = timeScopeFilter(scope, { paramPrefix: px, statDateColumn: 'c.stat_date', logTimeColumn: 'c.log_time' });
    expect(where).toContain('c.stat_date BETWEEN');
    expect(where).toContain('c.log_time >=');
  });
});

describe('bucket / date / extract 表达式', () => {
  const platformScope = makeService().materialize({ start: '2026-09-10', end: '2026-09-16' }, { now: NOW });
  const utcScope = makeService().materialize({ start: '2026-09-16', end: '2026-09-16', timezone: 'UTC' }, { now: NOW });

  it('恒等路径不带时区参数（与历史 SQL 一致）', () => {
    expect(bucketExpression(platformScope, 'log_time', 'day')).toBe('toStartOfDay(log_time)');
    expect(bucketExpression(platformScope, 'log_time', 'week')).toBe('toMonday(log_time)');
    expect(dateExpression(platformScope, 'log_time')).toBe('toDate(log_time)');
    expect(extractExpression(platformScope, 'toHour', 'log_time')).toBe('toHour(log_time)');
    expect(bucketParams(platformScope)).toEqual({});
  });

  it('异时区路径带 display_tz 参数', () => {
    expect(bucketExpression(utcScope, 'log_time', 'day')).toBe('toStartOfDay(log_time, {display_tz:String})');
    expect(bucketExpression(utcScope, 'log_time', 'month')).toBe('toStartOfMonth(log_time, {display_tz:String})');
    expect(dateExpression(utcScope, 'log_time')).toBe('toDate(log_time, {display_tz:String})');
    expect(extractExpression(utcScope, 'toHour', 'log_time')).toBe('toHour(log_time, {display_tz:String})');
    expect(bucketParams(utcScope)).toEqual({ display_tz: 'UTC' });
  });

  it('周口径恒为 toMonday（不出现 toStartOfWeek）', () => {
    expect(bucketExpression(utcScope, 'log_time', 'week')).toContain('toMonday');
    expect(bucketExpression(platformScope, 'log_time', 'week')).toContain('toMonday');
  });
});
