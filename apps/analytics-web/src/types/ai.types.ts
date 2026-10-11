export type AiAnalysisPage = 'event' | 'funnel' | 'retention' | 'sql';

export interface AiPageContext {
  page: AiAnalysisPage;
  route: string;
  revision?: number;
  analysis?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface HarnessHostTicket {
  ticket: string;
  launch_url: string;
  expires_in_ms: number;
  peer_sessions?: number;
}

export interface AiWorkspace {
  id: string;
  user_id: string;
  project_name: string;
  kind: 'persistent' | 'temporary';
  display_name: string;
  status: string;
  initialized_from: string;
  applied_template_version: number;
  last_access_at: string;
  expires_at: string | null;
}

export type PageBridgeAction =
  | 'sql_edit'
  | 'sql_execute'
  | 'sql_load_card'
  | 'analysis_edit'
  /** 图表配置提案（SQL / 事件两域共用，按页面分派域） */
  | 'analysis_chart_edit'
  /** 旧名，服务端仍接受（部署顺序容错） */
  | 'sql_chart_edit';

export interface PageBridgeEvent {
  sequence: number;
  proposal_id: string;
  action: PageBridgeAction;
  expected_revision: number;
  sql: string;
  reason: string;
  created_at: string;
  expires_at?: string;
  card_id?: string;
  card_name?: string;
  page?: AiAnalysisPage;
  dsl?: Record<string, unknown>;
  chart_config?: Record<string, unknown>;
}

export interface WorkspaceTemplateDraftEntry {
  path: string;
  kind: 'file' | 'directory';
  policy: 'managed_readonly' | 'seed_once';
  mode: string;
  sha256: string;
  size?: number;
  content?: string;
  encoding?: 'utf8' | 'base64';
}

/** 模型供应商设置（phase: clklog-ai-model-providers-v1 v1.1：库为唯一来源） */
export type ModelProviderAdapter = 'openai_compatible' | 'deepseek';
export type ModelProviderProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export interface ModelProviderKeyView {
  configured: boolean;
  /** `••••末4位`；未配置或密文不可读时为 null */
  hint: string | null;
  /** 密文存在但解不开（主密钥被换）：要求重填 */
  unreadable: boolean;
}

export interface ModelProviderModel {
  id: string;
  display_name: string;
  /** 模型是否接受图片输入（会话生成器据此声明 DSH 输入模态） */
  supports_image: boolean;
  reasoning_efforts: string[];
  default_reasoning_effort: string;
  /** 是否通过过连接测试 */
  verified: boolean;
  /** 可用 = 有密钥 且 已验证；只有可用模型会出现在助手的模型列表里 */
  usable: boolean;
}

export interface ModelProviderView {
  provider_id: string;
  display_name: string;
  adapter: ModelProviderAdapter;
  protocol: ModelProviderProtocol;
  base_url: string;
  key: ModelProviderKeyView;
  models: ModelProviderModel[];
  /** 该供应商是否至少有 1 个可用模型（决定它是否出现在助手模型列表里） */
  usable: boolean;
  last_test_at: string | null;
  last_test_by: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface ModelProviderDefaults {
  provider: string;
  model: string;
  reasoning_effort: string;
}

export interface ModelProviderAdminView {
  revision: string;
  defaults: ModelProviderDefaults;
  providers: ModelProviderView[];
  /** 仍由配置文件决定、页面只读展示的部署与安全边界 */
  readonly: {
    enabled: boolean;
    permission_preset: string;
    runtime: Record<string, unknown>;
    workspace: Record<string, unknown>;
  } | null;
  /** 当前运行中的 Harness 会话数 */
  applyable_runtimes: number;
  key_master_missing: boolean;
}

/** 写入口的模型项：验证状态由服务端维护，不由客户端提交 */
export type SaveModelProviderModel = Omit<ModelProviderModel, 'verified' | 'usable'>;

export interface SaveModelProviderInput {
  display_name: string;
  adapter: ModelProviderAdapter;
  protocol: ModelProviderProtocol;
  base_url: string;
  /** 缺省 = 不修改已保存的密钥 */
  api_key?: string;
  models: SaveModelProviderModel[];
}

export interface ModelProviderSaveResult {
  ok: boolean;
  applyable_runtimes: number;
}

export interface ModelProviderTestResult {
  ok: boolean;
  status: number;
  elapsed_ms: number;
  model: string;
  error_code?: string;
  error_key?: string;
  /** 厂商原始响应片段（不含密钥） */
  detail?: string;
}

/** 不带 model 时逐个测试该供应商下的全部模型 */
export interface ModelProviderTestResponse {
  results: ModelProviderTestResult[];
}
