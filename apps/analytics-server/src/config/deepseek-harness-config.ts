const PROVIDER_ID = /^[a-z0-9_-]+$/;

export type HarnessWorkspaceKind = 'persistent' | 'temporary';
export type HarnessPermissionPreset =
  | 'read_only'
  | 'workspace_write'
  | 'danger_full_access';
export type HarnessProviderAdapter = 'openai_compatible' | 'deepseek';
export type HarnessProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages';

export interface DeepseekHarnessModelConfig {
  id: string;
  display_name: string;
  /**
   * 模型是否接受图片输入（phase: clklog-ai-model-providers-v1 v1.1）。
   * 会话生成器据此声明 DSH 模型画像的 `input` 模态（`['text','image']` / `['text']`）。
   * 既有库存行没有这个字段时按 `false` 处理。
   */
  supports_image: boolean;
  reasoning_efforts: string[];
  default_reasoning_effort: string;
}

/** 供应商形状：网页写入口与运行期共用同一套字段与判定 */
export interface HarnessProviderShape {
  adapter: HarnessProviderAdapter;
  display_name: string;
  base_url: string;
  protocol: HarnessProviderProtocol;
  models: DeepseekHarnessModelConfig[];
}

/** 供应商形状 + 密钥终态（密钥唯一来源是库内密文，见实现方案 §4.2） */
export interface DeepseekHarnessProviderConfig extends HarnessProviderShape {
  /** 是否已配置可用密钥 */
  configured: boolean;
  /** 明文只在服务端内存里；永不回显、永不进日志 */
  resolved_api_key?: string;
}

/**
 * 模型供应商**不在配置文件里**（v1.1）：`deepseek_harness` 只留部署容量与安全预设，
 * 供应商清单与默认模型由「AI Workspace 管理 → 模型供应商」维护（库为唯一来源）。
 */
export interface DeepseekHarnessConfig {
  enabled: boolean;
  runtime: {
    linux_user: string;
    home_subdir: string;
    idle_ttl_ms: number;
    max_runtimes: number;
    max_tokens: number;
    container_image: string;
  };
  workspace: {
    default_kind: HarnessWorkspaceKind;
    temporary_ttl_ms: number;
    recovery_retention_ms: number;
    max_bytes: number;
  };
  defaults: {
    permission_preset: HarnessPermissionPreset;
  };
}

/**
 * 校验失败码（稳定标识）。启动期只打印 message 并终止；网页写入口按 code 映射到
 * `ai:error.provider.*` 文案。新增码时必须同步前端 13 种语言资源。
 */
export type HarnessValidationCode =
  | 'provider_id_invalid'
  | 'provider_unknown_field'
  | 'provider_key_case'
  | 'provider_field_invalid'
  | 'provider_base_url_invalid'
  | 'provider_base_url_insecure'
  | 'provider_protocol_invalid'
  | 'provider_adapter_invalid'
  | 'provider_models_invalid'
  | 'model_id_duplicate'
  | 'model_efforts_invalid'
  | 'model_efforts_duplicate'
  | 'model_default_effort_invalid'
  | 'providers_empty'
  | 'default_provider_missing'
  | 'default_model_missing'
  | 'default_effort_unsupported';

export class HarnessValidationError extends Error {
  constructor(
    readonly code: HarnessValidationCode,
    message: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HarnessValidationError';
  }
}

type UnknownRecord = Record<string, unknown>;

const ROOT_KEYS = ['enabled', 'runtime', 'workspace', 'defaults'] as const;
const RUNTIME_KEYS = [
  'linux_user',
  'home_subdir',
  'idle_ttl_ms',
  'max_runtimes',
  'max_tokens',
  'container_image',
] as const;
const WORKSPACE_KEYS = [
  'default_kind',
  'temporary_ttl_ms',
  'recovery_retention_ms',
  'max_bytes',
] as const;
const DEFAULT_KEYS = ['permission_preset'] as const;
const PROVIDER_KEYS = [
  'adapter',
  'display_name',
  'base_url',
  'protocol',
  'models',
] as const;
const MODEL_KEYS = [
  'id',
  'display_name',
  'supports_image',
  'reasoning_efforts',
  'default_reasoning_effort',
] as const;

function objectAt(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessValidationError(
      'provider_unknown_field',
      `配置字段必须是对象: ${path}`,
    );
  }
  return value as UnknownRecord;
}

function rejectUnknown(
  value: UnknownRecord,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (key !== key.toLowerCase()) {
      throw new HarnessValidationError(
        'provider_key_case',
        `DeepSeek Harness 配置键必须全小写: ${path}.${key}`,
      );
    }
    if (!allowed.includes(key)) {
      throw new HarnessValidationError(
        'provider_unknown_field',
        `未知 DeepSeek Harness 配置字段: ${path}.${key}`,
      );
    }
  }
}

function stringAt(value: unknown, path: string, optional = false): string | undefined {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new HarnessValidationError(
      'provider_field_invalid',
      `配置字段必须是非空字符串: ${path}`,
    );
  }
  return value.trim();
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HarnessValidationError(
      'provider_field_invalid',
      `配置字段必须是布尔值: ${path}`,
    );
  }
  return value;
}

function positiveIntegerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new HarnessValidationError(
      'provider_field_invalid',
      `配置字段必须是正整数: ${path}`,
    );
  }
  return Number(value);
}

function providerUrlAt(value: unknown, path: string): string {
  const raw = stringAt(value, path) as string;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HarnessValidationError(
      'provider_base_url_invalid',
      `供应商 base_url 不是合法 URL: ${path}`,
      { base_url: raw },
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new HarnessValidationError(
      'provider_base_url_invalid',
      `供应商 base_url 协议或认证信息无效: ${path}`,
      { base_url: raw },
    );
  }
  if (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new HarnessValidationError(
      'provider_base_url_insecure',
      `非本机供应商 base_url 必须使用 HTTPS: ${path}`,
      { base_url: raw },
    );
  }
  return raw.replace(/\/$/, '');
}

function enumAt<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  code: HarnessValidationCode,
): T {
  const parsed = stringAt(value, path, true) as T | undefined;
  if (!parsed || !allowed.includes(parsed)) {
    throw new HarnessValidationError(code, `配置字段取值无效: ${path}`);
  }
  return parsed;
}

function parseModel(value: unknown, path: string): DeepseekHarnessModelConfig {
  const raw = objectAt(value, path);
  rejectUnknown(raw, MODEL_KEYS, path);
  const id = stringAt(raw.id, `${path}.id`) as string;
  const effortsRaw = raw.reasoning_efforts;
  if (!Array.isArray(effortsRaw) || effortsRaw.length === 0) {
    throw new HarnessValidationError(
      'model_efforts_invalid',
      `配置字段必须是非空数组: ${path}.reasoning_efforts`,
      { model: id },
    );
  }
  const reasoningEfforts = effortsRaw.map((effort, index) =>
    stringAt(effort, `${path}.reasoning_efforts[${index}]`) as string,
  );
  if (new Set(reasoningEfforts).size !== reasoningEfforts.length) {
    throw new HarnessValidationError(
      'model_efforts_duplicate',
      `配置字段不能包含重复值: ${path}.reasoning_efforts`,
      { model: id },
    );
  }
  const defaultEffort = stringAt(
    raw.default_reasoning_effort,
    `${path}.default_reasoning_effort`,
  ) as string;
  if (!reasoningEfforts.includes(defaultEffort)) {
    throw new HarnessValidationError(
      'model_default_effort_invalid',
      `默认思考强度不在允许集合中: ${path}.default_reasoning_effort`,
      { model: id },
    );
  }
  return {
    id,
    display_name: stringAt(raw.display_name, `${path}.display_name`) as string,
    // 缺失按 false：既有库存行没有这个字段，不该因此判为非法
    supports_image:
      raw.supports_image === undefined
        ? false
        : booleanAt(raw.supports_image, `${path}.supports_image`),
    reasoning_efforts: reasoningEfforts,
    default_reasoning_effort: defaultEffort,
  };
}

/**
 * 单个供应商的形状校验。
 *
 * 网页写入口对「候选供应商」调用本函数；运行期对库行调用同一函数，
 * 保证「存得进去」与「跑得起来」用的是同一套判定。
 */
export function validateProviderShape(
  providerId: string,
  value: unknown,
  path = `providers.${providerId}`,
): HarnessProviderShape {
  if (!PROVIDER_ID.test(providerId)) {
    throw new HarnessValidationError(
      'provider_id_invalid',
      `供应商 ID 格式无效: ${path}`,
      { provider: providerId },
    );
  }
  const raw = objectAt(value, path);
  rejectUnknown(raw, PROVIDER_KEYS, path);
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new HarnessValidationError(
      'provider_models_invalid',
      `配置字段必须是非空数组: ${path}.models`,
      { provider: providerId },
    );
  }
  const models = raw.models.map((model, index) =>
    parseModel(model, `${path}.models[${index}]`),
  );
  const duplicateModelId = models
    .map((model) => model.id)
    .find((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateModelId) {
    throw new HarnessValidationError(
      'model_id_duplicate',
      `供应商模型 ID 不能重复: ${path}.models`,
      { provider: providerId, id: duplicateModelId },
    );
  }
  return {
    adapter: enumAt(
      raw.adapter,
      ['openai_compatible', 'deepseek'],
      `${path}.adapter`,
      'provider_adapter_invalid',
    ),
    display_name: stringAt(raw.display_name, `${path}.display_name`) as string,
    base_url: providerUrlAt(raw.base_url, `${path}.base_url`),
    protocol: enumAt(
      raw.protocol,
      ['openai-completions', 'openai-responses', 'anthropic-messages'],
      `${path}.protocol`,
      'provider_protocol_invalid',
    ),
    models,
  };
}

export interface HarnessDefaults {
  provider: string;
  model: string;
  reasoning_effort: string;
}

