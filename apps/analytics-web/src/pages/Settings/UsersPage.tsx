import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Drawer, Form, Input, Modal, Popconfirm, Radio, Select, Space, Switch, Table, Tabs, Tag, Typography, message } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  adminRevokeAllSessions,
  adminRevokeSession,
  createLoginUser,
  deleteUser,
  getMailStatus,
  listAuditLogs,
  listUserSessions,
  listUsers,
  resetUserPassword,
  setUserStatus,
  unlockUser,
  updateUser,
  type AuditLogItem,
  type SessionItem,
  type UserItem,
} from '../../services/auth.service';
import { useAuthStore } from '../../stores/auth.store';
import { addMember, createInvitation, getUserFootprint, seedIamDemo, type UserFootprint } from '../../services/iam.service';
import { listAccessibleProjects } from '../../services/iam.service';
import { useT } from '../../i18n';
import { MailConfigCard } from './MailConfigCard';
import { AUDIT_ACTION_KEYS } from '../../features/account/audit-actions';

const fmtTime = (iso: string | null) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '—');

/** 休眠口径（account-lifecycle-v3 PRD §5.3）：≥90 天未登录，或从未登录且创建 ≥90 天 */
function isDormant(u: UserItem): boolean {
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  if (u.last_login_at) return now - dayjs(u.last_login_at).valueOf() >= 90 * DAY;
  return now - dayjs(u.created_at).valueOf() >= 90 * DAY;
}


/**
 * 用户管理（ops.user.manage，phase: clklog-analytics-account-lifecycle-v1）：
 * 账号列表 + 创建/编辑/启停/解锁/重置密码/删除 + 账号审计查询。
 */
