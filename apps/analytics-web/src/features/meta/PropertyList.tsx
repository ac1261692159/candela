import { Table, Tag, Button, Input, message, Space, Tooltip } from 'antd';
import { ThunderboltOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import type { MetaEventProperty, MetaUserProperty } from '../../types/meta.types';
import { updateProperty, updateUserProperty, materializeProperty } from '../../services/meta.service';
import { useT } from '../../i18n';

interface PropertyListProps {
  properties: (MetaEventProperty | MetaUserProperty)[];
  scope?: 'event' | 'user';
  onChange?: () => void;
}

const typeColors: Record<string, string> = {
  string: 'blue',
  number: 'green',
  boolean: 'purple',
  datetime: 'orange',
  list: 'cyan',
  object: 'default',
  object_group: 'geekblue',
};

export function PropertyList({ properties, scope = 'event', onChange }: PropertyListProps) {
  const { t } = useT('meta');
  const materializeHelp = t('meta:property.materializeHelp');
  const handleDisplayNameChange = async (record: MetaEventProperty | MetaUserProperty, value: string) => {
    try {
      if (scope === 'event' && 'event_key' in record) {
        await updateProperty(record.id, { display_name: value });
      } else {
        await updateUserProperty(record.id, { display_name: value });
      }
      message.success(t('common:message.saveSuccess'));
      onChange?.();
    } catch {
      message.error(t('common:message.saveFailed'));
    }
  };

  const handleMaterialize = async (record: MetaEventProperty | MetaUserProperty) => {
    try {
      const res = await materializeProperty(record.id);
      if (res.success || res.ddl || res.sql) {
        message.success(res.ddl ? t('meta:property.ddlGenerated') : t('meta:property.materializeSubmitted'));
        onChange?.();
      } else {
        message.warning(t('meta:property.materializeNotDone'));
      }
    } catch {
      message.error(t('meta:property.materializeFailed'));
    }
  };

  return (
    <Table
      rowKey="id"
      dataSource={properties}
      pagination={{ pageSize: 20 }}
      size="small"
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
          minWidth: 220,
          render: (v: string, record) => (
            <Input
              defaultValue={v}
              size="small"
              onBlur={(e) => handleDisplayNameChange(record, e.target.value)}
            />
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
          minWidth: 130,
          render: (v: boolean) =>
            v ? <Tag color="green">{t('common:state.yes')}</Tag> : <Tag>{t('common:state.no')}</Tag>,
        },
        {
          title: t('common:label.actions'),
          key: 'action',
          minWidth: 170,
          fixed: 'right',
          render: (_, record) => (
            <Tooltip title={materializeHelp}>
              <Button
                size="small"
                icon={<ThunderboltOutlined />}
                disabled={'is_materialized' in record && record.is_materialized}
                onClick={() => handleMaterialize(record)}
              >
                {t('meta:label.materialize')}
              </Button>
            </Tooltip>
          ),
        },
      ]}
    />
  );
}
