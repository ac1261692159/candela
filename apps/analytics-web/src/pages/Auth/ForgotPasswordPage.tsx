import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Form, Input, Typography } from 'antd';
import { MailOutlined } from '@ant-design/icons';
import { BrandLogo } from '../../components/BrandLogo';
import { forgotPassword } from '../../services/auth.service';
import { useT } from '../../i18n';
import { LocaleSelect } from '../../i18n/LocaleSelect';

/**
 * 忘记密码（account-lifecycle-v2 AM-2）：无论账号是否存在，统一提示。
 */
export function ForgotPasswordPage() {
  const { t } = useT('auth');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (values: { identifier: string }) => {
    setLoading(true);
    try {
      await forgotPassword(values.identifier.trim());
      setSubmitted(true);
    } catch {
      // 限流等错误已由拦截器提示；保留表单可重试
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
      <Card style={{ width: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <BrandLogo variant="full" size={28} />
          <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 13, marginTop: 8 }}>{t('auth:forgot.subtitle')}</div>
        </div>
        {submitted ? (
          <>
            <Typography.Paragraph>{t('auth:forgot.sentHint')}</Typography.Paragraph>
            <Link to="/login">
              <Button block>{t('auth:forgot.backToLogin')}</Button>
            </Link>
          </>
        ) : (
          <Form onFinish={handleSubmit} size="large" layout="vertical">
            <Form.Item
              name="identifier"
              label={t('auth:forgot.identifier')}
              rules={[{ required: true, message: t('auth:forgot.identifierRequired') }]}
            >
              <Input prefix={<MailOutlined />} placeholder={t('auth:forgot.identifierPlaceholder')} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading}>
                {t('auth:forgot.submit')}
              </Button>
            </Form.Item>
            <div style={{ textAlign: 'center' }}>
              <Link to="/login">{t('auth:forgot.backToLogin')}</Link>
            </div>
          </Form>
        )}
      </Card>
      <div style={{ position: 'fixed', right: 16, bottom: 16 }}>
        <LocaleSelect compact />
      </div>
    </div>
  );
}
