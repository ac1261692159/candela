/**
 * 查询口径时区化：三个 SQL 生成器的恒等/异时区双路径锁定
 * （phase: clklog-analytics-timezone-v1，PRD SC-5/SC-6）。
 */
import { EventSqlGeneratorService } from '../../src/modules/query/event-sql-generator.service';
import { FunnelSqlGeneratorService } from '../../src/modules/query/funnel-sql-generator.service';
import { RetentionSqlGeneratorService } from '../../src/modules/query/retention-sql-generator.service';
import { TimeScopeService } from '../../src/modules/time/time-scope';
import { TimezoneService } from '../../src/modules/time/timezone.service';

const STRICT_SCOPE = new TimeScopeService(new TimezoneService({ platformTz: 'Asia/Shanghai' }));

function eventGenerator() {
  return new EventSqlGeneratorService(
    { inferDataType: async () => 'string', resolve: async () => 'properties' } as never,
    { findDefinition: async () => null } as never,
    {} as never,
    {} as never,
    { resolve: async () => ({ kind: 'preset' }) } as never,
    STRICT_SCOPE,
  );
}

function funnelGenerator() {
  return new FunnelSqlGeneratorService(
    { inferDataType: async () => 'string', resolve: async () => 'properties' } as never,
    { findDefinition: async () => null } as never,
    {} as never,
    {} as never,
    { resolve: async () => ({ kind: 'preset' }) } as never,
    STRICT_SCOPE,
  );
}

function retentionGenerator() {
  return new RetentionSqlGeneratorService(
    { inferDataType: async () => 'string', resolve: async () => 'properties' } as never,
    { findDefinition: async () => null } as never,
    {} as never,
    {} as never,
    { resolve: async () => ({ kind: 'preset' }) } as never,
    STRICT_SCOPE,
  );
}

describe('事件分析生成器 · 时区双路径', () => {
  const baseQuery = {
    project: 'clklogapp',
    event: 'Pay',
    metrics: [{ id: 'm_0', event: 'Pay', kind: 'event' as const, analysis: 'total_times' as const }],
    groups: [{ scope: 'time' as const, granularity: 'day' as const }],
  };

  it('恒等路径（无 timezone）：SQL/参数与历史逐字节一致，无 display_tz', async () => {
    const result = await eventGenerator().generate({
      ...baseQuery,
      time_range: { start: '2026-09-10', end: '2026-09-16' },
    });
    expect(result.sql).toContain('stat_date BETWEEN {m0_start:String} AND {m0_end:String}');
    expect(result.sql).toContain('toStartOfDay(log_time)');
    expect(result.sql).not.toContain('display_tz');
    expect(result.sql).not.toContain('fromUnixTimestamp64Milli');
    expect(result.params.m0_start).toBe('2026-09-10');
    expect(result.params.m0_end).toBe('2026-09-16');
  });

  it('异时区路径（UTC）：宽扫 ±1 天 + epoch 精切 + 桶带时区参数', async () => {
    const result = await eventGenerator().generate({
      ...baseQuery,
      time_range: { start: '2026-09-16', end: '2026-09-16', timezone: 'UTC' },
    });
    expect(result.sql).toContain('stat_date BETWEEN {m0_scan_start:String} AND {m0_scan_end:String}');
    expect(result.sql).toContain('log_time >= fromUnixTimestamp64Milli({m0_start_ms:Int64})');
    expect(result.sql).toContain('log_time < fromUnixTimestamp64Milli({m0_end_ms:Int64})');
    expect(result.sql).toContain('toStartOfDay(log_time, {display_tz:String})');
    expect(result.params).toMatchObject({
      m0_scan_start: '2026-09-15',
      m0_scan_end: '2026-09-17',
      m0_start_ms: Date.parse('2026-09-16T00:00:00Z'),
      m0_end_ms: Date.parse('2026-09-17T00:00:00Z'),
      display_tz: 'UTC',
    });
  });

  it('周粒度在任何时区路径都用 toMonday（ZQ-6）', async () => {
    const result = await eventGenerator().generate({
      ...baseQuery,
      groups: [{ scope: 'time' as const, granularity: 'week' as const }],
      time_range: { start: '2026-09-16', end: '2026-09-16', timezone: 'America/New_York' },
    });
    expect(result.sql).toContain('toMonday(log_time, {display_tz:String})');
    expect(result.sql).not.toContain('toStartOfWeek');
  });

  it('非法 timezone 被 400 契约拦截', async () => {
    await expect(
      eventGenerator().generate({ ...baseQuery, time_range: { start: '2026-09-16', end: '2026-09-16', timezone: 'Mars/Olympus' } }),
    ).rejects.toMatchObject({ errorCode: 'analysis.time_range.timezone_invalid' });
  });
});

