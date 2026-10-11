import { useEffect, useState } from 'react';
import { Form, Input, Modal, Select, Typography, message } from 'antd';
import { createSavedMetric } from '../../services/meta.service';
import type { TimeRange } from '../../types/dsl.types';
import { useT } from '../../i18n';
import { buildEventDefinition } from './metric-definition';
import { MetricDefinitionForm, patchFromFormValues } from './MetricDefinitionForm';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}

/** 新建事件指标的默认查询时间：近 7 天（含今天），与告警默认窗口一致 */
const DEFAULT_WINDOW: TimeRange = { start: '', end: '', relative: { kind: 'recent_n', n: 7 } };

/**
 * 新建事件指标（phase: clklog-analytics-metric-v2）。
 *
 * 以前只能在分析页「保存为指标」；现在数据管理 → 指标里可直接新建，
 * 口径表单与事件分析同深度，并带「试算」先看数。
 */
export function CreateEventMetricModal({ open, onClose, onCreated }: Props) {
  const { t } = useT('metrics');
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      format: 'number',
      analysis: 'total_times',
      time_range: DEFAULT_WINDOW,
      filters: { logic: 'and', items: [] },
    });
    setError(null);
    // 只在打开时重置，避免覆盖正在编辑的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const values = await form.validateFields();
      await createSavedMetric({
        name: values.name,
        display_name: values.display_name,
        remark: values.remark,
        kind: 'event',
        definition_json: buildEventDefinition({}, patchFromFormValues(values)),
        format: values.format === 'percent' ? 'percent' : 'number',
      });
      message.success(t('metrics:message.created'));
      await onCreated();
      onClose();
    } catch (err) {
      if (err instanceof Error && err.message) setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('metrics:create.title')}
      onCancel={onClose}
      onOk={() => void submit()}
      okText={t('common:action.save')}
      confirmLoading={saving}
      width={720}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="display_name"
          label={t('metrics:label.displayName')}
          rules={[{ required: true, message: t('metrics:validation.displayNameRequired') }]}
        >
          <Input maxLength={80} placeholder={t('metrics:create.displayNamePlaceholder')} />
        </Form.Item>
        <Form.Item
          name="name"
          label={t('metrics:label.metricName')}
          rules={[
            { required: true, message: t('metrics:validation.metricNameRequired') },
            { pattern: /^[a-z][a-z0-9_]{0,79}$/, message: t('metrics:validation.metricNamePattern') },
          ]}
          extra={t('metrics:create.metricNameExtra')}
        >
          <Input maxLength={80} placeholder={t('metrics:create.metricNamePlaceholder')} />
        </Form.Item>
        <Form.Item name="format" label={t('metrics:label.format')}>
          <Select
            style={{ minWidth: 170 }}
            options={[
              { value: 'number', label: t('metrics:format.number') },
              { value: 'percent', label: t('metrics:format.percent') },
            ]}
          />
        </Form.Item>
        <Form.Item name="remark" label={t('common:label.remark')}>
          <Input.TextArea maxLength={200} showCount rows={2} />
        </Form.Item>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('metrics:create.definitionHint')}
        </Typography.Text>
        <div style={{ marginTop: 8 }}>
          <MetricDefinitionForm form={form} />
        </div>
        {error ? (
          <Typography.Text type="danger" style={{ display: 'block', marginTop: 8 }}>
            {error}
          </Typography.Text>
        ) : null}
      </Form>
    </Modal>
  );
}
