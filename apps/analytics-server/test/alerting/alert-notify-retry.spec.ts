/**
 * 投递重试与通道分派（phase: clklog-analytics-alert-channels-v1）。
 *
 * 策略不变：最多 3 次尝试、退避 1s/2s、全失败才抛错（由检测器落一条 fail 记录）。
 * 变化：分派改走通道注册表，因此这里同时锁住「入队 → 限流后投递 → 回调落库」这条链路。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    alerting: {
      smtp: { host: '', port: 465, user: '', pass: '', from: '', secure: true },
      sms: { secretId: '', secretKey: '', sdkAppId: '', signName: '', templateId: '', region: 'ap-guangzhou' },
    },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { AlertNotifyService, SEND_ATTEMPTS, SEND_RETRY_DELAYS_MS } from '../../src/modules/alerting/alert-notify.service';
import { AlertChannelConfigService } from '../../src/modules/alerting/channels/channel-config.service';

const CONTACT = {
  kind: 'feishu_webhook',
  webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxx',
  address: '',
  options_json: null,
};

function service(muted = false) {
  const configs = {
    readConfig: jest.fn(async () => null),
    capabilities: jest.fn(async () => ({ feishu_webhook: { available: true, reason: null } })),
    // 投递守卫（增补 v1.1）：默认不暂停；暂停语义单独用例覆盖
    isMutedForKind: jest.fn(async () => muted),
  } as unknown as AlertChannelConfigService;
  return new AlertNotifyService(configs);
}

describe('通道暂停（增补 v1.1）', () => {
  it('暂停的通道：直接抛 channel_muted，且**不重试**（确定性失败）', async () => {
    const notify = service(true);
    const deliver = jest.spyOn(notify as unknown as { deliver: () => Promise<void> }, 'deliver');
    const onDone = jest.fn();

    notify.enqueue({
      contact: CONTACT,
      ruleName: '卡片缓存刷新连续失败',
      subject: '标题',
      text: '正文',
      vars: {},
      onDone,
    });

    for (let i = 0; i < 60 && onDone.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(onDone).toHaveBeenCalled();
    expect(onDone.mock.calls[0][0]).toBe(false);
    expect(String(onDone.mock.calls[0][1]?.message ?? onDone.mock.calls[0][1])).toContain('channel_muted');
    // 关键：一次都没真投（也没有 3 次重试）
    expect(deliver).not.toHaveBeenCalled();
  }, 60_000);
});

describe('AlertNotifyService 重试', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('首次失败后重试成功：只投递一次成功结果，不抛错', async () => {
    const notify = service();
    const deliver = jest.spyOn(notify as unknown as { deliver: () => Promise<void> }, 'deliver');
    deliver.mockRejectedValueOnce(new Error('feishu_http_500'));
    deliver.mockResolvedValueOnce(undefined);

    jest.useFakeTimers();
    const promise = notify.sendNow(CONTACT, { subject: 'x', text: '【警告】测试', vars: {} });
    await jest.advanceTimersByTimeAsync(SEND_RETRY_DELAYS_MS[0]);
    await expect(promise).resolves.toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('三次全失败：抛最后一次错误（含厂商原始信息）', async () => {
    const notify = service();
    const deliver = jest.spyOn(notify as unknown as { deliver: () => Promise<void> }, 'deliver');
    deliver.mockRejectedValueOnce(new Error('feishu_timeout'));
    deliver.mockRejectedValueOnce(new Error('feishu_http_503'));
    deliver.mockRejectedValueOnce(new Error('feishu_invalid_payload'));

    jest.useFakeTimers();
    const promise = notify.sendNow(CONTACT, { subject: 'x', text: '【警告】测试', vars: {} });
    const assertion = expect(promise).rejects.toThrow('feishu_invalid_payload');
    await jest.advanceTimersByTimeAsync(SEND_RETRY_DELAYS_MS[0] + SEND_RETRY_DELAYS_MS[1]);
    await assertion;
    expect(SEND_ATTEMPTS).toBe(3);
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('首次即成功不重试', async () => {
    const notify = service();
    const deliver = jest
      .spyOn(notify as unknown as { deliver: () => Promise<void> }, 'deliver')
      .mockResolvedValue(undefined);

    await notify.sendNow(CONTACT, { subject: 'x', text: '【警告】测试', vars: {} });

    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('入队投递（限流 + 回调落库）', () => {
  it('enqueue 不阻塞调用方，投递结束后回调 ok', async () => {
    const notify = service();
    jest
      .spyOn(notify as unknown as { deliver: () => Promise<void> }, 'deliver')
      .mockResolvedValue(undefined);
    const done = jest.fn();

    notify.enqueue({
      contact: CONTACT,
      ruleName: '慢查询次数突增',
      subject: 'x',
      text: '【警告】慢查询次数突增',
      vars: {},
      onDone: done,
    });

    // 通道有 250ms 合并窗口（攒批），等待上限放宽到 ~1.5s
    for (let i = 0; i < 60 && done.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(done).toHaveBeenCalledWith(true, undefined);
  });

  it('未知通道直接回调失败（不抛错、不丢记录）', () => {
    const notify = service();
    const done = jest.fn();

    notify.enqueue({
      contact: { ...CONTACT, kind: 'not_a_channel' },
      ruleName: 'r',
      subject: 'x',
      text: 'y',
      vars: {},
      onDone: done,
    });

    expect(done).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ message: 'unknown_channel_not_a_channel' }),
    );
  });
});
