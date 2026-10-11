/**
 * 时区系统 ZQ-1～ZQ-6 清零回归锁定（phase: clklog-analytics-timezone-v1；
 * 问题登记见 docs/product/research-clklog-analytics-timezone-v1.md §5）。
 * 不 mock 进程时区：本文件在 TZ=UTC 与 TZ=Pacific/Auckland 下须同样通过。
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { computeDay } from '../../src/modules/cohort/cohort-definition';
import { SaEventFlattener } from '../../src/modules/ingestor/sa-event-flattener.service';
import { CreateMuteDto } from '../../src/modules/alerting/dto/alerting.dto';
import { parseChDateTimeInTz, todayInTz } from '../../src/modules/time/calendar';
import { TimezoneService } from '../../src/modules/time/timezone.service';

describe('ZQ-2 分群/标签计算日按平台日历（原 UTC 今天）', () => {
  it('UTC+12 进程、UTC 日落后 8 点：上海今天仍在同一天（UTC 口径会是次日）', () => {
    // 2026-09-17T02:00Z = 上海 10:00 = 奥克兰 14:00；UTC 日 = 17 ✓ 同日
    // 关键差例：2026-09-16T20:00Z = 上海 17 日 04:00；UTC 日 = 16 —— 两口径差一天
    const now = new Date('2026-09-16T20:00:00Z');
    expect(computeDay('Asia/Shanghai', now)).toBe('2026-09-17');
    // 旧口径（UTC）会是 2026-09-16，正是 ZQ-2 的错位来源
    expect(now.toISOString().slice(0, 10)).toBe('2026-09-16');
  });
});

describe('ZQ-1 ingestor 写串显式平台时区（不读进程本地分量）', () => {
  const message = {
    type: 'track' as const,
    event: 'Pay',
    distinct_id: 'u1',
    time: 1785228036000, // 2026-07-28T08:40:36Z = 上海 16:40:36
    project_name: 'clklogapp',
    properties: {},
    crc: 'c1',
  };

  it('log_time/stat_date 与进程时区无关（固定 epoch 的断言在任何 TZ 下一致）', () => {
    const record = new SaEventFlattener().flatten(message);
    expect(record.log_time).toBe('2026-07-28 16:40:36.000');
    expect(record.stat_date).toBe('2026-07-28');
  });

  it('跨日历日边界：UTC 23:30 在上海已是次日', () => {
    // 2026-07-28T16:00:00Z = 上海 7-29 00:00
    const record = new SaEventFlattener().flatten({ ...message, time: Date.parse('2026-07-28T16:00:00Z') });
    expect(record.stat_date).toBe('2026-07-29');
    expect(record.log_time).toBe('2026-07-29 00:00:00.000');
  });
});

describe('ZQ-4 CH 服务端墙钟解析单点（两消费方同一口径）', () => {
  it('parseChDateTimeInTz：上海解析 = 本地-8h', () => {
    const ms = parseChDateTimeInTz('2026-09-17 10:00:00', 'Asia/Shanghai');
    expect(ms).toBe(Date.parse('2026-09-17T02:00:00Z'));
  });

  it('非法输入返回 null（不再被「+Z 拼接」或本地解释静默吞掉）', () => {
    expect(parseChDateTimeInTz('not a time', 'Asia/Shanghai')).toBeNull();
    expect(parseChDateTimeInTz('2026-09-17', 'Asia/Shanghai')).toBeNull();
  });

  it('UTC 与上海的解析差恰为 8 小时（旧双标的量化）', () => {
    const a = parseChDateTimeInTz('2026-09-17 10:00:00', 'Asia/Shanghai') as number;
    const b = parseChDateTimeInTz('2026-09-17 10:00:00', 'UTC') as number;
    expect(b - a).toBe(8 * 3600_000);
  });
});

describe('ZQ-8-② 静默窗口时间契约（ISO 8601 必须带偏移）', () => {
  it('拒绝无时区偏移的裸字符串', async () => {
    const dto = plainToInstance(CreateMuteDto, { starts_at: '2026-09-17 08:00:00', ends_at: '2026-09-17 09:00:00' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('接受 ISO 8601 带 Z / 带偏移', async () => {
    const zulu = plainToInstance(CreateMuteDto, { starts_at: '2026-09-17T08:00:00Z', ends_at: '2026-09-17T09:00:00.000Z' });
    expect(await validate(zulu)).toEqual([]);
    const offset = plainToInstance(CreateMuteDto, { starts_at: '2026-09-17T08:00:00+08:00', ends_at: '2026-09-17T09:00:00+0800' });
    expect(await validate(offset)).toEqual([]);
  });

  it('缺省（不传）合法', async () => {
    const dto = plainToInstance(CreateMuteDto, {});
    expect(await validate(dto)).toEqual([]);
  });
});

describe('ZQ-5/6 旁证', () => {
  it('todayInTz 与 computeDay 同源（口径单点）', () => {
    const now = new Date('2026-09-17T02:00:00Z');
    expect(computeDay('Asia/Shanghai', now)).toBe(todayInTz('Asia/Shanghai', now));
  });

  it('TimezoneService 与 ZQ 系列同口径的 today', () => {
    const service = new TimezoneService({ platformTz: 'Asia/Shanghai' });
    expect(service.todayYmd(new Date('2026-09-16T20:00:00Z'))).toBe('2026-09-17');
  });
});
