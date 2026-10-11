import { get, post, put } from './api';

/**
 * 运维面板接口（phase: clklog-analytics-ops-console-v1）。
 * 全部只读；仅平台超管可访问（后端两道闸：ops.runtime.access + isAdmin）。
 */

export interface SlowQueryItem {
  event_time: string;
  duration_ms: number;
  read_rows: number;
  read_bytes: number;
  memory_usage: number;
  user: string;
  status: 'success' | 'failed';
  query: string;
  exception: string | null;
}

export interface SlowQueryResponse {
  /** 提示的文案键与参数（i18n v1；优先用 key 渲染） */
  retention_note_key?: string;
  retention_note_params?: Record<string, unknown>;
  items: SlowQueryItem[];
  window: { hours: number; since: string };
  retention_note: string;
  generated_at: string;
  from_cache: boolean;
}

export function getSlowQueries(params: {
  hours?: number;
  min_duration_ms?: number;
  status?: 'all' | 'success' | 'failed';
  limit?: number;
}) {
  const search = new URLSearchParams();
  if (params.hours !== undefined) search.set('hours', String(params.hours));
  if (params.min_duration_ms !== undefined) search.set('min_duration_ms', String(params.min_duration_ms));
  if (params.status && params.status !== 'all') search.set('status', params.status);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  const query = search.toString();
  return get<SlowQueryResponse>(`/ops/slow-queries${query ? `?${query}` : ''}`);
}

export interface ServerStatus {
  app: {
    version: string;
    nodeVersion: string;
    uptimeSeconds: number;
    heapUsedBytes: number;
    rssBytes: number;
  };
  host: {
    memory: { totalBytes: number; availableBytes: number; usedPercent: number } | null;
    load: { load1: number; load5: number; load15: number } | null;
    disks: { path: string; totalBytes: number; freeBytes: number; usedPercent: number }[];
    cpuCores: number;
  };
  clickhouse: {
    ok: boolean;
    chVersion?: string;
    eventRows?: number;
    eventBytes?: number;
    lastWriteAt?: string | null;
    error?: string;
  };
}

export function getServerStatus() {
  return get<ServerStatus>('/ops/server-status');
}

// ===== 磁盘趋势（切片 3）=====

export interface DiskTrendResponse {
  samples: { sampled_at: string; value: number }[];
  current: { path: string; totalBytes: number; usedBytes: number; usedPercent: number } | null;
}

export function getDiskTrend(hours = 168, path?: string) {
  const search = new URLSearchParams({ hours: String(hours) });
  if (path) search.set('path', path);
  return get<DiskTrendResponse>(`/ops/disk-trend?${search.toString()}`);
}

// ===== 日志目录治理（数据管理 V1.1：程序内实现）=====

export interface LogCleanupConfigItem {
  path: string;
  label: string;
  retain_days: number;
  enabled: boolean;
  last_run_at: string | null;
  last_freed_bytes: number | null;
  last_file_count: number | null;
  current: { file_count: number; total_bytes: number };
}

export function getLogCleanupConfigs() {
  return get<LogCleanupConfigItem[]>('/ops/log-cleanup');
}

export function previewLogCleanup(path: string) {
  return get<{ path: string; retain_days: number; file_count: number; total_bytes: number }>(
    `/ops/log-cleanup/preview?path=${encodeURIComponent(path)}`,
  );
}

export function executeLogCleanup(path: string) {
  return post<{ deleted_count: number; freed_bytes: number }>('/ops/log-cleanup/execute', { path });
}

export function updateLogCleanupConfig(
  path: string,
  input: { retain_days?: number; enabled?: boolean },
) {
  return post<LogCleanupConfigItem[]>('/ops/log-cleanup/config', { path, ...input });
}

// ===== 数据管理（data-management V1.0）=====

export interface TableInventory {
  table: string;
  rows: number;
  compressed_bytes: number;
  total_bytes: number;
  partitions: number;
  last_write_at: string | null;
  ttl_days: number | null;
  engine: string;
}

export function getDataOverview() {
  return get<{ tables: TableInventory[]; generated_at: string }>('/ops/data-mgmt/overview');
}

export interface TableTrendResponse {
  hours: number;
  series: Record<string, { rows: [string, number][]; bytes: [string, number][] }>;
  sampled_points: number;
}

