import { useEffect, useState } from 'react';
import { formatDateTimeFixed } from '../../i18n/format';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Drawer,
  Dropdown,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ExclamationCircleFilled,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  deleteTag,
  getTagMembers,
  getTags,
  refreshTag,
  type UserTag,
} from '../../services/tag.service';
import { EntityIcon } from '../../components/EntityIcon';
import { EmptyState } from '../../components/EmptyState';
import { useT } from '../../i18n';
import { lockTag } from '../../services/iam.service';
import { useIamStore } from '../../stores/iam.store';

function formatTime(value: string | null) {
  if (!value) return '—';
  return formatDateTimeFixed(value);
}

export function UserTagsPage() {
  const { t } = useT('cohort');
  const navigate = useNavigate();
  const [items, setItems] = useState<UserTag[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [members, setMembers] = useState<{ uid: string; tag_value: string }[] | null>(null);
  const [membersTotal, setMembersTotal] = useState(0);
  const [membersTitle, setMembersTitle] = useState('');
  const canLock = useIamStore((s) => s.has('asset.lock'));

  const load = async (search = keyword) => {
    setLoading(true);
    try {
      const res = await getTags({ keyword: search || undefined });
      setItems(res.items);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!items.some((item) => item.status === 'pending')) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const handleDelete = (row: UserTag) => {
    Modal.confirm({
      title: t('cohort:tagList.deleteTitle'),
      content: t('cohort:tagList.deleteContent', { name: row.display_name }),
      okText: t('common:action.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common:action.cancel'),
      onOk: async () => {
        try {
          await deleteTag(row.tag_id);
          message.success(t('cohort:message.deleted'));
          await load();
        } catch (err) {
          const text = err instanceof Error ? err.message : '';
          // 优先按机器码判断（文案会随语言变化，机器码不会）；老后端无 errorCode 时回退文案匹配
          const errCode = (err as { errorCode?: string })?.errorCode;
          if (errCode ? errCode !== 'tag.cardReferenced' : !text.includes('已被卡片引用')) return;
          Modal.confirm({
            title: t('cohort:tagList.deleteReferencedTitle'),
            content: t('cohort:tagList.deleteReferencedContent', { message: text }),
            okText: t('cohort:action.deleteAnyway'),
            okButtonProps: { danger: true },
            cancelText: t('common:action.cancel'),
            onOk: async () => {
              await deleteTag(row.tag_id, true);
              message.success(t('cohort:message.deleted'));
              await load();
            },
          });
        }
      },
    });
  };

  const handleRefresh = async (row: UserTag) => {
    await refreshTag(row.tag_id);
    message.success(t('cohort:message.refreshed'));
    await load();
  };

  const handleMembers = async (row: UserTag) => {
    setMembersTitle(row.display_name);
    const res = await getTagMembers(row.tag_id);
    setMembers(res.items);
    setMembersTotal(res.total);
  };

  return (
    <Card
      title={t('cohort:tagList.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/analysis/tags/new')}>
          {t('cohort:tagList.create')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        {t('cohort:tagList.hint')}
      </Typography.Paragraph>
      <Space style={{ marginBottom: 16 }}>
        <Input
          allowClear
          placeholder={t('cohort:tagList.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={() => void load()}
          style={{ width: 280 }}
        />
        <Button onClick={() => void load()}>{t('common:action.search')}</Button>
      </Space>
      <Table
        rowKey="tag_id"
        loading={loading}
        dataSource={items}
        pagination={false}
        scroll={{ x: 1310 }}
        locale={{
          emptyText: (
            <EmptyState
              variant="tag"
              action={
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => navigate('/analysis/tags/new')}
                  aria-label={t('cohort:tagList.createFirstAria')}
                >
                  {t('cohort:tagList.create')}
                </Button>
              }
            />
          ),
        }}
        columns={[
          {
            title: t('cohort:label.tagName'),
            dataIndex: 'name',
            width: 280,
            render: (name: string, row) => (
              <Space size={6} wrap style={{ rowGap: 4 }}>
                <EntityIcon type="tag" />
                <Typography.Text ellipsis={{ tooltip: name }} style={{ maxWidth: 180 }}>
                  {name}
                </Typography.Text>
                {row.locked ? <Tag>{t('cohort:status.locked')}</Tag> : null}
                {row.status === 'failed' ? (
                  <Tooltip title={row.compute_error || t('cohort:status.computeFailed')}>
                    <ExclamationCircleFilled style={{ color: '#ff4d4f' }} aria-label={t('cohort:status.computeFailed')} />
                  </Tooltip>
                ) : null}
                {row.status === 'pending' ? <Tag>{t('cohort:status.computing')}</Tag> : null}
              </Space>
            ),
          },
          {
            title: t('cohort:label.displayName'),
            dataIndex: 'display_name',
            width: 200,
            ellipsis: true,
          },
          { title: t('common:label.creator'), dataIndex: 'owner', width: 140, ellipsis: true },
          {
            title: t('cohort:label.schedule'),
            dataIndex: 'schedule',
            /* 单元格文案 nowrap：俄 «По расписанию» 13 字符 ≈ 91px + 表头 «Способ расчёта»，
               100px 会截断；按最长语言估宽。 */
            width: 140,
            render: (schedule: string) => (schedule === 'daily' ? t('cohort:label.scheduleDaily') : t('cohort:label.scheduleManual')),
          },
          {
            title: t('cohort:label.lastComputedAt'),
            dataIndex: 'last_computed_at',
            width: 170,
            render: (value: string | null) => formatTime(value),
          },
          {
            /* 数字单元格很窄，但表头按最长语言要 143px（俄 «Число пользователей»）——
               90px 会把表头压成竖排窄条。 */
            title: t('cohort:label.memberCount'),
            dataIndex: 'member_count',
            width: 180,
          },
          {
            title: t('common:label.actions'),
            key: 'actions',
            width: 200,
            fixed: 'right',
            render: (_, row) => (
              <Space wrap style={{ rowGap: 4 }}>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void handleRefresh(row)}>
                  {t('common:action.refresh')}
                </Button>
                <Button size="small" onClick={() => navigate(`/analysis/tags/${row.tag_id}`)}>
                  {t('common:action.edit')}
                </Button>
                <Dropdown
                  menu={{
                    items: [
                      { key: 'members', label: t('cohort:action.members') },
                      ...(canLock
                        ? [{ key: 'lock', label: row.locked ? t('cohort:action.unlock') : t('cohort:action.lock') }]
                        : []),
                      { key: 'delete', label: t('common:action.delete'), danger: true },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'members') void handleMembers(row);
                      if (key === 'lock') void lockTag(row.tag_id, !row.locked).then(() => load());
                      if (key === 'delete') handleDelete(row);
                    },
                  }}
                >
                  <Button size="small" icon={<MoreOutlined />} aria-label={t('cohort:action.moreAria', { name: row.display_name })} />
                </Dropdown>
              </Space>
            ),
          },
        ]}
      />
      <Drawer
        title={t('cohort:member.drawerTitle', { name: membersTitle })}
        open={members != null}
        onClose={() => setMembers(null)}
        width={480}
      >
        <Typography.Paragraph type="secondary">{t('cohort:member.previewHint', { total: membersTotal })}</Typography.Paragraph>
        <Table
          size="small"
          rowKey={(row) => `${row.uid}:${row.tag_value}`}
          dataSource={members ?? []}
          pagination={{ pageSize: 50 }}
          columns={[
            { title: t('cohort:label.userId'), dataIndex: 'uid' },
            { title: t('cohort:label.tagValue'), dataIndex: 'tag_value' },
          ]}
        />
      </Drawer>
    </Card>
  );
}