export function UsersPage() {
  const { t } = useT('auth');
  const me = useAuthStore((s) => s.user);
  const [rows, setRows] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserItem | null>(null);
  const [resetResult, setResetResult] = useState<{ username: string; temporary_password: string } | null>(null);
  const [sessionUser, setSessionUser] = useState<UserItem | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [footprint, setFootprint] = useState<UserFootprint | null>(null);
  const [projects, setProjects] = useState<{ name: string; display_name: string }[]>([]);
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoForm] = Form.useForm();
  const [audits, setAudits] = useState<AuditLogItem[]>([]);
  const [smtpOn, setSmtpOn] = useState(false);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listUsers());
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAudits = useCallback(async () => {
    setAudits(await listAuditLogs());
  }, []);

  useEffect(() => {
    void load();
    loadAudits().catch(() => setAudits([]));
    // SMTP 可用才显示「发送设密邮件」建号方式（AM-4；未配置降级为代设）
    getMailStatus().then((r) => setSmtpOn(r.smtp_configured)).catch(() => setSmtpOn(false));
    listAccessibleProjects().then((ps) => setProjects(ps.map((p) => ({ name: p.name, display_name: p.display_name })))).catch(() => setProjects([]));
  }, [load, loadAudits]);

  const afterMutation = async () => {
    await load();
    loadAudits().catch(() => undefined);
  };

  const handleCreate = async () => {
    const values = await createForm.validateFields();
    const byMail = smtpOn && values.create_mode === 'mail';
    // v3.2 UX-6：邀请式建号——不发账号，只发 7 天注册链接，受邀人自选用户名注册落地即入会
    if (smtpOn && values.create_mode === 'invite') {
      await createInvitation({
        email: values.email.trim().toLowerCase(),
        role_key: values.invite_role ?? 'analyst',
        project_name: values.invite_project,
      });
      message.success(t('iam:invite.sent'));
      setCreateOpen(false);
      createForm.resetFields();
      await afterMutation();
      return;
    }
    const created = await createLoginUser({
      username: values.username.trim(),
      password: byMail ? undefined : values.password,
      display_name: values.display_name?.trim() || undefined,
      email: values.email?.trim() || undefined,
      send_setup_email: byMail || undefined,
    });
    // v3.1 UX-2：可选「建号顺带入会」——两步合并，失败保留账号并提示补入
    if (values.assign_project && values.assign_role) {
      try {
        await addMember({ user_id: created.id, role_key: values.assign_role, project_name: values.assign_project });
      } catch {
        message.warning(t('auth:users.assignPartialFail'));
      }
    }
    message.success(byMail ? t('auth:users.setupMailSent') : t('auth:users.created'));
    setCreateOpen(false);
    createForm.resetFields();
    await afterMutation();
  };

  const handleDemoSeed = async () => {
    const values = await demoForm.validateFields();
    await seedIamDemo(values.password);
    message.success(t('iam:members.seedSuccess'));
    setDemoOpen(false);
    demoForm.resetFields();
    await afterMutation();
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    const values = await editForm.validateFields();
    await updateUser(editTarget.id, {
      display_name: values.display_name?.trim() || null,
      email: values.email?.trim() || null,
      platform_role: values.platform_role,
    });
    message.success(t('auth:users.updated'));
    setEditTarget(null);
    await afterMutation();
  };

  const handleToggleStatus = async (row: UserItem) => {
    await setUserStatus(row.id, row.status === 'active' ? 'disabled' : 'active');
    message.success(t('auth:users.statusChanged'));
    await afterMutation();
  };

  const handleReset = async (row: UserItem) => {
    const res = await resetUserPassword(row.id);
    setResetResult({ username: row.username, temporary_password: res.temporary_password });
    await afterMutation();
  };

  const handleDelete = async (row: UserItem) => {
    await deleteUser(row.id);
    message.success(t('auth:users.deleted'));
    await afterMutation();
  };

  const handleUnlock = async (row: UserItem) => {
    await unlockUser(row.id);
    message.success(t('auth:users.unlocked'));
    await afterMutation();
  };

  const openSessions = async (row: UserItem) => {
    setSessionUser(row);
    setFootprint(null);
    setSessionsLoading(true);
    try {
      setSessions(await listUserSessions(row.id));
    } finally {
      setSessionsLoading(false);
    }
    getUserFootprint(row.id).then(setFootprint).catch(() => setFootprint(null));
  };

  const reloadSessions = async () => {
    if (!sessionUser) return;
    setSessions(await listUserSessions(sessionUser.id));
  };

  const handleRevokeSession = async (sid: string) => {
    if (!sessionUser) return;
    await adminRevokeSession(sessionUser.id, sid);
    message.success(t('auth:users.sessionRevoked'));
    await reloadSessions();
  };

  const handleRevokeAll = async () => {
    if (!sessionUser) return;
    await adminRevokeAllSessions(sessionUser.id);
    message.success(t('auth:users.allSessionsRevoked'));
    await reloadSessions();
  };

  const auditActionLabel = (action: string) => {
    const mapped = AUDIT_ACTION_KEYS[action];
    if (!mapped) return action;
    const label = t(`auth:users.auditActions.${mapped}`);
    return label === `auth:users.auditActions.${mapped}` ? action : label;
  };

  const columns = [
    { title: t('auth:users.colUsername'), dataIndex: 'username', key: 'username' },
    {
      title: t('auth:users.colDisplayName'),
      dataIndex: 'display_name',
      key: 'display_name',
      render: (v: string | null) => v || '—',
    },
    { title: t('auth:users.colEmail'), dataIndex: 'email', key: 'email', render: (v: string | null) => v || '—' },
    {
      title: t('auth:users.colPlatformRole'),
      dataIndex: 'platform_role',
      key: 'platform_role',
      render: (v: string) =>
        v === 'super_admin' ? (
          <Tag color="gold">{t('auth:users.roleSuperAdmin')}</Tag>
        ) : (
          <Tag>{t('auth:users.roleNone')}</Tag>
        ),
    },
    {
      title: t('auth:users.colStatus'),
      dataIndex: 'status',
      key: 'status',
      render: (v: string, row: UserItem) => (
        <Space size={4}>
          {v === 'active' ? (
            <Tag color="green">{t('auth:users.statusActive')}</Tag>
          ) : (
            <Tag color="red">{t('auth:users.statusDisabled')}</Tag>
          )}
          {isDormant(row) ? <Tag color="orange">{t('auth:users.dormant')}</Tag> : null}
        </Space>
      ),
    },
    { title: t('auth:users.colLastLogin'), dataIndex: 'last_login_at', key: 'last_login_at', render: fmtTime },
    { title: t('auth:users.colCreatedBy'), dataIndex: 'created_by', key: 'created_by', render: (v: string | null) => v || '—' },
    {
      title: t('auth:users.colActions'),
      key: 'actions',
      render: (_: unknown, row: UserItem) => {
        const isSelf = row.id === me?.id;
        return (
          <Space size="small" wrap>
            <Button size="small" onClick={() => {
              setEditTarget(row);
              editForm.setFieldsValue({
                display_name: row.display_name ?? '',
                email: row.email ?? '',
                platform_role: row.platform_role,
              });
            }}>
              {t('auth:users.actionEdit')}
            </Button>
            <Button size="small" onClick={() => void handleUnlock(row)}>
              {t('auth:users.actionUnlock')}
            </Button>
            <Button size="small" onClick={() => void openSessions(row)}>
              {t('auth:users.actionSessions')}
            </Button>
            <Popconfirm
              title={t('auth:users.resetConfirmTitle')}
              description={t('auth:users.resetConfirmDesc')}
              onConfirm={() => void handleReset(row)}
              disabled={isSelf}
            >
              <Button size="small" disabled={isSelf}>
                {t('auth:users.actionResetPassword')}
              </Button>
            </Popconfirm>
            <Button size="small" danger={row.status === 'active'} disabled={isSelf} onClick={() => void handleToggleStatus(row)}>
              {row.status === 'active' ? t('auth:users.actionDisable') : t('auth:users.actionEnable')}
            </Button>
            <Popconfirm
              title={t('auth:users.deleteConfirmTitle')}
              description={t('auth:users.deleteConfirmDesc')}
              onConfirm={() => void handleDelete(row)}
              disabled={isSelf}
            >
              <Button size="small" danger disabled={isSelf}>
                {t('auth:users.actionDelete')}
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <MailConfigCard />
      <Card
        title={t('auth:users.title')}
        extra={
          <Space wrap>
            <Button onClick={() => setDemoOpen(true)}>{t('auth:users.actionDemoSeed')}</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              {t('auth:users.create')}
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">{t('auth:users.hint')}</Typography.Paragraph>
        <Table rowKey="id" loading={loading} columns={columns} dataSource={rows} pagination={false} size="small" />
      </Card>

      <Card
        title={t('auth:users.auditTitle')}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void loadAudits()}>
            {t('auth:users.auditRefresh')}
          </Button>
        }
      >
        <Table
          rowKey="id"
          size="small"
          dataSource={audits}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          columns={[
            { title: t('auth:users.auditColTime'), dataIndex: 'created_at', key: 'created_at', render: fmtTime, minWidth: 170 },
            { title: t('auth:users.auditColAction'), dataIndex: 'action', key: 'action', render: auditActionLabel, minWidth: 240, ellipsis: { showTitle: true } },
            { title: t('auth:users.auditColOperator'), dataIndex: 'operator', key: 'operator', minWidth: 170, ellipsis: { showTitle: true } },
            {
              title: t('auth:users.auditColDetail'),
              dataIndex: 'detail',
              key: 'detail',
              render: (v: Record<string, unknown>) => (
                <Typography.Text code style={{ fontSize: 12 }}>
                  {JSON.stringify(v)}
                </Typography.Text>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title={t('auth:users.sessionsTitle', { username: sessionUser?.username ?? '' })}
        open={!!sessionUser}
        onClose={() => setSessionUser(null)}
        width={520}
        extra={
          <Button danger size="small" disabled={sessions.length === 0 || sessionUser?.id === me?.id} onClick={() => void handleRevokeAll()}>
            {t('auth:users.revokeAll')}
          </Button>
        }
      >
        {sessionUser?.id === me?.id ? (
          <Typography.Paragraph type="secondary">{t('auth:users.selfSessionsHint')}</Typography.Paragraph>
        ) : null}
        <Tabs
          items={[
            {
              key: 'sessions',
              label: t('auth:footprint.tabSessions'),
              children: (
                <Table
                  rowKey="id"
                  size="small"
                  loading={sessionsLoading}
                  pagination={false}
                  dataSource={sessions}
                  columns={[
                    { title: t('auth:users.sessionsColCreated'), dataIndex: 'created_at', render: fmtTime },
                    { title: t('auth:users.sessionsColExpires'), dataIndex: 'expires_at', render: fmtTime },
                    {
                      title: t('auth:users.colActions'),
                      minWidth: 150,
                      render: (_: unknown, row: SessionItem) => (
                        <Button size="small" danger disabled={sessionUser?.id === me?.id} onClick={() => void handleRevokeSession(row.id)}>
                          {t('auth:users.revoke')}
                        </Button>
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: 'footprint',
              label: t('auth:footprint.tabFootprint'),
              children: !footprint ? (
                <Typography.Text type="secondary">{t('auth:footprint.noData')}</Typography.Text>
              ) : (
                <>
                  <Table<UserFootprint['memberships'][number]>
                    rowKey={(r) => `${r.project_name}-${r.role_key}`}
                    size="small"
                    pagination={false}
                    dataSource={footprint.memberships}
                    locale={{ emptyText: t('auth:footprint.noData') }}
                    columns={[
                      { title: t('auth:footprint.colProject'), dataIndex: 'project_name' },
                      { title: t('auth:footprint.colRole'), dataIndex: 'role_key', render: (v: string) => t(`iam:role.${v === 'project_owner' ? 'projectOwner' : v === 'analysis_admin' ? 'analysisAdmin' : v}`) },
                      {
                        title: t('auth:footprint.colExpiry'),
                        dataIndex: 'expires_at',
                        render: (v: string | null, row: { expired?: boolean }) =>
                          row.expired ? <Tag color="red">{t('iam:member.expiredTag')}</Tag> : v ? fmtTime(v) : t('iam:member.expiryPermanent'),
                      },
                    ]}
                  />
                  {footprint.groups.length > 0 && (
                    <>
                      <Typography.Title level={5} style={{ marginTop: 16 }}>{t('auth:footprint.groupsTitle')}</Typography.Title>
                      <Table<UserFootprint['groups'][number]>
                        rowKey={(r) => `${r.project_name}-${r.group_name}`}
                        size="small"
                        pagination={false}
                        dataSource={footprint.groups}
                        columns={[
                          { title: t('auth:footprint.colProject'), dataIndex: 'project_name' },
                          { title: t('auth:footprint.colGroup'), dataIndex: 'group_name' },
                          { title: t('auth:footprint.colRole'), dataIndex: 'role_key', render: (v: string) => t(`iam:role.${v === 'analysis_admin' ? 'analysisAdmin' : v}`) },
                        ]}
                      />
                    </>
                  )}
                </>
              ),
            },
          ]}
        />
      </Drawer>

      <Modal
        title={t('iam:members.seed')}
        open={demoOpen}
        onCancel={() => setDemoOpen(false)}
        onOk={() => void handleDemoSeed()}
        destroyOnClose
      >
        <p>{t('iam:members.seedHint')}</p>
        <Form form={demoForm} layout="vertical">
          <Form.Item
            name="password"
            label={t('iam:members.demoPassword')}
            rules={[{ required: true }, { min: 8, message: t('auth:profile.newPasswordMin') }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('auth:users.createTitle')}
        open={createOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" initialValues={{ create_mode: 'mail', assign_enabled: false, assign_project: undefined, assign_role: 'analyst' }}>
          {smtpOn && (
            <Form.Item name="create_mode" label={t('auth:users.createMode')}>
              <Radio.Group
                options={[
                  { value: 'mail', label: t('auth:users.modeMail') },
                  { value: 'invite', label: t('auth:users.modeInvite') },
                  { value: 'manual', label: t('auth:users.modeManual') },
                ]}
              />
            </Form.Item>
          )}
          <Form.Item noStyle shouldUpdate={(a, b) => a.create_mode !== b.create_mode}>
            {() => {
              const mode = createForm.getFieldValue('create_mode');
              const byMail = smtpOn && mode === 'mail';
              const byInvite = smtpOn && mode === 'invite';
              return (
                <>
                  {!byInvite && (
                    <>
                      <Form.Item
                        name="username"
                        label={t('auth:users.fieldUsername')}
                        rules={[{ required: !byInvite, message: t('auth:users.usernameRequired') }]}
                      >
                        <Input autoComplete="off" />
                      </Form.Item>
                      <Form.Item name="display_name" label={t('auth:users.fieldDisplayName')}>
                        <Input />
                      </Form.Item>
                    </>
                  )}
                  <Form.Item
                    name="email"
                    label={t('auth:users.fieldEmail')}
                    rules={[
                      ...(byMail || byInvite ? [{ required: true, message: t('auth:users.emailRequired') }] : []),
                      { type: 'email', message: t('auth:users.emailInvalid') },
                    ]}
                  >
                    <Input placeholder={t('auth:users.emailOptional')} />
                  </Form.Item>
                  {!byMail && !byInvite && (
                    <Form.Item
                      name="password"
                      label={t('auth:users.fieldPassword')}
                      extra={t('auth:users.passwordHint')}
                      rules={[
                        { required: true, message: t('auth:users.passwordRequired') },
                        { min: 8, message: t('auth:profile.newPasswordMin') },
                      ]}
                    >
                      <Input.Password autoComplete="new-password" />
                    </Form.Item>
                  )}
                  {byMail && <Typography.Paragraph type="secondary">{t('auth:users.modeMailHint')}</Typography.Paragraph>}
                  {byInvite && (
                    <>
                      <Typography.Paragraph type="secondary">{t('auth:users.modeInviteHint')}</Typography.Paragraph>
                      <Form.Item name="invite_project" label={t('auth:footprint.colProject')} rules={[{ required: true, message: t('auth:users.assignHint') }]}>
                        <Select
                          options={projects.map((p) => ({ value: p.name, label: p.display_name ? `${p.display_name} (${p.name})` : p.name }))}
                        />
                      </Form.Item>
                      <Form.Item name="invite_role" label={t('auth:footprint.colRole')}>
                        <Select
                          options={[
                            { value: 'analysis_admin', label: t('iam:role.analysisAdmin') },
                            { value: 'analyst', label: t('iam:role.analyst') },
                            { value: 'member', label: t('iam:role.member') },
                            { value: 'external', label: t('iam:role.external') },
                          ]}
                        />
                      </Form.Item>
                    </>
                  )}
                </>
              );
            }}
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.create_mode !== b.create_mode}>
            {() =>
              createForm.getFieldValue('create_mode') !== 'invite' ? (
                <Form.Item name="assign_enabled" label={t('auth:users.assignProject')} valuePropName="checked" extra={t('auth:users.assignHint')}>
                  <Switch />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.assign_enabled !== b.assign_enabled || a.create_mode !== b.create_mode}>
            {() =>
              createForm.getFieldValue('assign_enabled') && createForm.getFieldValue('create_mode') !== 'invite' ? (
                <>
                  <Form.Item name="assign_project" label={t('auth:footprint.colProject')} rules={[{ required: true, message: t('auth:users.assignHint') }]}>
                    <Select
                      options={projects.map((p) => ({ value: p.name, label: p.display_name ? `${p.display_name} (${p.name})` : p.name }))}
                    />
                  </Form.Item>
                  <Form.Item name="assign_role" label={t('auth:footprint.colRole')}>
                    <Select
                      options={[
                        { value: 'analysis_admin', label: t('iam:role.analysisAdmin') },
                        { value: 'analyst', label: t('iam:role.analyst') },
                        { value: 'member', label: t('iam:role.member') },
                        { value: 'external', label: t('iam:role.external') },
                      ]}
                    />
                  </Form.Item>
                </>
              ) : null
            }
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('auth:users.editTitle')}
        open={!!editTarget}
        onOk={() => void handleEdit()}
        onCancel={() => setEditTarget(null)}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="display_name" label={t('auth:users.fieldDisplayName')}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label={t('auth:users.fieldEmail')} rules={[{ type: 'email', message: t('auth:users.emailInvalid') }]}>
            <Input placeholder={t('auth:users.emailOptional')} />
          </Form.Item>
          <Form.Item
            name="platform_role"
            label={t('auth:users.colPlatformRole')}
            extra={editTarget?.id === me?.id ? t('auth:users.selfRoleHint') : undefined}
          >
            <Select
              disabled={editTarget?.id === me?.id}
              options={[
                { value: 'none', label: t('auth:users.roleNone') },
                { value: 'super_admin', label: t('auth:users.roleSuperAdmin') },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('auth:users.resetResultTitle')}
        open={!!resetResult}
        footer={
          <Button type="primary" onClick={() => setResetResult(null)}>
            {t('common:action.confirm')}
          </Button>
        }
        onCancel={() => setResetResult(null)}
      >
        <Typography.Paragraph>{t('auth:users.resetResultDesc', { username: resetResult?.username })}</Typography.Paragraph>
        <Typography.Paragraph copyable={{ text: resetResult?.temporary_password }}>
          <Typography.Text strong code style={{ fontSize: 16 }}>
            {resetResult?.temporary_password}
          </Typography.Text>
        </Typography.Paragraph>
        <Typography.Paragraph type="warning">{t('auth:users.resetResultHint')}</Typography.Paragraph>
      </Modal>
    </div>
  );
}
