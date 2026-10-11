import { useEffect, useState } from 'react';
import { Form, Input, Modal, Select, Typography, message } from 'antd';
import { createSavedMetric } from '../../services/meta.service';
import type { MetricItem } from '../../types/dsl.types';
import type { RetentionFormState } from '../../utils/dsl-builder';
import { useT } from '../../i18n';

interface CreateMetricModalProps {
  open: boolean;
  kind: 'event' | 'retention';
  eventMetrics?: MetricItem[];
  retentionForm?: RetentionFormState | null;
  onClose: () => void;
}

export function CreateMetricModal({
  open,
  kind,
  eventMetrics = [],
  retentionForm,
  onClose,
}: CreateMetricModalProps) {
  const { t } = useT('metrics');
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const eventChoices = eventMetrics.filter((item) => item.kind !== 'formula' && item.event);
  const nChoices = retentionForm?.nList ?? [];
  const metricId = Form.useWatch('metricId', form);
  const selected = eventChoices.find((item) => item.id === metricId) ?? eventChoices[0];
  const summary =
    kind === 'event'
      ? selected
        ? t('metrics:modal.summaryEvent', {
            event: selected.event,
            metric: selected.alias || selected.analysis || t('metrics:modal.metricFallback'),
          })
        : t('metrics:modal.summaryEventEmpty')
      : retentionForm
        ? t('metrics:modal.summaryRetention', {
            start: retentionForm.startEvent || '—',
            end: retentionForm.returnEvent || '—',
          })
        : t('metrics:modal.summaryRetentionEmpty');

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      metricId: eventChoices[0]?.id,
      n: nChoices[0],
      measure: 'rate',
    });
    // 只在打开时写入默认口径，避免覆盖用户正在改的选项
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      if (kind === 'event') {
        const metric = eventChoices.find((item) => item.id === values.metricId) ?? eventChoices[0];
        if (!metric) {
          message.warning(t('metrics:message.noEventMetric'));
          return;
        }
        await createSavedMetric({
          name: values.name,
          display_name: values.display_name,
          remark: values.remark,
          kind: 'event',
          definition_json: { metric },
          format: 'number',
        });
      } else {
        if (!retentionForm) {
          message.warning(t('metrics:message.queryRetentionFirst'));
          return;
        }
        const measure = values.measure === 'count' ? 'count' : 'rate';
        await createSavedMetric({
          name: values.name,
          display_name: values.display_name,
          remark: values.remark,
          kind: 'retention',
          definition_json: {
            start_event: { event: retentionForm.startEvent, filters: retentionForm.startFilters },
            retain_event: { event: retentionForm.returnEvent, filters: retentionForm.returnFilters },
            cohort: retentionForm.cohort,
            granularity: retentionForm.granularity,
            n: values.n,
            measure,
          },
          format: measure === 'rate' ? 'percent' : 'number',
        });
      }
      message.success(t('metrics:message.created'));
      form.resetFields();
      onClose();
    } catch (err) {
      if (err instanceof Error && err.message) message.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t('metrics:modal.title')}
      open={open}
      onCancel={onClose}
      onOk={() => void handleOk()}
      okText={t('common:action.save')}
      confirmLoading={saving}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="display_name"
          label={t('metrics:label.displayName')}
          rules={[{ required: true, message: t('metrics:validation.displayNameRequired') }]}
        >
          <Input maxLength={80} />
        </Form.Item>
        <Form.Item
          name="name"
          label={t('metrics:label.metricName')}
          extra={t('metrics:modal.metricNameExtra')}
          rules={[
            { required: true, message: t('metrics:validation.metricNameRequired') },
            { pattern: /^[a-z][a-z0-9_]{0,79}$/, message: t('metrics:validation.metricNamePatternShort') },
          ]}
        >
          <Input maxLength={80} />
        </Form.Item>
        <Form.Item name="remark" label={t('metrics:label.remarkOptional')}>
          <Input.TextArea maxLength={200} showCount rows={2} />
        </Form.Item>
        {kind === 'event' ? (
          <Form.Item
            name="metricId"
            label={t('metrics:label.definitionPick')}
            rules={[{ required: true, message: t('metrics:validation.metricRequired') }]}
          >
            <Select
              options={eventChoices.map((item) => ({
                value: item.id,
                label: item.alias || item.analysis || item.id,
              }))}
            />
          </Form.Item>
        ) : (
          <>
            <Form.Item
              name="n"
              label={t('metrics:label.period')}
              rules={[{ required: true, message: t('metrics:validation.periodRequired') }]}
            >
              <Select
                options={nChoices.map((n) => ({
                  value: n,
                  label:
                    retentionForm?.granularity === 'week'
                      ? `W${n}`
                      : retentionForm?.granularity === 'month'
                        ? `M${n}`
                        : t('metrics:period.day', { n }),
                }))}
              />
            </Form.Item>
            <Form.Item name="measure" label={t('metrics:label.measure')}>
              <Select
                options={[
                  { value: 'rate', label: t('metrics:measure.rate') },
                  { value: 'count', label: t('metrics:measure.count') },
                ]}
              />
            </Form.Item>
          </>
        )}
      </Form>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {summary}
        {t('metrics:modal.summaryNote')}
      </Typography.Paragraph>
    </Modal>
  );
}
