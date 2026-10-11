import {
  DeepseekHarnessModelConfig,
  DeepseekHarnessProviderConfig,
  HarnessPermissionPreset,
  HarnessProviderAdapter,
  HarnessProviderProtocol,
} from '../../../config/deepseek-harness-config';

/**
 * AI 模型供应商设置的对外类型（phase: clklog-ai-model-providers-v1）。
 *
 * 两条读取路径刻意分开：
 * - `HarnessProviderSnapshot`：网关 / 会话生成器用的**有效配置快照**，热路径同步读；
 * - `ModelProviderAdminView`：设置页用的**展示视图**，含密钥状态，永不含明文。
 *
 * v1.1：供应商与密钥只有库一个来源，因此去掉了 source / origin / configured_by 这些
 * 「来源区分」字段——密钥状态只需回答「配没配」与「密文能不能解开」。
 */

export interface ModelProviderKeyView {
  configured: boolean;
  /** `••••末4位`；未配置或不可读时为 null */
  hint: string | null;
  /** 密文存在但解不开（主密钥被换）：显式报错，要求重填 */
  unreadable: boolean;
}

/** 模型在界面上的状态：已通过测试 / 未通过（含未测过） */
export interface ModelProviderModelView extends DeepseekHarnessModelConfig {
  verified: boolean;
  /** 可用 = 密钥可用 且 已验证；只有可用模型会下发给 Harness */
  usable: boolean;
}

export interface ModelProviderView {
  provider_id: string;
  display_name: string;
  adapter: HarnessProviderAdapter;
  protocol: HarnessProviderProtocol;
  base_url: string;
  key: ModelProviderKeyView;
  models: ModelProviderModelView[];
  /** 是否至少有一个可用模型（决定这个供应商会不会出现在助手模型列表里） */
  usable: boolean;
  last_test_at: string | null;
  last_test_by: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface ModelProviderDefaultsView {
  provider: string;
  model: string;
  reasoning_effort: string;
}

export interface ModelProviderAdminView {
  revision: string;
  defaults: ModelProviderDefaultsView;
  providers: ModelProviderView[];
  /** 仍由配置文件决定、设置页只读展示的边界项 */
  readonly: {
    enabled: boolean;
    permission_preset: HarnessPermissionPreset;
    runtime: Record<string, unknown>;
    workspace: Record<string, unknown>;
  } | null;
  /** 当前运行中的 Harness 会话数（「立即应用」按钮用） */
  applyable_runtimes: number;
  /** 主密钥未注入：保存密钥会失败，提前提示 */
  key_master_missing: boolean;
}

/** 有效配置快照（网关 / 会话生成器读这个） */
export interface HarnessProviderSnapshot {
  enabled: boolean;
  /** 变更标识：库行 revision + 最后更新时间，用于判断运行中会话是否已陈旧 */
  revision: string;
  defaults: ModelProviderDefaultsView;
  providers: Record<string, DeepseekHarnessProviderConfig>;
  /** 密文不可解密的供应商 ID（页面红字告警；网关对其返回 503） */
  unreadable: string[];
  /** 库行无法解析（人工改库等）的供应商 ID，已跳过 */
  broken: string[];
  /** 是否至少有一个**可用模型**（有密钥 + 测试通过）：false 时拒绝启动会话 */
  configured: boolean;
}

export type { DeepseekHarnessModelConfig, DeepseekHarnessProviderConfig };
