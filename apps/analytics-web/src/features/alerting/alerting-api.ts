import { currentLocale, type TFunction } from '../../i18n';
import { del, get, post, put } from '../../services/api';
import type { TimeRangeRelative } from '../../types/dsl.types';
import type { MetricSummaryStructure } from '../metrics/metric-definition';

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertComparator = 'gt' | 'gte' | 'lt' | 'lte';
/** 规则健康度（alerting-v4）：判定在后端，前端只展示 */
export type AlertRuleHealth = 'ok' | 'metric_missing' | 'metric_eval_failed' | 'no_contact';

/** 指标窗口天数（与后端白名单一致：事件分析按天过滤 stat_date，无分钟级窗口） */
export const windowDaysOptionsOf = (t: TFunction): { value: number; label: string }[] => [
  { value: 1, label: t('common:time.today') },
  { value: 2, label: t('alerting:window.last2Days') },
  { value: 7, label: t('common:time.last7Days') },
  { value: 30, label: t('common:time.last30Days') },
];

export interface AlertRuleItem {
  code: string;
  name: string;
  threshold: number;
  enabled: boolean;
  severity: AlertSeverity;
  comparator: AlertComparator;
  unit: string;
  window_minutes: number;
  for_windows: number;
  repeat_minutes: number;
  notify_on_resolve: boolean;
  contact_id: string | null;
  contact_ids: string[];
  contact_names: string[];
  contact_name: string | null;
  source: 'builtin' | 'metric' | string;
  /** 时间范围来源（metric-v2）：metric=跟随指标；rule=由本规则窗口指定 */
  time_source?: 'metric' | 'rule';
  /** 指标告警：绑定的「数据管理 → 指标」（alerting-v4，取代卡片来源） */
  metric_id: string | null;
  metric_name: string | null;
  window_days: number;
  project_name: string | null;
  firing: boolean;
  firing_value: number | null;
  health: AlertRuleHealth;
  /** 服务端下发的健康标签资源键；无则回退前端既有映射 */
  health_label_key?: string | null;
  health_detail: string;
  /** 健康详情（Tooltip）资源键与插值参数；无则回退 health_detail */
  health_detail_key?: string | null;
  health_detail_params?: Record<string, string | number> | null;
}

