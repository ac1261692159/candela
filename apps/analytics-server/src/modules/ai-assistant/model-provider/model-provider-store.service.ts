import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SaAiModelProvider, SaAiModelSettings } from '@prisma/client';
import {
  DeepseekHarnessConfig,
  DeepseekHarnessModelConfig,
  DeepseekHarnessProviderConfig,
  HarnessProviderShape,
  HarnessValidationError,
  assertHarnessProviderSet,
  validateProviderShape,
} from '../../../config/deepseek-harness-config';
import { badRequest, conflict, notFound } from '../../../i18n/domain-error';
import { PrismaService } from '../../shared/prisma.service';
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  parseMasterKey,
  SECRET_KEY_ENV,
} from '../../alerting/channels/channel-crypto';
import {
  ModelProviderAdminView,
  ModelProviderDefaultsView,
  ModelProviderView,
} from './model-provider.types';

const SETTINGS_ID = 'singleton';
const AUDIT_TABLE = 'saaimodelprovider';

/** 单个供应商的密钥终态（明文只在内存里，永不回显） */
export interface ResolvedProviderKey {
  /** 库内密文解出来的可用密钥；没有或解不开则为 undefined */
  plain?: string;
  hint: string | null;
  unreadable: boolean;
}

/** 库行 → 供应商配置的中间态（视图与快照共用） */
export interface ModelProviderEntry {
  row: SaAiModelProvider;
  shape: HarnessProviderShape;
  key: ResolvedProviderKey;
  /** 连接测试通过的模型 ID（v1.2） */
  verified: string[];
  /**
   * 可用模型 = 密钥可用 且 已验证（v1.2）。只有这些模型会被下发给 Harness 的
   * 模型列表——把「没密钥」或「没测过」的模型摆给用户，等于给了一个选了必然失败的选项。
   */
  usableModels: DeepseekHarnessModelConfig[];
}

export interface DatabaseProviderLoad {
  entries: ModelProviderEntry[];
  settings: SaAiModelSettings | null;
  /** 只含可用模型的有效供应商；一个可用模型都没有的供应商不在这里（v1.2） */
  providers: Record<string, DeepseekHarnessProviderConfig>;
  /** 密文解不开的供应商 ID */
  unreadable: string[];
  /** 库行无法解析的供应商 ID（已跳过） */
  broken: string[];
  /** 运行中会话的陈旧判定标识 */
  revision: string;
}

/** 写入口的模型项：`supports_image` 可省略（缺省按 false），落库前统一补全 */
export type SaveProviderModelInput = Omit<DeepseekHarnessModelConfig, 'supports_image'> & {
  supports_image?: boolean;
};

export interface SaveProviderInput {
  display_name: string;
  adapter: string;
  protocol: string;
  base_url: string;
  /** 缺省或空串 = 不修改已保存的密钥 */
  api_key?: string;
  models: SaveProviderModelInput[];
}

/**
 * 模型供应商的唯一写入方（phase: clklog-ai-model-providers-v1）。
 *
 * 库是供应商与密钥的唯一来源：没有配置文件来源，也没有环境变量覆盖，初始为空。
 * 写前对**候选整组配置**做结构校验（与运行期解析同一套规则），校验失败一律不落库；
 * 密钥只以 AES-256-GCM 密文存储；验证状态（v1.2）由「测试连接」写入、配置改写即清空。
 */
