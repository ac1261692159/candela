import { ConfigService } from '@nestjs/config';
import { DeepseekHarnessConfig } from '../../../config/deepseek-harness-config';
import { encryptSecret, generateMasterKey } from '../../alerting/channels/channel-crypto';
import { ModelProviderRegistryService } from './model-provider-registry.service';
import { ModelProviderStoreService } from './model-provider-store.service';

/**
 * 有效配置合成（v1.1）：库是唯一来源，没有配置文件/环境变量回退；
 * 密文不可解密时不静默降级；未配置供应商时快照标记 configured=false。
 */
const MASTER_KEY = generateMasterKey();
const OTHER_KEY = generateMasterKey();

const MODEL = {
  id: 'deepseek-v4-flash',
  display_name: 'DeepSeek V4 Flash',
  supports_image: false,
  reasoning_efforts: ['off', 'high'],
  default_reasoning_effort: 'high',
};
const OTHER_MODEL = { ...MODEL, id: 'deepseek-v4-pro', display_name: 'Pro' };

function yamlConfig(): DeepseekHarnessConfig {
  return {
    enabled: true,
    runtime: {
      linux_user: 'harness',
      home_subdir: 'clklog-ai',
      idle_ttl_ms: 900_000,
      max_runtimes: 8,
      max_tokens: 8_192,
      container_image: 'docker.io/library/node:24.20.0-bookworm-slim',
    },
    workspace: {
      default_kind: 'persistent',
      temporary_ttl_ms: 86_400_000,
      recovery_retention_ms: 604_800_000,
      max_bytes: 1_073_741_824,
    },
    defaults: { permission_preset: 'workspace_write' },
  };
}

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'uuid-1',
    provider_id: 'tencent',
    display_name: 'Tencent TokenHub',
    adapter: 'openai_compatible',
    protocol: 'openai-completions',
    base_url: 'https://tokenhub.test/plan/v3',
    api_key_cipher: encryptSecret('sk-from-database', Buffer.from(MASTER_KEY, 'base64')),
    models_json: JSON.stringify([MODEL]),
    verified_json: JSON.stringify([MODEL.id]),
    last_test_at: new Date('2026-09-22T00:00:00.000Z'),
    last_test_by: 'admin',
    updated_by: 'admin',
    updated_at: new Date('2026-09-22T00:00:00.000Z'),
    ...overrides,
  };
}

function createRegistry(options: {
  rows?: ReturnType<typeof dbRow>[];
  settings?: Record<string, unknown> | null;
  masterKey?: string;
  failLoad?: boolean;
} = {}) {
  const rows = options.rows ?? [];
  const prisma = {
    saAiModelProvider: {
      count: jest.fn(async () => rows.length),
      findMany: jest.fn(async () => {
        if (options.failLoad) throw new Error('db_down');
        return rows;
      }),
      findUnique: jest.fn(async () => null),
    },
    saAiModelSettings: {
      findUnique: jest.fn(async () => options.settings ?? null),
    },
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'deepseek_harness') return yamlConfig();
      if (key === 'alerting') return { configKey: options.masterKey ?? MASTER_KEY };
      return undefined;
    }),
  } as unknown as ConfigService;
  const store = new ModelProviderStoreService(prisma as never, config);
  return { registry: new ModelProviderRegistryService(store), store, prisma };
}

