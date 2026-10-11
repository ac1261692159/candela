/**
 * 时间范围解析与校验（实现已整组搬入 `src/modules/time/calendar.ts`，
 * 解析矩阵见 test/time/calendar.spec.ts；本文件保留默认解析抽查 + 校验器集成）。
 */
import { DslValidatorService } from '../../src/modules/query/dsl-validator.service';
import {
  defaultPastNDays,
  materializeTimeRange,
  resolveTimeRange,
} from '../../src/modules/time/calendar';
import type { EventAnalysisQuery, Metric } from '../../src/types/dsl.types';

const TODAY = '2026-09-11';

describe('time-range resolve', () => {
  it('maps 过去7天 to seven complete days ending yesterday', () => {
    expect(resolveTimeRange({ start: '', end: '', relative: { kind: 'past_n', n: 7 } }, TODAY)).toEqual({
      start: '2026-09-04',
      end: '2026-09-10',
    });
  });

  it('maps 最近7天 to seven days including today', () => {
    expect(resolveTimeRange({ start: '', end: '', relative: { kind: 'recent_n', n: 7 } }, TODAY)).toEqual({
      start: '2026-09-05',
      end: '2026-09-11',
    });
  });

  it('keeps relative on materialize and defaults to past 7', () => {
    const past = defaultPastNDays(7, TODAY);
    expect(past.relative).toEqual({ kind: 'past_n', n: 7 });
    expect(past.start).toBe('2026-09-04');
    const frozen = materializeTimeRange({ start: '2026-01-01', end: '2026-01-02' }, TODAY);
    expect(frozen.relative).toBeUndefined();
  });

  it('rejects inverted custom offsets', () => {
    expect(() =>
      resolveTimeRange(
        { start: '', end: '', relative: { kind: 'custom_offsets', from_offset: 1, to_offset: 3 } },
        TODAY,
      ),
    ).toThrow('动态时间起始不能晚于结束');
  });
});

describe('dsl validator relative time_range', () => {
  const service = new DslValidatorService();
    const metrics: Metric[] = [{ id: 'm_0', type: 'count', event: 'Pay' }];

  it('overwrites stale start/end from relative before query', () => {
    const query: EventAnalysisQuery = {
      project: 'clklogapp',
      event: 'Pay',
      metrics,
      time_range: { start: '2000-01-01', end: '2000-01-02', relative: { kind: 'past_n', n: 7 } },
    };
    service.validateEventQuery(query);
    expect(query.time_range.start).not.toBe('2000-01-01');
    expect(query.time_range.end).not.toBe('2000-01-02');
    expect(query.time_range.relative).toEqual({ kind: 'past_n', n: 7 });
    expect(query.time_range.start < query.time_range.end || query.time_range.start === query.time_range.end).toBe(true);
  });
});