/**
 * 整组一致性：至少一个供应商、默认供应商/模型/思考强度自洽。
 * 半截配置会让模型出口拿到不一致的 allowlist，因此在写库前、事务内校验（不是写入后自愈）。
 */
export function assertHarnessProviderSet(
  providers: Record<string, HarnessProviderShape>,
  defaults: HarnessDefaults,
  path = 'ai.modelProviders',
): void {
  if (Object.keys(providers).length === 0) {
    throw new HarnessValidationError(
      'providers_empty',
      `至少需要一个模型供应商: ${path}`,
    );
  }
  const provider = providers[defaults.provider];
  if (!provider) {
    throw new HarnessValidationError(
      'default_provider_missing',
      `默认供应商不存在: ${path}.defaults.provider`,
      { provider: defaults.provider },
    );
  }
  const model = provider.models.find((item) => item.id === defaults.model);
  if (!model) {
    throw new HarnessValidationError(
      'default_model_missing',
      `默认模型不存在: ${path}.defaults.model`,
      { model: defaults.model },
    );
  }
  if (!model.reasoning_efforts.includes(defaults.reasoning_effort)) {
    throw new HarnessValidationError(
      'default_effort_unsupported',
      `默认思考强度不受模型支持: ${path}.defaults.reasoning_effort`,
      { model: defaults.model },
    );
  }
}

export function parseDeepseekHarnessConfig(value: unknown): DeepseekHarnessConfig {
  const root = objectAt(value, 'deepseek_harness');
  rejectUnknown(root, ROOT_KEYS, 'deepseek_harness');
  const runtime = objectAt(root.runtime, 'deepseek_harness.runtime');
  const workspace = objectAt(root.workspace, 'deepseek_harness.workspace');
  const defaults = objectAt(root.defaults, 'deepseek_harness.defaults');
  rejectUnknown(runtime, RUNTIME_KEYS, 'deepseek_harness.runtime');
  rejectUnknown(workspace, WORKSPACE_KEYS, 'deepseek_harness.workspace');
  rejectUnknown(defaults, DEFAULT_KEYS, 'deepseek_harness.defaults');

  const linuxUser = stringAt(
    runtime.linux_user,
    'deepseek_harness.runtime.linux_user',
  ) as string;
  const homeSubdir = stringAt(
    runtime.home_subdir,
    'deepseek_harness.runtime.home_subdir',
  ) as string;
  if (
    linuxUser === 'root' ||
    !/^[a-z_][a-z0-9_-]*[$]?$/.test(linuxUser)
  ) {
    throw new HarnessValidationError(
      'provider_field_invalid',
      'Harness Linux 用户无效或禁止使用 root: deepseek_harness.runtime.linux_user',
    );
  }
  if (homeSubdir === '.' || homeSubdir === '..' || /[\\/]/.test(homeSubdir)) {
    throw new HarnessValidationError(
      'provider_field_invalid',
      'Harness home_subdir 必须是单个相对目录名',
    );
  }
  const maxRuntimes = positiveIntegerAt(
    runtime.max_runtimes,
    'deepseek_harness.runtime.max_runtimes',
  );
  if (maxRuntimes > 64) {
    throw new HarnessValidationError(
      'provider_field_invalid',
      'Harness max_runtimes 不能超过 64',
    );
  }
  const containerImage = stringAt(
    runtime.container_image,
    'deepseek_harness.runtime.container_image',
  ) as string;
  if (/\s/.test(containerImage) || containerImage.startsWith('-')) {
    throw new HarnessValidationError(
      'provider_field_invalid',
      'Harness container_image 格式无效',
    );
  }

  return {
    enabled: booleanAt(root.enabled, 'deepseek_harness.enabled'),
    runtime: {
      linux_user: linuxUser,
      home_subdir: homeSubdir,
      idle_ttl_ms: positiveIntegerAt(
        runtime.idle_ttl_ms,
        'deepseek_harness.runtime.idle_ttl_ms',
      ),
      max_runtimes: maxRuntimes,
      max_tokens: positiveIntegerAt(
        runtime.max_tokens,
        'deepseek_harness.runtime.max_tokens',
      ),
      container_image: containerImage,
    },
    workspace: {
      default_kind: enumAt(
        workspace.default_kind,
        ['persistent', 'temporary'],
        'deepseek_harness.workspace.default_kind',
        'provider_field_invalid',
      ),
      temporary_ttl_ms: positiveIntegerAt(
        workspace.temporary_ttl_ms,
        'deepseek_harness.workspace.temporary_ttl_ms',
      ),
      recovery_retention_ms: positiveIntegerAt(
        workspace.recovery_retention_ms,
        'deepseek_harness.workspace.recovery_retention_ms',
      ),
      max_bytes: positiveIntegerAt(
        workspace.max_bytes,
        'deepseek_harness.workspace.max_bytes',
      ),
    },
    defaults: {
      permission_preset: enumAt(
        defaults.permission_preset,
        ['read_only', 'workspace_write', 'danger_full_access'],
        'deepseek_harness.defaults.permission_preset',
        'provider_field_invalid',
      ),
    },
  };
}
