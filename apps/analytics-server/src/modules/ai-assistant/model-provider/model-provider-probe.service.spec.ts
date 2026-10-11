import { DeepseekHarnessProviderConfig } from '../../../config/deepseek-harness-config';
import { ModelProviderProbeService } from './model-provider-probe.service';

/**
 * 连通性探测（v1.2）：请求形状与模型出口网关一致；不带 model 时测全部模型；
 * 每个模型的结果都落库（决定它能不能出现在助手的模型列表里）。
 */
const MODEL = {
  id: 'deepseek-v4-flash',
  display_name: 'DeepSeek V4 Flash',
  supports_image: false,
  reasoning_efforts: ['off', 'high'],
  default_reasoning_effort: 'high',
};
const SECOND_MODEL = { ...MODEL, id: 'deepseek-v4-pro', display_name: 'DeepSeek V4 Pro' };

function shape(overrides: Partial<DeepseekHarnessProviderConfig> = {}) {
  return {
    adapter: 'openai_compatible' as const,
    display_name: 'Tencent TokenHub',
    base_url: 'https://tokenhub.test/plan/v3/',
    protocol: 'openai-completions' as const,
    models: [MODEL, SECOND_MODEL],
    ...overrides,
  };
}

function createProbe(options: {
  key?: string;
  models?: unknown[];
  found?: boolean;
  protocol?: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
} = {}) {
  const recorded: Array<{ model: string; ok: boolean }> = [];
  const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const entry = {
    row: { provider_id: 'tencent', updated_at: new Date('2026-09-22T00:00:00.000Z') },
    shape: shape({
      ...(options.protocol ? { protocol: options.protocol } : {}),
      models: (options.models ?? [MODEL, SECOND_MODEL]) as never,
    }),
    key: {
      plain: options.key === undefined ? 'sk-probe-secret-1234' : options.key,
      hint: '••••1234',
      unreadable: false,
    },
    verified: [],
    usableModels: [],
  };
  const store = {
    loadDatabase: jest.fn(async () => ({
      entries: options.found === false ? [] : [entry],
      settings: null,
      providers: {},
      unreadable: [],
      broken: [],
      revision: '1.0',
    })),
    recordTest: jest.fn(async (_id: string, model: string, ok: boolean) => {
      recorded.push({ model, ok });
    }),
    audit: jest.fn(async (action: string, detail: Record<string, unknown>) => {
      audits.push({ action, detail });
    }),
  };
  return {
    probe: new ModelProviderProbeService(store as never),
    store,
    recorded,
    audits,
  };
}

function mockFetch(status: number, body: string) {
  const fetchMock = jest.fn(async () => ({ status, text: async () => body }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('ModelProviderProbeService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('不带 model 时逐个测试全部模型，并逐个记录结果', async () => {
    mockFetch(200, '{"choices":[]}');
    const { probe, recorded, audits } = createProbe();

    const { results } = await probe.test('tencent', undefined, 'admin');

    expect(results.map((item) => item.model)).toEqual([MODEL.id, SECOND_MODEL.id]);
    expect(results.every((item) => item.ok)).toBe(true);
    expect(recorded).toEqual([
      { model: MODEL.id, ok: true },
      { model: SECOND_MODEL.id, ok: true },
    ]);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ action: 'ai_model_provider_test', detail: { ok: true } });
  });

  it('openai-completions：路径接在 base_url 之后，带 Bearer 与最小请求体', async () => {
    const fetchMock = mockFetch(200, '{"choices":[]}');
    const { probe } = createProbe({ models: [MODEL] });

    await probe.test('tencent', MODEL.id, 'admin');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://tokenhub.test/plan/v3/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-probe-secret-1234');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: MODEL.id,
      max_tokens: 16,
      stream: false,
    });
  });

  it('openai-responses：走 /responses 且用 max_output_tokens', async () => {
    const fetchMock = mockFetch(200, '{}');
    const { probe } = createProbe({ models: [MODEL], protocol: 'openai-responses' });

    await probe.test('tencent', MODEL.id, 'admin');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://tokenhub.test/plan/v3/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({ input: 'ping', max_output_tokens: 16 });
  });

  it('anthropic-messages：走 /messages 且带 x-api-key 与版本头', async () => {
    const fetchMock = mockFetch(200, '{}');
    const { probe } = createProbe({ models: [MODEL], protocol: 'anthropic-messages' });

    await probe.test('tencent', MODEL.id, 'admin');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://tokenhub.test/plan/v3/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-probe-secret-1234');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('上游 4xx：返回厂商原始错误、记为失败（该模型不会被放行），且不含密钥', async () => {
    mockFetch(401, '{"error":{"message":"invalid api key"}}');
    const { probe, recorded, audits } = createProbe({ models: [MODEL] });

    const { results } = await probe.test('tencent', MODEL.id, 'admin');

    expect(results[0]).toMatchObject({ ok: false, status: 401 });
    expect(results[0].detail).toContain('invalid api key');
    expect(JSON.stringify(results)).not.toContain('sk-probe-secret-1234');
    expect(recorded).toEqual([{ model: MODEL.id, ok: false }]);
    expect(audits[0]).toMatchObject({ detail: { ok: false, status: 401 } });
  });

  it('没有密钥时直接返回可本地化的未配置错误，不发请求并记为失败', async () => {
    const fetchMock = mockFetch(200, '{}');
    const { probe, recorded } = createProbe({ key: '', models: [MODEL] });

    const { results } = await probe.test('tencent', MODEL.id, 'admin');

    expect(results[0]).toMatchObject({
      ok: false,
      status: 0,
      error_code: 'provider_not_configured',
      error_key: 'ai:error.gateway.providerNotConfigured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recorded).toEqual([{ model: MODEL.id, ok: false }]);
  });

  it('模型不在该供应商清单内时拒绝探测，并带上模型名插值', async () => {
    const { probe } = createProbe();
    await expect(probe.test('tencent', 'ghost-model', 'admin')).rejects.toMatchObject({
      messageKey: 'ai:error.provider.testModelMissing',
      params: { model: 'ghost-model' },
    });
  });

  it('供应商不存在时报 404 语义错误', async () => {
    const { probe } = createProbe({ found: false });
    await expect(probe.test('ghost', undefined, 'admin')).rejects.toMatchObject({
      messageKey: 'ai:error.provider.notFound',
    });
  });
});
