import { Form, Input, Select, Button, Space, Typography } from 'antd';
import { useT } from '../../i18n';
import type { MetaVirtualProperty } from '../../types/meta.types';

interface VirtualPropertyEditorProps {
  value?: Partial<MetaVirtualProperty>;
  events?: { event_key: string; display_name?: string }[];
  onSubmit?: (data: Partial<MetaVirtualProperty>) => void;
  onCancel?: () => void;
}

export function VirtualPropertyEditor({
  value,
  events = [],
  onSubmit,
  onCancel,
}: VirtualPropertyEditorProps) {
  const { t } = useT('meta');
  const [form] = Form.useForm();

  const handleFinish = (values: Record<string, unknown>) => {
    onSubmit?.({
      ...value,
      prop_key: values.prop_key as string,
      display_name: values.display_name as string,
      data_type: values.data_type as any,
      expression: values.expression as string,
      event_key: values.event_key as string,
      description: values.description as string,
    });
  };

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{
        prop_key: value?.prop_key,
        display_name: value?.display_name,
        data_type: value?.data_type || 'number',
        expression: value?.expression,
        event_key: value?.event_key,
        description: value?.description,
      }}
      onFinish={handleFinish}
    >
      <Form.Item
        name="prop_key"
        label={t('meta:label.propKey')}
        rules={[
          { required: true },
          { pattern: /^vp_[a-zA-Z_][a-zA-Z0-9_$.-]{0,63}$/, message: t('meta:virtualProperty.keyPattern') },
        ]}
      >
        <Input placeholder="vp_total_amount" disabled={!!value?.id} />
      </Form.Item>
      <Form.Item name="display_name" label={t('meta:label.displayName')} rules={[{ required: true }]}>
        <Input placeholder={t('meta:label.displayNamePlaceholder')} />
      </Form.Item>
      <Form.Item name="data_type" label={t('meta:label.dataType')} rules={[{ required: true }]}>
        <Select
          options={[
            { label: t('meta:dataType.string'), value: 'string' },
            { label: t('meta:dataType.number'), value: 'number' },
            { label: t('meta:dataType.boolean'), value: 'boolean' },
            { label: t('meta:dataType.datetime'), value: 'datetime' },
          ]}
        />
      </Form.Item>
      <Form.Item name="event_key" label={t('meta:virtualProperty.scopeEventLabel')}>
        <Select
          allowClear
          showSearch
          options={events.map((e) => ({
            label: e.display_name ? `${e.display_name} (${e.event_key})` : e.event_key,
            value: e.event_key,
          }))}
          placeholder={t('meta:virtualProperty.scopeEventPlaceholder')}
        />
      </Form.Item>
      <Form.Item
        name="expression"
        label={t('meta:label.expression')}
        rules={[{ required: true }]}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('meta:virtualProperty.expressionHelp')}
          </Typography.Text>
        }
      >
        <Input.TextArea rows={4} placeholder="$amount * $quantity" />
      </Form.Item>
      <Form.Item name="description" label={t('common:label.description')}>
        <Input.TextArea rows={2} placeholder={t('meta:label.descriptionPlaceholder')} />
      </Form.Item>
      <Form.Item>
        <Space>
          <Button onClick={onCancel}>{t('common:action.cancel')}</Button>
          <Button type="primary" htmlType="submit">
            {t('common:action.save')}
          </Button>
        </Space>
      </Form.Item>
    </Form>
  );
}
