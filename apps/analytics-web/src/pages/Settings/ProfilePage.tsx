import { useEffect, useState } from 'react';
import { Button, Card, Form, Input, Select, Table, Tag, Typography, message } from 'antd';
import { LogoutOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useAuthStore } from '../../stores/auth.store';
import { useProjectStore } from '../../stores/project.store';
import { logout, updatePreferences, updateProfile, changePassword, listMySessions, revokeMySession, revokeOtherSessions, type SessionItem } from '../../services/auth.service';
import { ANALYTICS_LOGIN_HREF } from '../../services/login-path';
import { useT } from '../../i18n';
import { LocaleSelect } from '../../i18n/LocaleSelect';
import { TimeZoneSelect } from '../../features/time-range/TimeZoneSelect';
import { setUserTimeZone } from '../../features/time-range/resolve';

/**
 * 个人设置：默认项目 + 修改密码 + 退出登录。
 */
export function ProfilePage() {
  const { t } = useT('auth');
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const projects = useProjectStore((s) => s.projects);
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  const [prefForm] = Form.useForm();
  const [tzForm] = Form.useForm();
  const [pwdForm] = Form.useForm();
  const [basicForm] = Form.useForm();
  const [savingPref, setSavingPref] = useState(false);
  const [savingPwd, setSavingPwd] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  // 修改密码表单默认收起，点击按钮才展开（避免高频误触）
  const [pwdOpen, setPwdOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionItem[]>([]);

  useEffect(() => {
    listMySessions().then(setSessions).catch(() => setSessions([]));
  }, []);

  const fmtTime = (iso: string | null) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '—');

  const handleRevoke = async (id: string) => {
    await revokeMySession(id);
    message.success(t('auth:profile.sessionRevoked'));
    setSessions(await listMySessions());
  };

  const handleRevokeOthers = async () => {
    const res = await revokeOtherSessions();
    message.success(t('auth:profile.sessionsRevokedOthers', { count: res.revoked }));
    setSessions(await listMySessions());
  };

  /** 基本资料（account-lifecycle-v1）：显示名 + 邮箱 */
  const handleSaveBasic = async () => {
    const values = await basicForm.validateFields();
    setSavingPref(true);
    try {
      const res = await updateProfile({
        display_name: values.display_name?.trim() || undefined,
        email: values.email?.trim() || null,
      });
      if (user) setUser({ ...user, display_name: res.display_name, email: res.email });
      message.success(t('auth:profile.saved'));
    } catch {
      // 错误已由拦截器提示
    } finally {
      setSavingPref(false);
    }
  };

  const handleSavePreference = async () => {
    const values = await prefForm.validateFields();
    setSavingPref(true);
    try {
      await updatePreferences({ default_project: values.default_project || null });
      // 立即生效：更新当前项目 + 本地用户信息
      if (values.default_project) setCurrentProject(values.default_project);
      if (user) setUser({ ...user, default_project: values.default_project });
      message.success(t('auth:profile.defaultProjectSaved'));
    } catch {
      // 错误已由拦截器提示
    } finally {
      setSavingPref(false);
    }
  };

  /** 显示时区（timezone-v2）：空 = 跟随项目/平台；保存后即时换算展示 */
  const handleSaveTimezone = async () => {
    const values = await tzForm.validateFields();
    setSavingPref(true);
    try {
      await updatePreferences({ timezone: values.timezone || null });
      setUserTimeZone(values.timezone || null);
      if (user) setUser({ ...user, timezone: values.timezone || null });
      message.success(t('auth:profile.saved'));
    } catch {
      // 错误已由拦截器提示
    } finally {
      setSavingPref(false);
    }
  };

  const handleChangePassword = async () => {
    const values = await pwdForm.validateFields();
    setSavingPwd(true);
    try {
      await changePassword({ old_password: values.old_password, new_password: values.new_password });
      pwdForm.resetFields();
      message.success(t('auth:profile.passwordChanged'));
    } catch {
      // 错误已由拦截器提示
    } finally {
      setSavingPwd(false);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      // 即使接口失败也清除本地登录态
    } finally {
      clearAuth();
      window.location.assign(ANALYTICS_LOGIN_HREF);
    }
  };

  return (
    <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Card title={t('auth:profile.title')}>
        <Typography.Paragraph type="secondary">
          {t('auth:profile.currentUser')}
          <Typography.Text strong>{user?.display_name || user?.username}</Typography.Text>
          （{user?.username}，{user?.platform_role === 'super_admin' ? t('auth:profile.platformAdmin') : t('auth:profile.loginAccount')}）
        </Typography.Paragraph>
      </Card>

      <Card title={t('auth:profile.basic')}>
        <Typography.Paragraph type="secondary">{t('auth:profile.basicHint')}</Typography.Paragraph>
        <Form
          form={basicForm}
          layout="vertical"
          style={{ maxWidth: 360 }}
          initialValues={{ display_name: user?.display_name ?? '', email: user?.email ?? '' }}
        >
          <Form.Item name="display_name" label={t('auth:profile.displayName')}>
            <Input />
          </Form.Item>
          <Form.Item
            name="email"
            label={t('auth:profile.email')}
            rules={[{ type: 'email', message: t('auth:profile.emailInvalid') }]}
          >
            <Input placeholder={t('auth:profile.emailPlaceholder')} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" loading={savingPref} onClick={handleSaveBasic}>
              {t('common:action.save')}
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title={t('auth:profile.language')}>
        <Typography.Paragraph type="secondary">{t('auth:profile.languageHint')}</Typography.Paragraph>
        <LocaleSelect
          onChange={async (tag) => {
            await updatePreferences({ locale: tag });
          }}
        />
      </Card>

      <Card title={t('auth:profile.defaultProjectCard')}>
        <Typography.Paragraph type="secondary">
          {t('auth:profile.defaultProjectHint')}
        </Typography.Paragraph>
        <Form
          form={prefForm}
          layout="inline"
          initialValues={{ default_project: user?.default_project || undefined }}
        >
          <Form.Item name="default_project" label={t('auth:profile.defaultProject')} style={{ minWidth: 240 }}>
            <Select
              allowClear
              placeholder={t('auth:profile.defaultProjectPlaceholder')}
              options={projects.map((p) => ({ label: p.display_name || p.name, value: p.name }))}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" loading={savingPref} onClick={handleSavePreference}>
              {t('common:action.save')}
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title={t('auth:profile.timezone')}>
        <Typography.Paragraph type="secondary">{t('auth:profile.timezoneHint')}</Typography.Paragraph>
        <Form form={tzForm} layout="inline">
          <Form.Item name="timezone" label={t('auth:profile.timezone')}>
            <TimeZoneSelect
              followLabel={t('auth:profile.timezoneFollow')}
              ariaLabel={t('auth:profile.timezone')}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" loading={savingPref} onClick={handleSaveTimezone}>
              {t('common:action.save')}
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card
        title={t('auth:profile.changePassword')}
        extra={
          <Button
            size="small"
            type={pwdOpen ? 'default' : 'primary'}
            onClick={() => {
              setPwdOpen((v) => !v);
              if (pwdOpen) pwdForm.resetFields();
            }}
          >
            {pwdOpen ? t('common:action.collapse') : t('auth:profile.changePassword')}
          </Button>
        }
      >
        {pwdOpen && (
          <>
            <Typography.Paragraph type="secondary">
              {t('auth:profile.changePasswordHint')}
            </Typography.Paragraph>
            <Form form={pwdForm} layout="vertical" style={{ maxWidth: 360 }}>
              <Form.Item
                name="old_password"
                label={t('auth:profile.oldPassword')}
                rules={[{ required: true, message: t('auth:profile.oldPasswordRequired') }]}
              >
                <Input.Password />
              </Form.Item>
              <Form.Item
                name="new_password"
                label={t('auth:profile.newPassword')}
                rules={[
                  { required: true, message: t('auth:profile.newPasswordRequired') },
                  { min: 8, message: t('auth:profile.newPasswordMin') },
                ]}
              >
                <Input.Password />
              </Form.Item>
              <Form.Item
                name="confirm_password"
                label={t('auth:profile.confirmPassword')}
                dependencies={['new_password']}
                rules={[
                  { required: true, message: t('auth:profile.confirmPasswordRequired') },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('new_password') === value) {
                        return Promise.resolve();
                      }
                      return Promise.reject(new Error(t('auth:profile.passwordMismatch')));
                    },
                  }),
                ]}
              >
                <Input.Password />
              </Form.Item>
              <Button
                type="primary"
                loading={savingPwd}
                onClick={async () => {
                  await handleChangePassword();
                  setPwdOpen(false);
                }}
              >
                {t('auth:profile.confirmChange')}
              </Button>
            </Form>
          </>
        )}
        {!pwdOpen && (
          <Typography.Paragraph type="secondary">
            {t('auth:profile.changePasswordHintCollapsed')}
          </Typography.Paragraph>
        )}
      </Card>

      <Card
        title={t('auth:profile.devices')}
        extra={
          <Button size="small" onClick={() => void handleRevokeOthers()} disabled={sessions.filter((s) => !s.current).length === 0}>
            {t('auth:profile.revokeOthers')}
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">{t('auth:profile.devicesHint')}</Typography.Paragraph>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={sessions}
          columns={[
            {
              title: t('auth:profile.deviceColSession'),
              render: (_, row) => (row.current ? <Tag color="green">{t('auth:profile.currentDevice')}</Tag> : <Tag>{t('auth:profile.otherDevice')}</Tag>),
              minWidth: 170,
            },
            { title: t('auth:profile.deviceColCreated'), dataIndex: 'created_at', render: fmtTime },
            { title: t('auth:profile.deviceColExpires'), dataIndex: 'expires_at', render: fmtTime },
            {
              title: t('common:label.actions'),
              minWidth: 130,
              render: (_, row) =>
                row.current ? null : (
                  <Button size="small" danger onClick={() => void handleRevoke(row.id)}>
                    {t('auth:profile.revoke')}
                  </Button>
                ),
            },
          ]}
        />
      </Card>

      <Card title={t('auth:profile.account')}>
        <Button danger icon={<LogoutOutlined />} loading={loggingOut} onClick={handleLogout}>
          {t('common:action.logout')}
        </Button>
      </Card>
    </div>
  );
}
