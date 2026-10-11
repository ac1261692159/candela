import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Card, Form, Input, Result, Typography } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { BrandLogo } from '../../components/BrandLogo';
import { resetPasswordByToken } from '../../services/auth.service';
import { useT } from '../../i18n';
import { LocaleSelect } from '../../i18n/LocaleSelect';

/**
 * 重置 / 设密页（account-lifecycle-v2，AM-1/AM-4）：
 * 忘记密码与建号设密共用；token 来自邮件链接 query。
 */
export function ResetPasswordPage() {
  const { t } = useT('auth');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const handleSubmit = async (values: { new_password: string }) => {
    if (!token) return;
    setLoading(true);
    try {
      await resetPasswordByToken(token, values.new_password);
      setDone(true);
    } catch (e) {
      // tokenLink.invalid 等：表单下方给出重发入口，其余错误拦截器已提示
      if ((e as { errorCode?: string }).errorCode === 'auth.tokenLink.invalid') {
        setLinkError('invalid');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
      <Card style={{ width: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <BrandLogo variant="full" size={28} />
          <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 13, marginTop: 8 }}>{t('auth:reset.subtitle')}</div>
        </div>
        {done ? (
          <Result
            status="success"
            title={t('auth:reset.done')}
            extra={
              <Button type="primary" onClick={() => navigate('/login', { replace: true })}>
                {t('auth:reset.goLogin')}
              </Button>
            }
          />
        ) : linkError ? (
          <Result
            status="warning"
            title={t('auth:reset.invalid')}
            extra={
              <Link to="/forgot-password">
                <Button type="primary">{t('auth:reset.retry')}</Button>
              </Link>
            }
          />
        ) : (
          <Form onFinish={handleSubmit} size="large" layout="vertical">
            {!token && <Typography.Paragraph type="warning">{t('auth:reset.missingToken')}</Typography.Paragraph>}
            <Form.Item
              name="new_password"
              label={t('auth:profile.newPassword')}
              rules={[
                { required: true, message: t('auth:profile.newPasswordRequired') },
                { min: 8, message: t('auth:profile.newPasswordMin') },
              ]}
            >
              <Input.Password prefix={<LockOutlined />} />
            </Form.Item>
            <Form.Item
              name="confirm_password"
              label={t('auth:profile.confirmPassword')}
              dependencies={['new_password']}
              rules={[
                { required: true, message: t('auth:profile.confirmPasswordRequired') },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('new_password') === value) return Promise.resolve();
                    return Promise.reject(new Error(t('auth:profile.passwordMismatch')));
                  },
                }),
              ]}
            >
              <Input.Password prefix={<LockOutlined />} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading} disabled={!token}>
                {t('auth:reset.submit')}
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
