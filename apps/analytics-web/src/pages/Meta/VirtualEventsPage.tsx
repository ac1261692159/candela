import { useEffect, useState } from 'react';
import { Card, Table, Button, Modal, Tag, message } from 'antd';
import { PlusOutlined, EyeOutlined } from '@ant-design/icons';
import { VirtualEventEditor } from '../../features/meta/VirtualEventEditor';
import { useT } from '../../i18n';
import {
  getVirtualEvents,
  createVirtualEvent,
  updateVirtualEvent,
  deleteVirtualEvent,
  getEvents,
} from '../../services/meta.service';
import type { MetaVirtualEvent, MetaEvent } from '../../types/meta.types';

export function VirtualEventsPage() {
  const { t } = useT('meta');
  const statusMap: Record<string, { label: string; color: string }> = {
    pending: { label: t('meta:status.pending'), color: 'orange' },
    visible: { label: t('meta:status.visible'), color: 'green' },
    hidden: { label: t('meta:status.hidden'), color: 'default' },
  };
  const [virtualEvents, setVirtualEvents] = useState<MetaVirtualEvent[]>([]);
  const [events, setEvents] = useState<MetaEvent[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<MetaVirtualEvent> | undefined>();

  const load = async () => {
    const [vRes, eRes] = await Promise.all([
      getVirtualEvents(),
      getEvents({ pageSize: 500, exclude_hidden: true }),
    ]);
    setVirtualEvents(vRes.items);
    setEvents(eRes.items);
  };

  useEffect(() => {
    void load();
  }, []);

  const closeEditor = () => {
    setModalOpen(false);
    setEditing(undefined);
  };

  const handleSubmit = async (data: Partial<MetaVirtualEvent>) => {
    try {
      if (data.ve_id) {
        await updateVirtualEvent(data.ve_id, data);
      } else {
        await createVirtualEvent(data);
      }
      message.success(t('common:message.saveSuccess'));
      closeEditor();
      await load();
    } catch {
      message.error(t('common:message.saveFailed'));
    }
  };

  const handleDelete = (veId: string) => {
    Modal.confirm({
      title: t('meta:virtualEvent.deleteLabel'),
      content: t('meta:virtualEvent.deleteConfirm'),
      okText: t('common:action.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common:action.cancel'),
      onOk: async () => {
        try {
          await deleteVirtualEvent(veId);
          message.success(t('common:message.deleteSuccess'));
          closeEditor();
          await load();
        } catch {
          message.error(t('common:message.deleteFailed'));
        }
      },
    });
  };

  return (
    <Card
      title={t('meta:virtualEvent.title')}
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditing(undefined);
            setModalOpen(true);
          }}
        >
          {t('meta:virtualEvent.create')}
        </Button>
      }
    >
      <Table
        rowKey="ve_id"
        dataSource={virtualEvents}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 900 }}
        columns={[
          {
            title: t('meta:label.eventName'),
            dataIndex: 'event_key',
            key: 'event_key',
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
            title: t('meta:virtualEvent.sourceEvents'),
            dataIndex: 'definition_json',
            key: 'events',
            minWidth: 280,
            ellipsis: { showTitle: true },
            render: (def) => (def?.events ?? []).join(t('meta:virtualEvent.orSeparator')),
          },
          {
            title: t('common:label.status'),
            dataIndex: 'status',
            key: 'status',
            minWidth: 120,
            render: (v: string) => {
              const map = statusMap[v] || { label: v, color: 'default' };
              return <Tag color={map.color}>{map.label}</Tag>;
            },
          },
          {
            title: t('common:label.actions'),
            key: 'action',
            minWidth: 140,
            fixed: 'right',
            render: (_, record) => (
              <Button
                size="small"
                icon={<EyeOutlined />}
                onClick={() => {
                  setEditing(record);
                  setModalOpen(true);
                }}
              >
                {t('common:label.detail')}
              </Button>
            ),
          },
        ]}
      />
      <Modal
        title={editing?.ve_id ? t('meta:virtualEvent.detailTitle') : t('meta:virtualEvent.create')}
        open={modalOpen}
        onCancel={closeEditor}
        footer={null}
        width={720}
        destroyOnClose
      >
        <VirtualEventEditor
          value={editing}
          events={events}
          onSubmit={handleSubmit}
          onCancel={closeEditor}
          onDelete={editing?.ve_id ? () => handleDelete(editing.ve_id as string) : undefined}
        />
      </Modal>
    </Card>
  );
}