export interface AlertEventItem {
  id: string;
  rule_code: string;
  rule_name: string;
  severity: AlertSeverity;
  unit: string;
  value: number;
  status: 'firing' | 'resolved';
  fired_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

export interface AlertContactItem {
  id: string;
  name: string;
  kind: string;
  webhook_url: string;
  address?: string;
  /** 启用开关（停用后不投递） */
  enabled: boolean;
  is_default?: boolean;
  /** 收件人语言（BCP-47，如 zh-CN / en-US）；null = 平台默认 */
  locale?: string | null;
  /** 收件人时区（IANA，timezone-v2）；null = 项目/平台 */
  timezone?: string | null;
  created_at: string;
}

/** 可选告警指标（数据管理 → 指标） */
export interface AlertMetricItem {
  metric_id: string;
  name: string;
  display_name: string;
  kind: string;
  kind_label: string;
  /** 指标类型名的资源键（优先用 key 渲染，无则回退 kind_label） */
  kind_label_key?: string;
  format: string;
  unit: string;
  remark: string | null;
  definition_summary: string;
  /**
   * 口径摘要的**结构**（i18n 收口）：固定文案由前端 `metricSummaryText` 按查看者语言渲染；
   * `definition_summary` 是中文原值（老响应兜底）。
   */
  definition_summary_structure?: MetricSummaryStructure | null;
  /** 指标自带查询时间的文案（null = 未设置，告警按规则窗口） */
  window_label: string | null;
  /** 指标自带查询时间的结构：天数 + 相对范围（界面按查看者语言渲染窗口文案） */
  window_days?: number | null;
  window_relative?: TimeRangeRelative | null;
  /** 取值选择文案（null = 自动，按计算方法推荐） */
  value_pick_label: string | null;
  /** 取值选择的枚举原值（前端用 `metrics:valuePick.*` 渲染） */
  value_pick?: string | null;
  alertable: boolean;
  reason: string | null;
  updated_at: string;
}

export interface MetricProbeResult {
  value: number | null;
  value_fmt: string;
  window_days: number;
  window_fmt: string;
  /** 窗口来源：metric=指标查询时间；rule=本规则窗口；default=默认 7 天 */
  window_source?: 'metric' | 'rule' | 'default';
  /** 窗口结构（i18n 收口）：`relative` 仅指标自带查询时间时下发，其余按天数生成 */
  window_relative?: TimeRangeRelative | null;
  /** 留存口径：文案带「队列 {window}」前缀 */
  window_cohort?: boolean;
  pick?: string;
  pick_label?: string;
  unit: string;
  elapsed_ms: number;
  error?: string;
}

export type AlertKind = 'fire' | 'resolve';
/**
 * 通知模板按**通道组**维护（phase: clklog-analytics-alert-channels-v1）：
 * chat = 群机器人 / IM / 通用 Webhook / Telegram / WhatsApp。
 */
export type AlertChannel = 'chat' | 'email' | 'sms';

export interface AlertTemplateVar {
  name: string;
  label: string;
  /** 本地化名资源键；无则回退 label */
  label_key?: string;
  sample: string;
}

export interface AlertTemplateItem {
  kind: AlertKind;
  kind_label: string;
  /** 事件类型名的资源键（优先用 key 渲染，无则回退 kind_label） */
  kind_label_key?: string;
  channel: AlertChannel;
  channel_label: string;
  subject: string;
  body: string;
  is_default: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

export interface AlertMuteItem {
  id: string;
  rule_code: string | null;
  starts_at: string;
  ends_at: string;
  reason: string;
}

export interface AlertNotificationItem {
  id: string;
  rule_code: string;
  event_id: string | null;
  kind: 'fire' | 'repeat' | 'resolve';
  status: 'success' | 'fail';
  error: string | null;
  /** 投递目标（多联系人后同一事件多行，用于区分是哪条通道） */
  contact_id: string | null;
  contact_name: string | null;
  created_at: string;
}

export interface AlertOverview {
  fired_today: number;
  unresolved: number;
  notify_fail_today: number;
  top_rules: { rule_code: string; rule_name: string; count: number }[];
  health: {
    contacts: number;
    has_enabled_contact: boolean;
    enabled_contacts: number;
    broken_rules: number;
    broken_rule_names: string[];
    no_contact_rules: number;
    notify_fail_24h: number;
  };
}

export interface AlertAuditItem {
  id: string;
  action: string;
  target_table: string;
  detail: Record<string, unknown>;
  operator: string;
  created_at: string;
}

export function getAlertRules() {
  return get<{ items: AlertRuleItem[] }>('/ops/alerts/rules');
}

export function createAlertRule(input: {
  name: string;
  metric_id: string;
  threshold: number;
  unit?: string;
  severity?: AlertSeverity;
  comparator?: AlertComparator;
  window_days?: number;
  for_windows?: number;
  repeat_minutes?: number;
  notify_on_resolve?: boolean;
  contact_id?: string | null;
  /** 多联系人绑定（可发到多个渠道） */
  contact_ids?: string[];
  /** 时间范围来源（metric-v2）：metric=跟随指标查询时间；rule=由本规则窗口指定 */
  time_source?: 'metric' | 'rule';
}) {
  return post<{ code: string }>('/ops/alerts/rules', input);
}

export function deleteAlertRule(code: string) {
  return del<{ ok: boolean }>(`/ops/alerts/rules/${code}`);
}

/** 通道能力位 + 元数据（label/group/contact_fields/hint），前端表单据此渲染 */
export interface AlertChannelCapability {
  available: boolean;
  reason: string | null;
  /** 不可用原因资源键（names 参数由 reason_configs 本地化后拼出）；无则回退 reason */
  reason_key?: string | null;
  /** 不可用原因涉及的平台配置键（按 channelConfig.<key>.label 本地化） */
  reason_configs?: string[];
  label: string;
  /** 本地化名资源键；无则回退 label */
  label_key?: string | null;
  group: 'chat' | 'email' | 'sms';
  kind: string;
  contact_fields: string[];
  required_config: string[];
  hint: string | null;
  /** 可用性来自平台邮件通道（告警侧未配置时的回落）；仅 email 可能为 true */
  platform_fallback?: boolean;
  /** 该通道被暂停投递（此时 available 必为 false） */
  muted?: boolean;
}

export function getAlertChannels() {
  return get<Record<string, AlertChannelCapability>>('/ops/alerts/channels');
}

/* --------------------- 通道平台配置（凭证） --------------------- */

export interface AlertChannelConfigField {
  key: string;
  label: string;
  /** 本地化资源键；无则回退原字段 */
  label_key?: string;
  placeholder_key?: string;
  hint_key?: string;
  type: 'text' | 'password' | 'number' | 'boolean';
  required: boolean;
  placeholder?: string;
  hint?: string;
  defaultValue?: string | number | boolean;
}

export interface AlertChannelConfigSchema {
  channel: string;
  label: string;
  label_key?: string;
  hint: string;
  hint_key?: string;
  /** 表头「?」里的逐步配置方法（多行文本）；缺省则不显示「?」 */
  help?: string;
  help_key?: string;
  fields: AlertChannelConfigField[];
  secretFields: AlertChannelConfigField[];
}

export interface AlertChannelConfigItem {
  channel: string;
  label: string;
  label_key?: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  secret: { configured: boolean; hint: string; keys: Record<string, string> };
  updated_by: string | null;
  updated_at: string | null;
  env_fallback: boolean;
  /** 告警侧未启用、但平台邮件通道可用（邮件走「用户管理 → 邮件通道」的账号）；仅 smtp 可能为 true */
  platform_fallback?: boolean;
  /** 暂停投递：保留配置与密钥，但此通道不参与任何投递（含平台邮件兜底） */
  muted?: boolean;
}

export function getAlertChannelConfigs() {
  return get<{ items: AlertChannelConfigItem[]; schemas: AlertChannelConfigSchema[] }>(
    '/ops/alerts/channel-configs',
  );
}

export function saveAlertChannelConfig(
  channel: string,
  input: { enabled?: boolean; muted?: boolean; config?: Record<string, unknown>; secret?: Record<string, unknown> },
) {
  return put<{ ok: boolean }>(`/ops/alerts/channel-configs/${channel}`, input);
}

export function testAlertChannel(
  channel: string,
  input: { address?: string; webhook_url?: string; chat_id?: string; options?: Record<string, unknown> },
) {
  return post<{
    ok: boolean;
    error?: string;
    /** 校验失败原因的文案键与插值参数（后端新增字段）：优先用它按当前语言渲染，缺省回退 error */
    error_key?: string | null;
    error_params?: Record<string, unknown> | null;
    detail: string;
  }>(`/ops/alerts/channel-configs/${channel}/test`, input);
}

/** 通道与通道组的中文名（模板页签兜底；能力位接口会带 label） */
export const channelLabelsOf = (t: TFunction): Record<string, string> => ({
  feishu_webhook: t('alerting:channel.feishu'),
  dingtalk: t('alerting:channel.dingtalk'),
  wecom: t('alerting:channel.wecom'),
  telegram: 'Telegram',
  webhook: t('alerting:channel.webhook'),
  email: t('alerting:channel.email'),
  sms: t('alerting:channel.sms'),
  whatsapp: 'WhatsApp',
});

/**
 * 可选指标清单。project 走 params（拦截器会带上），**不在 URL 里手拼 query**——
 * 曾经手拼 `?project=` 与拦截器重复，导致后端收到数组参数直接 500（alerting-v4 缺陷修复）。
 */
export function getAlertMetrics(project?: string) {
  return get<{ items: AlertMetricItem[] }>('/ops/alerts/metrics', {
    params: project ? { project } : undefined,
  });
}

export function probeAlertMetric(
  metricId: string,
  windowDays: number,
  project?: string,
  timeSource?: 'metric' | 'rule',
) {
  return post<MetricProbeResult>(
    `/ops/alerts/metrics/${metricId}/probe`,
    { window_days: windowDays, time_source: timeSource },
    { params: project ? { project } : undefined },
  );
}

export function updateAlertRule(
  code: string,
  input: Partial<
    Pick<
      AlertRuleItem,
      | 'enabled'
      | 'threshold'
      | 'severity'
      | 'comparator'
      | 'window_minutes'
      | 'window_days'
      | 'for_windows'
      | 'repeat_minutes'
      | 'notify_on_resolve'
      | 'contact_id'
    >
  > & {
    /** 多联系人绑定（可发到多个渠道）；空数组 = 清空绑定 */
    contact_ids?: string[];
    /** 时间范围来源（metric-v2） */
    time_source?: 'metric' | 'rule';
  },
) {
  return put<{ ok: boolean }>(`/ops/alerts/rules/${code}`, input);
}

export function getAlertEvents(params?: { status?: 'all' | 'firing' | 'resolved'; limit?: number }) {
  const search = new URLSearchParams();
  if (params?.status && params.status !== 'all') search.set('status', params.status);
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  const query = search.toString();
  return get<{ items: AlertEventItem[] }>(`/ops/alerts/events${query ? `?${query}` : ''}`);
}

export function getAlertOverview() {
  return get<AlertOverview>('/ops/alerts/overview');
}

export function getAlertContacts() {
  return get<{ items: AlertContactItem[] }>('/ops/alerts/contacts');
}

export function createAlertContact(input: {
  name: string;
  /** 通道 key（见 getAlertChannels 返回的 map） */
  kind?: string;
  webhook_url?: string;
  address?: string;
  /** 通道专属：{ secret?, headers?, body_template?, provider? } */
  options?: Record<string, unknown>;
  enabled?: boolean;
  /** 收件人语言（BCP-47）：通知按此语言渲染；null = 平台默认 */
  locale?: string | null;
}) {
  return post<{ id: string }>('/ops/alerts/contacts', input);
}

export function updateAlertContact(
  id: string,
  input: {
    name?: string;
    kind?: string;
    webhook_url?: string;
    address?: string;
    options?: Record<string, unknown>;
    enabled?: boolean;
    /** 收件人语言（BCP-47）：null = 平台默认 */
    locale?: string | null;
  },
) {
  return put<{ ok: boolean }>(`/ops/alerts/contacts/${id}`, input);
}

export function deleteAlertContact(id: string) {
  return del<{ ok: boolean }>(`/ops/alerts/contacts/${id}`);
}

export function getAlertMutes() {
  return get<{ items: AlertMuteItem[] }>('/ops/alerts/mutes');
}

export function createAlertMute(input: {
  rule_code?: string | null;
  starts_at?: string;
  ends_at?: string;
  duration_hours?: number;
  reason?: string;
}) {
  return post<{ id: string }>('/ops/alerts/mutes', input);
}

export function deleteAlertMute(id: string) {
  return del<{ ok: boolean }>(`/ops/alerts/mutes/${id}`);
}

export function getAlertNotifications(limit = 50) {
  return get<{ items: AlertNotificationItem[] }>(`/ops/alerts/notifications?limit=${limit}`);
}

/** 配置变更审计（alerting-v3）：规则/联系人/屏蔽/模板的增删改 */
export function getAlertAudits(limit = 50) {
  return get<{ items: AlertAuditItem[] }>(`/ops/alerts/audits?limit=${limit}`);
}

/* ------------------------- 通知模板（alerting-v4） ------------------------- */

export function getAlertTemplates(project?: string) {
  // x-locale：服务端按**操作者**语言返回未自定义的默认模板（与投递侧按收件人语言区分）
  return get<{ items: AlertTemplateItem[]; variables: AlertTemplateVar[] }>('/ops/alerts/templates', {
    params: project ? { project } : undefined,
    headers: { 'x-locale': currentLocale() },
  });
}

export function saveAlertTemplate(
  kind: AlertKind,
  channel: AlertChannel,
  input: { body: string; subject?: string },
  project?: string,
) {
  return put<{ ok: boolean }>(`/ops/alerts/templates/${kind}/${channel}`, input, {
    params: project ? { project } : undefined,
  });
}

export function resetAlertTemplate(kind: AlertKind, channel: AlertChannel, project?: string) {
  return del<{ ok: boolean }>(`/ops/alerts/templates/${kind}/${channel}`, {
    params: project ? { project } : undefined,
  });
}

/** 预览：用示例数据渲染，不会发送真实通知（默认模板按操作者语言） */
export function previewAlertTemplate(input: {
  kind: AlertKind;
  channel: AlertChannel;
  body?: string;
  subject?: string;
}) {
  return post<{ subject: string; body: string; is_default: boolean }>(
    '/ops/alerts/templates/preview',
    input,
    { headers: { 'x-locale': currentLocale() } },
  );
}

export const ruleActionLabelsOf = (t: TFunction): Record<string, string> => ({
  alert_rule_update: t('alerting:audit.action.ruleUpdate'),
  alert_rule_create: t('alerting:audit.action.ruleCreate'),
  alert_rule_delete: t('alerting:audit.action.ruleDelete'),
  alert_contact_create: t('alerting:audit.action.contactCreate'),
  alert_contact_delete: t('alerting:audit.action.contactDelete'),
  alert_contact_default: t('alerting:audit.action.contactDefault'),
  alert_mute_create: t('alerting:audit.action.muteCreate'),
  alert_mute_delete: t('alerting:audit.action.muteDelete'),
  alert_contact_update: t('alerting:audit.action.contactUpdate'),
  alert_retention_update: t('alerting:audit.action.retentionUpdate'),
  alert_retention_cleanup: t('alerting:audit.action.retentionCleanup'),
  alert_template_update: t('alerting:audit.action.templateUpdate'),
  alert_template_reset: t('alerting:audit.action.templateReset'),
});

/** 变更内容渲染：changes={field:{from,to}} 时输出「字段：旧 → 新」 */
export function formatAuditDetail(detail: Record<string, unknown>, t: TFunction): string {
  const changes = detail?.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  if (changes && typeof changes === 'object') {
    const parts = Object.entries(changes).map(([field, pair]) => {
      const label = auditFieldLabel(t, field);
      return t('alerting:audit.change', {
        field: label,
        from: renderValue(t, field, pair?.from),
        to: renderValue(t, field, pair?.to),
      });
    });
    return parts.join(t('alerting:separator.pair')) || t('alerting:audit.noChange');
  }
  return Object.entries(detail ?? {})
    .filter(([key]) => key !== 'changes')
    .map(([key, value]) =>
      t('alerting:audit.fieldEntry', {
        field: auditFieldLabel(t, key),
        value: renderValue(t, key, value),
      }),
    )
    .join(t('alerting:separator.entry'));
}

const auditFieldLabelsOf = (t: TFunction): Record<string, string> => ({
  code: t('alerting:audit.field.code'),
  name: t('common:label.name'),
  threshold: t('alerting:rule.threshold'),
  comparator: t('alerting:audit.field.comparator'),
  severity: t('alerting:severity.label'),
  unit: t('alerting:field.unit'),
  window_minutes: t('alerting:audit.field.windowMinutes'),
  window_days: t('alerting:audit.field.windowDays'),
  for_windows: t('alerting:audit.field.forWindows'),
  repeat_minutes: t('alerting:audit.field.repeatMinutes'),
  notify_on_resolve: t('alerting:audit.field.notifyOnResolve'),
  contact_id: t('alerting:contact.label'),
  contact_ids: t('alerting:contact.label'),
  enabled: t('alerting:field.enabled'),
  metric_id: t('alerting:metric.label'),
  metric_name: t('alerting:audit.field.metricName'),
  kind: t('common:label.type'),
  channel: t('alerting:channel.label'),
  body_length: t('alerting:audit.field.bodyLength'),
  subject: t('alerting:template.subject'),
  project: t('alerting:metric.project'),
  deleted: t('alerting:audit.field.deleted'),
  address: t('alerting:contact.address'),
  is_default: t('common:state.default'),
  was_default: t('alerting:audit.field.wasDefault'),
  enabled_contacts: t('alerting:audit.field.enabledContacts'),
  provider: t('alerting:contact.smsProvider'),
  rule_code: t('alerting:rule.label'),
  starts_at: t('alerting:mute.start'),
  ends_at: t('alerting:mute.end'),
  reason: t('alerting:mute.reason'),
});

function auditFieldLabel(t: TFunction, field: string): string {
  return auditFieldLabelsOf(t)[field] ?? field;
}

function renderValue(t: TFunction, field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') {
    return value ? t('alerting:audit.valueOn') : t('alerting:audit.valueOff');
  }
  if ((field === 'contact_id' || field === 'contact_ids') && Array.isArray(value)) {
    return value.length > 0
      ? value.join(t('alerting:separator.list'))
      : t('alerting:rule.allContacts');
  }
  if (field === 'contact_id' && value === null) return t('alerting:rule.allContacts');
  return String(value);
}

export const severityLabelsOf = (t: TFunction): Record<AlertSeverity, string> => ({
  critical: t('alerting:severity.critical'),
  warning: t('alerting:severity.warning'),
  info: t('alerting:severity.info'),
});

export const COMPARATOR_LABEL: Record<AlertComparator, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/* ------------------------- 展示层本地化（服务端 key 优先） ------------------------- */

/** 平台配置通道（凭证级）→ 本地化名键；与 channel-config-schema 的 label_key 一致 */
const CONFIG_CHANNEL_LABEL_KEYS: Record<string, string> = {
  smtp: 'alerting:channelConfig.smtp.label',
  telegram: 'alerting:channelConfig.telegram.label',
  whatsapp: 'alerting:channelConfig.whatsapp.label',
  sms_aliyun: 'alerting:channelConfig.smsAliyun.label',
  sms_tencent: 'alerting:channelConfig.smsTencent.label',
  sms_aws: 'alerting:channelConfig.smsAws.label',
  sms_twilio: 'alerting:channelConfig.smsTwilio.label',
};

/** 平台配置通道名（本地化）；未知 key 原样返回 */
export function configChannelLabelOf(t: TFunction, channel: string): string {
  const key = CONFIG_CHANNEL_LABEL_KEYS[channel];
  return key ? t(key) : channel;
}

/** 联系人通道不可用原因：优先用服务端 reason_key 本地化（配置名参数一并本地化） */
export function channelReasonTextOf(t: TFunction, capability: AlertChannelCapability): string | null {
  if (!capability.reason_key) return capability.reason;
  const names = (capability.reason_configs ?? [])
    .map((key) => configChannelLabelOf(t, key))
    .join(t('alerting:separator.slash'));
  return t(capability.reason_key, { names });
}

/** 单位显示映射：存储值不动，仅把已知中文单位换成当前语言的写法 */
const UNIT_LABEL_KEYS: Record<string, string> = {
  次: 'alerting:unit.times',
  条: 'alerting:unit.rows',
  个: 'alerting:unit.pieces',
  '%': 'alerting:unit.percent',
};

/** 单位文案：已知单位本地化，未知单位原样显示 */
export function unitTextOf(t: TFunction, unit: string | null | undefined): string {
  if (!unit) return '';
  const key = UNIT_LABEL_KEYS[unit];
  return key ? t(key) : unit;
}

/**
 * 数值 + 单位（展示层）：中文界面与迁移前逐字一致（`200次`），
 * 英文单位（times / items）前补一个空格（`200 times`），`%` 紧贴（`90%`）。
 */
export function formatUnitValueOf(t: TFunction, value: string | number, unit: string | null | undefined): string {
  const label = unitTextOf(t, unit);
  if (!label) return String(value);
  return /^[A-Za-z]/.test(label) ? `${value} ${label}` : `${value}${label}`;
}

export const kindLabelsOf = (t: TFunction): Record<string, string> => ({
  feishu_webhook: t('alerting:channel.feishu'),
  email: t('alerting:channel.email'),
  sms: t('alerting:channel.sms'),
});

export const mutePresetsOf = (t: TFunction): { label: string; hours: number }[] => [
  { label: t('alerting:mute.presetHours', { count: 1 }), hours: 1 },
  { label: t('alerting:mute.presetHours', { count: 6 }), hours: 6 },
  { label: t('alerting:mute.presetDays', { count: 1 }), hours: 24 },
  { label: t('alerting:mute.presetDays', { count: 3 }), hours: 72 },
  { label: t('alerting:mute.presetDays', { count: 7 }), hours: 168 },
];

/* ------------------------ 数据保留策略 ------------------------ */

export type RetentionScope = 'events' | 'notifications' | 'audits';

export interface RetentionItem {
  scope: RetentionScope;
  label: string;
  /** 本地化名资源键；无则回退 label */
  label_key?: string;
  /** null = 永久保留 */
  retain_days: number | null;
  updated_by: string | null;
  updated_at: string | null;
}

export function getAlertRetention() {
  return get<{ items: RetentionItem[] }>('/ops/alerts/retention');
}

export function saveAlertRetention(scope: RetentionScope, retainDays: number | null) {
  return put<{ ok: boolean }>(`/ops/alerts/retention/${scope}`, { retain_days: retainDays });
}

export const ruleActionLabelsExtraOf = (t: TFunction): Record<string, string> => {
  const all = ruleActionLabelsOf(t);
  return {
    alert_contact_update: all.alert_contact_update,
    alert_retention_update: all.alert_retention_update,
    alert_retention_cleanup: all.alert_retention_cleanup,
  };
};
