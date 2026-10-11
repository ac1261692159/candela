/** 显式时区格式化（phase: clklog-analytics-timezone-v1；替代 common/utils/date.util） */
import {
  formatChDate,
  formatChDateTimeMs,
  formatChDateTimeSeconds,
  formatInTz,
  formatUtcIso,
} from '../../src/modules/time/format';

const EPOCH = new Date('2026-09-17T02:03:04.567Z');

describe('time/format', () => {
  it('同一 epoch 不同时区渲染不同墙钟', () => {
    expect(formatInTz(EPOCH, 'Asia/Shanghai')).toBe('2026-09-17 10:03:04');
    expect(formatInTz(EPOCH, 'UTC')).toBe('2026-09-17 02:03:04');
    expect(formatInTz(EPOCH, 'Pacific/Honolulu')).toBe('2026-09-16 16:03:04');
  });

  it('CH 写串形态（DateTime64(3) / DateTime / Date）', () => {
    expect(formatChDateTimeMs(EPOCH, 'Asia/Shanghai')).toBe('2026-09-17 10:03:04.567');
    expect(formatChDateTimeSeconds(EPOCH, 'Asia/Shanghai')).toBe('2026-09-17 10:03:04');
    expect(formatChDate(EPOCH, 'Asia/Shanghai')).toBe('2026-09-17');
    expect(formatChDate(EPOCH, 'Pacific/Honolulu')).toBe('2026-09-16');
  });

  it('毫秒边界取整与 UTC ISO', () => {
    expect(formatChDateTimeMs(1785228036000, 'Asia/Shanghai').endsWith('.000')).toBe(true);
    expect(formatUtcIso(EPOCH)).toBe('2026-09-17T02:03:04.567Z');
  });
});
