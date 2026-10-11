import { ConfigService } from '@nestjs/config';
import { DeepseekHarnessConfig } from '../../../config/deepseek-harness-config';
import {
  decryptSecret,
  encryptSecret,
  generateMasterKey,
} from '../../alerting/channels/channel-crypto';
import { ModelProviderStoreService } from './model-provider-store.service';

/**
 * 模型供应商写入口（v1.1：库是唯一来源，无 env / 无导入）：
 * 校验失败不落库、密钥只加密落库、审计不含明文、revision 自增。
 */
const MASTER_KEY = generateMasterKey();

function yamlConfig(overrides: Partial<DeepseekHarnessConfig> = {}): DeepseekHarnessConfig {
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
    ...overrides,
  };
}

const MODEL = {
  id: 'deepseek-v4-flash',
  display_name: 'DeepSeek V4 Flash',
  supports_image: false,
  reasoning_efforts: ['off', 'high'],
  default_reasoning_effort: 'high',
};

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'uuid-1',
    provider_id: 'tencent',
    display_name: 'Tencent TokenHub',
    adapter: 'openai_compatible',
    protocol: 'openai-completions',
    base_url: 'https://tokenhub.test/plan/v3',
    api_key_cipher: encryptSecret('sk-db-key-4321', Buffer.from(MASTER_KEY, 'base64')),
    models_json: JSON.stringify([MODEL]),
    verified_json: JSON.stringify([MODEL.id]),
    last_test_at: new Date('2026-09-22T00:00:00.000Z'),
    last_test_by: 'admin',
    updated_by: 'admin',
    updated_at: new Date('2026-09-22T00:00:00.000Z'),
    ...overrides,
  };
}

function createStore(options: {
  rows?: ReturnType<typeof providerRow>[];
  settings?: Record<string, unknown> | null;
  masterKey?: string;
} = {}) {
  const rows = options.rows ?? [];
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  let settingsUpsert: Record<string, unknown> | null = null;
  const prisma = {
    saAiModelProvider: {
      count: jest.fn(async () => rows.length),
      findMany: jest.fn(async () => rows),
      findUnique: jest.fn(
        async ({ where }: { where: { provider_id: string } }) =>
          rows.find((row) => row.provider_id === where.provider_id) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return data;
      }),
      delete: jest.fn(async () => undefined),
    },
    saAiModelSettings: {
      findUnique: jest.fn(async () => options.settings ?? null),
      upsert: jest.fn(async (args: Record<string, unknown>) => {
        settingsUpsert = args;
        return args;
      }),
      updateMany: jest.fn(async () => ({ count: rows.length > 0 ? 1 : 0 })),
    },
    opsActionLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'deepseek_harness') return yamlConfig();
      if (key === 'alerting') {
        return { configKey: options.masterKey === undefined ? MASTER_KEY : options.masterKey };
      }
      return undefined;
    }),
  } as unknown as ConfigService;
  return {
    store: new ModelProviderStoreService(prisma as never, config),
    prisma,
    created,
    updates,
    audits,
    settingsUpsert: () => settingsUpsert,
  };
}

const SAVE_INPUT = {
  display_name: 'Tencent TokenHub',
  adapter: 'openai_compatible',
  protocol: 'openai-completions',
  base_url: 'https://tokenhub.test/plan/v3',
  models: [MODEL],
};

