import {
  compare,
  isEmailAddress,
  isFeishuWebhook,
  isMobileNumber,
  maskAddress,
  maskWebhook,
  nextStreak,
  requiredPolls,
  resolveMuteWindow,
} from '../../src/modules/alerting/alert-eval';

describe('alert-eval', () => {
  it('比较符', () => {
    expect(compare(11, 'gt', 10)).toBe(true);
    expect(compare(10, 'gt', 10)).toBe(false);
    expect(compare(10, 'gte', 10)).toBe(true);
    expect(compare(9, 'lt', 10)).toBe(true);
    expect(compare(10, 'lte', 10)).toBe(true);
  });

  it('连续窗口次数 = 粒度分钟 × 持续窗口', () => {
    expect(requiredPolls(1, 1)).toBe(1);
    expect(requiredPolls(5, 2)).toBe(10);
    expect(requiredPolls(0, 3)).toBe(3);
  });

  it('streak 未命中归零', () => {
    expect(nextStreak(4, true)).toBe(5);
    expect(nextStreak(4, false)).toBe(0);
  });

  it('webhook 校验与脱敏', () => {
    const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdEFGHijkl';
    expect(isFeishuWebhook(url)).toBe(true);
    expect(isFeishuWebhook('https://evil.example/hook')).toBe(false);
    expect(maskWebhook(url)).toContain('***');
    expect(maskWebhook(url)).not.toContain('abcdEFGH');
    expect(maskAddress('email', 'ops@example.com')).toBe('op***@example.com');
    expect(maskAddress('sms', '13812345678')).toBe('138****5678');
    expect(isEmailAddress('ops@example.com')).toBe(true);
    expect(isMobileNumber('13812345678')).toBe(true);
    expect(isMobileNumber('138123')).toBe(false);
  });

  it('快捷屏蔽小时数', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const quick = resolveMuteWindow({ duration_hours: 6, now });
    expect(quick?.ends.toISOString()).toBe('2026-09-10T18:00:00.000Z');
    expect(resolveMuteWindow({ starts_at: 'bad', ends_at: 'also-bad' })).toBeNull();
    expect(resolveMuteWindow({})).toBeNull();
  });
});
