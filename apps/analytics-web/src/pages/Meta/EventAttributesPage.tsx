import { useEffect, useState } from 'react';
import { formatDateTime } from '../../i18n/format';
import {
  Card,
  Table,
  Input,
  Select,
  Tag,
  Button,
  Space,
  Typography,
  Drawer,
  Form,
  message,
  Tooltip,
} from 'antd';
import { SyncOutlined, EyeOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import type { MetaEventAttribute } from '../../types/meta.types';
import {
  getEventAttributes,
  updateEventAttribute,
  refreshEventAttributeCounts,
  getEventAttributeDetail,
} from '../../services/meta.service';

const typeColors: Record<string, string> = {
  string: 'blue',
  number: 'green',
  boolean: 'purple',
  datetime: 'orange',
  list: 'cyan',
  object: 'default',
  object_group: 'geekblue',
};

export function EventAttributesPage() {
  const { t } = useT('meta');
  const typeLabels: Record<string, string> = {
    string: t('meta:dataType.string'),
    number: t('meta:dataType.number'),
    boolean: t('meta:dataType.boolean'),
    datetime: t('meta:dataType.datetime'),
    list: t('meta:dataType.list'),
    object: t('meta:dataType.object'),
    object_group: t('meta:dataType.objectGroup'),
  };
  const statusLabels: Record<string, { label: string; color: string }> = {
    pending: { label: t('meta:status.pending'), color: 'orange' },
    visible: { label: t('meta:status.visible'), color: 'green' },
    hidden: { label: t('meta:status.hidden'), color: 'default' },
  };
  const statusHelp = t('meta:eventAttribute.statusHelp');
  const dataTypeOptions = Object.entries(typeLabels).map(([value, label]) => ({
    label,
    value,
  }));
  const [attributes, setAttributes] = useState<MetaEventAttribute[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [dataType, setDataType] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [editing, setEditing] = useState<MetaEventAttribute | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = async (page = pagination.current, pageSize = pagination.pageSize) => {
    setLoading(true);
    try {
      const res = await getEventAttributes({
        data_type: dataType,
        status,
        keyword: keyword || undefined,
        page,
        pageSize,
      });
      setAttributes(res.items);
      setPagination({ current: res.page, pageSize: res.pageSize, total: res.total });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(1, pagination.pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataType, status]);

  useEffect(() => {
    const timer = setTimeout(() => load(1, pagination.pageSize), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshEventAttributeCounts();
      message.success(t('meta:eventAttribute.countsRefreshed'));
      load();
    } catch {
      message.error(t('meta:eventAttribute.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  };

  const openDetail = async (record: MetaEventAttribute) => {
    setEditing(record);
    setDetailOpen(true);
    await reloadDetail(record.prop_key);
  };

  const closeDetail = () => {
    setDetailOpen(false);
    setEditing(null);
    setDetail(null);
    form.resetFields();
  };

  const reloadDetail = async (propKey: string) => {
    try {
      const res = await getEventAttributeDetail(propKey);
      setDetail(res);
      form.setFieldsValue({
        display_name: res.display_name,
        data_type: res.data_type,
        remark: res.remark,
      });
    } catch {
      setDetail(null);
    }
  };

  const handleSaveDetail = async () => {
    if (!editing) return;
    try {
      const values = await form.validateFields();
      setSaving(true);
      await updateEventAttribute(editing.prop_key, {
        display_name: values.display_name,
        data_type: values.data_type,
        remark: values.remark,
      });
      message.success(t('common:message.saveSuccess'));
      await load();
      await reloadDetail(editing.prop_key);
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(t('common:message.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    {
      title: t('meta:label.propKey'),
      dataIndex: 'prop_key',
      key: 'prop_key',
      minWidth: 260,
      ellipsis: { showTitle: true },
      render: (v: string, record: MetaEventAttribute) => (
        <Space direction="vertical" size={0} style={{ maxWidth: '100%' }}>
          <Typography.Text strong ellipsis={{ tooltip: v }}>
            {v}
          </Typography.Text>
          {record.display_name && (
            <Typography.Text type="secondary" ellipsis={{ tooltip: record.display_name }} style={{ fontSize: 12 }}>
              {record.display_name}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: t('meta:label.dataType'),
      dataIndex: 'data_type',
      key: 'data_type',
      minWidth: 130,
      render: (v: string) => (
        <Tag color={typeColors[v] || 'default'}>{typeLabels[v] || v}</Tag>
      ),
    },
    {
      title: t('meta:eventAttribute.eventCount'),
      dataIndex: 'event_count',
      key: 'event_count',
      minWidth: 130,
      render: (v: number, record: MetaEventAttribute) => (
        <Button type="link" onClick={() => openDetail(record)}>
          {v}
        </Button>
      ),
    },
    {
      title: (
        <Space size={4}>
          {t('common:label.status')}
          <Tooltip title={statusHelp}>
            <QuestionCircleOutlined style={{ color: '#8c8c8c', cursor: 'help' }} />
          </Tooltip>
        </Space>
      ),
      dataIndex: 'status',
      key: 'status',
      minWidth: 130,
      render: (v: string) => {
        const item = statusLabels[v] ?? { label: v, color: 'default' };
        return <Tag color={item.color}>{item.label}</Tag>;
      },
    },
    {
      title: t('common:label.remark'),
      dataIndex: 'remark',
      key: 'remark',
      minWidth: 220,
      ellipsis: { showTitle: true },
      render: (v: string | undefined) => (
        <Typography.Text type={v ? undefined : 'secondary'} ellipsis={{ tooltip: v }}>
          {v || '—'}
        </Typography.Text>
      ),
    },
    {
      title: t('common:label.updatedAt'),
      dataIndex: 'updated_at',
      key: 'updated_at',
      minWidth: 180,
      render: (v?: string) => (v ? formatDateTime(v) : '-'),
    },
    {
      title: t('common:label.actions'),
      key: 'action',
      minWidth: 140,
      fixed: 'right' as const,
      render: (_: unknown, record: MetaEventAttribute) => (
        <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(record)}>
          {t('common:label.detail')}
        </Button>
      ),
    },
  ];

  return (
    <Card
      title={t('meta:eventAttribute.title')}
      extra={
        <Button icon={<SyncOutlined />} loading={refreshing} onClick={handleRefresh}>
          {t('meta:eventAttribute.refreshCounts')}
        </Button>
      }
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          placeholder={t('meta:label.dataType')}
          allowClear
          value={dataType}
          onChange={setDataType}
          options={dataTypeOptions}
          style={{ minWidth: 160 }}
        />
        <Space size={4}>
          <Select
            placeholder={t('common:label.status')}
            allowClear
            value={status}
            onChange={setStatus}
            options={[
              { label: t('meta:status.pending'), value: 'pending' },
              { label: t('meta:status.visible'), value: 'visible' },
              { label: t('meta:status.hidden'), value: 'hidden' },
            ]}
            style={{ minWidth: 150 }}
          />
          <Tooltip title={statusHelp}>
            <QuestionCircleOutlined style={{ color: '#8c8c8c', cursor: 'help' }} />
          </Tooltip>
        </Space>
        <Input.Search
          placeholder={t('meta:eventAttribute.searchPlaceholder')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ minWidth: 300 }}
        />
      </Space>

      <Table
        rowKey="prop_key"
        loading={loading}
        dataSource={attributes}
        columns={columns}
        pagination={{
          ...pagination,
          showSizeChanger: true,
          showTotal: (total) => t('meta:pagination.total', { count: total }),
        }}
        onChange={(p) => load(p.current, p.pageSize)}
      />

      <Drawer
        title={editing ? t('meta:property.detailTitleNamed', { key: editing.prop_key }) : t('meta:property.detailTitle')}
        width={640}
        open={detailOpen}
        onClose={closeDetail}
        destroyOnClose
        footer={
          <Space>
            <Button onClick={closeDetail}>{t('common:action.cancel')}</Button>
            <Button type="primary" loading={saving} onClick={() => void handleSaveDetail()}>
              {t('common:action.save')}
            </Button>
          </Space>
        }
      >
        {detail && (
          <>
            <Form form={form} layout="vertical">
              <Form.Item label={t('meta:label.propKey')}>
                <Input value={detail.prop_key} disabled />
              </Form.Item>
              <Form.Item name="display_name" label={t('meta:label.displayName')}>
                <Input placeholder={t('meta:label.displayNamePlaceholder')} />
              </Form.Item>
              <Form.Item name="data_type" label={t('meta:eventAttribute.globalDataType')}>
                <Select options={dataTypeOptions} />
              </Form.Item>
              <Form.Item name="remark" label={t('meta:eventAttribute.globalRemark')}>
                <Input.TextArea rows={3} maxLength={500} showCount placeholder={t('meta:label.remarkPlaceholder')} />
              </Form.Item>
            </Form>
            <Typography.Title level={5}>
              {t('meta:eventAttribute.relatedEvents', { count: detail.event_count })}
            </Typography.Title>
            <Table
              rowKey="event_key"
              size="small"
              dataSource={detail.events || []}
              columns={[
                { title: t('meta:label.eventName'), dataIndex: 'event_key' },
                { title: t('meta:label.displayName'), dataIndex: 'display_name' },
                {
                  title: t('meta:label.dataType'),
                  dataIndex: 'data_type',
                  render: (v: string) => (
                    <Tag color={typeColors[v] || 'default'}>{typeLabels[v] || v}</Tag>
                  ),
                },
                {
                  title: t('common:label.status'),
                  dataIndex: 'status',
                  render: (v: string) =>
                    v === 'visible' ? (
                      <Tag color="green">{t('meta:status.visible')}</Tag>
                    ) : (
                      <Tag>{t('meta:status.pending')}</Tag>
                    ),
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </Card>
  );
}
