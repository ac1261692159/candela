/**
 * timezone-v2 各消费面单点效果（phase: clklog-analytics-timezone-v2）：
 * ingest stat_date 随项目时区、联系人时区校验、用户偏好写入路径。
 */
import { contactTimezone } from '../../src/modules/alerting/contact-normalize';
import { SaEventFlattener } from '../../src/modules/ingestor/sa-event-flattener.service';
import { ProjectTimeRegistry } from '../../src/modules/time/project-time-registry';
import { TimezoneService } from '../../src/modules/time/timezone.service';

describe('ingest stat_date 随项目时区（SC-2 单测面）', () => {
  const message = {
    type: 'track' as const,
    event: 'Pay',
    distinct_id: 'u1',
    // 2026-09-17T16:30:00Z = 上海 9-18 00:30 = 纽约 9-17 12:30(EDT)
    time: Date.parse('2026-09-17T16:30:00Z'),
    project_name: 'proj_ny',
    properties: {},
    crc: 'c1',
  };

  function flattenerWith(projects: Record<string, string | null>) {
    const registry = new ProjectTimeRegistry({} as never);
    registry.seedForTest(projects);
    return new SaEventFlattener(new TimezoneService({ platformTz: 'Asia/Shanghai' }), registry);
  }

  it('项目设 America/New_York：stat_date 按纽约日历，log_time 仍上海渲染（instant 不变）', () => {
    const record = flattenerWith({ proj_ny: 'America/New_York' }).flatten(message);
    expect(record.stat_date).toBe('2026-09-17'); // 纽约当天
    expect(record.log_time).toBe('2026-09-18 00:30:00.000'); // 上海墙钟（服务端时区口径）
  });

  it('项目未设/未知：stat_date 按平台日历 = 上海（v1 行为不变）', () => {
    expect(flattenerWith({}).flatten(message).stat_date).toBe('2026-09-18');
    expect(flattenerWith({ proj_ny: null }).flatten(message).stat_date).toBe('2026-09-18');
    expect(flattenerWith({ proj_ny: 'Mars/Olympus' }).flatten(message).stat_date).toBe('2026-09-18');
  });
});

describe('contactTimezone（联系人时区准入校验）', () => {
  it('空值透传 null；合法 IANA 透传；非法 400 带 messageKey', () => {
    expect(contactTimezone(undefined)).toBeNull();
    expect(contactTimezone(null)).toBeNull();
    expect(contactTimezone('  ')).toBeNull();
    expect(contactTimezone('UTC')).toBe('UTC');
    expect(contactTimezone(' America/New_York ')).toBe('America/New_York');
    try {
      contactTimezone('Beijing');
      fail('应当抛出');
    } catch (error) {
      expect((error as { messageKey?: string }).messageKey).toBe('alerting:error.contact.timezoneInvalid');
    }
  });
});

describe('用户偏好时区校验（auth preferences 同源口径）', () => {
  it('TimezoneService.resolveDisplayTz 兼用偏好校验', () => {
    const service = new TimezoneService({ platformTz: 'Asia/Shanghai' });
    expect(service.resolveDisplayTz('Pacific/Honolulu')).toBe('Pacific/Honolulu');
    expect(() => service.resolveDisplayTz('GMT+8')).toThrow(/时区不合法/);
  });
});
