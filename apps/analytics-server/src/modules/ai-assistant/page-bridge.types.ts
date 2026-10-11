export type AiAnalysisPage = 'event' | 'funnel' | 'retention' | 'sql';
export type PageBridgeAction =
  | 'sql_edit'
  | 'sql_execute'
  | 'sql_load_card'
  | 'analysis_edit'
  /** 图表配置提案，SQL 与事件两域共用，按绑定页面选域；等价旧名 'sql_chart_edit' */
  | 'analysis_chart_edit'
  | 'sql_chart_edit';

export interface PageBridgeSnapshotInput {
  tab_id: string;
  page: AiAnalysisPage;
  revision: number;
  state: Record<string, unknown>;
}

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

export interface PageBridgeDecisionInput {
  accepted: boolean;
  current_revision: number;
  applied_revision?: number;
  result?: unknown;
  reason?: string;
}

export interface PageBridgeRuntimeIdentity {
  user_id: string;
  project_name: string;
  tab_id: string;
}