export function getDataTrend(hours = 24 * 30) {
  return get<TableTrendResponse>(`/ops/data-mgmt/trend?hours=${hours}`);
}

/** 清理前置对拍结论（R2-3）：未通过时后端会拒绝执行 */
export interface PreflightView {
  ok: boolean;
  reason: 'ok' | 'no_snapshot' | 'not_covered' | 'snapshot_failed' | 'snapshot_stale';
  snapshot_id: string | null;
  ran_at: string | null;
  range: { from: string; to: string } | null;
  has_alert: boolean | null;
  age_hours: number | null;
  max_age_hours: number;
  required_to: string;
}

export interface CleanupPreviewResult {
  table: string;
  older_than_days: number;
  cutoff: string;
  partitions: { partition: string; rows: number; compressed_bytes: number }[];
  total_rows: number;
  total_compressed_bytes: number;
  action: string;
  note?: string;
  preflight?: PreflightView | null;
}

/** 保留策略总览（R2-1）：预期 × 实际 × 状态 × 对拍可信区间 */
export interface RetentionRowView {
  table: string;
  expected_days: number;
  registered: boolean;
  mode: string;
  enabled: boolean;
  remark: string | null;
  updated_by: string | null;
  updated_at: string | null;
  actual_ttl_days: number | null;
  status: 'ok' | 'unset' | 'deviates' | 'disabled';
  rows: number;
  compressed_bytes: number;
  partitions: number;
}

export interface RetentionOverviewView {
  rows: RetentionRowView[];
  trusted_range: {
    from: string | null;
    to: string;
    retention_days: number | null;
    sa_days: number | null;
    raw_days: number | null;
    bound_by: string | null;
  };
  summary: {
    total: number;
    unset: number;
    deviates: number;
    raw_unset: number;
    suspicious_partitions: Array<{ table: string; partition: string; kind: 'future' | 'ancient'; rows: number }>;
  };
}

export function getRetentionOverview() {
  return get<RetentionOverviewView>('/ops/data-mgmt/retention');
}

export function saveRetentionPolicy(
  db: string,
  table: string,
  patch: { keep_days: number; mode?: string; enabled?: boolean; remark?: string | null },
) {
  return put<RetentionRowView>(`/ops/data-mgmt/retention/${db}/${table}`, patch);
}

export function previewCleanup(table: string, older_than_days: number) {
  return post<CleanupPreviewResult>('/ops/data-mgmt/cleanup/preview', { table, older_than_days });
}

export interface ReconcileSnapshotView {
  ran_at: string;
  range: { from: string; to: string };
  summary: {
    has_alert: boolean;
    total_days: number;
    alert_days: number;
    skipped_days?: number;
    dup_crc_rows: number;
    crc_pass: boolean;
    recent_changes: number;
  } | null;
  /** 快照新鲜度：fresh=新鲜 / warn=偏旧（黄）/ error=过期（红）；两页同源 */
  stale_level: 'fresh' | 'warn' | 'error';
  age_hours: number;
  stale_warn_hours: number;
  stale_error_hours: number;
}

export function getDataHealth() {
  return get<ReconcileSnapshotView | null>('/ops/data-mgmt/health');
}

// ===== 数据管理 V1.1：清理执行（动作类）=====

export interface ExecuteDropResult {
  done: string[];
  failed: { partition: string; error: string }[];
  rejected: { partition: string; reason: string }[];
}

export function executeDropPartitions(input: {
  table: string;
  partitions: string[];
  confirmed_table: string;
  dry_run_snapshot?: unknown;
}) {
  return post<ExecuteDropResult>('/ops/data-mgmt/cleanup/execute', input);
}

export function setTableTtl(input: { table: string; days: number; confirmed_table: string }) {
  return post<{ table: string; ttl_days: number; time_column: string }>('/ops/data-mgmt/ttl', input);
}

export interface ActionLogItem {
  id: string;
  action: string;
  target_table: string;
  detail: Record<string, unknown>;
  dry_run_snapshot: Record<string, unknown> | null;
  status: 'done' | 'failed' | 'partial';
  error: string | null;
  operator: string;
  created_at: string;
}

export function getDataMgmtActions(params?: { table?: string; limit?: number }) {
  const search = new URLSearchParams();
  if (params?.table) search.set('table', params.table);
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  const q = search.toString();
  return get<ActionLogItem[]>(`/ops/data-mgmt/actions${q ? `?${q}` : ''}`);
}

