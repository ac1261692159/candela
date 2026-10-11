/** 平台/展示时区解析（phase: clklog-analytics-timezone-v1） */
import { DomainError } from '../../src/i18n/domain-error';
import { TimezoneService } from '../../src/modules/time/timezone.service';

describe('TimezoneService', () => {
  it('缺省平台时区 = Asia/Shanghai', () => {
    expect(new TimezoneService(undefined).platformTz).toBe('Asia/Shanghai');
    expect(new TimezoneService({}).platformTz).toBe('Asia/Shanghai');
    expect(new TimezoneService({ platformTz: '  ' }).platformTz).toBe('Asia/Shanghai');
  });

  it('配置生效并 trim', () => {
    expect(new TimezoneService({ platformTz: ' America/New_York ' }).platformTz).toBe('America/New_York');
  });

  it('非法配置启动期报错（fail-fast，不静默回退）', () => {
    expect(() => new TimezoneService({ platformTz: 'Beijing' })).toThrow('Invalid analytics.timezone');
  });

  it('resolveDisplayTz：空值回落平台；合法透传', () => {
    const service = new TimezoneService({ platformTz: 'Asia/Shanghai' });
    expect(service.resolveDisplayTz(undefined)).toBe('Asia/Shanghai');
    expect(service.resolveDisplayTz(null)).toBe('Asia/Shanghai');
    expect(service.resolveDisplayTz('')).toBe('Asia/Shanghai');
    expect(service.resolveDisplayTz('  ')).toBe('Asia/Shanghai');
    expect(service.resolveDisplayTz('UTC')).toBe('UTC');
    expect(service.resolveDisplayTz('America/New_York')).toBe('America/New_York');
  });

  it('resolveDisplayTz：非法抛 DomainError(400) 且带 messageKey', () => {
    const service = new TimezoneService({ platformTz: 'Asia/Shanghai' });
    try {
      service.resolveDisplayTz('Mars/Olympus');
      fail('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domain = error as DomainError;
      expect(domain.getStatus()).toBe(400);
      expect(domain.messageKey).toBe('errors:analysis.timeRange.timezoneInvalid');
      expect(domain.errorCode).toBe('analysis.time_range.timezone_invalid');
    }
  });
});
