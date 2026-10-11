import { useEffect, useState } from 'react';
import { Alert as AntAlert, Button, Drawer, Form, Input, InputNumber, Radio, Select, Space, Switch, Tag, Typography, message } from 'antd';
import { useT } from '../../i18n';
import { useProjectStore } from '../../stores/project.store';
import { metricSummaryText, metricWindowPayloadLabel, valuePickLabel } from '../metrics/metric-definition';
import {
  COMPARATOR_LABEL,
  severityLabelsOf,
  windowDaysOptionsOf,
  createAlertRule,
  getAlertMetrics,
  probeAlertMetric,
  type AlertComparator,
  type AlertContactItem,
  type AlertMetricItem,
  type AlertSeverity,
} from './alerting-api';

interface Props {
  open: boolean;
  contacts: AlertContactItem[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * 新建指标告警（alerting-v4）。
 *
 * 观测源 = 数据管理里的已保存指标（不再用分析卡片缓存）：求值走与工作台相同的查询链路，
 * 因此「工作台看到的数」与「告警判定的数」同口径；保存前可「测试取值」验证阈值是否合适。
 */
export function MetricAlertDrawer({ open, contacts, onClose, onSaved }: Props) {
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const { t } = useT('alerting');
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [metrics, setMetrics] = useState<AlertMetricItem[]>([]);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);
  const project = Form.useWatch('project_name', form) as string | undefined;
  const metricId = Form.useWatch('metric_id', form) as string | undefined;
  const windowDays = Form.useWatch('window_days', form) as number | undefined;
  const timeSource = Form.useWatch('time_source', form) as 'metric' | 'rule' | undefined;
  const selected = metrics.find((m) => m.metric_id === metricId);
  /** 指标类型名：服务端优先下发资源键（i18n v1），无 key 时回退中文 label */
  const kindTextOf = (item: AlertMetricItem): string =>
    item.kind_label_key ? t(item.kind_label_key) : item.kind_label;
  /**
   * 口径摘要 / 窗口 / 取值都按查看者语言渲染：
   * 服务端给结构（kind + 天数 + 相对范围 + 枚举值），中文原文只在结构缺失（老响应）时兜底。
   */
  const summaryTextOf = (item: AlertMetricItem): string =>
    item.definition_summary_structure
      ? metricSummaryText(item.definition_summary_structure, t)
      : item.definition_summary;
  const metricWindowTextOf = (item: AlertMetricItem): string =>
    item.window_label
      ? metricWindowPayloadLabel(
          {
            days: item.window_days ?? null,
            label: item.window_label,
            relative: item.window_relative ?? null,
          },
          t,
        )
      : '';
  /** 指标自带查询时间时默认跟随；没有查询时间的指标只能由规则窗口指定 */
  const followsMetric = Boolean(selected?.window_label) && (timeSource ?? 'metric') === 'metric';

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      project_name: currentProject,
      severity: 'warning',
      comparator: 'gt',
      window_days: 1,
      time_source: 'metric',
      for_windows: 1,
      repeat_minutes: 60,
      notify_on_resolve: true,
    });
    setProbe(null);
  }, [open, currentProject, form]);

  useEffect(() => {
    if (!open || !project) {
      setMetrics([]);
      return;
    }
    void getAlertMetrics(project).then((res) => setMetrics(res.items ?? []));
  }, [open, project]);

  // 选中指标后带出单位（留存率是 %）与默认规则名，减少手工填写
  useEffect(() => {
    if (!selected) return;
    form.setFieldsValue({
      unit: form.getFieldValue('unit') || selected.unit,
      name: form.getFieldValue('name') || t('alerting:rule.defaultName', { metric: selected.display_name }),
      time_source: selected.window_label ? 'metric' : 'rule',
    });
    setProbe(null);
  }, [selected, form, t]);

  const runProbe = async () => {
    if (!metricId || !project) return;
    setProbing(true);
    try {
      const result = await probeAlertMetric(metricId, windowDays ?? 1, project, timeSource ?? 'metric');
      // 窗口 / 取值按查看者语言渲染（服务端给结构 + 枚举值；`window_fmt` 仅老响应兜底）
      const pickText = result.pick
        ? valuePickLabel(result.pick, t)
        : result.pick_label ?? '';
      setProbe(
        result.error
          ? t('alerting:rule.probeFailed', { error: result.error })
          : t('alerting:rule.probeResult', {
              value: result.value_fmt,
              window: metricWindowPayloadLabel(
                {
                  days: result.window_days,
                  label: result.window_fmt,
                  relative: result.window_relative ?? null,
                  cohort: result.window_cohort === true,
                },
                t,
              ),
              pick: pickText ? t('alerting:rule.probePick', { pick: pickText }) : '',
              ms: result.elapsed_ms,
            }),
      );
    } finally {
      setProbing(false);
    }
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await createAlertRule({
        name: values.name,
        metric_id: values.metric_id,
        threshold: Number(values.threshold),
        unit: values.unit,
        severity: values.severity as AlertSeverity,
        comparator: values.comparator as AlertComparator,
        window_days: Number(values.window_days),
        time_source: followsMetric ? 'metric' : 'rule',
        for_windows: Number(values.for_windows),
        repeat_minutes: Number(values.repeat_minutes),
        notify_on_resolve: Boolean(values.notify_on_resolve),
        contact_ids: (values.contact_ids ?? []) as string[],
      });
      message.success(t('alerting:rule.created'));
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      title={t('alerting:rule.createMetric')}
      open={open}
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
      <AntAlert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t('alerting:rule.metricSource')}
        description={
          <span>
            {t('alerting:rule.metricSourceHint')}
          </span>
        }
      />
      <Form form={form} layout="vertical">
        <Form.Item
          name="project_name"
          label={t('alerting:metric.project')}
          rules={[
            { required: true, message: t('alerting:validate.select', { field: t('alerting:metric.project') }) },
          ]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            options={projects.map((p) => ({ value: p.name, label: p.display_name || p.name }))}
            onChange={() => {
              form.setFieldsValue({ metric_id: undefined });
              setProbe(null);
            }}
          />
        </Form.Item>
        <Form.Item
          name="metric_id"
          label={t('alerting:metric.label')}
          rules={[
            { required: true, message: t('alerting:validate.select', { field: t('alerting:metric.label') }) },
          ]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            placeholder={metrics.length ? t('alerting:metric.select') : t('alerting:metric.noneInProject')}
            options={metrics.map((m) => ({
              value: m.metric_id,
              disabled: !m.alertable,
              label: m.alertable
                ? t('alerting:metric.option', { name: m.display_name, kind: kindTextOf(m) })
                : t('alerting:metric.optionDisabled', {
                    name: m.display_name,
                    kind: kindTextOf(m),
                    reason: m.reason ?? t('alerting:metric.unavailable'),
                  }),
            }))}
          />
        </Form.Item>
        {selected && (
          <Space direction="vertical" size={4} style={{ marginBottom: 12 }}>
            <Space size={6} wrap>
              <Tag>{kindTextOf(selected)}</Tag>
              <Typography.Text type="secondary">{summaryTextOf(selected)}</Typography.Text>
            </Space>
            <Space size={8} wrap>
              <Button size="small" loading={probing} onClick={() => void runProbe()}>
                {t('alerting:rule.probe')}
              </Button>
              {probe && (
                <Typography.Text
                  type={probe.startsWith(t('alerting:rule.probeFailedPrefix')) ? 'danger' : 'success'}
                >
                  {probe}
                </Typography.Text>
              )}
            </Space>
          </Space>
        )}
        <Form.Item
          name="name"
          label={t('alerting:rule.name')}
          rules={[
            { required: true, message: t('alerting:validate.required', { field: t('common:label.name') }) },
          ]}
        >
          <Input maxLength={80} />
        </Form.Item>
        <Space wrap align="start" style={{ width: '100%' }}>
          <Form.Item name="comparator" label={t('alerting:rule.comparator')}>
            <Select
              style={{ width: 120 }}
              options={Object.entries(COMPARATOR_LABEL).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item
            name="threshold"
            label={t('alerting:rule.threshold')}
            rules={[
              {
                required: true,
                message: t('alerting:validate.required', { field: t('alerting:rule.threshold') }),
              },
            ]}
          >
            <InputNumber min={0} max={1_000_000_000_000} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="unit" label={t('alerting:field.unit')}>
            <Input style={{ minWidth: 130 }} placeholder={t('alerting:field.unitPlaceholder')} />
          </Form.Item>
          <Form.Item name="severity" label={t('alerting:severity.label')}>
            <Select
              style={{ minWidth: 150 }}
              options={Object.entries(severityLabelsOf(t)).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
        </Space>
        <Space wrap>
          <Form.Item
            name="time_source"
            label={t('common:label.timeRange')}
            tooltip={t('alerting:rule.timeSourceHintMetric')}
          >
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              onChange={() => setProbe(null)}
              options={
                selected?.window_label
                  ? [
                      {
                        value: 'metric',
                        label: t('alerting:rule.timeFromMetricWith', {
                          window: metricWindowTextOf(selected),
                        }),
                      },
                      { value: 'rule', label: t('alerting:rule.timeFromRule') },
                    ]
                  : [{ value: 'rule', label: t('alerting:rule.timeFromRuleNoWindow') }]
              }
            />
          </Form.Item>
          <Form.Item
            name="window_days"
            label={t('alerting:rule.statWindow')}
            tooltip={t('alerting:rule.statWindowHint')}
          >
            <Select style={{ minWidth: 170 }} options={windowDaysOptionsOf(t)} disabled={followsMetric} />
          </Form.Item>
          <Form.Item
            name="for_windows"
            label={t('alerting:rule.forWindows')}
            tooltip={t('alerting:rule.forWindowsHint')}
          >
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
