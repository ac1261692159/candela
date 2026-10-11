import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, Form, Input, message } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { BrandLogo } from '../components/BrandLogo';
import { login } from '../services/auth.service';
import { useAuthStore } from '../stores/auth.store';
import { useProjectStore } from '../stores/project.store';
import { applyUserLocale, useT } from '../i18n';
import { LocaleSelect } from '../i18n/LocaleSelect';
import { setPlatformTimeZone, setUserTimeZone } from '../features/time-range/resolve';

export function LoginPage() {
  const { t } = useT('auth');
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const setAuth = useAuthStore((s) => s.setAuth);
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  const handleSubmit = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await login(values.username, values.password);
      setAuth(res.token, res.user);
      // 实例级平台时区（分析默认日历基调）
      setPlatformTimeZone(res.user.platform_timezone);
      // 用户显示时区偏好（timezone-v2；null 跟随项目/平台）
      setUserTimeZone(res.user.timezone);
      // 应用用户默认项目与语言偏好
      if (res.user.default_project) {
        setCurrentProject(res.user.default_project);
      }
      await applyUserLocale(res.user.locale);
      message.success(t('auth:login.success'));
      navigate('/', { replace: true });
    } catch {
      // 错误已由拦截器提示
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f5f5f5',
      }}
    >
      <Card style={{ width: 360 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <BrandLogo variant="full" size={28} />
          <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 13, marginTop: 8 }}>{t('auth:login.subtitle')}</div>
        </div>
        <Form onFinish={handleSubmit} size="large">
          <Form.Item name="username" rules={[{ required: true, message: t('auth:login.usernameRequired') }]}>
            <Input prefix={<UserOutlined />} placeholder={t('auth:login.username')} />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: t('auth:login.passwordRequired') }]}>
            <Input.Password prefix={<LockOutlined />} placeholder={t('auth:login.password')} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              {t('auth:login.submit')}
            </Button>
          </Form.Item>
          <div style={{ textAlign: 'center' }}>
            <Link to="/forgot-password">{t('auth:login.forgotPassword')}</Link>
          </div>
        </Form>
      </Card>
      <div style={{ position: 'fixed', right: 16, bottom: 16 }}>
        <LocaleSelect compact />
      </div>
    </div>
  );
}
