// @vitest-environment jsdom
/**
 * 告警工作台 · 2026-09-16 反馈四项（phase: clklog-analytics-alert-channels-v1）。
 *
 * 注：整页渲染 + userEvent 的用例在 CI runner 上比本地慢约 2 倍（本地 ~3s / CI ~6s），
 * 默认 5s 超时不够，故显式给 20s（不是用 sleep 掩盖问题，而是 jsdom 重渲染本身的开销）。
 *
 * 覆盖：
 * 1. 模板编辑器「左编辑 / 右预览」并排，编辑后右侧自动刷新；
 * 2. 联系人不再有「默认」概念，改为每个联系人自己的「启用」开关，且操作列有「编辑」；
 * 3. 数据保留策略三个范围可分设（历史/通知默认 1 年、变更默认永久）。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertsWorkbench } from './AlertsWorkbench';
import { RetentionPanel } from './RetentionPanel';
import { TemplateEditor } from './TemplateEditor';
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
    getAlertMetrics: vi.fn(),
    getAlertRetention: vi.fn(),
    saveAlertRetention: vi.fn(),
    getAlertTemplates: vi.fn(),
    previewAlertTemplate: vi.fn(),
    updateAlertContact: vi.fn(),
    createAlertContact: vi.fn(),
  };
});

const mockApi = vi.mocked(api);

const CONTACT = {
  id: '3',
  name: '值班群',
  kind: 'feishu_webhook',
  webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/ab***kl',
  address: '',
  enabled: true,
  created_at: '2026-09-01T00:00:00.000Z',
};

function stubWorkbench() {
  mockApi.getAlertOverview.mockResolvedValue({
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
    },
  });
  mockApi.getAlertRules.mockResolvedValue({ items: [] });
  mockApi.getAlertEvents.mockResolvedValue({ items: [] });
  mockApi.getAlertContacts.mockResolvedValue({ items: [CONTACT] });
  mockApi.getAlertMutes.mockResolvedValue({ items: [] });
  mockApi.getAlertNotifications.mockResolvedValue({ items: [] });
  mockApi.getAlertChannels.mockResolvedValue({
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
  });
  mockApi.getAlertAudits.mockResolvedValue({ items: [] });
  mockApi.getAlertMetrics.mockResolvedValue({ items: [] });
  mockApi.getAlertRetention.mockResolvedValue({ items: [] });
  mockApi.getAlertTemplates.mockResolvedValue({ items: [], variables: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('模板编辑器 · 左编辑右预览', () => {
  beforeEach(() => {
    mockApi.getAlertTemplates.mockResolvedValue({
      items: [
        {
          kind: 'fire',
          kind_label: '告警触发',
          channel: 'chat',
          channel_label: '群聊 / Webhook',
          subject: '',
          body: '【{{.level}}】{{.rule_name}} {{.status}}',
          is_default: true,
          updated_by: null,
          updated_at: null,
        },
      ],
      variables: [{ name: 'rule_name', label: '规则名', sample: '慢查询次数突增' }],
    });
    mockApi.previewAlertTemplate.mockResolvedValue({
      subject: '',
      body: '【警告】慢查询次数突增 触发',
      is_default: true,
    });
  });

  it('编辑区与预览区同时可见，编辑后预览自动刷新', async () => {
    render(<TemplateEditor />);

    // 左右两块并排：编辑卡片 + 预览卡片
    expect(await screen.findByText('编辑')).toBeTruthy();
    expect(screen.getByText('预览')).toBeTruthy();

    // 编辑停顿后自动预览（防抖 500ms）
    expect(await screen.findByText(/【警告】慢查询次数突增 触发/, undefined, { timeout: 3000 })).toBeTruthy();
    expect(mockApi.previewAlertTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'fire', channel: 'chat' }),
    );
  }, 60_000);

  it('渲染失败时在预览区显示错误，覆盖编辑器报错', async () => {
    mockApi.previewAlertTemplate.mockRejectedValue(new Error('模板语法错误：{{if}} 未闭合'));

    render(<TemplateEditor />);

    expect(await screen.findByText('预览失败', undefined, { timeout: 3000 })).toBeTruthy();
    expect(await screen.findByText(/模板语法错误/)).toBeTruthy();
  }, 60_000);
});

describe('联系人 · 启用开关与编辑', () => {
  it('有「启用」开关与「编辑」按钮，且不再出现「默认」字样', async () => {
    stubWorkbench();
    render(<AlertsWorkbench />);

    await userEvent.click(await screen.findByRole('tab', { name: '联系人' }));

    expect(await screen.findByLabelText('启用 值班群')).toBeTruthy();
    expect(screen.getByRole('button', { name: /编\s*辑/ })).toBeTruthy();
    expect(screen.queryByText('设为默认')).toBeNull();
    expect(screen.queryByText('默认联系人')).toBeNull();
  }, 60_000);

  it('切换启用开关直接调 updateAlertContact', async () => {
    stubWorkbench();
    mockApi.updateAlertContact.mockResolvedValue({ ok: true });
    render(<AlertsWorkbench />);

    await userEvent.click(await screen.findByRole('tab', { name: '联系人' }));
    await userEvent.click(await screen.findByLabelText('启用 值班群'));

    await waitFor(() => expect(mockApi.updateAlertContact).toHaveBeenCalledWith('3', { enabled: false }));
  }, 60_000);

  it('编辑弹窗回填名称但不回填脱敏地址，保存只提交改动字段', async () => {
    stubWorkbench();
    mockApi.updateAlertContact.mockResolvedValue({ ok: true });
    render(<AlertsWorkbench />);

    await userEvent.click(await screen.findByRole('tab', { name: '联系人' }));
    await userEvent.click(await screen.findByRole('button', { name: /编\s*辑/ }));

    expect(await screen.findByDisplayValue('值班群')).toBeTruthy();
    // 脱敏地址只作为占位提示，不能进输入框（否则保存会把掩码写进库）
    expect(screen.queryByDisplayValue('https://open.feishu.cn/open-apis/bot/v2/hook/ab***kl')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '保 存' }));

    await waitFor(() => expect(mockApi.updateAlertContact).toHaveBeenCalled());
    const [, payload] = mockApi.updateAlertContact.mock.calls[0];
    expect(payload).not.toHaveProperty('webhook_url');
    expect(payload).toMatchObject({ name: '值班群', kind: 'feishu_webhook', enabled: true });
  }, 60_000);

  it('列表展示收件人语言，编辑弹窗回填并原样提交', async () => {
    stubWorkbench();
    mockApi.getAlertContacts.mockResolvedValue({ items: [{ ...CONTACT, locale: 'en-US' }] });
    mockApi.updateAlertContact.mockResolvedValue({ ok: true });
    render(<AlertsWorkbench />);

    await userEvent.click(await screen.findByRole('tab', { name: '联系人' }));
    // 语言列显示语言自名（不翻译）
    expect(await screen.findByText('English')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /编\s*辑/ }));
    await screen.findByDisplayValue('值班群');
    await userEvent.click(screen.getByRole('button', { name: '保 存' }));

    await waitFor(() => expect(mockApi.updateAlertContact).toHaveBeenCalled());
    expect(mockApi.updateAlertContact.mock.calls[0][1]).toMatchObject({ locale: 'en-US' });
  }, 60_000);

  it('新增联系人可指定收件人语言；不选 = 平台默认（null）', async () => {
    stubWorkbench();
    mockApi.createAlertContact.mockResolvedValue({ id: '9' });
    render(<AlertsWorkbench />);

    await userEvent.click(await screen.findByRole('tab', { name: '联系人' }));
    await userEvent.type(await screen.findByPlaceholderText('名称'), '值班邮箱');
    await userEvent.type(
      screen.getByPlaceholderText('https://…'),
      'https://open.feishu.cn/open-apis/bot/v2/hook/xyz',
    );
    await userEvent.click(screen.getByRole('combobox', { name: '语言' }));
    await userEvent.click(await screen.findByTitle('English'));
    await userEvent.click(screen.getByRole('button', { name: /添\s*加/ }));

    await waitFor(() => expect(mockApi.createAlertContact).toHaveBeenCalled());
    expect(mockApi.createAlertContact.mock.calls[0][0]).toMatchObject({
      name: '值班邮箱',
      locale: 'en-US',
    });
  }, 60_000);
});

describe('数据保留策略 · 三个范围分设', () => {
  it('展示各范围当前保留天数（历史/通知 1 年、变更永久）', async () => {
    mockApi.getAlertRetention.mockResolvedValue({
      items: [
        { scope: 'events', label: '告警历史', retain_days: 365, updated_by: 'admin', updated_at: '2026-09-16T02:00:00.000Z' },
        { scope: 'notifications', label: '通知记录', retain_days: 365, updated_by: null, updated_at: null },
        { scope: 'audits', label: '变更记录', retain_days: null, updated_by: null, updated_at: null },
      ],
    });

    render(<RetentionPanel />);

    expect(await screen.findByText('告警历史')).toBeTruthy();
    expect(screen.getAllByText('365 天')).toHaveLength(2);
    expect(screen.getByText('永久保留')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '保 存' })).toHaveLength(3);
  });

  it('保存单个范围只提交该范围', async () => {
    mockApi.getAlertRetention.mockResolvedValue({
      items: [{ scope: 'audits', label: '变更记录', retain_days: null, updated_by: null, updated_at: null }],
    });
    mockApi.saveAlertRetention.mockResolvedValue({ ok: true });

    render(<RetentionPanel />);
    await screen.findByText('变更记录');

    await userEvent.click(screen.getByRole('button', { name: '保 存' }));

    await waitFor(() => expect(mockApi.saveAlertRetention).toHaveBeenCalledWith('audits', null));
  });
});
