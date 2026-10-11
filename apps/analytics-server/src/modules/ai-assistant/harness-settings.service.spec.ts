import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { HarnessSettingsService } from './harness-settings.service';

/**
 * 会话生成器写盘：cordis.patch.yml 用有效快照的供应商；
 * settings.yaml 必须**合并写**（DSH 会往同一个文件写别的偏好），且值相同时不重写。
 */
const MODEL = {
  id: 'deepseek-v4-flash',
  display_name: 'DeepSeek V4 Flash',
  supports_image: false,
  reasoning_efforts: ['off', 'high'],
  default_reasoning_effort: 'high',
};

const IMAGE_MODEL = { ...MODEL, id: 'deepseek-v4-vision', display_name: 'Vision', supports_image: true };

async function createService(snapshotOverrides: Record<string, unknown> = {}) {
  const dshHome = await mkdtemp(join(tmpdir(), 'clklog-harness-'));
  const snapshot = {
    enabled: true,
    configured: true,
    revision: '1.0',
    defaults: { provider: 'tencent', model: MODEL.id, reasoning_effort: 'high' },
    providers: {
      tencent: {
        adapter: 'openai_compatible',
        display_name: 'Tencent TokenHub',
        base_url: 'https://tokenhub.test/plan/v3',
        protocol: 'openai-completions',
        configured: true,
        resolved_api_key: 'sk-should-never-reach-disk',
        models: [MODEL],
      },
    },
    unreadable: [],
    broken: [],
    ...snapshotOverrides,
  };
  const paths = {
    harnessConfig: jest.fn(() => ({ runtime: { max_tokens: 8_192 } })),
    runtimePaths: jest.fn(async () => ({ dshHome, instances: join(dshHome, 'instances') })),
    systemUser: jest.fn(async () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 })),
    ensureOwnedDirectory: jest.fn(async () => undefined),
  };
  const providers = { snapshot: jest.fn(() => snapshot) };
  return {
    dshHome,
    service: new HarnessSettingsService(paths as never, providers as never),
  };
}

describe('HarnessSettingsService', () => {
  it('写出 cordis.patch.yml：路由 ID 化、密钥只留环境变量名、默认模型指向路由', async () => {
    const { service, dshHome } = await createService();

    await service.prepare('user-1', 'clklogapp');

    const patch = yaml.load(await readFile(join(dshHome, 'cordis.patch.yml'), 'utf8')) as Array<{
      id: string;
      config: Record<string, unknown>;
    }>;
    const route = patch[0].config.providers as Record<string, { apiKeyEnv: string; baseURL: string }>;
    const routeId = Object.keys(route)[0];
    expect(routeId).toMatch(/^clklog-tencent-[0-9a-f]{8}$/);
    expect(route[routeId].apiKeyEnv).toBe('CLKLOG_MODEL_CAPABILITY');
    expect(route[routeId].baseURL).toBe('http://127.0.0.1:39100/model/tencent');
    expect(patch[1].config).toEqual({ provider: routeId, model: MODEL.id });
    // 真实密钥绝不落到 dsh-home
    expect(await readFile(join(dshHome, 'cordis.patch.yml'), 'utf8')).not.toContain('sk-should-never-reach-disk');
  });

  it('模型画像声明输入模态：支持图片的模型写 text+image，其余只写 text', async () => {
    const { service, dshHome } = await createService({
      providers: {
        tencent: {
          adapter: 'openai_compatible',
          display_name: 'Tencent TokenHub',
          base_url: 'https://tokenhub.test/plan/v3',
          protocol: 'openai-completions',
          configured: true,
          resolved_api_key: 'sk-should-never-reach-disk',
          models: [MODEL, IMAGE_MODEL],
        },
      },
    });

    await service.prepare('user-1', 'clklogapp');

    const patch = yaml.load(await readFile(join(dshHome, 'cordis.patch.yml'), 'utf8')) as Array<{
      id: string;
      config: { providers: Record<string, { models: Array<{ id: string; input: string[] }> }> };
    }>;
    const route = Object.values(patch[0].config.providers)[0];
    const byId = Object.fromEntries(route.models.map((model) => [model.id, model.input]));
    expect(byId[MODEL.id]).toEqual(['text']);
    expect(byId[IMAGE_MODEL.id]).toEqual(['text', 'image']);
  });

  it('没有配置任何供应商时拒绝生成会话配置（不写出空 provider 的 patch）', async () => {
    const { service, dshHome } = await createService({ configured: false, providers: {} });
    await expect(service.prepare('user-1', 'clklogapp')).rejects.toMatchObject({
      messageKey: 'ai:error.provider.noneConfigured',
    });
    await expect(readFile(join(dshHome, 'cordis.patch.yml'), 'utf8')).rejects.toThrow();
  });

  it('首次写出 settings.yaml 的默认模型', async () => {
    const { service, dshHome } = await createService();

    await service.prepare('user-1', 'clklogapp');

    const settings = yaml.load(await readFile(join(dshHome, 'settings.yaml'), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(settings['agent-default-model']).toMatchObject({ model: MODEL.id, reasoningEffort: 'high' });
  });

  it('默认模型变化时合并写：保留 DSH 自己写的其他键', async () => {
    const { service, dshHome } = await createService();
    const settingsPath = join(dshHome, 'settings.yaml');
    await writeFile(
      settingsPath,
      yaml.dump({
        'agent-default-model': { provider: 'old-route', model: 'old-model', reasoningEffort: 'off' },
        theme: 'dark',
      }),
      'utf8',
    );

    await service.prepare('user-1', 'clklogapp');

    const settings = yaml.load(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(settings.theme).toBe('dark');
    expect(settings['agent-default-model']).toMatchObject({ model: MODEL.id, reasoningEffort: 'high' });
  });

  it('默认模型未变时不重写文件（避免与另一个存活容器抢文件）', async () => {
    const { service, dshHome } = await createService();
    const settingsPath = join(dshHome, 'settings.yaml');
    const original =
      `agent-default-model:\n  provider: ${service.routeId('tencent')}\n` +
      `  model: ${MODEL.id}\n  reasoningEffort: high\n# 用户手写注释\n`;
    await writeFile(settingsPath, original, 'utf8');

    await service.prepare('user-1', 'clklogapp');

    // 内容逐字未变（连注释都在），说明没有落盘
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
  });

  it('settings.yaml 损坏时保留原文件，不写坏用户数据', async () => {
    const { service, dshHome } = await createService();
    const settingsPath = join(dshHome, 'settings.yaml');
    await writeFile(settingsPath, 'agent-default-model: [unclosed\n', 'utf8');

    await service.prepare('user-1', 'clklogapp');

    expect(await readFile(settingsPath, 'utf8')).toBe('agent-default-model: [unclosed\n');
  });
});
