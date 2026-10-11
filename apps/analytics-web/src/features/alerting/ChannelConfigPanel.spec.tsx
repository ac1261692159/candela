// @vitest-environment jsdom
/**
 * 通道配置面板（phase: clklog-analytics-account-lifecycle-v3 增补 v3.2 修订）。
 *
 * 生产现象：平台邮件通道已配好，「邮件（SMTP）」仍显示「未启用」，用户以为告警邮件没配。
 * 这里钉住徽标口径：告警侧未启用但平台邮件可用 → 蓝色「平台邮件通道」，展开后给出说明。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelConfigPanel } from './ChannelConfigPanel';
import * as api from './alerting-api';

vi.mock('./alerting-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./alerting-api')>();
  return {
    ...actual,
    getAlertChannelConfigs: vi.fn(),
    saveAlertChannelConfig: vi.fn(),
    testAlertChannel: vi.fn(),
  };
});

const mockApi = vi.mocked(api);

function item(overrides: Partial<api.AlertChannelConfigItem> = {}): api.AlertChannelConfigItem {
  return {
    channel: 'smtp',
    label: '邮件（SMTP）',
    enabled: false,
    config: {},
    secret: { configured: false, hint: '（未配置）', keys: {} },
    updated_by: null,
    updated_at: null,
    env_fallback: false,
    ...overrides,
  };
}

function setup(items: api.AlertChannelConfigItem[], schemas?: api.AlertChannelConfigSchema[]) {
  mockApi.getAlertChannelConfigs.mockResolvedValue({
    items,
    schemas: schemas ?? [
      { channel: 'smtp', label: '邮件（SMTP）', hint: 'SMTP 说明', fields: [], secretFields: [] },
    ],
  });
  return render(<ChannelConfigPanel />);
}

/** Telegram schema：带 help/help_key（真实资源键，验证键解析链路） */
function telegramSchema(overrides: Partial<api.AlertChannelConfigSchema> = {}): api.AlertChannelConfigSchema {
  return {
    channel: 'telegram',
    label: 'Telegram',
    hint: '用 @BotFather 建机器人拿 Token',
    help: '中文兜底（help_key 命中时不应显示这条）',
    help_key: 'alerting:channelConfig.telegram.help',
    fields: [],
    secretFields: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('通道配置 · 平台邮件回落徽标', () => {
  it('告警侧未启用但平台邮件可用 → 状态显示「已启用」，来源单独标「平台邮件通道」，展开后给出说明', async () => {
    setup([item({ platform_fallback: true })]);

    // 状态与来源分开：只显示来源会被读成「没启用」（2026-10-09 用户反馈）
    expect(await screen.findByText('已启用')).toBeTruthy();
    expect(screen.getByText('平台邮件通道')).toBeTruthy();
    expect(screen.queryByText('未启用')).toBeNull();
    // 开关呈「实效状态」且置灰：它在发信，off 位不代表停发
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.className).toContain('ant-switch-disabled');

    await userEvent.click(screen.getByText('邮件（SMTP）'));
    expect(await screen.findByText(/用户管理 → 邮件通道/)).toBeTruthy();
  }, 60_000);

  it('平台邮件不可用且告警侧未配置 → 维持「未启用」且无说明', async () => {
    setup([item()]);

    expect(await screen.findByText('未启用')).toBeTruthy();
    expect(screen.queryByText(/用户管理 → 邮件通道/)).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('告警侧已配置并启用 → 显示「已启用」，回落标记不参与，开关可点', async () => {
    setup([item({ enabled: true, updated_by: 'ops-config', updated_at: '2026-10-01T00:00:00.000Z' })]);

    expect(await screen.findByText('已启用')).toBeTruthy();
    expect(screen.queryByText('平台邮件通道')).toBeNull();
    expect(screen.queryByText('未启用')).toBeNull();
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.className).not.toContain('ant-switch-disabled');
  });
});

describe('通道配置 · 暂停投递（增补 v1.1）', () => {
  it('暂停的通道：橙色「已暂停」标签、表头开关置灰关闭，展开区可恢复投递', async () => {
    setup([item({ enabled: true, muted: true, updated_by: 'ops', updated_at: '2026-10-09T00:00:00.000Z' })]);

    // 暂停盖过「已启用」：即使本通道自己的配置是启用的
    expect(await screen.findByText('已暂停')).toBeTruthy();
    expect(screen.queryByText('已启用')).toBeNull();
    const headerSwitch = screen.getByRole('switch');
    expect(headerSwitch.getAttribute('aria-checked')).toBe('false');
    expect(headerSwitch.className).toContain('ant-switch-disabled');

    await userEvent.click(screen.getByText('邮件（SMTP）'));
    expect(screen.getByText(/暂停后保留配置与密钥/)).toBeTruthy();
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    expect(switches[1].getAttribute('aria-checked')).toBe('true');

    // 恢复：只提交 muted（不动配置与密钥）
    await userEvent.click(switches[1]);
    expect(mockApi.saveAlertChannelConfig).toHaveBeenCalledWith('smtp', { muted: false });
  }, 60_000);

  it('未暂停：展开区暂停开关默认关，提交时写 muted=true', async () => {
    setup([item({ enabled: true, updated_by: 'ops', updated_at: '2026-10-09T00:00:00.000Z' })]);

    await userEvent.click(await screen.findByText('邮件（SMTP）'));
    const switches = screen.getAllByRole('switch');
    expect(switches[1].getAttribute('aria-checked')).toBe('false');

    await userEvent.click(switches[1]);
    expect(mockApi.saveAlertChannelConfig).toHaveBeenCalledWith('smtp', { muted: true });
  }, 60_000);
});

describe('通道配置 · 表头「?」逐步配置方法', () => {
  it('有 help 的通道显示「?」，点击弹出该语言的说明（含真实排障坑），且不会折叠卡片', async () => {
    setup([item({ channel: 'telegram', label: 'Telegram' })], [telegramSchema()]);

    // 先展开卡片（默认全部折叠）：点标题文字即可，事件冒泡到表头
    await userEvent.click(await screen.findByText('Telegram'));
    const hint = await screen.findByText('用 @BotFather 建机器人拿 Token');

    await userEvent.click(screen.getByLabelText('Telegram 配置方法'));

    // 弹出层取的是 13 门语言资源（zh-CN 文案），不是 schema 里的中文兜底
    expect(await screen.findByText(/chat not found/)).toBeTruthy();
    expect(screen.getByText(/@userinfobot/)).toBeTruthy();
    expect(screen.queryByText('中文兜底（help_key 命中时不应显示这条）')).toBeNull();
    // 点「?」不应连带折叠：卡片仍是展开的（hint 还在）
    expect(hint.isConnected).toBe(true);
  }, 60_000);

  it('没有 help 的通道不出现「?」', async () => {
    setup([item()]);

    expect(await screen.findByText('邮件（SMTP）')).toBeTruthy();
    expect(screen.queryByLabelText('邮件（SMTP）配置方法')).toBeNull();
  });
});
