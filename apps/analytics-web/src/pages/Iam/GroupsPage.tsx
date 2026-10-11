import { useEffect, useState } from 'react';
import { Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import {
  addGroupUser,
  createGroup,
  listGroups,
  listMembers,
  removeGroupUser,
  type IamGroup,
  type IamMember,
} from '../../services/iam.service';
import { useIamStore } from '../../stores/iam.store';
import { IamLoadError } from './load-error';
import { SubjectDashboardGrantModal } from './SubjectDashboardGrantModal';
import { useT, type TFunction } from '../../i18n';

const roleOptionsOf = (t: TFunction): { value: string; label: string }[] => [
  { value: 'analysis_admin', label: t('iam:role.analysisAdmin') },
  { value: 'analyst', label: t('iam:role.analyst') },
  { value: 'member', label: t('iam:role.member') },
  { value: 'external', label: t('iam:role.external') },
];

export function IamGroupsPage() {
  const { t } = useT('iam');
  const roleOptions = roleOptionsOf(t);
  const [rows, setRows] = useState<IamGroup[]>([]);
  const [members, setMembers] = useState<IamMember[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<IamGroup | null>(null);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [form] = Form.useForm();
  // rbac-v4：项目权限全员只读可见——无编辑码时只读展示组员，不提供增删
  const canManage = useIamStore((s) => s.has('iam.member.edit'));
  // rbac-v6：成员组视角的看板授权入口（owner / 分析管理员持 asset.grant）
  const canGrantDashboards = useIamStore((s) => s.has('asset.grant'));
  const [loadFailed, setLoadFailed] = useState(false);
  const [grantGroup, setGrantGroup] = useState<{ id: string; name: string } | null>(null);
  const load = () =>
    listGroups()
      .then((rows) => {
        setRows(rows);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));

  useEffect(() => {
    void load();
    listMembers().then(setMembers).catch(() => setMembers([]));
  }, []);

  const memberName = (userId: string) => {
    const m = members.find((item) => item.user_id === userId);
    return m ? m.user.display_name || m.user.username : userId;
  };
  const editingMemberIds = (editing?.users ?? []).map((u) => u.user_id);

  return (
    <Card
      title={t('iam:groups.title')}
      extra={
        canManage ? (
          <Button type="primary" onClick={() => setOpen(true)}>
            {t('iam:groups.create')}
          </Button>
        ) : null
      }
    >
      {loadFailed ? <IamLoadError onRetry={() => void load()} /> : null}
      <Table
        rowKey="id"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 930 }}
        columns={[
          { title: t('common:label.name'), dataIndex: 'name', minWidth: 220, ellipsis: { showTitle: true } },
          {
            title: t('iam:label.role'),
            dataIndex: 'role_key',
            minWidth: 150,
            render: (v: string) => roleOptions.find((o) => o.value === v)?.label ?? v,
          },
          { title: t('iam:groups.memberCount'), minWidth: 110, render: (_, r) => r._count?.users ?? 0 },
          {
            title: t('iam:dataPolicy.column'),
            minWidth: 200,
            ellipsis: { showTitle: true },
            render: (_, r) => r.data_policy?.name || t('iam:dataPolicy.unrestricted'),
          },
          {
            title: t('common:label.actions'),
            minWidth: canGrantDashboards ? 250 : 120,
            fixed: 'right',
            render: (_, r) => (
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(r);
                    setUserIds((r.users ?? []).map((u) => u.user_id));
                  }}
                >
                  {t('iam:groups.members')}
                </Button>
                {canGrantDashboards ? (
                  <Button size="small" onClick={() => setGrantGroup({ id: r.id, name: r.name })}>
                    {t('iam:subjectGrant.action')}
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={t('iam:groups.createTitle')}
        open={canManage && open}
        onCancel={() => setOpen(false)}
        onOk={async () => {
          const v = await form.validateFields();
          await createGroup(v);
          message.success(t('iam:message.created'));
          setOpen(false);
          form.resetFields();
          await load();
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('common:label.name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="role_key" label={t('iam:label.role')} rules={[{ required: true }]} initialValue="analyst">
            <Select options={roleOptions} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={t('iam:groups.membersTitle', { name: editing?.name ?? '' })}
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        footer={canManage ? undefined : null}
        onOk={async () => {
          if (!editing) return;
          const current = new Set((editing.users ?? []).map((u) => u.user_id));
          const next = new Set(userIds);
          for (const id of next) {
            if (!current.has(id)) await addGroupUser(editing.id, id);
          }
          for (const id of current) {
            if (!next.has(id)) await removeGroupUser(editing.id, id);
          }
          message.success(t('iam:groups.membersUpdated'));
          setEditing(null);
          await load();
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>{t('iam:groups.membersHint')}</div>
          {canManage ? (
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              value={userIds}
              onChange={setUserIds}
              options={members
                .filter((m) => m.role_key !== 'project_owner')
                .map((m) => ({ value: m.user_id, label: m.user.display_name || m.user.username }))}
            />
          ) : (
            <Space wrap>
              {editingMemberIds.length === 0 ? (
                <Typography.Text type="secondary">{t('iam:groups.membersEmpty')}</Typography.Text>
              ) : (
                editingMemberIds.map((id) => <Tag key={id}>{memberName(id)}</Tag>)
              )}
            </Space>
          )}
        </Space>
      </Modal>
      <SubjectDashboardGrantModal
        open={Boolean(grantGroup)}
        subjectType="group"
        subjectId={grantGroup?.id ?? ''}
        subjectName={grantGroup?.name ?? ''}
        onClose={() => setGrantGroup(null)}
      />
    </Card>
  );
}
