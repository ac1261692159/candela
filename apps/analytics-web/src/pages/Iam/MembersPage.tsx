import { useEffect, useState } from 'react';
import { AutoComplete, Button, Card, DatePicker, Form, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  addMember,
  createInvitation,
  listInvitations,
  listMembers,
  listUserDirectory,
  patchMember,
  removeMember,
  revokeInvitation,
  type IamMember,
  type PendingInvitation,
} from '../../services/iam.service';
import { listAuditLogs, type AuditLogItem } from '../../services/auth.service';
import { AUDIT_ACTION_KEYS } from '../../features/account/audit-actions';
import { useProjectStore } from '../../stores/project.store';
import { useIamStore } from '../../stores/iam.store';
import { IamLoadError } from './load-error';
import { SubjectDashboardGrantModal } from './SubjectDashboardGrantModal';
import { useT, type TFunction } from '../../i18n';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const roleOptionsOf = (t: TFunction): { value: string; label: string }[] => [
  { value: 'analysis_admin', label: t('iam:role.analysisAdmin') },
  { value: 'analyst', label: t('iam:role.analyst') },
  { value: 'member', label: t('iam:role.member') },
  { value: 'external', label: t('iam:role.external') },
];

export function IamMembersPage() {
  const { t } = useT('iam');
  const roleOptions = roleOptionsOf(t);
  // 渲染用映射要含 owner：成员列表里 owner 的角色不会被分配但不该显示成裸键
  const roleLabelsWithOwner: Record<string, string> = {
    project_owner: t('iam:role.projectOwner'),
    ...Object.fromEntries(roleOptions.map((o) => [o.value, o.label])),
  };
  const [rows, setRows] = useState<IamMember[]>([]);
  const [invites, setInvites] = useState<PendingInvitation[]>([]);
  const [renewTarget, setRenewTarget] = useState<IamMember | null>(null);
  const [renewDate, setRenewDate] = useState<Dayjs | null>(null);
  const [users, setUsers] = useState<{ id: string; username: string; display_name: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [audits, setAudits] = useState<AuditLogItem[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [grantSubject, setGrantSubject] = useState<{ id: string; name: string } | null>(null);

  const currentProject = useProjectStore((s) => s.currentProject);
  // rbac-v4：项目权限全员只读可见——邀请队列与权限审计流水仍属治理面，无编辑码时不取也不渲染
  const canManage = useIamStore((s) => s.has('iam.member.edit'));
  // rbac-v6：成员视角的看板授权入口（owner / 分析管理员持 asset.grant）
  const canGrantDashboards = useIamStore((s) => s.has('asset.grant'));
  const load = async () => {
    try {
      const data = await listMembers();
      setRows(data);
      setLoadFailed(false);
      if (canManage) listInvitations().then(setInvites).catch(() => setInvites([]));
    } catch {
      setLoadFailed(true);
    }
  };
  const loadAudits = async () => {
    setAudits(await listAuditLogs(200, currentProject));
  };

  const auditLabel = (action: string) => {
    const mapped = AUDIT_ACTION_KEYS[action];
    if (!mapped) return action;
    const label = t(`auth:users.auditActions.${mapped}`);
    return label === `auth:users.auditActions.${mapped}` ? action : label;
  };

  useEffect(() => {
    void load();
    if (canManage) {
      loadAudits().catch(() => setAudits([]));
      listUserDirectory().then(setUsers).catch(() => setUsers([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject, canManage]);

  return (
    <Card
      title={t('iam:members.title')}
      extra={
        canManage ? (
          <Button type="primary" onClick={() => setOpen(true)}>
            {t('iam:members.add')}
          </Button>
        ) : null
      }
    >
      {loadFailed ? <IamLoadError onRetry={() => void load()} /> : null}
      <Table
        rowKey="id"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 1050 }}
        columns={[
          { title: t('iam:label.user'), minWidth: 200, ellipsis: { showTitle: true }, render: (_, r) => r.user.display_name || r.user.username },
          {
            title: t('iam:label.role'),
            dataIndex: 'role_key',
            minWidth: 150,
            render: (v: string) => roleLabelsWithOwner[v] ?? v,
          },
          {
            title: t('iam:dataPolicy.column'),
            minWidth: 200,
            ellipsis: { showTitle: true },
            render: (_, r) => r.data_policy?.name || t('iam:dataPolicy.unrestricted'),
          },
          {
            title: t('iam:member.colExpiry'),
            minWidth: 210,
            render: (_, r) => {
              if ((r as { expired?: boolean }).expired) return <Tag color="red">{t('iam:member.expiredTag')}</Tag>;
              const exp = (r as { expires_at?: string | null }).expires_at;
              if (!exp) return t('iam:member.expiryPermanent');
              const days = dayjs(exp).diff(dayjs(), 'day');
              return days <= 7 ? (
                <Tag color="orange">{t('iam:member.expiryInDays', { days: Math.max(days, 0) })}</Tag>
              ) : (
                dayjs(exp).format('YYYY-MM-DD')
              );
            },
          },
          ...(canManage || canGrantDashboards
            ? [
                {
                  title: t('common:label.actions'),
                  minWidth: canManage ? 340 : 170,
                  fixed: 'right' as const,
                  render: (_: unknown, r: IamMember) => {
                    // owner 全量可见，不需要按看板授权
                    if (r.role_key === 'project_owner') return '—';
                    return (
                      <Space wrap>
                        {canManage ? (
                          <>
                            {(r as { expired?: boolean }).expired ? (
                              <Button
                                size="small"
                                onClick={() => {
                                  setRenewTarget(r);
                                  setRenewDate(null);
                                }}
                              >
                                {t('iam:member.renew')}
                              </Button>
                            ) : (
                              <Select
                                size="small"
                                style={{ minWidth: 170 }}
                                value={r.role_key}
                                options={roleOptions}
                                onChange={(role_key) => patchMember(r.id, { role_key }).then(load)}
                              />
                            )}
                            <Popconfirm
                              title={t('iam:members.removeConfirm')}
                              onConfirm={() => removeMember(r.id).then(load)}
                            >
                              <Button size="small" danger>
                                {t('iam:members.remove')}
                              </Button>
                            </Popconfirm>
                          </>
                        ) : null}
                        {canGrantDashboards ? (
                          <Button
                            size="small"
                            onClick={() =>
                              setGrantSubject({ id: r.user_id, name: r.user.display_name || r.user.username })
                            }
                          >
                            {t('iam:subjectGrant.action')}
                          </Button>
                        ) : null}
                      </Space>
                    );
                  },
                },
              ]
            : []),
        ]}
      />
      {canManage && invites.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            {t('iam:invite.pendingTitle')}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={invites}
            columns={[
              { title: t('iam:invite.colEmail'), dataIndex: 'email' },
              { title: t('iam:label.role'), dataIndex: 'role_key', minWidth: 150, render: (v: string) => roleLabelsWithOwner[v] ?? v },
              { title: t('iam:invite.colInviter'), dataIndex: 'invited_by', minWidth: 160, ellipsis: { showTitle: true } },
              {
                title: t('iam:invite.colExpires'),
                dataIndex: 'expires_at',
                minWidth: 170,
                render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
              },
              {
                title: t('common:label.actions'),
                minWidth: 160,
                render: (_, r) => (
                  <Popconfirm title={t('iam:invite.revokeConfirm')} onConfirm={() => revokeInvitation(r.id).then(load)}>
                    <Button size="small" danger>
                      {t('iam:invite.revoke')}
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </div>
      )}
      <Modal
        title={t('iam:members.add')}
        open={canManage && open}
        onCancel={() => setOpen(false)}
        onOk={async () => {
          const v = await form.validateFields();
          const picked = String(v.user_key ?? '').trim();
          const expiresAt = (v.member_expires_at as Dayjs | undefined)?.toISOString() ?? null;
          if (users.some((u) => u.id === picked)) {
            await addMember({ user_id: picked, role_key: v.role_key, expires_at: expiresAt });
            message.success(t('iam:members.added'));
          } else if (EMAIL_RE.test(picked.toLowerCase())) {
            const res = await createInvitation({ email: picked.toLowerCase(), role_key: v.role_key, member_expires_at: expiresAt });
            message.success(res.added ? t('iam:invite.addedDirect') : t('iam:invite.sent'));
          } else {
            form.setFields([{ name: 'user_key', errors: [t('iam:invite.emailInvalid')] }]);
            return;
          }
          setOpen(false);
          form.resetFields();
          await load();
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="user_key"
            label={t('iam:label.user')}
            extra={t('iam:invite.userOrEmailHint')}
            rules={[{ required: true }]}
          >
            <AutoComplete
              options={users.map((u) => ({ value: u.id, label: u.display_name || u.username }))}
              filterOption={(input, option) => String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
              placeholder={t('iam:invite.userOrEmailPlaceholder')}
            />
          </Form.Item>
          <Form.Item name="role_key" label={t('iam:label.role')} rules={[{ required: true }]} initialValue="analyst">
            <Select options={roleOptions} />
          </Form.Item>
          <Form.Item name="member_expires_at" label={t('iam:member.expiryLabel')} extra={t('iam:member.expiryHint')}>
            <DatePicker showTime style={{ width: '100%' }} allowClear />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={t('iam:member.renewTitle')}
        open={canManage && !!renewTarget}
        onCancel={() => setRenewTarget(null)}
        onOk={async () => {
          if (!renewTarget || !renewDate) return;
          await patchMember(renewTarget.id, { expires_at: renewDate.toISOString() });
          message.success(t('iam:member.renewed'));
          setRenewTarget(null);
          await load();
        }}
      >
        <DatePicker showTime style={{ width: '100%' }} value={renewDate} onChange={(d) => setRenewDate(d)} />
      </Modal>
      {canManage && (
        <div style={{ marginTop: 24 }}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            {t('iam:audit.title')}
          </Typography.Title>
          <Table
            rowKey="id"
            size="small"
            pagination={{ pageSize: 10, showSizeChanger: false }}
            dataSource={audits}
            columns={[
              { title: t('auth:users.auditColTime'), dataIndex: 'created_at', minWidth: 170, render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
              { title: t('auth:users.auditColAction'), dataIndex: 'action', minWidth: 220, ellipsis: { showTitle: true }, render: auditLabel },
              { title: t('auth:users.auditColOperator'), dataIndex: 'operator', minWidth: 160, ellipsis: { showTitle: true } },
              {
                title: t('auth:users.auditColDetail'),
                dataIndex: 'detail',
                render: (v: Record<string, unknown>) => (
                  <Typography.Text code style={{ fontSize: 12 }}>
                    {JSON.stringify(v)}
                  </Typography.Text>
                ),
              },
            ]}
          />
        </div>
      )}
      <SubjectDashboardGrantModal
        open={Boolean(grantSubject)}
        subjectType="user"
        subjectId={grantSubject?.id ?? ''}
        subjectName={grantSubject?.name ?? ''}
        onClose={() => setGrantSubject(null)}
      />
    </Card>
  );
}
