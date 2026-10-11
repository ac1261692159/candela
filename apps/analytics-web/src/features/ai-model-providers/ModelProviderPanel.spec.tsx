// @vitest-environment jsdom
/**
 * 模型供应商设置面板（phase: clklog-ai-model-providers-v1 v1.1）。
 *
 * 覆盖最容易出错的契约：
 * 1) 密钥留空时**不下发** api_key（否则会把已保存的密钥抹成空串）；
 * 2) 一个供应商都没有时显示空状态与新增入口，而不是一张空表；
 * 3) 密文解不开时显式标红；图片能力在表格里可见。
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getModelProviders = vi.fn();
vi.mock('../../services/ai.service', () => ({
  getModelProviders: (...args: unknown[]) => getModelProviders(...(args as [])),
  createModelProvider: vi.fn(),
  updateModelProvider: vi.fn(),
  deleteModelProvider: vi.fn(),
  saveModelDefaults: vi.fn(),
  testModelProvider: vi.fn(),
  applyModelProviders: vi.fn(),
}));

import { ModelProviderPanel } from './ModelProviderPanel';
import { toSavePayload, type ProviderFormValues } from './ProviderFormModal';

const MODEL = {
  id: 'deepseek-v4-flash',
  display_name: 'DeepSeek V4 Flash',
  supports_image: false,
  reasoning_efforts: ['off', 'high'],
  default_reasoning_effort: 'high',
  verified: true,
  usable: true,
};

const READONLY = {
  enabled: true,
  permission_preset: 'workspace_write',
  runtime: { max_runtimes: 8 },
  workspace: { max_bytes: 1_073_741_824 },
};

function view(overrides: Record<string, unknown> = {}) {
  return {
    revision: '1.0',
    defaults: { provider: 'tencent', model: MODEL.id, reasoning_effort: 'high' },
    providers: [
      {
        provider_id: 'tencent',
        display_name: 'Tencent TokenHub',
        adapter: 'openai_compatible',
        protocol: 'openai-completions',
        base_url: 'https://tokenhub.test/plan/v3',
        key: { configured: true, hint: '••••DA7g', unreadable: false },
        models: [MODEL],
        usable: true,
        last_test_at: '2026-09-22T00:00:00.000Z',
        last_test_by: 'admin',
        updated_by: 'admin',
        updated_at: '2026-09-22T00:00:00.000Z',
      },
    ],
    readonly: READONLY,
    applyable_runtimes: 0,
    key_master_missing: false,
    ...overrides,
  };
}

describe('toSavePayload', () => {
  const values: ProviderFormValues = {
    provider_id: 'tencent',
    display_name: '  Tencent TokenHub  ',
    adapter: 'openai_compatible',
    protocol: 'openai-completions',
    base_url: ' https://tokenhub.test/plan/v3 ',
    api_key: '',
    models: [{ ...MODEL, id: ' deepseek-v4-flash ', display_name: ' DeepSeek V4 Flash ' }],
  };

  it('密钥留空时不下发 api_key，字段做去空格并补齐图片标记', () => {
    const { payload } = toSavePayload(values, true);
    expect(payload).not.toHaveProperty('api_key');
    expect(payload.display_name).toBe('Tencent TokenHub');
    expect(payload.base_url).toBe('https://tokenhub.test/plan/v3');
    expect(payload.models[0]).toMatchObject({
      id: 'deepseek-v4-flash',
      display_name: 'DeepSeek V4 Flash',
      supports_image: false,
    });
  });

  it('填了密钥才下发 api_key，图片能力原样透传', () => {
    const { payload } = toSavePayload({
      ...values,
      api_key: 'sk-plain',
      models: [{ ...MODEL, supports_image: true }],
    }, false);
    expect(payload.api_key).toBe('sk-plain');
    expect(payload.models[0].supports_image).toBe(true);
  });
});

describe('ModelProviderPanel', () => {
  beforeEach(() => {
    getModelProviders.mockReset();
  });

  it('一个供应商都没有时给空状态与新增入口，不给空表格', async () => {
    getModelProviders.mockResolvedValue(
      view({ providers: [], defaults: { provider: '', model: '', reasoning_effort: '' } }),
    );
    render(<ModelProviderPanel />);

    expect(await screen.findByText('还没有模型供应商')).toBeTruthy();
    // 空状态与卡片标题各有一个「新增供应商」按钮
    expect(screen.getAllByRole('button', { name: /新增供应商/ }).length).toBeGreaterThan(0);
  });

  it('密钥密文不可解密时给出红字告警', async () => {
    getModelProviders.mockResolvedValue(
      view({
        providers: [
          {
            ...view().providers[0],
            key: { configured: false, hint: null, unreadable: true },
          },
        ],
      }),
    );
    render(<ModelProviderPanel />);

    expect(await screen.findByText('有供应商的密钥无法解密')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('密文不可解密')).toBeTruthy());
  });

  it('展示密钥末 4 位，并对支持图片的模型打标', async () => {
    getModelProviders.mockResolvedValue(
      view({
        providers: [
          {
            ...view().providers[0],
            models: [MODEL, { ...MODEL, id: 'deepseek-v4-vision', supports_image: true }],
          },
        ],
      }),
    );
    render(<ModelProviderPanel />);

    expect(await screen.findByText('已配置 ••••DA7g')).toBeTruthy();
    expect(screen.getAllByText('Tencent TokenHub').length).toBeGreaterThan(0);
    // 图片能力在模型列以说明文字给出
    expect(screen.getAllByText('支持图片输入').length).toBeGreaterThan(0);
  });

  it('v1.2：未验证的模型标为未测试，且该供应商提示不会出现在助手模型列表里', async () => {
    getModelProviders.mockResolvedValue(
      view({
        providers: [
          {
            ...view().providers[0],
            models: [{ ...MODEL, verified: false, usable: false }],
            usable: false,
          },
        ],
      }),
    );
    render(<ModelProviderPanel />);

    expect(await screen.findByTitle(/未测试/)).toBeTruthy();
    expect(screen.getByText('该供应商暂无可用模型，不会出现在助手的模型列表里')).toBeTruthy();
  });
});
