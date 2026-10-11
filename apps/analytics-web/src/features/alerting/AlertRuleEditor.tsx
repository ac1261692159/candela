import { useEffect, useState } from 'react';
import { Drawer, Form, InputNumber, Radio, Select, Space, Switch, Tag, Typography } from 'antd';
import { useT } from '../../i18n';
import {
  COMPARATOR_LABEL,
  severityLabelsOf,
  unitTextOf,
  windowDaysOptionsOf,
  updateAlertRule,
  type AlertComparator,
  type AlertContactItem,
  type AlertRuleItem,
  type AlertSeverity,
} from './alerting-api';

interface Props {
  rule: AlertRuleItem | null;
  contacts: AlertContactItem[];
  onClose: () => void;
  onSaved: () => void;
}

export function AlertRuleEditor({ rule, contacts, onClose, onSaved }: Props) {
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const { t } = useT('alerting');
  const isMetricRule = rule?.source === 'metric';
  const timeSource = Form.useWatch('time_source', form) as 'metric' | 'rule' | undefined;

  useEffect(() => {
    if (!rule) return;
    form.setFieldsValue({
      severity: rule.severity,
      comparator: rule.comparator,
      threshold: rule.threshold,
      window_minutes: rule.window_minutes,
      window_days: rule.window_days,
      time_source: rule.time_source ?? 'rule',
      for_windows: rule.for_windows,
      repeat_minutes: rule.repeat_minutes,
      notify_on_resolve: rule.notify_on_resolve,
      contact_ids: rule.contact_ids,
    });
  }, [form, rule]);

  const save = async () => {
    if (!rule) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      await updateAlertRule(rule.code, {
        severity: values.severity as AlertSeverity,
        comparator: values.comparator as AlertComparator,
        threshold: Number(values.threshold),
        window_minutes: Number(values.window_minutes),
        // 指标规则的窗口是「天」，内置规则才是分钟级观测窗口
        ...(isMetricRule
          ? {
              window_days: Number(values.window_days),
              // 跟随指标（默认）时窗口字段仍写入，但不参与求值（由指标查询时间决定）
              time_source: (values.time_source ?? 'metric') as 'metric' | 'rule',
            }
          : {}),
        for_windows: Number(values.for_windows),
        repeat_minutes: Number(values.repeat_minutes),
        notify_on_resolve: Boolean(values.notify_on_resolve),
        contact_ids: (values.contact_ids ?? []) as string[],
      });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      title={rule ? t('alerting:rule.editTitleNamed', { name: rule.name }) : t('alerting:rule.editTitle')}
      open={Boolean(rule)}
      onClose={onClose}
      width={720}
      destroyOnClose
      extra={
        <Space>
          <Typography.Link onClick={onClose}>{t('common:action.cancel')}</Typography.Link>
          <Typography.Link onClick={() => void save()} disabled={saving}>
            {saving ? t('alerting:rule.saving') : t('common:action.save')}
          </Typography.Link>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        {t('alerting:rule.editorHint')}
        {isMetricRule ? ` ${t('alerting:rule.editorMetricHint')}` : ''}
      </Typography.Paragraph>
      <Form form={form} layout="vertical">
        <Form.Item name="severity" label={t('alerting:severity.alertLevel')}>
          <Select
            options={Object.entries(severityLabelsOf(t)).map(([value, label]) => ({ value, label }))}
          />
        </Form.Item>
        <Space wrap align="start" style={{ width: '100%' }}>
          <Form.Item label={isMetricRule ? t('alerting:rule.targetMetric') : t('alerting:rule.target')}>
            <Space size={6}>
              <Typography.Text>
                {isMetricRule ? rule?.metric_name ?? rule?.metric_id : rule?.name}
              </Typography.Text>
              {isMetricRule ? <Tag>{t('alerting:rule.metricTag')}</Tag> : null}
            </Space>
          </Form.Item>
          <Form.Item name="comparator" label={t('alerting:rule.comparator')}>
            <Select
              style={{ width: 120 }}
              options={Object.entries(COMPARATOR_LABEL).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item name="threshold" label={t('alerting:rule.threshold')}>
            <InputNumber min={0} max={1_000_000_000_000} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item label={t('alerting:field.unit')}>
            <Typography.Text>{rule?.unit ? unitTextOf(t, rule.unit) : '—'}</Typography.Text>
          </Form.Item>
          {isMetricRule ? (
            <Form.Item
              name="time_source"
              label={t('common:label.timeRange')}
              tooltip={t('alerting:rule.timeSourceHint')}
            >
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                options={[
                  { value: 'metric', label: t('alerting:rule.timeFromMetric') },
                  { value: 'rule', label: t('alerting:rule.timeFromRule') },
                ]}
              />
            </Form.Item>
          ) : null}
          {isMetricRule ? (
            <Form.Item name="window_days" label={t('alerting:rule.statWindow')}>
              <Select
                style={{ minWidth: 170 }}
                options={windowDaysOptionsOf(t)}
                disabled={(timeSource ?? rule?.time_source ?? 'rule') === 'metric'}
              />
            </Form.Item>
          ) : (
            <Form.Item name="window_minutes" label={t('alerting:rule.windowMinutesLabel')}>
              <Select
                style={{ minWidth: 170 }}
                options={[
                  { value: 1, label: t('alerting:rule.windowMinutesOption', { minutes: 1 }) },
                  { value: 5, label: t('alerting:rule.windowMinutesOption', { minutes: 5 }) },
                  { value: 15, label: t('alerting:rule.windowMinutesOption', { minutes: 15 }) },
                ]}
              />
            </Form.Item>
          )}
          <Form.Item name="for_windows" label={t('alerting:rule.forWindows')}>
            <InputNumber min={1} max={60} addonAfter={t('alerting:rule.timesSuffix')} style={{ width: 160 }} />
          </Form.Item>
        </Space>
        <Form.Item name="repeat_minutes" label={t('alerting:rule.repeatInterval')}>
          <InputNumber min={5} max={1440} style={{ width: 200 }} />
        </Form.Item>
        <Form.Item name="notify_on_resolve" label={t('alerting:rule.notifyOnResolve')} valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item
          name="contact_ids"
          label={t('alerting:contact.alertContacts')}
          tooltip={t('alerting:contact.multiHint')}
          extra={t('alerting:contact.multiExtra')}
        >
          <Select
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            placeholder={t('alerting:contact.noneSelected')}
            options={contacts.map((c) => ({
              value: c.id,
              label: c.enabled ? c.name : t('alerting:contact.disabledName', { name: c.name }),
            }))}
          />
        </Form.Item>
      </Form>
    </Drawer>
  );
}
