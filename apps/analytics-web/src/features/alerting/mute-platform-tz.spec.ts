// @vitest-environment jsdom
/** 静默表单：选择器墙钟按平台时区转 ISO（phase: clklog-analytics-timezone-v1） */
import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { dayjsToPlatformIso } from './mute-form';
import { getPlatformTimeZone } from '../time-range/resolve';

describe('dayjsToPlatformIso', () => {
  it('选择墙钟按平台时区（默认 Asia/Shanghai）解释为 epoch', () => {
    expect(getPlatformTimeZone()).toBe('Asia/Shanghai');
    // 与运行机时区无关：dayjs 字面量总是解析成本地分量，再按平台时区换算
    expect(dayjsToPlatformIso(dayjs('2026-09-17 08:30'))).toBe('2026-09-17T00:30:00.000Z');
    expect(dayjsToPlatformIso(dayjs('2026-03-09 00:00'))).toBe('2026-03-08T16:00:00.000Z');
  });

  it('提交 ISO 带 Z 后缀（服务端 CreateMuteDto 的 ISO8601_WITH_OFFSET 校验通过）', () => {
    expect(dayjsToPlatformIso(dayjs('2026-09-17 23:59:59'))).toMatch(/Z$/);
  });
});
