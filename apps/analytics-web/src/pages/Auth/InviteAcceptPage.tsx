import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, Form, Input, Result, Typography, message } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { BrandLogo } from '../../components/BrandLogo';
import { acceptInvite, getInviteInfo, registerViaInvite, type InviteInfo } from '../../services/auth.service';
import { useAuthStore } from '../../stores/auth.store';
import { useT } from '../../i18n';
import { LocaleSelect } from '../../i18n/LocaleSelect';

/**
 * 邀请接受页（account-lifecycle-v2，AM-5/7）三态：
 * - 已登录且邮箱匹配 → 一键接受
 * - 已登录但邮箱不匹配 → 只读提示 + 换账号出口
 * - 未登录 → 注册表单（邮箱只读），落地建号即入会
 */
export function InviteAcceptPage() {
  const { t } = useT('auth');
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getInviteInfo(token).then(setInfo).catch(() => setInvalid(true));
  }, [token]);

  const emailMatched = Boolean(user?.email && info && user.email.toLowerCase() === info.email.toLowerCase());

  const handleAccept = useCallback(async () => {
    setLoading(true);
    try {
      await acceptInvite(token);
      setAccepted(true);
      message.success(t('auth:invite.accepted'));
    } catch (e) {
      if ((e as { errorCode?: string }).errorCode === 'auth.tokenLink.invalid') setInvalid(true);
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  const handleRegister = async (values: { username: string; display_name?: string; password: string }) => {
    setLoading(true);
    try {
      await registerViaInvite(token, {
        username: values.username.trim(),
        display_name: values.display_name?.trim() || undefined,
        password: values.password,
      });
      setRegistered(true);
    } catch (e) {
      if ((e as { errorCode?: string }).errorCode === 'auth.tokenLink.invalid') setInvalid(true);
    } finally {
      setLoading(false);
    }
  };

  const switchAccount = () => {
    clearAuth();
    navigate('/login', { replace: true });
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
      <Card style={{ width: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <BrandLogo variant="full" size={28} />
          <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 13, marginTop: 8 }}>{t('auth:invite.subtitle')}</div>
        </div>
        {invalid ? (
          <Result
            status="warning"
            title={t('auth:invite.invalid')}
            extra={
              <Link to="/login">
                <Button type="primary">{t('auth:invite.goLogin')}</Button>
              </Link>
            }
          />
        ) : !info ? null : registered ? (
          <Result
            status="success"
            title={t('auth:invite.registerDone')}
            subTitle={t('auth:invite.registerDoneHint', { project: info.project_name })}
            extra={
              <Button type="primary" onClick={() => navigate('/login', { replace: true })}>
                {t('auth:invite.goLogin')}
              </Button>
            }
          />
        ) : accepted ? (
          <Result
            status="success"
            title={t('auth:invite.accepted')}
            subTitle={t('auth:invite.acceptedHint', { project: info.project_name })}
            extra={
              <Button type="primary" onClick={() => navigate('/', { replace: true })}>
                {t('auth:invite.enter')}
              </Button>
            }
          />
        ) : user ? (
          emailMatched ? (
            <>
              <Typography.Paragraph>
                {t('auth:invite.summary', { project: info.project_name, role: t(`auth:invite.roles.${info.role_key}`), email: info.email })}
              </Typography.Paragraph>
              <Button type="primary" block loading={loading} onClick={() => void handleAccept()}>
                {t('auth:invite.accept')}
              </Button>
            </>
          ) : (
            <Result
              status="info"
              title={t('auth:invite.mismatchTitle')}
              subTitle={t('auth:invite.mismatchHint', { current: user.email ?? user.username, expected: info.email })}
              extra={
                <Button type="primary" onClick={switchAccount}>
                  {t('auth:invite.switchAccount')}
                </Button>
              }
            />
          )
        ) : (
          <Form onFinish={handleRegister} size="large" layout="vertical">
            <Typography.Paragraph>
              {t('auth:invite.summary', { project: info.project_name, role: t(`auth:invite.roles.${info.role_key}`), email: info.email })}
            </Typography.Paragraph>
            <Form.Item label={t('auth:invite.email')}>
              <Input value={info.email} disabled />
            </Form.Item>
            <Form.Item
              name="username"
              label={t('auth:login.username')}
              rules={[{ required: true, message: t('auth:login.usernameRequired') }]}
            >
              <Input prefix={<UserOutlined />} autoComplete="off" />
            </Form.Item>
            <Form.Item name="display_name" label={t('auth:profile.displayName')}>
              <Input />
            </Form.Item>
            <Form.Item
              name="password"
              label={t('auth:profile.newPassword')}
              rules={[
                { required: true, message: t('auth:profile.newPasswordRequired') },
                { min: 8, message: t('auth:profile.newPasswordMin') },
              ]}
            >
              <Input.Password prefix={<LockOutlined />} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading}>
                {t('auth:invite.registerAndJoin')}
              </Button>
            </Form.Item>
          </Form>
        )}
      </Card>
      <div style={{ position: 'fixed', right: 16, bottom: 16 }}>
        <LocaleSelect compact />
      </div>
    </div>
  );
}
