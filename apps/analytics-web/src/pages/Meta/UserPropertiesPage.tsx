import { useEffect, useState } from 'react';
import {
  Card,
  Table,
  Tag,
  Button,
  Drawer,
  Form,
  Input,
  Space,
  Typography,
  Tooltip,
  message,
} from 'antd';
import { EyeOutlined, QuestionCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import type { MetaUserProperty } from '../../types/meta.types';
import {
  getUserProperties,
  updateUserProperty,
  materializeUserProperty,
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

export function UserPropertiesPage() {
  const { t } = useT('meta');
  const materializeHelp = t('meta:property.materializeHelp');
  const [properties, setProperties] = useState<MetaUserProperty[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<MetaUserProperty | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const res = await getUserProperties();
      setProperties(res.items);
      return res.items;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openDetail = (record: MetaUserProperty) => {
    setEditing(record);
    form.setFieldsValue({ display_name: record.display_name });
    setDetailOpen(true);
  };

  const closeDetail = () => {
    setDetailOpen(false);
    setEditing(null);
    form.resetFields();
  };

  const handleSaveDetail = async () => {
    if (!editing) return;
    try {
      const values = await form.validateFields();
      setSaving(true);
      await updateUserProperty(editing.id, { display_name: values.display_name });
      message.success(t('common:message.saveSuccess'));
      const items = await load();
      const latest = items.find((item) => item.id === editing.id);
      if (latest) {
        setEditing(latest);
        form.setFieldsValue({ display_name: latest.display_name });
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(t('common:message.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleMaterialize = async () => {
    if (!editing) return;
    setMaterializing(true);
    try {
      const res = await materializeUserProperty(editing.id);
      if (res.ddl || res.sql || res.success !== false) {
        message.success(res.ddl ? t('meta:property.ddlGenerated') : t('meta:property.materializeSubmitted'));
        await load();
      } else {
        message.warning(t('meta:property.materializeNotDone'));
      }
    } catch {
      message.error(t('meta:property.materializeFailed'));
    } finally {
      setMaterializing(false);
    }
  };

  return (
    <Card title={t('meta:userProperty.title')}>
      <Typography.Paragraph type="secondary">
        {t('meta:userProperty.hint')}
      </Typography.Paragraph>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={properties}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 880 }}
        columns={[
          {
            title: t('meta:label.propName'),
            dataIndex: 'prop_key',
            key: 'prop_key',
            minWidth: 240,
            ellipsis: { showTitle: true },
          },
          {
            title: t('meta:label.displayName'),
            dataIndex: 'display_name',
            key: 'display_name',
            minWidth: 200,
            ellipsis: { showTitle: true },
            render: (v?: string) => (
              <Typography.Text type={v ? undefined : 'secondary'} ellipsis={{ tooltip: v }}>
                {v || '—'}
              </Typography.Text>
            ),
          },
          {
            title: t('common:label.type'),
            dataIndex: 'data_type',
            key: 'data_type',
            minWidth: 110,
            render: (v: string) => <Tag color={typeColors[v] || 'default'}>{v}</Tag>,
          },
          {
            title: (
              <Space size={4}>
                {t('meta:label.materialized')}
                <Tooltip title={materializeHelp}>
                  <QuestionCircleOutlined style={{ color: '#8c8c8c', cursor: 'help' }} />
                </Tooltip>
              </Space>
            ),
            dataIndex: 'is_materialized',
            key: 'is_materialized',
            minWidth: 150,
            render: (v: boolean) =>
              v ? <Tag color="green">{t('common:state.yes')}</Tag> : <Tag>{t('common:state.no')}</Tag>,
          },
          {
            title: t('common:label.actions'),
            key: 'action',
            minWidth: 140,
            fixed: 'right',
            render: (_: unknown, record: MetaUserProperty) => (
              <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(record)}>
                {t('common:label.detail')}
              </Button>
            ),
          },
        ]}
      />
      <Drawer
        title={editing ? t('meta:property.detailTitleNamed', { key: editing.prop_key }) : t('meta:property.detailTitle')}
        width={480}
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
        {editing && (
          <>
            <Form form={form} layout="vertical">
              <Form.Item label={t('meta:label.propName')}>
                <Input value={editing.prop_key} disabled />
              </Form.Item>
              <Form.Item name="display_name" label={t('meta:label.displayName')}>
                <Input placeholder={t('meta:label.displayNamePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('common:label.type')}>
                <Tag color={typeColors[editing.data_type] || 'default'}>{editing.data_type}</Tag>
              </Form.Item>
              <Form.Item
                label={
                  <Space size={4}>
                    {t('meta:label.materialize')}
                    <Tooltip title={materializeHelp}>
                      <QuestionCircleOutlined style={{ color: '#8c8c8c', cursor: 'help' }} />
                    </Tooltip>
                  </Space>
                }
              >
                <Space wrap>
                  {editing.is_materialized ? (
                    <Tag color="green">{t('meta:label.materialized')}</Tag>
                  ) : (
                    <Tag>{t('meta:property.notMaterialized')}</Tag>
                  )}
                  <Button
                    size="small"
                    icon={<ThunderboltOutlined />}
                    disabled={editing.is_materialized}
                    loading={materializing}
                    onClick={() => void handleMaterialize()}
                  >
                    {t('meta:label.materialize')}
                  </Button>
                </Space>
              </Form.Item>
            </Form>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {materializeHelp}
            </Typography.Paragraph>
          </>
        )}
      </Drawer>
    </Card>
  );
}
