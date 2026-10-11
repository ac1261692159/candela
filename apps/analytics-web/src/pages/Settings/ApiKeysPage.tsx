import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '../../i18n/format';
import { Button, Card, Modal, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import { PlusOutlined, KeyOutlined, CopyOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { EntityIcon } from '../../components/EntityIcon';
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  deleteApiKey,
  type ApiKeyItem,
} from '../../services/auth.service';
import { useT } from '../../i18n';

/** 日期格式化 */
function fmtDate(v: string | null) {
  return formatDateTime(v ?? undefined);
}

/**
 * API Key 管理（仅 admin）。
 * 一键生成：无需输入任何信息，自动生成 sk-tp-<48位随机串> 并自动命名；
 * project 边界默认 clklogapp，永不过期。
 */
export function ApiKeysPage() {
  const { t } = useT('iam');
  const [items, setItems] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listApiKeys();
      setItems(res);
    } catch {
      // 错误已由拦截器提示
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** 一键生成：无表单，直接创建 */
  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await createApiKey();
      setCreatedKey(res.api_key);
      message.success(t('iam:apiKeys.created'));
      load();
    } catch {
      // 错误已由拦截器提示
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeApiKey(id);
      message.success(t('iam:apiKeys.revokedMsg'));
      load();
    } catch {
      // 错误已由拦截器提示
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteApiKey(id);
      message.success(t('iam:apiKeys.deleted'));
      load();
    } catch {
      // 错误已由拦截器提示
    }
  };

  const copyKey = () => {
    if (!createdKey) return;
    navigator.clipboard?.writeText(createdKey).then(() => {
      message.success(t('iam:apiKeys.copied'));
    });
  };

  const columns: ColumnsType<ApiKeyItem> = [
    {
      title: t('common:label.name'),
      dataIndex: 'name',
      key: 'name',
      minWidth: 240,
      ellipsis: { showTitle: true },
      render: (v: string) => (
        <Space size={6}>
          <EntityIcon type="api-key" />
          <span>{v}</span>
        </Space>
      ),
    },
    { title: t('iam:apiKeys.projectScope'), dataIndex: 'project_name', key: 'project_name', minWidth: 180, ellipsis: { showTitle: true } },
    {
      title: t('common:label.status'),
      dataIndex: 'status',
      key: 'status',
      minWidth: 120,
      render: (s: string) =>
        s === 'active' ? <Tag color="green">{t('iam:apiKeys.active')}</Tag> : <Tag color="red">{t('iam:apiKeys.revoked')}</Tag>,
    },
    {
      title: t('iam:apiKeys.expiresAt'),
      dataIndex: 'expires_at',
      key: 'expires_at',
      minWidth: 170,
      render: fmtDate,
    },
    {
      title: t('iam:apiKeys.lastUsedAt'),
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      minWidth: 170,
      render: fmtDate,
    },
    {
      title: t('common:label.createdAt'),
      dataIndex: 'created_at',
      key: 'created_at',
      minWidth: 170,
      render: fmtDate,
    },
    {
      title: t('common:label.actions'),
      key: 'action',
      minWidth: 220,
      fixed: 'right',
      render: (_, record) => (
        <Space wrap>
          {record.status === 'active' && (
            <Popconfirm title={t('iam:apiKeys.revokeConfirm')} onConfirm={() => handleRevoke(record.id)}>
              <Button size="small" danger>
                {t('iam:apiKeys.revoke')}
              </Button>
            </Popconfirm>
          )}
          <Popconfirm title={t('iam:apiKeys.deleteConfirm')} onConfirm={() => handleDelete(record.id)}>
            <Button size="small" type="text" danger>
              {t('common:action.delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('iam:apiKeys.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={handleCreate}>
          {t('iam:apiKeys.create')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        {t('iam:apiKeys.hintLead')}{' '}
        <Typography.Text code>/sa/api/ai/query</Typography.Text>{' '}
        {t('iam:apiKeys.hintTail')}
      </Typography.Paragraph>

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={false}
        scroll={{ x: 1280 }}
      />

      {/* 生成成功展示明文 key */}
      <Modal
        title={t('iam:apiKeys.createSuccess')}
        open={!!createdKey}
        onCancel={() => setCreatedKey(null)}
        footer={[
          <Button key="copy" icon={<CopyOutlined />} onClick={copyKey}>
            {t('common:action.copy')}
          </Button>,
          <Button key="close" type="primary" onClick={() => setCreatedKey(null)}>
            {t('iam:apiKeys.saved')}
          </Button>,
        ]}
      >
        <Typography.Paragraph type="warning">
          {t('iam:apiKeys.plaintextWarning')}
        </Typography.Paragraph>
        <div
          style={{
            background: '#f5f5f5',
            padding: 12,
            borderRadius: 6,
            fontFamily: 'monospace',
            // 明文 key 是机器串（复制用）：用 break-word 兜底而不是 break-all（红线禁止 break-all）
            overflowWrap: 'break-word',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <KeyOutlined />
          <span>{createdKey}</span>
        </div>
      </Modal>
    </Card>
  );
}