@Injectable()
export class ModelProviderStoreService {
  private readonly logger = new Logger(ModelProviderStoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** 配置文件基线：只含部署容量与安全预设（供应商不在其中） */
  yamlConfig(): DeepseekHarnessConfig | null {
    return this.config.get<DeepseekHarnessConfig>('deepseek_harness') ?? null;
  }

  masterKey(): Buffer | null {
    return parseMasterKey(this.config.get<{ configKey?: string }>('alerting')?.configKey);
  }

  keyMasterMissing(): boolean {
    return this.masterKey() === null;
  }

  /**
   * 读取库内供应商并合成有效配置。
   *
   * 密钥只有一个来源：库内密文；模型是否可用还要看验证状态（v1.2）。
   * 密文解不开时按「未配置」处理并标记 `unreadable`，不回退任何东西（没有可回退的来源）。
   */
  async loadDatabase(): Promise<DatabaseProviderLoad> {
    const [rows, settings] = await Promise.all([
      this.prisma.saAiModelProvider.findMany({ orderBy: { provider_id: 'asc' } }),
      this.prisma.saAiModelSettings.findUnique({ where: { id: SETTINGS_ID } }),
    ]);
    const entries: ModelProviderEntry[] = [];
    const broken: string[] = [];
    for (const row of rows) {
      try {
        const shape = validateProviderShape(row.provider_id, {
          adapter: row.adapter,
          display_name: row.display_name,
          base_url: row.base_url,
          protocol: row.protocol,
          models: JSON.parse(row.models_json) as unknown,
        }, `saaimodelprovider.${row.provider_id}`);
        const key = this.resolveKey(row);
        const verified = this.parseVerified(row);
        entries.push({
          row,
          shape,
          key,
          verified,
          usableModels: this.usableModels(shape, key, verified),
        });
      } catch (error) {
        // 只可能是人工改库：跳过该行而不是让整页 500，但要显式暴露（broken）
        broken.push(row.provider_id);
        this.logger.error(
          `Skipping unparsable model provider row [${row.provider_id}]: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const providers: Record<string, DeepseekHarnessProviderConfig> = {};
    const unreadable: string[] = [];
    for (const entry of entries) {
      if (entry.key.unreadable) unreadable.push(entry.row.provider_id);
      if (entry.usableModels.length === 0) continue;
      providers[entry.row.provider_id] = {
        ...entry.shape,
        models: entry.usableModels,
        configured: Boolean(entry.key.plain),
        ...(entry.key.plain ? { resolved_api_key: entry.key.plain } : {}),
      };
    }
    const latest = rows.reduce(
      (max, row) => Math.max(max, row.updated_at.getTime()),
      settings?.updated_at.getTime() ?? 0,
    );
    return {
      entries,
      settings,
      providers,
      unreadable,
      broken,
      revision: `${settings?.revision ?? 0}.${latest}`,
    };
  }

  /** 库里的默认选择原样返回（没有设置行时用当前清单第一个可用模型） */
  private storedDefaults(load: DatabaseProviderLoad): ModelProviderDefaultsView {
    if (load.settings) {
      return {
        provider: load.settings.default_provider,
        model: load.settings.default_model,
        reasoning_effort: load.settings.default_reasoning_effort,
      };
    }
    return this.pickDefaults(load.providers, null);
  }

  /** 下发给 Harness 的默认选择：只在**可用**模型里挑（v1.2） */
  effectiveDefaults(load: DatabaseProviderLoad): ModelProviderDefaultsView {
    return this.pickDefaults(
      load.providers,
      load.settings
        ? {
            provider: load.settings.default_provider,
            model: load.settings.default_model,
            reasoning_effort: load.settings.default_reasoning_effort,
          }
        : null,
    );
  }

  /**
   * 在给定供应商集合里挑一个自洽的默认三元组：首选值必须真的存在且思考强度受支持，
   * 否则退回集合里第一个可用模型。半截默认值会让会话生成器指向不存在的路由。
   */
  private pickDefaults(
    providers: Record<string, HarnessProviderShape | DeepseekHarnessProviderConfig>,
    preferred: ModelProviderDefaultsView | null,
  ): ModelProviderDefaultsView {
    if (preferred) {
      const model = providers[preferred.provider]?.models.find(
        (candidate) => candidate.id === preferred.model,
      );
      if (model && model.reasoning_efforts.includes(preferred.reasoning_effort)) return preferred;
    }
    for (const [providerId, provider] of Object.entries(providers)) {
      const model = provider.models[0];
      if (model) {
        return {
          provider: providerId,
          model: model.id,
          reasoning_effort: model.default_reasoning_effort,
        };
      }
    }
    return preferred ?? { provider: '', model: '', reasoning_effort: '' };
  }

  /** 存库的验证状态：解析失败按「没有验证过」处理，不静默保留旧结果 */
  private parseVerified(row: SaAiModelProvider): string[] {
    try {
      const parsed = JSON.parse(row.verified_json) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      this.logger.warn(`Ignoring unparsable verified_json [${row.provider_id}]`);
      return [];
    }
  }

  private usableModels(
    shape: HarnessProviderShape,
    key: ResolvedProviderKey,
    verified: string[],
  ): DeepseekHarnessModelConfig[] {
    if (!key.plain) return [];
    const passed = new Set(verified);
    return shape.models.filter((model) => passed.has(model.id));
  }

  private resolveKey(row: SaAiModelProvider): ResolvedProviderKey {
    if (!row.api_key_cipher) return { hint: null, unreadable: false };
    const key = this.masterKey();
    if (!key) {
      // 有密文但读不到主密钥：与新版的「不可读」同类，需要重填
      return { hint: null, unreadable: true };
    }
    try {
      const plain = decryptSecret(row.api_key_cipher, key);
      if (plain) return { plain, hint: maskSecret(plain), unreadable: false };
    } catch {
      return { hint: null, unreadable: true };
    }
    return { hint: null, unreadable: true };
  }

  // ===== 写入 =====

  async create(providerId: string, input: SaveProviderInput, operator: string): Promise<void> {
    const existing = await this.prisma.saAiModelProvider.findUnique({ where: { provider_id: providerId } });
    if (existing) {
      throw conflict({
        code: 'ai.modelProvider.exists',
        messageKey: 'ai:error.provider.exists',
        params: { id: providerId },
      });
    }
    await this.write({ providerId, input, operator, action: 'ai_model_provider_create' });
  }

  async update(providerId: string, input: SaveProviderInput, operator: string): Promise<void> {
    const existing = await this.prisma.saAiModelProvider.findUnique({ where: { provider_id: providerId } });
    if (!existing) throw this.notFound(providerId);
    await this.write({ providerId, input, operator, action: 'ai_model_provider_update', existing });
  }

  async remove(providerId: string, operator: string): Promise<void> {
    const existing = await this.prisma.saAiModelProvider.findUnique({ where: { provider_id: providerId } });
    if (!existing) throw this.notFound(providerId);
    const load = await this.loadDatabase();
    const remaining: Record<string, HarnessProviderShape> = {};
    for (const entry of load.entries) {
      if (entry.row.provider_id !== providerId) remaining[entry.row.provider_id] = entry.shape;
    }
    // 用库里的**真实**默认值校验，不做自愈：删掉默认供应商应当被拒绝，
    // 而不是把所有人的默认模型悄悄换成另一个
    this.validateSet(remaining, this.storedDefaults(load));
    await this.prisma.saAiModelProvider.delete({ where: { provider_id: providerId } });
    await this.bumpRevision(operator);
    await this.audit('ai_model_provider_delete', { provider_id: providerId }, operator);
  }

  /**
   * 默认模型：必须是**可用**模型（有密钥 + 测试通过）。
   * 指向不可用模型不会报错但会在用户侧失败，所以这里直接拒绝并说明原因。
   */
  async saveDefaults(input: ModelProviderDefaultsView, operator: string): Promise<void> {
    const load = await this.loadDatabase();
    const candidate: Record<string, HarnessProviderShape> = {};
    for (const entry of load.entries) candidate[entry.row.provider_id] = entry.shape;
    this.validateSet(candidate, input);
    const usableModel = load.providers[input.provider]?.models.find(
      (model) => model.id === input.model,
    );
    if (!usableModel || !usableModel.reasoning_efforts.includes(input.reasoning_effort)) {
      throw badRequest({
        code: 'ai.modelProvider.defaultUnavailable',
        messageKey: 'ai:error.provider.defaultUnavailable',
        params: { provider: input.provider, model: input.model },
      });
    }
    await this.prisma.saAiModelSettings.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        default_provider: input.provider,
        default_model: input.model,
        default_reasoning_effort: input.reasoning_effort,
        revision: 1,
        updated_by: operator,
      },
      update: {
        default_provider: input.provider,
        default_model: input.model,
        default_reasoning_effort: input.reasoning_effort,
        revision: { increment: 1 },
        updated_by: operator,
      },
    });
    await this.audit('ai_model_defaults_update', {
      provider_id: input.provider,
      model: input.model,
      reasoning_effort: input.reasoning_effort,
    }, operator);
  }

  /**
   * 记录一次连接测试的结果（v1.2）：通过的模型加入可选列表，失败的移出。
   * 供应商在测试期间被删掉时静默返回（结果已无意义）。
   */
  async recordTest(
    providerId: string,
    model: string,
    ok: boolean,
    operator: string,
  ): Promise<void> {
    const row = await this.prisma.saAiModelProvider.findUnique({ where: { provider_id: providerId } });
    if (!row) return;
    const verified = new Set(this.parseVerified(row));
    if (ok) verified.add(model);
    else verified.delete(model);
    await this.prisma.saAiModelProvider.update({
      where: { provider_id: providerId },
      data: {
        verified_json: JSON.stringify([...verified].sort()),
        last_test_at: new Date(),
        last_test_by: operator,
      },
    });
  }

  async audit(action: string, detail: Record<string, unknown>, operator: string): Promise<void> {
    try {
      await this.prisma.opsActionLog.create({
        data: { action, target_table: AUDIT_TABLE, detail: detail as object, status: 'done', operator },
      });
    } catch (error) {
      this.logger.warn(
        `Model provider audit write failed [${action}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 设置页视图：逐行给出密钥状态与逐模型验证状态，密钥只回显 `••••末4位` */
  async adminView(): Promise<Omit<ModelProviderAdminView, 'applyable_runtimes'>> {
    const yaml = this.yamlConfig();
    const load = await this.loadDatabase();
    return {
      revision: load.revision,
      defaults: this.effectiveDefaults(load),
      providers: load.entries.map((entry) => this.databaseRowView(entry)),
      readonly: yaml
        ? {
            enabled: yaml.enabled,
            permission_preset: yaml.defaults.permission_preset,
            runtime: { ...yaml.runtime },
            workspace: { ...yaml.workspace },
          }
        : null,
      key_master_missing: this.keyMasterMissing(),
    };
  }

  private databaseRowView(entry: ModelProviderEntry): ModelProviderView {
    const { row, shape, key, verified } = entry;
    const passed = new Set(verified);
    const usable = new Set(entry.usableModels.map((model) => model.id));
    return {
      provider_id: row.provider_id,
      display_name: shape.display_name,
      adapter: shape.adapter,
      protocol: shape.protocol,
      base_url: shape.base_url,
      key: {
        configured: Boolean(key.plain),
        hint: key.hint,
        unreadable: key.unreadable,
      },
      models: shape.models.map((model) => ({
        ...model,
        verified: passed.has(model.id),
        usable: usable.has(model.id),
      })),
      usable: usable.size > 0,
      last_test_at: row.last_test_at?.toISOString() ?? null,
      last_test_by: row.last_test_by,
      updated_by: row.updated_by,
      updated_at: row.updated_at.toISOString(),
    };
  }

  private async write(input: {
    providerId: string;
    input: SaveProviderInput;
    operator: string;
    action: string;
    existing?: SaAiModelProvider;
  }): Promise<void> {
    const { providerId, input: payload, operator } = input;
    const key = this.masterKey();
    const wantsKey = Boolean(payload.api_key);
    if (wantsKey && !key) {
      throw badRequest({
        code: 'ai.modelProvider.masterKeyMissing',
        messageKey: 'ai:error.provider.masterKeyMissing',
        params: { env: SECRET_KEY_ENV },
      });
    }
    const shape = this.validateShape(providerId, payload);
    const load = await this.loadDatabase();
    const candidate: Record<string, HarnessProviderShape> = {};
    for (const entry of load.entries) candidate[entry.row.provider_id] = entry.shape;
    candidate[providerId] = shape;
    // 结构校验用全量模型；默认值优先沿用库设置行，不可用时取候选集合里第一个模型
    const defaults = this.pickDefaults(candidate, this.storedDefaults(load));
    this.validateSet(candidate, defaults);

    const cipher = wantsKey && key ? encryptSecret(payload.api_key as string, key) : null;
    const data = {
      display_name: shape.display_name,
      adapter: shape.adapter,
      protocol: shape.protocol,
      base_url: shape.base_url,
      models_json: JSON.stringify(shape.models),
      // 配置一改，之前的验证就不代表当前配置了（v1.2）
      verified_json: '[]',
      last_test_at: null,
      last_test_by: null,
      updated_by: operator,
    };
    await this.prisma.$transaction(async (tx) => {
      if (input.existing) {
        await tx.saAiModelProvider.update({
          where: { provider_id: providerId },
          data: { ...data, ...(cipher ? { api_key_cipher: cipher } : {}) },
        });
      } else {
        await tx.saAiModelProvider.create({
          data: { ...data, provider_id: providerId, api_key_cipher: cipher },
        });
      }
      await tx.saAiModelSettings.upsert({
        where: { id: SETTINGS_ID },
        create: {
          id: SETTINGS_ID,
          default_provider: defaults.provider,
          default_model: defaults.model,
          default_reasoning_effort: defaults.reasoning_effort,
          revision: 1,
          updated_by: operator,
        },
        update: { revision: { increment: 1 } },
      });
    });
    // 审计只记「密钥是否更新」，任何密钥/token 明文都不进审计表
    await this.audit(input.action, {
      provider_id: providerId,
      base_url: shape.base_url,
      protocol: shape.protocol,
      models: shape.models.map((model) => model.id),
      image_models: shape.models.filter((model) => model.supports_image).map((model) => model.id),
      key_updated: wantsKey,
    }, operator);
  }

  private validateShape(providerId: string, payload: SaveProviderInput): HarnessProviderShape {
    try {
      return validateProviderShape(providerId, {
        adapter: payload.adapter,
        display_name: payload.display_name,
        base_url: payload.base_url,
        protocol: payload.protocol,
        models: payload.models.map((model) => ({
          ...model,
          supports_image: model.supports_image ?? false,
        })),
      });
    } catch (error) {
      throw this.toDomainError(error, providerId);
    }
  }

  private validateSet(
    entries: Record<string, HarnessProviderShape>,
    defaults: ModelProviderDefaultsView,
  ): void {
    try {
      assertHarnessProviderSet(entries, defaults, 'ai.modelProviders');
    } catch (error) {
      throw this.toDomainError(error);
    }
  }

  private async bumpRevision(operator: string): Promise<void> {
    await this.prisma.saAiModelSettings.updateMany({
      where: { id: SETTINGS_ID },
      data: { revision: { increment: 1 }, updated_by: operator },
    });
  }

  private notFound(providerId: string): Error {
    return notFound({
      code: 'ai.modelProvider.notFound',
      messageKey: 'ai:error.provider.notFound',
      params: { id: providerId },
    });
  }

  /**
   * 把配置层的稳定错误码映射成带 i18n 文案键的领域错误（前端按当前语言渲染）。
   * 无法识别的码统一落到 `error.provider.invalid`，不把内部异常文本当作用户文案。
   */
  private toDomainError(error: unknown, providerId?: string): Error {
    if (error instanceof HarnessValidationError) {
      // 码 → 文案键；文案与插值参数由前端按当前语言渲染（不再保留中文兜底，见 domain-error 契约）
      const messageKeys: Partial<Record<string, string>> = {
        provider_id_invalid: 'ai:error.provider.idInvalid',
        model_id_duplicate: 'ai:error.provider.modelDuplicate',
        model_efforts_invalid: 'ai:error.provider.effortRequired',
        model_efforts_duplicate: 'ai:error.provider.effortRequired',
        model_default_effort_invalid: 'ai:error.provider.defaultEffortInvalid',
        default_effort_unsupported: 'ai:error.provider.defaultEffortInvalid',
        provider_base_url_invalid: 'ai:error.provider.baseUrlInvalid',
        provider_base_url_insecure: 'ai:error.provider.baseUrlInvalid',
        providers_empty: 'ai:error.provider.empty',
        default_provider_missing: 'ai:error.provider.defaultProviderMissing',
        default_model_missing: 'ai:error.provider.defaultModelMissing',
      };
      return badRequest({
        code: `ai.modelProvider.${error.code}`,
        messageKey: messageKeys[error.code] ?? 'ai:error.provider.invalid',
        params: { ...(providerId ? { provider: providerId } : {}), ...error.params },
      });
    }
    this.logger.error(
      `Model provider validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return badRequest({
      code: 'ai.modelProvider.invalid',
      messageKey: 'ai:error.provider.invalid',
    });
  }
}
