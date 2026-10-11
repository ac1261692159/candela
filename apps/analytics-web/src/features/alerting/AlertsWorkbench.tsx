import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateTimeFixed } from '../../i18n/format';
import {
  Alert,
  Button,
  Modal,
  Card,
  Col,
  Form,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { LOCALES, useT, type TFunction } from '../../i18n';
import { AlertRuleEditor } from './AlertRuleEditor';
import { MetricAlertDrawer } from './MetricAlertDrawer';
import { TemplateEditor } from './TemplateEditor';
import { ChannelConfigPanel } from './ChannelConfigPanel';
import { RetentionPanel } from './RetentionPanel';
import { MutePanel, MuteQuickButtons } from './mute-form';
import { TimeZoneSelect } from '../time-range/TimeZoneSelect';
import {
  COMPARATOR_LABEL,
  channelLabelsOf,
  channelReasonTextOf,
  formatUnitValueOf,
  kindLabelsOf,
  ruleActionLabelsOf,
  severityLabelsOf,
  windowDaysOptionsOf,
  createAlertContact,
  deleteAlertContact,
  updateAlertContact,
  deleteAlertRule,
  formatAuditDetail,
  getAlertAudits,
  getAlertChannels,
  getAlertContacts,
  getAlertEvents,
  getAlertMutes,
  getAlertNotifications,
  getAlertOverview,
  getAlertRules,
  updateAlertRule,
  type AlertAuditItem,
  type AlertContactItem,
  type AlertEventItem,
  type AlertMuteItem,
  type AlertNotificationItem,
  type AlertOverview,
  type AlertRuleHealth,
  type AlertChannelCapability,
  type AlertRuleItem,
  type AlertSeverity,
} from './alerting-api';

function fmt(value: string | null): string {
  if (!value) return '-';
  return formatDateTimeFixed(value);
}

function severityTag(severity: AlertSeverity, t: TFunction) {
  const color = severity === 'critical' ? 'red' : severity === 'warning' ? 'orange' : 'blue';
  return <Tag color={color}>{severityLabelsOf(t)[severity]}</Tag>;
}

/**
 * 联系人语言下拉（选项用语言自身书写，与登录页 / 个人设置的选择器一致，不翻译语言名）。
 * 留空 = 平台默认（`AlertContact.locale` 可空）。
 */
const contactLocaleOptions = LOCALES.map((item) => ({ value: item.tag, label: item.label }));

/** 语言自名（zh-CN → 简体中文）；未知标签原样显示（API 客户端写入的历史值） */
function contactLocaleLabel(tag: string): string {
  return LOCALES.find((item) => item.tag === tag)?.label ?? tag;
}

/** 健康标签：正常不显示（有问题的才需要看） */
const healthLabelsOf = (t: TFunction): Record<AlertRuleHealth, string> => ({
  ok: t('alerting:status.normal'),
  metric_missing: t('alerting:rule.health.metricMissing'),
  metric_eval_failed: t('alerting:rule.health.evalFailed'),
  no_contact: t('alerting:rule.health.noContact'),
});

function healthTag(row: AlertRuleItem, t: TFunction) {
  const { health } = row;
  if (health === 'ok') return null;
  // 服务端优先下发 health_label_key / health_detail_key；无 key（旧接口）回退中文
  const label = row.health_label_key ? t(row.health_label_key) : healthLabelsOf(t)[health];
  const detail = row.health_detail_key
    ? t(row.health_detail_key, (row.health_detail_params ?? {}) as Record<string, unknown>)
    : row.health_detail;
  return (
    <Tooltip title={detail || label}>
      <Tag color={health === 'metric_missing' || health === 'metric_eval_failed' ? 'red' : 'orange'}>
        {label}
      </Tag>
    </Tooltip>
  );
}

export function AlertsWorkbench() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<AlertOverview | null>(null);
  const [rules, setRules] = useState<AlertRuleItem[]>([]);
  const [events, setEvents] = useState<AlertEventItem[]>([]);
  const [eventFilter, setEventFilter] = useState<'all' | 'firing' | 'resolved'>('all');
  const [contacts, setContacts] = useState<AlertContactItem[]>([]);
  const [mutes, setMutes] = useState<AlertMuteItem[]>([]);
  const [notifications, setNotifications] = useState<AlertNotificationItem[]>([]);
  const [audits, setAudits] = useState<AlertAuditItem[]>([]);
  const [editing, setEditing] = useState<AlertRuleItem | null>(null);
  const [creatingMetric, setCreatingMetric] = useState(false);
  const [channels, setChannels] = useState<Record<string, AlertChannelCapability>>({});
  const { t } = useT('alerting');

  /** 指标窗口天数的中文标签（与新建抽屉同一份口径） */
  const windowLabels = useMemo(
    () => Object.fromEntries(windowDaysOptionsOf(t).map((item) => [item.value, item.label])),
    [t],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, ruleRes, eventRes, contactRes, muteRes, notifyRes, channelRes, auditRes] = await Promise.all([
        getAlertOverview(),
        getAlertRules(),
        getAlertEvents({ status: eventFilter, limit: 50 }),
        getAlertContacts(),
        getAlertMutes(),
        getAlertNotifications(50),
        getAlertChannels(),
        getAlertAudits(50),
      ]);
      setOverview(ov);
      setRules(ruleRes.items ?? []);
      setEvents(eventRes.items ?? []);
      setContacts(contactRes.items ?? []);
      setMutes(muteRes.items ?? []);
      setNotifications(notifyRes.items ?? []);
      setChannels(channelRes);
      setAudits(auditRes.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common:message.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [eventFilter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const firingCount = rules.filter((rule) => rule.firing).length;
  const firingRules = rules.filter((rule) => rule.firing);

  return (
    <Card
      title={t('alerting:workbench.title')}
      extra={
        <Space wrap>
          <Button onClick={() => setCreatingMetric(true)}>{t('alerting:rule.createMetric')}</Button>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            {t('common:action.refresh')}
          </Button>
        </Space>
      }
    >
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {firingCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t('alerting:workbench.firing', { count: firingCount })}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {overview && !overview.health.has_enabled_contact ? (
        <Alert
          type="error"
          showIcon
          message={t('alerting:workbench.noContact')}
          description={t('alerting:workbench.noContactHint')}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {overview && overview.health.broken_rules > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t('alerting:workbench.brokenRules', { count: overview.health.broken_rules })}
          description={t('alerting:workbench.brokenRulesHint', {
            names: overview.health.broken_rule_names.join(t('alerting:separator.list')),
          })}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {overview && overview.health.notify_fail_24h > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t('alerting:workbench.notifyFail24h', { count: overview.health.notify_fail_24h })}
          description={t('alerting:workbench.notifyFail24hHint')}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Tabs
        items={[
          {
            key: 'overview',
            label: t('alerting:tab.overview'),
            children: (
              <>
                <RetentionPanel />
                <Row gutter={16} style={{ marginBottom: 16 }}>
                  <Col xs={24} sm={8}>
                    <Card size="small">
                      <Statistic title={t('alerting:overview.firedToday')} value={overview?.fired_today ?? 0} />
                    </Card>
                  </Col>
                  <Col xs={24} sm={8}>
                    <Card size="small">
                      <Statistic title={t('alerting:overview.unresolved')} value={overview?.unresolved ?? 0} />
                    </Card>
                  </Col>
                  <Col xs={24} sm={8}>
                    <Card size="small">
                      <Statistic
                        title={t('alerting:overview.notifyFailToday')}
                        value={overview?.notify_fail_today ?? 0}
                      />
                    </Card>
                  </Col>
                </Row>
                <Table
                  rowKey="code"
                  size="small"
                  pagination={false}
                  dataSource={firingRules}
                  locale={{ emptyText: t('alerting:overview.firingEmpty') }}
                  style={{ marginBottom: 16 }}
                  columns={[
                    { title: t('alerting:status.firing'), dataIndex: 'name', key: 'name' },
                    {
                      title: t('alerting:rule.column.currentValue'),
                      dataIndex: 'firing_value',
                      minWidth: 130,
                      render: (value: number | null, row: AlertRuleItem) =>
                        value === null ? '-' : formatUnitValueOf(t, value.toLocaleString('zh-CN'), row.unit),
                    },
                    {
                      title: t('alerting:rule.muteQuick'),
                      key: 'mute',
                      render: (_: unknown, row: AlertRuleItem) => (
                        <MuteQuickButtons ruleCode={row.code} onChanged={load} />
                      ),
                    },
                  ]}
                />
                <Typography.Text type="secondary">{t('alerting:overview.topRules')}</Typography.Text>
                <Table
                  rowKey="rule_code"
                  size="small"
                  pagination={false}
                  dataSource={overview?.top_rules ?? []}
                  locale={{ emptyText: t('alerting:overview.topRulesEmpty') }}
                  style={{ marginTop: 8 }}
                  columns={[
                    { title: t('alerting:rule.label'), dataIndex: 'rule_name', key: 'rule_name' },
                    { title: t('alerting:overview.fireCount'), dataIndex: 'count', key: 'count', minWidth: 130 },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'rules',
            label: t('alerting:tab.rules'),
            children: (
              <Table
                rowKey="code"
                size="small"
                loading={loading}
                dataSource={rules}
                pagination={false}
                scroll={{ x: 1320 }}
                columns={[
                  {
                    title: t('alerting:rule.label'),
                    dataIndex: 'name',
                    minWidth: 220,
                    render: (value: string, row: AlertRuleItem) => (
                      <Space direction="vertical" size={0}>
                        <Typography.Text strong>{value}</Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {row.source === 'metric'
                            ? t('alerting:rule.source.metric', { name: row.metric_name ?? row.metric_id })
                            : t('alerting:rule.source.builtin')}{' '}
                          · {row.code} · {t('alerting:rule.checkInterval')}
                        </Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: t('alerting:rule.column.health'),
                    key: 'health',
                    minWidth: 120,
                    // 正常不显示标签（有问题的才需要被看见）
                    render: (_: unknown, row: AlertRuleItem) => healthTag(row, t),
                  },
                  {
                    title: t('alerting:severity.label'),
                    dataIndex: 'severity',
                    minWidth: 100,
                    render: (v: AlertSeverity) => severityTag(v, t),
                  },
                  {
                    title: t('alerting:rule.column.condition'),
                    key: 'cond',
                    minWidth: 160,
                    render: (_: unknown, row: AlertRuleItem) =>
                      `${COMPARATOR_LABEL[row.comparator]} ${formatUnitValueOf(t, row.threshold, row.unit)}`,
                  },
                  {
                    title: t('alerting:rule.column.window'),
                    key: 'win',
                    minWidth: 160,
                    // 指标规则窗口按天（事件分析按 stat_date 过滤）；内置规则仍是分钟级观测窗口
                    render: (_: unknown, row: AlertRuleItem) =>
                      row.source === 'metric'
                        ? t('alerting:rule.windowTimes', {
                            window:
                              windowLabels[row.window_days] ?? t('alerting:rule.windowDays', { days: row.window_days }),
                            times: row.for_windows,
                          })
                        : t('alerting:rule.windowMinutesTimes', {
                            minutes: row.window_minutes,
                            times: row.for_windows,
                          }),
                  },
                  {
                    title: t('alerting:contact.label'),
                    key: 'contacts',
                    minWidth: 180,
                    render: (_: unknown, row: AlertRuleItem) =>
                      row.contact_names?.length ? (
                        <Space size={[4, 4]} wrap>
                          {row.contact_names.map((name) => (
                            <Tag key={name} style={{ marginInlineEnd: 0 }}>
                              {name}
                            </Tag>
                          ))}
                        </Space>
                      ) : (
                        <Typography.Text type="secondary">{t('alerting:rule.allContacts')}</Typography.Text>
                      ),
                  },
                  {
                    title: t('common:label.status'),
                    dataIndex: 'firing',
                    minWidth: 110,
                    render: (firing: boolean) =>
                      firing ? (
                        <Tag color="red">{t('alerting:status.firing')}</Tag>
                      ) : (
                        <Tag color="green">{t('alerting:status.normal')}</Tag>
                      ),
                  },
                  {
                    title: t('alerting:rule.column.currentValue'),
                    dataIndex: 'firing_value',
                    minWidth: 110,
                    render: (value: number | null) => (value === null ? '-' : value.toLocaleString('zh-CN')),
                  },
                  {
                    title: t('alerting:field.enabled'),
                    dataIndex: 'enabled',
                    minWidth: 90,
                    render: (enabled: boolean, row: AlertRuleItem) => (
                      <Switch
                        aria-label={t('alerting:field.enabledAria', { name: row.name })}
                        checked={enabled}
                        onChange={(next) => void updateAlertRule(row.code, { enabled: next }).then(load)}
                      />
                    ),
                  },
                  {
                    title: t('common:label.actions'),
                    key: 'edit',
                    minWidth: 210,
                    render: (_: unknown, row: AlertRuleItem) => (
                      <Space wrap>
                        <Button size="small" onClick={() => setEditing(row)}>
                          {t('alerting:rule.editCondition')}
                        </Button>
                        {row.source !== 'builtin' ? (
                          <Button
                            size="small"
                            danger
                            onClick={() => void deleteAlertRule(row.code).then(load)}
                          >
                            {t('common:action.delete')}
                          </Button>
                        ) : null}
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'history',
            label: t('alerting:tab.history'),
            children: (
              <>
                <Select
                  aria-label={t('alerting:event.filterLabel')}
                  value={eventFilter}
                  style={{ minWidth: 150, marginBottom: 12 }}
                  options={[
                    { value: 'all', label: t('common:state.all') },
                    { value: 'firing', label: t('alerting:status.firing') },
                    { value: 'resolved', label: t('alerting:status.resolved') },
                  ]}
                  onChange={setEventFilter}
                />
                <Table
                  rowKey="id"
                  size="small"
                  loading={loading}
                  dataSource={events}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  columns={[
                    {
                      title: t('alerting:event.firedAt'),
                      dataIndex: 'fired_at',
                      minWidth: 170,
                      render: (v: string) => fmt(v),
                    },
                    {
                      title: t('alerting:severity.label'),
                      dataIndex: 'severity',
                      minWidth: 110,
                      render: (v: AlertSeverity) => severityTag(v, t),
                    },
                    { title: t('alerting:rule.label'), dataIndex: 'rule_name', minWidth: 180, ellipsis: { showTitle: true } },
                    {
                      title: t('alerting:event.value'),
                      dataIndex: 'value',
                      minWidth: 140,
                      render: (v: number, row: AlertEventItem) => formatUnitValueOf(t, v, row.unit),
                    },
                    {
                      title: t('common:label.status'),
                      dataIndex: 'status',
                      minWidth: 110,
                      render: (value: AlertEventItem['status']) =>
                        value === 'firing' ? (
                          <Tag color="red">{t('alerting:status.firing')}</Tag>
                        ) : (
                          <Tag color="green">{t('alerting:status.resolved')}</Tag>
                        ),
                    },
                    {
                      title: t('alerting:event.lastSeen'),
                      dataIndex: 'last_seen_at',
                      minWidth: 170,
                      render: (v: string) => fmt(v),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'mute',
            label: t('alerting:tab.mute'),
            children: <MutePanel rules={rules} mutes={mutes} onChanged={load} />,
          },
          {
            key: 'notify',
            label: t('alerting:tab.notifications'),
            children: (
              <Table
                rowKey="id"
                size="small"
                loading={loading}
                dataSource={notifications}
                pagination={{ pageSize: 10, showSizeChanger: false }}
                columns={[
                  {
                    title: t('alerting:notification.time'),
                    dataIndex: 'created_at',
                    minWidth: 170,
                    render: (v: string) => fmt(v),
                  },
                  { title: t('alerting:rule.label'), dataIndex: 'rule_code', minWidth: 180, ellipsis: { showTitle: true } },
                  {
                    title: t('alerting:contact.label'),
                    dataIndex: 'contact_name',
                    minWidth: 150,
                    render: (v: string | null) => v ?? <Typography.Text type="secondary">-</Typography.Text>,
                  },
                  {
                    title: t('common:label.type'),
                    dataIndex: 'kind',
                    minWidth: 120,
                    render: (v: string) =>
                      ({
                        fire: t('alerting:notification.kindFire'),
                        repeat: t('alerting:notification.kindRepeat'),
                        resolve: t('alerting:notification.kindResolve'),
                      })[v] ?? v,
                  },
                  {
                    title: t('alerting:notification.result'),
                    dataIndex: 'status',
                    minWidth: 110,
                    render: (v: string) =>
                      v === 'success' ? (
                        <Tag color="green">{t('common:state.success')}</Tag>
                      ) : (
                        <Tag color="red">{t('common:state.failed')}</Tag>
                      ),
                  },
                  {
                    title: t('alerting:notification.error'),
                    dataIndex: 'error',
                    ellipsis: { showTitle: true },
                    render: (v: string | null) => v ?? '-',
                  },
                ]}
              />
            ),
          },
          {
            key: 'templates',
            label: t('alerting:tab.templates'),
            children: <TemplateEditor />,
          },
          {
            key: 'channel-config',
            label: t('alerting:tab.channels'),
            children: <ChannelConfigPanel />,
          },
          {
            key: 'contacts',
            label: t('alerting:tab.contacts'),
            children: <ContactPanel contacts={contacts} channels={channels} onChanged={load} />,
          },
          {
            key: 'audits',
            label: t('alerting:tab.audits'),
            children: (
              <AuditPanel audits={audits} loading={loading} />
            ),
          },
        ]}
      />

      <AlertRuleEditor
        rule={editing}
        contacts={contacts}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />
      <MetricAlertDrawer
        open={creatingMetric}
        contacts={contacts}
        onClose={() => setCreatingMetric(false)}
        onSaved={() => void load()}
      />
    </Card>
  );
}

function ContactPanel({
  contacts,
  channels,
  onChanged,
}: {
  contacts: AlertContactItem[];
  channels: Record<string, AlertChannelCapability>;
  onChanged: () => Promise<void>;
}) {
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<AlertContactItem | null>(null);
  const [saving, setSaving] = useState(false);
  const { t } = useT('alerting');
  const channelLabels = channelLabelsOf(t);
  const kindLabels = kindLabelsOf(t);
  const kind = Form.useWatch('kind', form) as string | undefined;
  const current = kind ? channels[kind] : undefined;
  const fields = current?.contact_fields ?? ['webhook_url'];
  const capabilityLabel = (capability: AlertChannelCapability) =>
    capability.label_key ? t(capability.label_key) : capability.label;
  const channelOptions = Object.entries(channels).map(([key, capability]) => ({
    value: key,
    label: capabilityLabel(capability),
    disabled: !capability.available,
  }));

  /** 联系人字段 → 提交载荷（含通道专属 options） */
  const buildInput = (values: Record<string, unknown>) => {
    const options: Record<string, unknown> = {};
    if (values.secret) options.secret = values.secret;
    if (values.headers) options.headers = values.headers;
    if (values.body_template) options.body_template = values.body_template;
    if (values.provider) options.provider = values.provider;
    return {
      name: String(values.name ?? '').trim(),
      kind: String(values.kind ?? ''),
      webhook_url: values.webhook_url as string | undefined,
      address: values.address as string | undefined,
      options: Object.keys(options).length > 0 ? options : undefined,
      enabled: values.enabled !== false,
      // 收件人语言/时区：留空 = 平台默认（显式下发 null，语义清晰）
      locale: values.locale ? String(values.locale) : null,
      timezone: values.timezone ? String(values.timezone) : null,
    };
  };

  const submit = async () => {
    const values = await form.validateFields();
    await createAlertContact(buildInput(values));
    form.resetFields();
    form.setFieldsValue({ kind: 'feishu_webhook', enabled: true });
    await onChanged();
  };

  /** 编辑提交：只有填了新地址/新密钥才提交，留空一律保持原值（列表里是掩码，回填会写坏数据） */
  const buildEditInput = (values: Record<string, unknown>) => {
    const input: Record<string, unknown> = {
      name: String(values.name ?? '').trim(),
      kind: String(values.kind ?? ''),
      enabled: values.enabled !== false,
      // 语言/时区不涉及脱敏，可直接回填提交；留空 = 项目/平台
      locale: values.locale ? String(values.locale) : null,
      timezone: values.timezone ? String(values.timezone) : null,
    };
    const webhook = String(values.webhook_url ?? '').trim();
    const address = String(values.address ?? '').trim();
    if (webhook) input.webhook_url = webhook;
    if (address) input.address = address;
    const options: Record<string, unknown> = {};
    if (values.secret) options.secret = values.secret;
    if (Object.keys(options).length > 0) input.options = options;
    return input;
  };

  const saveEdit = async () => {
    if (!editing) return;
    const values = await editForm.validateFields();
    setSaving(true);
    try {
      await updateAlertContact(editing.id, buildEditInput(values));
      message.success(t('alerting:contact.updated'));
      setEditing(null);
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  const [editForm] = Form.useForm();
  const editKind = Form.useWatch('kind', editForm) as string | undefined;
  const editFields = (editKind ? channels[editKind]?.contact_fields : undefined) ?? ['webhook_url'];

  return (
    <>
      <Typography.Paragraph type="secondary">
        {t('alerting:contact.hint')}
      </Typography.Paragraph>
      <Form
        form={form}
        layout="inline"
        style={{ marginBottom: 12 }}
        onFinish={() => void submit()}
        initialValues={{ kind: 'feishu_webhook', enabled: true }}
        autoComplete="off"
      >
        <Form.Item
          name="name"
          rules={[{ required: true, message: t('alerting:validate.required', { field: t('common:label.name') }) }]}
        >
          <Input placeholder={t('common:label.name')} autoComplete="off" />
        </Form.Item>
        <Form.Item name="kind" rules={[{ required: true }]}>
          <Select
            style={{ minWidth: 180 }}
            showSearch
            optionFilterProp="label"
            options={channelOptions}
            onChange={() => form.setFieldsValue({ webhook_url: undefined, address: undefined, secret: undefined })}
          />
        </Form.Item>
        {fields.includes('webhook_url') ? (
          <Form.Item
            name="webhook_url"
            rules={[{ required: true, message: t('alerting:contact.webhookRequired') }]}
          >
            <Input placeholder="https://…" style={{ width: 320 }} autoComplete="off" />
          </Form.Item>
        ) : null}
        {fields.includes('address') ? (
          <Form.Item
            name="address"
            rules={[
              {
                required: true,
                message: t('alerting:validate.required', { field: t('alerting:contact.addressLabel') }),
              },
            ]}
          >
            <Input
              style={{ minWidth: 220 }}
              autoComplete="off"
              placeholder={
                kind === 'email'
                  ? t('alerting:contact.addressEmail')
                  : kind === 'telegram'
                    ? t('alerting:contact.addressChatId')
                    : kind === 'whatsapp'
                      ? t('alerting:contact.addressWhatsapp')
                      : t('alerting:contact.addressSms')
              }
            />
          </Form.Item>
        ) : null}
        {fields.includes('secret') ? (
          <Form.Item name="secret" tooltip={t('alerting:contact.secretHint')}>
            <Input.Password
              placeholder={t('alerting:contact.secretOptional')}
              style={{ minWidth: 200 }}
              autoComplete="new-password"
            />
          </Form.Item>
        ) : null}
        {kind === 'sms' ? (
          <Form.Item name="provider" tooltip={t('alerting:contact.smsProviderHint')}>
            <Select
              style={{ minWidth: 180 }}
              allowClear
              placeholder={t('alerting:contact.smsProvider')}
              options={Object.entries(channels)
                .filter(([key]) => key.startsWith('sms_'))
                .map(([key, capability]) => ({ value: key, label: capabilityLabel(capability) }))}
            />
          </Form.Item>
        ) : null}
        {fields.includes('headers') || fields.includes('body_template') ? (
          <Form.Item
            name="body_template"
            tooltip={t('alerting:contact.bodyTemplateHint', { text: '{{.text}}', textJson: '{{.text_json}}' })}
          >
            <Input
              placeholder={t('alerting:contact.bodyTemplatePlaceholder', { textJson: '{{.text_json}}' })}
              style={{ width: 320 }}
              autoComplete="off"
            />
          </Form.Item>
        ) : null}
        <Form.Item name="locale" tooltip={t('alerting:contact.localeHint')}>
          <Select
            style={{ minWidth: 160 }}
            allowClear
            placeholder={t('alerting:contact.localeDefault')}
            options={contactLocaleOptions}
            aria-label={t('alerting:contact.locale')}
          />
        </Form.Item>
        <Form.Item name="timezone" tooltip={t('alerting:contact.timezoneHint')}>
          <TimeZoneSelect followLabel={t('alerting:contact.timezoneDefault')} ariaLabel={t('alerting:contact.timezone')} />
        </Form.Item>
        <Form.Item name="enabled" valuePropName="checked" tooltip={t('alerting:contact.disableHint')}>
          <Switch checkedChildren={t('alerting:field.switchOn')} unCheckedChildren={t('alerting:field.switchOff')} />
        </Form.Item>
        <Button type="primary" htmlType="submit">
          {t('common:action.add')}
        </Button>
      </Form>
      {current && !current.available ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={channelReasonTextOf(t, current) ?? t('alerting:channel.unavailable')}
        />
      ) : null}
      {current?.available && current.platform_fallback ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('alerting:channel.platformFallbackNote')}
        />
      ) : null}
      <Table
        rowKey="id"
        size="small"
        dataSource={contacts}
        pagination={false}
        columns={[
          { title: t('common:label.name'), dataIndex: 'name' },
          {
            title: t('alerting:channel.label'),
            dataIndex: 'kind',
            minWidth: 160,
            render: (v: string) => channelLabels[v] ?? kindLabels[v] ?? v,
          },
          { title: t('alerting:contact.address'), dataIndex: 'webhook_url', minWidth: 220, ellipsis: { showTitle: true } },
          {
            title: t('alerting:contact.timezone'),
            dataIndex: 'timezone',
            minWidth: 150,
            render: (value: string | null | undefined) =>
              value ? <Tag>{value}</Tag> : <Typography.Text type="secondary">{t('alerting:contact.timezoneDefault')}</Typography.Text>,
          },
          {
            title: t('alerting:contact.locale'),
            dataIndex: 'locale',
            minWidth: 140,
            render: (value: string | null | undefined) =>
              value ? (
                <Tag>{contactLocaleLabel(value)}</Tag>
              ) : (
                <Typography.Text type="secondary">{t('alerting:contact.localeDefault')}</Typography.Text>
              ),
          },
          {
            title: t('alerting:field.enabled'),
            dataIndex: 'enabled',
            minWidth: 100,
            render: (value: boolean, row: AlertContactItem) => (
              <Switch
                size="small"
                checked={value}
                aria-label={t('alerting:field.enabledAria', { name: row.name })}
                onChange={(next) => void updateAlertContact(row.id, { enabled: next }).then(onChanged)}
              />
            ),
          },
          {
            title: t('common:label.actions'),
            key: 'ops',
            minWidth: 170,
            render: (_: unknown, row: AlertContactItem) => (
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => {
                    editForm.setFieldsValue({
                      name: row.name,
                      kind: row.kind,
                      webhook_url: undefined,
                      address: undefined,
                      secret: undefined,
                      enabled: row.enabled,
                      locale: row.locale ?? null,
                    });
                    setEditing(row);
                  }}
                >
                  {t('common:action.edit')}
                </Button>
                <Button size="small" danger onClick={() => void deleteAlertContact(row.id).then(onChanged)}>
                  {t('common:action.delete')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={Boolean(editing)}
        title={
          editing
            ? t('alerting:contact.editTitleNamed', { name: editing.name })
            : t('alerting:contact.editTitle')
        }
        onCancel={() => setEditing(null)}
        onOk={() => void saveEdit()}
        confirmLoading={saving}
        okText={t('common:action.save')}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" autoComplete="off" style={{ marginTop: 12 }}>
          <Form.Item
            name="name"
            label={t('common:label.name')}
            rules={[{ required: true, message: t('alerting:validate.required', { field: t('common:label.name') }) }]}
          >
            <Input maxLength={80} autoComplete="off" />
          </Form.Item>
          <Form.Item name="kind" label={t('alerting:channel.label')} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={channelOptions}
              onChange={() => editForm.setFieldsValue({ webhook_url: undefined, address: undefined })}
            />
          </Form.Item>
          {editFields.includes('webhook_url') ? (
            <Form.Item
              name="webhook_url"
              label={t('alerting:contact.webhookUrl')}
              tooltip={t('alerting:field.keepSavedAddress')}
            >
              <Input
                autoComplete="off"
                placeholder={
                  editing?.webhook_url
                    ? t('alerting:field.keepCurrent', { value: editing.webhook_url })
                    : 'https://…'
                }
              />
            </Form.Item>
          ) : null}
          {editFields.includes('address') ? (
            <Form.Item
              name="address"
              label={t('alerting:contact.addressLabel')}
              tooltip={t('alerting:field.keepSavedAddress')}
            >
              <Input
                autoComplete="off"
                placeholder={
                  editing?.address
                    ? t('alerting:field.keepCurrent', { value: editing.address })
                    : t('alerting:contact.addressLabel')
                }
              />
            </Form.Item>
          ) : null}
          {editFields.includes('secret') ? (
            <Form.Item
              name="secret"
              label={t('alerting:contact.secret')}
              tooltip={t('alerting:field.keepSavedSecret')}
            >
              <Input.Password autoComplete="new-password" placeholder={t('alerting:field.keepBlank')} />
            </Form.Item>
          ) : null}
          <Form.Item name="locale" label={t('alerting:contact.locale')} tooltip={t('alerting:contact.localeHint')}>
            <Select
              allowClear
              placeholder={t('alerting:contact.localeDefault')}
              options={contactLocaleOptions}
            />
          </Form.Item>
          <Form.Item name="enabled" label={t('alerting:field.enabled')} valuePropName="checked">
            <Switch checkedChildren={t('alerting:field.switchOn')} unCheckedChildren={t('alerting:field.switchOff')} />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('alerting:contact.maskedHint')}
          </Typography.Text>
        </Form>
      </Modal>
    </>
  );
}

/** 配置变更记录（alerting-v3）：谁在什么时候把什么改成了什么 */
function AuditPanel({ audits, loading }: { audits: AlertAuditItem[]; loading: boolean }) {
  const { t } = useT('alerting');
  const actionLabels = ruleActionLabelsOf(t);
  return (
    <>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
        {t('alerting:audit.hint')}
      </Typography.Text>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={audits}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: t('alerting:audit.empty') }}
        scroll={{ x: 900 }}
        columns={[
          {
            title: t('alerting:audit.column.time'),
            dataIndex: 'created_at',
            minWidth: 170,
            render: (value: string) => fmt(value),
          },
          { title: t('alerting:audit.column.operator'), dataIndex: 'operator', minWidth: 150, ellipsis: { showTitle: true } },
          {
            title: t('alerting:audit.column.action'),
            dataIndex: 'action',
            minWidth: 160,
            render: (value: string) => actionLabels[value] ?? value,
          },
          { title: t('alerting:audit.column.target'), dataIndex: 'target_table', minWidth: 150, ellipsis: { showTitle: true } },
          {
            title: t('alerting:audit.column.detail'),
            key: 'detail',
            render: (_: unknown, row: AlertAuditItem) => (
              <Typography.Text style={{ fontSize: 12 }}>
                {formatAuditDetail(row.detail ?? {}, t)}
              </Typography.Text>
            ),
          },
        ]}
      />
    </>
  );
}
