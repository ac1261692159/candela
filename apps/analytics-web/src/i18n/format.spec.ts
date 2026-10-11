// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from './index';
import { formatDate, formatDateTime, formatDateTimeFixed, formatDurationSec, formatNumber, formatPercent } from './format';

afterEach(async () => {
  vi.unstubAllEnvs();
  await changeLocale('zh-CN');
});

// 时刻锚点：2026-09-16T13:05:00Z = 上海 21:05（与运行机时区无关，时区矩阵共用）
const INSTANT = new Date('2026-09-16T13:05:00Z');

describe('localized formatting', () => {
  it('keeps zh-CN output identical to the pre-migration formatter', () => {
    expect(formatNumber(1234567)).toBe((1234567).toLocaleString('zh-CN'));
    expect(formatNumber(undefined)).toBe('-');
    expect(formatPercent(0.1234)).toBe('12.34%');
    expect(formatDate(INSTANT)).toBe('2026-09-16');
    expect(formatDateTime(INSTANT)).toBe(
      INSTANT.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    );
    expect(formatDurationSec(12.5)).toBe(`${(12.5).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 秒`);
  });

  it('switches number and date formats with the language', async () => {
    const zhDateTime = formatDateTime(INSTANT);
    await changeLocale('en-US');
    const enDateTime = formatDateTime(INSTANT);
    expect(enDateTime).not.toBe(zhDateTime);
    expect(enDateTime.startsWith('09/16/2026')).toBe(true);
    // 数字分组在两种语言下一致（zh-CN 与 en-US 都是千分位逗号），但要确认未写死区域
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatDurationSec(12.5)).not.toContain('秒');
  });
});

describe('timezone rendering（展示口径锚定平台时区，与浏览器时区无关）', () => {
  it('浏览器切到檀香山（UTC-10），平台口径展示不变', () => {
    vi.stubEnv('TZ', 'Pacific/Honolulu');
    expect(formatDate(INSTANT)).toBe('2026-09-16');
    expect(formatDateTimeFixed(INSTANT)).toBe('2026-09-16 21:05:00');
  });

  it('formatDate/formatDateTime/formatDateTimeFixed 支持逐次覆盖 tz', () => {
    expect(formatDate(INSTANT, 'UTC')).toBe('2026-09-16');
    expect(formatDate(INSTANT, 'Pacific/Honolulu')).toBe('2026-09-16');
    // 日界用例：2026-09-17T02:00Z 在上海是 17 日、檀香山还是 16 日
    const boundary = new Date('2026-09-17T02:00:00Z');
    expect(formatDate(boundary, 'Asia/Shanghai')).toBe('2026-09-17');
    expect(formatDate(boundary, 'Pacific/Honolulu')).toBe('2026-09-16');
    expect(formatDateTimeFixed(boundary, 'Pacific/Honolulu')).toBe('2026-09-16 16:00:00');
    expect(formatDateTime(boundary, 'UTC')).toContain('2026');
  });

  it('formatDateTimeFixed 无效输入兜底', () => {
    expect(formatDateTimeFixed('')).toBe('-');
    expect(formatDateTimeFixed(undefined)).toBe('-');
  });
});
