// @vitest-environment jsdom
/**
 * 告警工作台渲染验收（phase: clklog-analytics-alerting-v3/v4）。
 *
 * 覆盖展示层：概览的三类提示条（无启用联系人 / N 条规则无效 / 近 24h 通知失败）、
 * 策略 Tab 的规则健康标签与指标列、变更记录 Tab 的变更内容渲染。
 * v4 追加：告警对象从「分析卡片」改为「数据管理指标」——断言页面上不再出现卡片字样，
 * 且新建入口、通知模板 Tab 存在。生产环境需要超管登录，浏览器人工核验不便，故用组件测试补上。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertsWorkbench } from './AlertsWorkbench';
import * as api from './alerting-api';

// 整页渲染用例（antd 表单/表格 + 数据装配）单文件就要 18–35 秒；套件变大后 20s 上限会在整轮
// 并行时被挤爆（表现为「单跑必过、整轮超时」）。这里放到 60s 作为**卡死检测**上限，不是预期耗时。
vi.mock('./alerting-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./alerting-api')>();
  return {
    ...actual,
    getAlertOverview: vi.fn(),
    getAlertRules: vi.fn(),
    getAlertEvents: vi.fn(),
    getAlertContacts: vi.fn(),
    getAlertMutes: vi.fn(),
    getAlertNotifications: vi.fn(),
    getAlertChannels: vi.fn(),
    getAlertAudits: vi.fn(),
    updateAlertRule: vi.fn(),
    deleteAlertRule: vi.fn(),
    createAlertContact: vi.fn(),
    deleteAlertContact: vi.fn(),
    updateAlertContact: vi.fn(),
    getAlertTemplates: vi.fn(),
    getAlertMetrics: vi.fn(),
    getAlertRetention: vi.fn(),
    saveAlertRetention: vi.fn(),
  };
});

const mockApi = vi.mocked(api);

function rule(overrides: Partial<api.AlertRuleItem> = {}): api.AlertRuleItem {
  return {
    code: 'slow_query_spike',
    name: '慢查询次数突增',
    threshold: 200,
    enabled: true,
    severity: 'warning',
    comparator: 'gt',
    unit: '次',
    window_minutes: 1,
    for_windows: 1,
    repeat_minutes: 60,
    notify_on_resolve: true,
    contact_id: null,
    contact_ids: [],
    contact_names: [],
    contact_name: null,
    source: 'builtin',
    metric_id: null,
    metric_name: null,
    window_days: 1,
    project_name: null,
    firing: false,
    firing_value: null,
    health: 'ok',
    health_detail: '',
    ...overrides,
  };
}

function overview(health: Partial<api.AlertOverview['health']> = {}): api.AlertOverview {
  return {
    fired_today: 0,
    unresolved: 0,
    notify_fail_today: 0,
    top_rules: [],
    health: {
      contacts: 1,
      has_enabled_contact: true,
      enabled_contacts: 1,
      broken_rules: 0,
      broken_rule_names: [],
      no_contact_rules: 0,
      notify_fail_24h: 0,
      ...health,
    },
  };
}

function setup(options: {
  health?: Partial<api.AlertOverview['health']>;
  rules?: api.AlertRuleItem[];
  audits?: api.AlertAuditItem[];
  notifications?: api.AlertNotificationItem[];
  channels?: Record<string, api.AlertChannelCapability>;
}) {
  mockApi.getAlertOverview.mockResolvedValue(overview(options.health));
  mockApi.getAlertRules.mockResolvedValue({ items: options.rules ?? [rule()] });
  mockApi.getAlertEvents.mockResolvedValue({ items: [] });
  mockApi.getAlertContacts.mockResolvedValue({ items: [] });
  mockApi.getAlertMutes.mockResolvedValue({ items: [] });
  mockApi.getAlertNotifications.mockResolvedValue({ items: options.notifications ?? [] });
  mockApi.getAlertChannels.mockResolvedValue(
    options.channels ?? {
      feishu_webhook: {
        available: true,
        reason: null,
        label: '飞书',
        group: 'chat',
        kind: 'chat',
        contact_fields: ['webhook_url'],
        required_config: [],
        hint: null,
      },
      email: {
        available: false,
        reason: '未配置：邮件（SMTP）',
        label: '邮件',
        group: 'email',
        kind: 'email',
        contact_fields: ['address'],
        required_config: ['smtp'],
        hint: null,
      },
    },
  );
  mockApi.getAlertAudits.mockResolvedValue({ items: options.audits ?? [] });
  mockApi.getAlertTemplates.mockResolvedValue({ items: [], variables: [] });
  mockApi.getAlertMetrics.mockResolvedValue({ items: [] });
  mockApi.getAlertRetention.mockResolvedValue({ items: [] });
  return render(<AlertsWorkbench />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('告警工作台 · 概览提示条', () => {
  it('没有启用联系人且有规则未指定联系人 → 提示告警不会外发', async () => {
    setup({ health: { has_enabled_contact: false, enabled_contacts: 0, no_contact_rules: 3 } });

    expect(await screen.findByText('没有启用中的联系人，告警不会外发')).toBeTruthy();
  });

  it('存在失效规则 → 列出条数与规则名', async () => {
    setup({ health: { broken_rules: 2, broken_rule_names: ['DAU 告警', 'CDN 成功率'] } });

    expect(await screen.findByText('2 条规则当前无效')).toBeTruthy();
    expect(screen.getByText(/DAU 告警、CDN 成功率/)).toBeTruthy();
  });

  it('近 24 小时有通知失败 → 显示失败次数', async () => {
    setup({ health: { notify_fail_24h: 4 } });

    expect(await screen.findByText('近 24 小时有 4 次通知投递失败')).toBeTruthy();
  });

  it('一切正常时不出现任何提示条', async () => {
    setup({});

    await screen.findByText('概览');
    expect(screen.queryByText('没有启用中的联系人，告警不会外发')).toBeNull();
    expect(screen.queryByText(/条规则当前无效/)).toBeNull();
    expect(screen.queryByText(/次通知投递失败/)).toBeNull();
  });
});

describe('告警工作台 · 策略健康标签', () => {
  it('指标被删的规则显示「指标已删除」，正常规则不显示健康标签', async () => {
    setup({
      rules: [
        rule({
          code: 'metric_x',
          name: '订单量过低',
          source: 'metric',
          metric_id: 'metric_gone',
          health: 'metric_missing',
          health_detail: '指标 metric_gone 已删除',
        }),
        rule({ code: 'disk_space_low', name: '磁盘可用空间不足', health: 'ok' }),
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: '策略' }));
    await screen.findByText('指标已删除');

    const rows = screen.getAllByRole('row');
    const brokenRow = rows.find((row) => row.textContent?.includes('订单量过低'));
    const okRow = rows.find((row) => row.textContent?.includes('磁盘可用空间不足'));

    expect(brokenRow?.textContent).toContain('指标已删除');
    // 健康列对正常规则不渲染标签
    expect(okRow?.textContent).not.toContain('指标已删除');
    expect(okRow?.textContent).not.toContain('求值失败');
    expect(okRow?.textContent).not.toContain('无联系人');
  });

  it('指标规则显示绑定的指标名与天窗口，页面不再出现「分析卡片」', async () => {
    setup({
      rules: [
        rule({
          code: 'metric_abc',
          name: '今日订单量过低',
          source: 'metric',
          metric_id: 'metric_1',
          metric_name: '订单量',
          window_days: 7,
          comparator: 'lt',
          threshold: 100,
        }),
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: '策略' }));

    const table = await screen.findByText('今日订单量过低');
    expect(table.closest('tr')?.textContent).toContain('指标：订单量');
    expect(table.closest('tr')?.textContent).toContain('近 7 天 × 1 次');
    expect(screen.queryByText(/分析卡片/)).toBeNull();
  });
});

describe('告警工作台 · v4 入口', () => {
  it('新建入口是「新建指标告警」，并存在「通知模板」Tab', async () => {
    setup({});

    expect(await screen.findByText('新建指标告警')).toBeTruthy();

    await userEvent.click(screen.getByRole('tab', { name: '通知模板' }));
    await waitFor(() => expect(mockApi.getAlertTemplates).toHaveBeenCalled());
  });
});

describe('告警工作台 · 通知记录', () => {
  it('多联系人时按投递目标分行显示（能看出是哪条通道失败）', async () => {
    setup({
      notifications: [
        {
          id: '1',
          rule_code: 'card_cache_fail',
          event_id: '9',
          kind: 'fire',
          status: 'success',
          error: null,
          contact_id: '2',
          contact_name: '飞书机器人2',
          created_at: '2026-09-16T08:46:31.858Z',
        },
        {
          id: '2',
          rule_code: 'card_cache_fail',
          event_id: '9',
          kind: 'fire',
          status: 'fail',
          error: 'feishu_code_19021(sign match fail)',
          contact_id: '3',
          contact_name: '飞书机器人',
          created_at: '2026-09-16T08:46:36.287Z',
        },
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: '通知记录' }));

    expect(await screen.findByText('飞书机器人2')).toBeTruthy();
    expect(screen.getByText('飞书机器人')).toBeTruthy();
    expect(screen.getByText(/19021/)).toBeTruthy();
  }, 60_000);
});

describe('告警工作台 · 平台邮件回落（v3.2 修订）', () => {
  const platformEmail: Record<string, api.AlertChannelCapability> = {
    email: {
      available: true,
      reason: null,
      label: '邮件',
      group: 'email',
      kind: 'email',
      contact_fields: ['address'],
      required_config: ['smtp'],
      hint: null,
      platform_fallback: true,
    },
  };

  it('email 由平台邮件通道兜底时：通道可选，并提示邮件走「用户管理 → 邮件通道」', async () => {
    setup({ channels: platformEmail });

    await userEvent.click(await screen.findByRole('tab', { name: '联系人' }));
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByTitle('邮件'));

    expect(await screen.findByText(/用户管理 → 邮件通道/)).toBeTruthy();
    expect(screen.queryByText('该通道当前不可用')).toBeNull();
  }, 60_000);

  it('平台邮件不可用时：邮件选项禁用，也不显示回落说明', async () => {
    setup({});

    await userEvent.click(await screen.findByRole('tab', { name: '联系人' }));
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    const option = await screen.findByTitle('邮件');

    expect(option.className).toContain('ant-select-item-option-disabled');
    expect(screen.queryByText(/用户管理 → 邮件通道/)).toBeNull();
  }, 60_000);
});

describe('告警工作台 · 变更记录', () => {
  it('渲染变更内容为「字段：旧 → 新」并显示操作者', async () => {
    setup({
      audits: [
        {
          id: '371',
          action: 'alert_rule_update',
          target_table: 'alertrule',
          detail: {
            code: 'slow_query_spike',
            name: '慢查询次数突增',
            changes: { threshold: { from: 20, to: 200 } },
          },
          operator: 'admin',
          created_at: '2026-09-15T07:33:29.397Z',
        },
      ],
    });

    await userEvent.click(await screen.findByRole('tab', { name: '变更记录' }));

    expect(await screen.findByText('阈值：20 → 200')).toBeTruthy();
    expect(screen.getByText('修改规则')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();
  });

  it('无变更记录时给出空态', async () => {
    setup({ audits: [] });

    await userEvent.click(await screen.findByRole('tab', { name: '变更记录' }));

    await waitFor(() => expect(screen.getByText('暂无变更记录')).toBeTruthy());
  });
});