describe('漏斗生成器 · 时区双路径', () => {
  const baseQuery = {
    project: 'clklogapp',
    window_seconds: 3600,
    steps: [{ event: 'A' }, { event: 'B' }],
    groups: [{ scope: 'time' as const, granularity: 'day' as const }],
  };

  it('恒等路径：start/end 参数与模板形态保持', async () => {
    const result = await funnelGenerator().generate({
      ...baseQuery,
      time_range: { start: '2026-09-10', end: '2026-09-16' },
    });
    expect(result.sql).toContain('stat_date BETWEEN {start:String} AND {end:String}');
    expect(result.sql).not.toContain('display_tz');
    expect(result.params).toMatchObject({ start: '2026-09-10', end: '2026-09-16', window: 3600 });
  });

  it('异时区路径：内层宽扫 + epoch 精切 + 分组桶 tz 参数', async () => {
    const result = await funnelGenerator().generate({
      ...baseQuery,
      time_range: { start: '2026-09-16', end: '2026-09-16', timezone: 'UTC' },
    });
    expect(result.sql).toContain('stat_date BETWEEN {scan_start:String} AND {scan_end:String}');
    expect(result.sql).toContain('log_time >= fromUnixTimestamp64Milli({start_ms:Int64})');
    expect(result.sql).toContain('toStartOfDay(minIf(log_time, step_0), {display_tz:String})');
    expect(result.params).toMatchObject({
      scan_start: '2026-09-15',
      scan_end: '2026-09-17',
      display_tz: 'UTC',
    });
  });
});

describe('留存生成器 · 时区双路径', () => {
  const baseQuery = {
    project: 'clklogapp',
    start_event: { event: 'A' },
    retain_event: { event: 'B' },
    cohort: 'all' as const,
    granularity: 'day' as const,
    n_list: [1, 7],
  };

  it('恒等路径：stat_bucket 走 toDate(stat_date)，无 epoch 精切', async () => {
    const result = await retentionGenerator().generate({
      ...baseQuery,
      time_range: { start: '2026-09-10', end: '2026-09-16' },
    });
    expect(result.sql).toContain('toDate(stat_date) AS stat_bucket');
    expect(result.sql).toContain('stat_date BETWEEN {scan_start: String} AND {scan_end: String}');
    expect(result.sql).not.toContain('fromUnixTimestamp64Milli');
    expect(result.params.scan_start).toBe('2026-09-10');
  });

  it('异时区路径：入组日按展示日历切，宽扫 + epoch 边界', async () => {
    const result = await retentionGenerator().generate({
      ...baseQuery,
      time_range: { start: '2026-09-16', end: '2026-09-16', timezone: 'UTC' },
    });
    expect(result.sql).toContain('toDate(log_time, {display_tz:String}) AS stat_bucket');
    expect(result.sql).toContain('log_time >= fromUnixTimestamp64Milli({ret_start_ms:Int64})');
    expect(result.sql).toContain('log_time < fromUnixTimestamp64Milli({ret_scanend_ms:Int64})');
    expect(result.params).toMatchObject({
      scan_start: '2026-09-15',
      // 观察窗含成熟期延展（n=7 → 2026-09-23），再宽扫一天
      scan_end: '2026-09-24',
      ret_start_ms: Date.parse('2026-09-16T00:00:00Z'),
      ret_scanend_ms: Date.parse('2026-09-24T00:00:00Z'),
      display_tz: 'UTC',
      start: '2026-09-16',
      end: '2026-09-16',
    });
  });
});
