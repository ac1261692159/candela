import { useEffect, useState } from 'react';
import { Drawer, Form, Input, Select, Button, Space, message, Tabs, Tag, Descriptions } from 'antd';
import type { MetaEvent, MetaEventProperty, MetaVirtualProperty } from '../../types/meta.types';
import { getEventProperties, updateEvent, getVirtualProperties } from '../../services/meta.service';
import { PropertyList } from './PropertyList';
import { formatNumber, formatDateTime } from '../../i18n/format';
import { useT } from '../../i18n';

interface EventDetailDrawerProps {
  event: MetaEvent | null;
  open: boolean;
  onClose: () => void;
  onChange?: () => void;
}

export function EventDetailDrawer({ event, open, onClose, onChange }: EventDetailDrawerProps) {
  const { t } = useT('meta');
  const statusMap: Record<string, { label: string; color: string }> = {
    pending: { label: t('meta:status.pending'), color: 'orange' },
    visible: { label: t('meta:status.visible'), color: 'green' },
    hidden: { label: t('meta:status.hidden'), color: 'default' },
  };

  const availabilityMap: Record<string, { label: string; color: string }> = {
    available: { label: t('meta:event.availability.available'), color: 'green' },
    no_data: { label: t('meta:event.availability.noData'), color: 'orange' },
    hidden: { label: t('common:state.hidden'), color: 'default' },
    deprecated: { label: t('meta:event.availability.deprecated'), color: 'red' },
  };

  const eventTypeMap: Record<string, string> = {
    report: t('meta:event.type.report'),
    virtual: t('meta:event.type.virtual'),
    preset: t('meta:event.type.preset'),
  };

  const [form] = Form.useForm();
  const [properties, setProperties] = useState<MetaEventProperty[]>([]);
  const [virtualProperties, setVirtualProperties] = useState<MetaVirtualProperty[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (event && open) {
      form.setFieldsValue({
        display_name: event.display_name,
        status: event.status,
        owner: event.owner,
        description: event.description,
        remark: event.remark,
      });
      getEventProperties(event.event_key).then(setProperties).catch(() => setProperties([]));
      getVirtualProperties(event.event_key).then(setVirtualProperties).catch(() => setVirtualProperties([]));
    }
  }, [event, open, form]);

  const handleSave = async () => {
    if (!event) return;
    const values = await form.validateFields();
    setLoading(true);
    try {
      await updateEvent(event.event_key, values);
      message.success(t('common:message.saveSuccess'));
      onChange?.();
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Drawer
      title={event ? t('meta:event.detailTitleNamed', { key: event.event_key }) : t('meta:event.detailTitle')}
      width={760}
      open={open}
      onClose={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>{t('common:action.cancel')}</Button>
          <Button type="primary" loading={loading} onClick={handleSave}>
            {t('common:action.save')}
          </Button>
        </Space>
      }
    >
      {event && (
        <Tabs
          defaultActiveKey="basic"
          items={[
            {
              key: 'basic',
              label: t('meta:section.basicInfo'),
              children: (
                <>
                  <Descriptions bordered size="small" column={2} style={{ marginBottom: 24 }}>
                    <Descriptions.Item label={t('meta:label.eventName')}>{event.event_key}</Descriptions.Item>
                    <Descriptions.Item label={t('meta:label.eventType')}>
                      {eventTypeMap[event.event_type] || event.event_type}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('common:label.status')}>
                      <Tag color={statusMap[event.status]?.color}>
                        {statusMap[event.status]?.label}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label={t('meta:label.availability')}>
                      <Tag color={availabilityMap[event.availability_status]?.color}>
                        {availabilityMap[event.availability_status]?.label}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label={t('meta:label.yesterday')}>
                      {formatNumber(event.yesterday_count ?? 0)}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('meta:label.recent7d')}>
                      {formatNumber(event.recent_7d_count ?? 0)}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('meta:label.firstSeen')}>
                      {formatDateTime(event.first_seen_at)}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('meta:label.lastUpdated')}>
                      {formatDateTime(event.updated_at)}
                    </Descriptions.Item>
                  </Descriptions>
                  <Form form={form} layout="vertical">
                    <Form.Item name="display_name" label={t('meta:label.displayName')}>
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
                    <Form.Item name="owner" label={t('meta:label.owner')}>
                      <Input placeholder={t('meta:label.ownerPlaceholder')} />
                    </Form.Item>
                    <Form.Item name="description" label={t('common:label.description')}>
                      <Input.TextArea rows={3} placeholder={t('meta:event.descriptionPlaceholder')} />
                    </Form.Item>
                    <Form.Item name="remark" label={t('common:label.remark')}>
                      <Input.TextArea rows={2} placeholder={t('meta:label.remarkWithLimit')} maxLength={500} showCount />
                    </Form.Item>
                  </Form>
                </>
              ),
            },
            {
              key: 'properties',
              label: t('meta:event.propertiesTab', { count: properties.length }),
              children: <PropertyList properties={properties} scope="event" />,
            },
            {
              key: 'virtual_properties',
              label: t('meta:event.virtualPropertiesTab', { count: virtualProperties.length }),
              children: (
                <PropertyList
                  properties={virtualProperties.map((vp) => ({
                    id: vp.id,
                    prop_key: vp.prop_key,
                    display_name: vp.display_name,
                    data_type: vp.data_type,
                    is_materialized: false,
                    sample_value: t('meta:virtualProperty.expressionLabel', { expression: vp.expression }),
                    status: vp.status,
                    project_name: vp.project_name,
                    created_at: vp.created_at,
                    updated_at: vp.updated_at,
                  }))}
                  scope="event"
                />
              ),
            },
          ]}
        />
      )}
    </Drawer>
  );
}
