import { useEffect, useState } from 'react';
import { Card, Table, Button, Modal, Space, Tag, message } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { VirtualPropertyEditor } from '../../features/meta/VirtualPropertyEditor';
import { useT } from '../../i18n';
import {
  getVirtualProperties,
  createVirtualProperty,
  updateVirtualProperty,
  deleteVirtualProperty,
  getEvents,
} from '../../services/meta.service';
import type { MetaVirtualProperty, MetaEvent } from '../../types/meta.types';

const typeColors: Record<string, string> = {
  string: 'blue',
  number: 'green',
  boolean: 'purple',
  datetime: 'orange',
};

const statusColors: Record<string, string> = {
  active: 'green',
  invalid: 'red',
  hidden: 'default',
};

export function VirtualPropertiesPage() {
  const { t } = useT('meta');
  const [virtualProperties, setVirtualProperties] = useState<MetaVirtualProperty[]>([]);
  const [events, setEvents] = useState<MetaEvent[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<MetaVirtualProperty> | undefined>();

  const load = async () => {
    const [vpRes, eRes] = await Promise.all([getVirtualProperties(), getEvents()]);
    setVirtualProperties(vpRes);
    setEvents(eRes.items);
  };

  useEffect(() => {
    load();
  }, []);

  const handleSubmit = async (data: Partial<MetaVirtualProperty>) => {
    try {
      if (data.id) {
        await updateVirtualProperty(data.id, data);
      } else {
        await createVirtualProperty(data);
      }
      message.success(t('common:message.saveSuccess'));
      setModalOpen(false);
      setEditing(undefined);
      load();
    } catch (err: any) {
      message.error(err?.response?.data?.message || t('common:message.saveFailed'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteVirtualProperty(id);
      message.success(t('common:message.deleteSuccess'));
      load();
    } catch {
      message.error(t('common:message.deleteFailed'));
    }
  };

  return (
    <Card
      title={t('meta:virtualProperty.title')}
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditing(undefined);
            setModalOpen(true);
          }}
        >
          {t('meta:virtualProperty.create')}
        </Button>
      }
    >
      <Table
        rowKey="id"
        dataSource={virtualProperties}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 1080 }}
        columns={[
          {
            title: t('meta:label.propKey'),
            dataIndex: 'prop_key',
            key: 'prop_key',
            minWidth: 220,
            ellipsis: { showTitle: true },
          },
          {
            title: t('meta:label.displayName'),
            dataIndex: 'display_name',
            key: 'display_name',
            minWidth: 200,
            ellipsis: { showTitle: true },
          },
          {
            title: t('meta:label.dataType'),
            dataIndex: 'data_type',
            key: 'data_type',
            minWidth: 110,
            render: (v: string) => <Tag color={typeColors[v] || 'default'}>{v}</Tag>,
          },
          {
            title: t('common:label.status'),
            dataIndex: 'status',
            key: 'status',
            minWidth: 120,
            render: (v: string) => <Tag color={statusColors[v] || 'default'}>{v}</Tag>,
          },
          {
            title: t('meta:virtualProperty.scopeEvent'),
            dataIndex: 'event_key',
            key: 'event_key',
            minWidth: 160,
            ellipsis: { showTitle: true },
            render: (v?: string) => v || t('meta:virtualProperty.global'),
          },
          {
            title: t('meta:label.expression'),
            dataIndex: 'expression',
            key: 'expression',
            minWidth: 240,
            ellipsis: { showTitle: true },
          },
          {
            title: t('common:label.actions'),
            key: 'action',
            minWidth: 200,
            fixed: 'right',
            render: (_, record) => (
              <Space wrap>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEditing(record);
                    setModalOpen(true);
                  }}
                >
                  {t('common:action.edit')}
                </Button>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => handleDelete(record.id)}
                >
                  {t('common:action.delete')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editing?.id ? t('meta:virtualProperty.edit') : t('meta:virtualProperty.create')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        footer={null}
      >
        <VirtualPropertyEditor
          value={editing}
          events={events}
          onSubmit={handleSubmit}
          onCancel={() => setModalOpen(false)}
        />
      </Modal>
    </Card>
  );
}