describe('ModelProviderStoreService', () => {
  it('供应商 ID 非法时拒绝且不落库', async () => {
    const { store, prisma } = createStore();
    await expect(store.create('Tencent', SAVE_INPUT, 'admin')).rejects.toMatchObject({
      messageKey: 'ai:error.provider.idInvalid',
    });
    expect(prisma.saAiModelProvider.create).not.toHaveBeenCalled();
  });

  it('明文 HTTP 的外网接口地址被拒绝', async () => {
    const { store } = createStore();
    await expect(
      store.create('other', { ...SAVE_INPUT, base_url: 'http://api.example.com/v1' }, 'admin'),
    ).rejects.toMatchObject({ messageKey: 'ai:error.provider.baseUrlInvalid' });
  });

  it('模型 ID 重复时拒绝，并把重复的模型 ID 作为插值参数', async () => {
    const { store } = createStore();
    await expect(store.create('other', {
      ...SAVE_INPUT,
      models: [MODEL, MODEL],
    }, 'admin')).rejects.toMatchObject({
      messageKey: 'ai:error.provider.modelDuplicate',
      // 文案里是「{{id}}」：参数漏传会让用户只看到一句没有主语的提示
      params: { id: MODEL.id },
    });
  });

  it('新增第一个供应商：自动成为默认供应商，密钥加密入库、审计不含明文', async () => {
    const { store, created, audits, settingsUpsert } = createStore();
    await store.create('tencent', { ...SAVE_INPUT, api_key: 'sk-plain-text-secret' }, 'admin');

    expect(created).toHaveLength(1);
    const cipher = String(created[0].api_key_cipher);
    expect(cipher).not.toContain('sk-plain-text-secret');
    expect(decryptSecret(cipher, Buffer.from(MASTER_KEY, 'base64'))).toBe('sk-plain-text-secret');
    // 空库第一次写入时默认值由该供应商补全（否则会因为没有默认值而拒绝保存）
    expect(settingsUpsert()).toMatchObject({
      create: { default_provider: 'tencent', default_model: MODEL.id },
    });
    expect(audits[0]).toMatchObject({
      action: 'ai_model_provider_create',
      detail: { provider_id: 'tencent', key_updated: true },
    });
    expect(JSON.stringify(audits)).not.toContain('sk-plain-text-secret');
  });

  it('审计记录模型的图片能力，便于事后核对谁开了多模态', async () => {
    const { store, audits } = createStore();
    await store.create('tencent', {
      ...SAVE_INPUT,
      models: [{ ...MODEL, supports_image: true }],
    }, 'admin');
    expect(audits[0].detail).toMatchObject({ image_models: [MODEL.id] });
  });

  it('编辑时密钥留空 = 不修改已保存的密文', async () => {
    const { store, updates, audits } = createStore({ rows: [providerRow()] });
    await store.update('tencent', { ...SAVE_INPUT, display_name: 'Tencent 改名' }, 'admin');

    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty('api_key_cipher');
    expect(updates[0].display_name).toBe('Tencent 改名');
    expect(audits[0].detail).toMatchObject({ key_updated: false });
  });

  it('主密钥缺失时拒绝保存新密钥（明文不入库）', async () => {
    const { store, prisma } = createStore({ rows: [providerRow()], masterKey: '' });
    await expect(
      store.update('tencent', { ...SAVE_INPUT, api_key: 'sk-would-be-plain' }, 'admin'),
    ).rejects.toMatchObject({ messageKey: 'ai:error.provider.masterKeyMissing' });
    expect(prisma.saAiModelProvider.update).not.toHaveBeenCalled();
  });

  it('把最后一个供应商删光被拒绝（清单不能为空）', async () => {
    const { store, prisma } = createStore({ rows: [providerRow()] });
    await expect(store.remove('tencent', 'admin')).rejects.toMatchObject({
      messageKey: 'ai:error.provider.empty',
    });
    expect(prisma.saAiModelProvider.delete).not.toHaveBeenCalled();
  });

  it('删除默认供应商被拒绝（默认值必须落在清单内）', async () => {
    const { store } = createStore({
      rows: [providerRow(), providerRow({ id: 'uuid-2', provider_id: 'other', display_name: 'Other' })],
      settings: {
        id: 'singleton',
        default_provider: 'tencent',
        default_model: MODEL.id,
        default_reasoning_effort: 'high',
        revision: 3,
        updated_by: 'admin',
        updated_at: new Date('2026-09-22T00:00:00.000Z'),
      },
    });
    await expect(store.remove('tencent', 'admin')).rejects.toMatchObject({
      messageKey: 'ai:error.provider.defaultProviderMissing',
    });
  });

  it('保存默认模型要求三元组自洽', async () => {
    const { store, prisma } = createStore({ rows: [providerRow()] });
    await expect(
      store.saveDefaults({ provider: 'tencent', model: MODEL.id, reasoning_effort: 'max' }, 'admin'),
    ).rejects.toMatchObject({ messageKey: 'ai:error.provider.defaultEffortInvalid' });
    expect(prisma.saAiModelSettings.upsert).not.toHaveBeenCalled();

    await store.saveDefaults({ provider: 'tencent', model: MODEL.id, reasoning_effort: 'off' }, 'admin');
    expect(prisma.saAiModelSettings.upsert).toHaveBeenCalled();
  });

  it('v1.2：未验证的模型不算可用（有密钥也不下发）', async () => {
    const { store } = createStore({ rows: [providerRow({ verified_json: '[]' })] });
    const load = await store.loadDatabase();
    expect(Object.keys(load.providers)).toEqual([]);
    expect(load.entries[0].verified).toEqual([]);
    expect(load.entries[0].usableModels).toEqual([]);

    const view = await store.adminView();
    expect(view.providers[0].usable).toBe(false);
    expect(view.providers[0].models[0]).toMatchObject({ verified: false, usable: false });
  });

  it('v1.2：验证通过后才可用，且只下发验证过的模型', async () => {
    const second = { ...MODEL, id: 'deepseek-v4-pro', display_name: 'Pro' };
    const { store } = createStore({
      rows: [providerRow({
        models_json: JSON.stringify([MODEL, second]),
        verified_json: JSON.stringify([second.id]),
      })],
    });
    const load = await store.loadDatabase();
    expect(load.providers.tencent.models.map((model) => model.id)).toEqual([second.id]);
    const view = await store.adminView();
    expect(view.providers[0].usable).toBe(true);
    expect(view.providers[0].models).toMatchObject([
      { id: MODEL.id, verified: false, usable: false },
      { id: second.id, verified: true, usable: true },
    ]);
  });

  it('v1.2：改写供应商配置会清空验证状态（改了地址就不该沿用旧验证）', async () => {
    const { store, updates } = createStore({ rows: [providerRow()] });
    await store.update('tencent', SAVE_INPUT, 'admin');
    expect(updates[0]).toMatchObject({ verified_json: '[]', last_test_at: null, last_test_by: null });
  });

  it('v1.2：测试结果逐模型落库（通过加入、失败移出）', async () => {
    const { store, updates } = createStore({ rows: [providerRow({ verified_json: '["a","b"]' })] });
    await store.recordTest('tencent', 'b', false, 'admin');
    expect(JSON.parse(String(updates[0].verified_json))).toEqual(['a']);

    await store.recordTest('tencent', 'c', true, 'admin');
    expect(JSON.parse(String(updates[1].verified_json))).toEqual(['a', 'b', 'c']);
    expect(updates[1]).toMatchObject({ last_test_by: 'admin' });
  });

  it('v1.2：默认模型必须是可用模型，未验证/无密钥一律拒绝', async () => {
    const { store } = createStore({ rows: [providerRow({ verified_json: '[]' })] });
    await expect(
      store.saveDefaults({ provider: 'tencent', model: MODEL.id, reasoning_effort: 'high' }, 'admin'),
    ).rejects.toMatchObject({ messageKey: 'ai:error.provider.defaultUnavailable' });
  });

  it('视图只回显密钥末 4 位，密文不可解密时显式标红', async () => {
    const { store } = createStore({ rows: [providerRow()] });
    const view = await store.adminView();
    expect(view.providers[0].key).toMatchObject({
      configured: true,
      hint: '••••4321',
      unreadable: false,
    });
    expect(JSON.stringify(view)).not.toContain('sk-db-key-4321');

    const { store: broken } = createStore({ rows: [providerRow()], masterKey: generateMasterKey() });
    const brokenView = await broken.adminView();
    expect(brokenView.providers[0].key).toMatchObject({ configured: false, unreadable: true });
  });
});