export function getMutations(table: string) {
  return get<{ running: { command: string; created_at: string; latest_fail_reason: string | null }[] }>(
    `/ops/data-mgmt/mutations?table=${encodeURIComponent(table)}`,
  );
}

// ===== 数据清理 v1.2：定点删除 + 数据↔元数据对账（phase: clklog-data-management-v1.2）=====

/** 删除条件类型（与后端 cleanup-plan.ts 的白名单一致） */
export type DeleteKind = 'event' | 'project' | 'before' | 'future';

export interface DeletePreviewView {
  table: string;
  plan_summary: string;
  rows: number;
  min_date: string | null;
  max_date: string | null;
  samples: Record<string, unknown>[];
  max_rows: number;
  max_rows_exceeded: boolean;
  backup_table: string;
  cleanup_enabled: boolean;
  preflight: {
    ok: boolean;
    reason: 'ok' | 'no_snapshot' | 'not_covered' | 'snapshot_failed' | 'snapshot_stale';
    required_to: string;
    snapshot_id: string | null;
    range: { from: string; to: string } | null;
    age_hours: number | null;
  };
  confirm_token: string | null;
}

export interface UnregisteredEventsView {
  project: string;
  window_days: number;
  window_from: string;
  data_events: number;
  registered_events: number;
  unregistered: Array<{ event: string; rows: number; min_date: string; max_date: string; has_future: boolean }>;
  ghost_registered: string[];
  truncated: boolean;
}

export function getUnregisteredEvents(project: string, windowDays = 14) {
  // ⚠️ project 必须走 params：api 拦截器会补 `params.project`（它只检查 params 里有没有），
  // 直接拼在 URL 里会被再补一次 → 服务端收到 "a,a" 过滤不到任何行（2026-10-09 实测踩到）
  return get<UnregisteredEventsView>('/ops/data-mgmt/unregistered-events', {
    params: { project, window_days: windowDays },
  });
}

export function deletePreview(input: {
  kind: DeleteKind;
  table: string;
  project: string;
  event?: string;
  before?: string;
}) {
  return post<DeletePreviewView>('/ops/data-mgmt/delete/preview', input);
}

export function deleteExecute(input: {
  kind: DeleteKind;
  table: string;
  project: string;
  event?: string;
  before?: string;
  confirm_table: string;
  confirm_token: string;
}) {
  return post<{
    table: string;
    rows_planned: number;
    backup_table: string | null;
    mode: 'drop_partition' | 'alter_delete';
    mutation_id: string | null;
    ledger_id: string | null;
  }>('/ops/data-mgmt/delete/execute', input);
}

/** 项目退役预演（R4-b，只读）：sa 5 张 + MySQL 31 张影响面 + 最近 24h 写入 + 社区版提示 */
export interface ProjectRetirePreviewView {
  project: string;
  registered: boolean;
  writes_last_24h: number;
  sa_tables: Array<{ table: string; rows: number; min_date: string | null; max_date: string | null }>;
  mysql_tables: Array<{ table: string; rows: number }>;
  mysql_total_rows: number;
  /** 展示文案由前端按查看者语言渲染（服务端只下发 key） */
  community_note_key: 'communityNoProject';
  next_step_keys: Array<'stopWrites' | 'execution' | 'backupAudit'>;
}

export function projectRetirePreview(project: string) {
  return post<ProjectRetirePreviewView>('/ops/data-mgmt/project-retire/preview', { project });
}

/** 取退役执行的确认令牌（绑定项目名 + 影响面行数，5 分钟有效） */
export function projectRetireToken(project: string) {
  return post<{ token: string; summary: string; rows: number }>('/ops/data-mgmt/project-retire/token', { project });
}

/** 执行退役的一步（sa | mysql）：服务端会再校验 24h 写入=0 + 令牌有效 */
export function projectRetireExecute(input: { project: string; step: 'sa' | 'mysql'; confirm_token: string }) {
  return post<{
    project: string;
    step: 'sa' | 'mysql';
    done: boolean;
    tables: Array<{ table: string; rows: number; mode: string }>;
    backup: string | null;
    message_key: 'saDone' | 'saPartial' | 'mysqlDone';
    message_params: Record<string, unknown>;
  }>('/ops/data-mgmt/project-retire/execute', input);
}
