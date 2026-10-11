import { useEffect, useState } from 'react';
import { Form, Input, Select, Button, Space, Divider, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import type { MetaVirtualEvent, MetaEventProperty } from '../../types/meta.types';
import type { FilterGroup } from '../../types/dsl.types';
import { FilterEditor } from '../../components/FilterEditor';
import { getEventProperties } from '../../services/meta.service';
import { useT } from '../../i18n';

interface VirtualEventEditorProps {
  value?: Partial<MetaVirtualEvent>;
  events?: { event_key: string; display_name?: string }[];
  onSubmit?: (data: Partial<MetaVirtualEvent>) => void;
  onCancel?: () => void;
  onDelete?: () => void;
}

const defaultFilters: FilterGroup = { logic: 'and', items: [] };

export function VirtualEventEditor({
  value,
  events = [],
  onSubmit,
  onCancel,
  onDelete,
}: VirtualEventEditorProps) {
  const { t } = useT('meta');
  const [form] = Form.useForm();
  const [selectedEvents, setSelectedEvents] = useState<string[]>(
    value?.definition_json?.events ?? [],
  );
  const [filters, setFilters] = useState<FilterGroup>(
    value?.definition_json?.filters ?? defaultFilters,
  );
  const [eventProperties, setEventProperties] = useState<MetaEventProperty[]>([]);

  useEffect(() => {
    if (value) {
      form.setFieldsValue({
        ve_id: value.ve_id,
        display_name: value.display_name,
        status: value.status || 'visible',
      });
      setSelectedEvents(value.definition_json?.events ?? []);
      setFilters(value.definition_json?.filters ?? defaultFilters);
    } else {
      form.resetFields();
      setSelectedEvents([]);
      setFilters(defaultFilters);
    }
  }, [value, form]);

  useEffect(() => {
    if (selectedEvents.length === 0) {
      setEventProperties([]);
      return;
    }
    // 取第一个来源事件的属性作为全局筛选候选；多事件共用属性需用户自行保证
    getEventProperties(selectedEvents[0])
      .then(setEventProperties)
      .catch(() => setEventProperties([]));
  }, [selectedEvents]);

  const handleFinish = async () => {
    const values = await form.validateFields();
    if (selectedEvents.length === 0) {
      form.setFields([
        { name: 'events', errors: [t('meta:virtualEvent.needEvent')] },
      ]);
      return;
    }
    onSubmit?.({
      ve_id: values.ve_id as string | undefined,
      display_name: values.display_name as string,
      status: values.status as any,
      definition_json: {
        events: selectedEvents,
        filters: filters.items.length > 0 ? filters : undefined,
      },
    });
  };

  const eventOptions = events.map((e) => ({
    label: e.display_name ? `${e.display_name} (${e.event_key})` : e.event_key,
    value: e.event_key,
  }));

  return (
    <Form form={form} layout="vertical" onFinish={handleFinish}>
      <Typography.Title level={5}>{t('meta:section.ruleDefinition')}</Typography.Title>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        {t('meta:virtualEvent.ruleHint')}
      </Typography.Text>

      <Form.Item label={t('meta:label.event')} required validateStatus={selectedEvents.length ? '' : 'error'}>
        <Space direction="vertical" style={{ width: '100%' }}>
          {selectedEvents.map((key, index) => (
            <Space key={key} wrap>
              <span>{index + 1}</span>
              <span>{events.find((e) => e.event_key === key)?.display_name || key}</span>
              {index > 0 && <span style={{ color: '#999' }}>{t('meta:virtualEvent.or')}</span>}
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label={t('meta:virtualEvent.removeSource', { key })}
                onClick={() => setSelectedEvents(selectedEvents.filter((k) => k !== key))}
              />
            </Space>
          ))}
          <Select
            value={undefined}
            onChange={(key: string) => {
              if (key && !selectedEvents.includes(key)) {
                setSelectedEvents([...selectedEvents, key]);
              }
            }}
            options={eventOptions.filter((o) => !selectedEvents.includes(o.value))}
            placeholder={t('meta:virtualEvent.addEvent')}
            style={{ minWidth: 320 }}
            disabled={eventOptions.length === selectedEvents.length}
          />
        </Space>
      </Form.Item>

      <Form.Item label={t('meta:virtualEvent.globalFilter')}>
        <FilterEditor
          value={filters}
          onChange={setFilters}
          eventProperties={eventProperties.map((p) => ({
            prop_key: p.prop_key,
            display_name: p.display_name,
            data_type: p.data_type,
          }))}
        />
      </Form.Item>

      <Divider />

      <Typography.Title level={5}>{t('meta:section.basicInfo')}</Typography.Title>
      {value?.ve_id ? (
        <Form.Item name="ve_id" label={t('meta:label.eventName')}>
          <Input placeholder={t('meta:label.autoGenerated')} disabled />
        </Form.Item>
      ) : null}
      <Form.Item name="display_name" label={t('meta:label.displayName')} rules={[{ required: true }]}>
        <Input placeholder={t('meta:label.displayNamePlaceholder')} />
      </Form.Item>
      <Form.Item name="status" label={t('common:label.status')}>
        <Select
          options={[
            { label: t('meta:status.pending'), value: 'pending' },
            { label: t('meta:status.visible'), value: 'visible' },
            { label: t('meta:status.hidden'), value: 'hidden' },
          ]}
        />
      </Form.Item>
      <Form.Item>
        <Space>
          <Button onClick={onCancel}>{t('common:action.cancel')}</Button>
          <Button type="primary" htmlType="submit">
            {t('common:action.save')}
          </Button>
          {onDelete ? (
            <Button danger onClick={onDelete} aria-label={t('meta:virtualEvent.deleteLabel')}>
              {t('common:action.delete')}
            </Button>
          ) : null}
        </Space>
      </Form.Item>
    </Form>
  );
}