describe('ModelProviderRegistryService', () => {
  it('库为空时清单为空，且标记未配置（不再回退配置文件）', async () => {
    const { registry } = createRegistry({ rows: [] });
    const snapshot = await registry.refresh();
    expect(snapshot.configured).toBe(false);
    expect(Object.keys(snapshot.providers)).toEqual([]);
    expect(snapshot.defaults).toEqual({ provider: '', model: '', reasoning_effort: '' });
    // 部署预设仍来自配置文件
    expect(snapshot.enabled).toBe(true);
  });

  it('v1.2：有密钥但没测试通过 → 不算可用，供应商整条不下发', async () => {
    const { registry } = createRegistry({ rows: [dbRow({ verified_json: '[]' })] });
    const snapshot = await registry.refresh();
    expect(snapshot.configured).toBe(false);
    expect(Object.keys(snapshot.providers)).toEqual([]);
  });

  it('v1.2：只下发验证通过的模型，未验证的不出现在模型列表里', async () => {
    const { registry } = createRegistry({
      rows: [dbRow({
        models_json: JSON.stringify([MODEL, OTHER_MODEL]),
        verified_json: JSON.stringify([OTHER_MODEL.id]),
      })],
    });
    const snapshot = await registry.refresh();
    expect(snapshot.configured).toBe(true);
    expect(snapshot.providers.tencent.models.map((model) => model.id)).toEqual([OTHER_MODEL.id]);
  });

  it('v1.2：默认模型不可用时退到第一个可用模型（不写坏会话配置）', async () => {
    const { registry } = createRegistry({
      rows: [dbRow({
        models_json: JSON.stringify([MODEL, OTHER_MODEL]),
        verified_json: JSON.stringify([OTHER_MODEL.id]),
      })],
      settings: {
        id: 'singleton',
        default_provider: 'tencent',
        default_model: MODEL.id,
        default_reasoning_effort: 'high',
        revision: 2,
        updated_by: 'admin',
        updated_at: new Date('2026-09-22T00:00:00.000Z'),
      },
    });
    const snapshot = await registry.refresh();
    expect(snapshot.defaults).toEqual({
      provider: 'tencent',
      model: OTHER_MODEL.id,
      reasoning_effort: 'high',
    });
  });

  it('库行即清单：字段与默认值都取自库', async () => {
    const { registry } = createRegistry({
      rows: [dbRow()],
      settings: {
        id: 'singleton',
        default_provider: 'tencent',
        default_model: 'deepseek-v4-flash',
        default_reasoning_effort: 'off',
        revision: 7,
        updated_by: 'admin',
        updated_at: new Date('2026-09-22T00:00:00.000Z'),
      },
    });
    const snapshot = await registry.refresh();
    expect(snapshot.configured).toBe(true);
    expect(snapshot.revision).toBe(`7.${new Date('2026-09-22T00:00:00.000Z').getTime()}`);
    expect(snapshot.providers.tencent.base_url).toBe('https://tokenhub.test/plan/v3');
    expect(snapshot.providers.tencent.configured).toBe(true);
    expect(snapshot.providers.tencent.resolved_api_key).toBe('sk-from-database');
    expect(snapshot.defaults.reasoning_effort).toBe('off');
  });

  it('v1.2：没有密钥 → 没有可用模型，供应商整条不下发', async () => {
    const { registry } = createRegistry({ rows: [dbRow({ api_key_cipher: null })] });
    const snapshot = await registry.refresh();
    expect(Object.keys(snapshot.providers)).toEqual([]);
    expect(snapshot.configured).toBe(false);
  });

  it('密文解不开（主密钥被换）时标记 unreadable，且没有任何回退来源', async () => {
    const { registry } = createRegistry({
      rows: [dbRow({ api_key_cipher: encryptSecret('sk-lost', Buffer.from(OTHER_KEY, 'base64')) })],
    });
    const snapshot = await registry.refresh();
    expect(snapshot.unreadable).toEqual(['tencent']);
    // 解不开的密文等同于没有密钥：模型不可用、供应商不下发
    expect(Object.keys(snapshot.providers)).toEqual([]);
    expect(snapshot.configured).toBe(false);
  });

  it('库行无法解析时跳过该行并记入 broken，不影响其余供应商', async () => {
    const { registry } = createRegistry({
      rows: [
        dbRow(),
        dbRow({ provider_id: 'bad', models_json: '{not json' }),
      ],
    });
    const snapshot = await registry.refresh();
    expect(snapshot.broken).toEqual(['bad']);
    expect(Object.keys(snapshot.providers)).toEqual(['tencent']);
  });

  it('读库失败时给空快照（等价未配置）而不是假装配置还在', async () => {
    const { registry } = createRegistry({ rows: [dbRow()], failLoad: true });
    const snapshot = await registry.refresh();
    expect(snapshot.configured).toBe(false);
    expect(Object.keys(snapshot.providers)).toEqual([]);
  });

  it('snapshot() 是同步的：缓存未就绪时也不阻塞，先给可用快照', () => {
    const { registry } = createRegistry({ rows: [dbRow()] });
    expect(registry.snapshot()).toBeDefined();
    expect(registry.provider('nope')).toBeUndefined();
  });
});
