import {
  assertHarnessProviderSet,
  parseDeepseekHarnessConfig,
  validateProviderShape,
} from './deepseek-harness-config';

function runtimeConfig() {
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

const MODEL = {
  id: 'deepseek-v4',
  display_name: 'DeepSeek V4',
  reasoning_efforts: ['off', 'high'],
  default_reasoning_effort: 'high',
};

describe('parseDeepseekHarnessConfig', () => {
  it('只解析部署容量与安全预设（供应商不在配置文件里）', () => {
    const parsed = parseDeepseekHarnessConfig(runtimeConfig());
    expect(parsed.enabled).toBe(true);
    expect(parsed.defaults.permission_preset).toBe('workspace_write');
    expect(parsed.runtime.max_runtimes).toBe(8);
    expect('providers' in parsed).toBe(false);
  });

  it('v1.1：配置文件里再写 providers 会被当成未知字段拒绝', () => {
    const value = runtimeConfig() as Record<string, unknown>;
    value.providers = { tencent: { api_key_env: 'TENCENT_API_KEY' } };
    expect(() => parseDeepseekHarnessConfig(value)).toThrow('未知');
  });

  it('拒绝大写或未知配置键', () => {
    const value = runtimeConfig() as Record<string, unknown>;
    (value.runtime as Record<string, unknown>).Linux_User = 'harness';
    expect(() => parseDeepseekHarnessConfig(value)).toThrow('必须全小写');
  });

  it('拒绝 root 用户与非法 home_subdir', () => {
    const root = runtimeConfig();
    root.runtime.linux_user = 'root';
    expect(() => parseDeepseekHarnessConfig(root)).toThrow('root');

    const nested = runtimeConfig();
    nested.runtime.home_subdir = 'a/b';
    expect(() => parseDeepseekHarnessConfig(nested)).toThrow('单个相对目录名');
  });

  it('拒绝超出上限的 max_runtimes', () => {
    const value = runtimeConfig();
    value.runtime.max_runtimes = 65;
    expect(() => parseDeepseekHarnessConfig(value)).toThrow('64');
  });
});

describe('validateProviderShape', () => {
  it('补全默认值：supports_image 缺失按 false', () => {
    const shape = validateProviderShape('tencent', {
      adapter: 'openai_compatible',
      display_name: 'Tencent',
      base_url: 'https://example.test/v1/',
      protocol: 'openai-completions',
      models: [MODEL],
    });
    expect(shape.base_url).toBe('https://example.test/v1');
    expect(shape.models[0].supports_image).toBe(false);
  });

  it('接受支持图片输入的模型', () => {
    const shape = validateProviderShape('tencent', {
      adapter: 'openai_compatible',
      display_name: 'Tencent',
      base_url: 'https://example.test/v1',
      protocol: 'openai-completions',
      models: [{ ...MODEL, supports_image: true }],
    });
    expect(shape.models[0].supports_image).toBe(true);
  });

  it('拒绝非法供应商 ID 与非布尔的支持图片标记', () => {
    expect(() => validateProviderShape('Tencent', {
      adapter: 'openai_compatible',
      display_name: 'T',
      base_url: 'https://example.test/v1',
      protocol: 'openai-completions',
      models: [MODEL],
    })).toThrow('供应商 ID 格式无效');

    expect(() => validateProviderShape('tencent', {
      adapter: 'openai_compatible',
      display_name: 'T',
      base_url: 'https://example.test/v1',
      protocol: 'openai-completions',
      models: [{ ...MODEL, supports_image: 'yes' }],
    })).toThrow('布尔值');
  });

  it('拒绝明文 HTTP 的外网地址，允许本机 http', () => {
    expect(() => validateProviderShape('tencent', {
      adapter: 'openai_compatible',
      display_name: 'T',
      base_url: 'http://10.0.0.8/v1',
      protocol: 'openai-completions',
      models: [MODEL],
    })).toThrow('必须使用 HTTPS');

    expect(validateProviderShape('local', {
      adapter: 'openai_compatible',
      display_name: 'Local',
      base_url: 'http://127.0.0.1:8080/v1',
      protocol: 'openai-completions',
      models: [MODEL],
    }).base_url).toBe('http://127.0.0.1:8080/v1');
  });

  it('拒绝重复模型 ID 与不受支持的默认思考强度', () => {
    expect(() => validateProviderShape('tencent', {
      adapter: 'openai_compatible',
      display_name: 'T',
      base_url: 'https://example.test/v1',
      protocol: 'openai-completions',
      models: [MODEL, MODEL],
    })).toThrow('不能重复');

    expect(() => validateProviderShape('tencent', {
      adapter: 'openai_compatible',
      display_name: 'T',
      base_url: 'https://example.test/v1',
      protocol: 'openai-completions',
      models: [{ ...MODEL, default_reasoning_effort: 'max' }],
    })).toThrow('默认思考强度');
  });
});

describe('assertHarnessProviderSet', () => {
  const shape = {
    adapter: 'openai_compatible' as const,
    display_name: 'Tencent',
    base_url: 'https://example.test/v1',
    protocol: 'openai-completions' as const,
    models: [{ ...MODEL, supports_image: false }],
  };

  it('空清单直接拒绝', () => {
    expect(() => assertHarnessProviderSet({}, { provider: 'x', model: 'y', reasoning_effort: 'off' }))
      .toThrow('至少需要一个模型供应商');
  });

  it('默认值必须落在清单内且自洽', () => {
    expect(() => assertHarnessProviderSet({ tencent: shape }, {
      provider: 'ghost', model: MODEL.id, reasoning_effort: 'off',
    })).toThrow('默认供应商不存在');

    expect(() => assertHarnessProviderSet({ tencent: shape }, {
      provider: 'tencent', model: 'ghost', reasoning_effort: 'off',
    })).toThrow('默认模型不存在');

    expect(() => assertHarnessProviderSet({ tencent: shape }, {
      provider: 'tencent', model: MODEL.id, reasoning_effort: 'max',
    })).toThrow('默认思考强度不受模型支持');

    expect(() => assertHarnessProviderSet({ tencent: shape }, {
      provider: 'tencent', model: MODEL.id, reasoning_effort: 'high',
    })).not.toThrow();
  });
});
