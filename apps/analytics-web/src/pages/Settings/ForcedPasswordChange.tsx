import { useState } from 'react';
import { Button, Card, Form, Input, Typography, message } from 'antd';
import { LockOutlined, LogoutOutlined } from '@ant-design/icons';
import { useAuthStore } from '../../stores/auth.store';
import { changePassword } from '../../services/auth.service';
import { useT } from '../../i18n';

/**
 * 强制首登改密（phase: clklog-analytics-account-lifecycle-v1）：
 * `must_change_password=true` 时替换内容区，只有改密（复用 PUT /auth/password）
 * 与退出登录两条出路；改密成功清除标记并放行。
 */
export function ForcedPasswordChange({ onLogout }: { onLogout: () => void }) {
  const { t } = useT('auth');
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await changePassword({ old_password: values.old_password, new_password: values.new_password });
      if (user) setUser({ ...user, must_change_password: false });
      message.success(t('auth:profile.passwordChanged'));
    } catch {
      // 错误已由拦截器提示
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 64 }}>
      <Card style={{ maxWidth: 440, width: '100%' }}>
        <Typography.Title level={4}>
          <LockOutlined /> {t('auth:forceChange.title')}
        </Typography.Title>
        <Typography.Paragraph type="secondary">{t('auth:forceChange.desc')}</Typography.Paragraph>
        <Form form={form} layout="vertical">
          <Form.Item
            name="old_password"
            label={t('auth:profile.oldPassword')}
            rules={[{ required: true, message: t('auth:profile.oldPasswordRequired') }]}
          >
            <Input.Password autoFocus />
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
                  if (!value || getFieldValue('new_password') === value) return Promise.resolve();
                  return Promise.reject(new Error(t('auth:profile.passwordMismatch')));
                },
              }),
            ]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item>
            <Button type="primary" block loading={saving} onClick={() => void handleSubmit()}>
              {t('auth:forceChange.submit')}
            </Button>
            <Button block icon={<LogoutOutlined />} style={{ marginTop: 8 }} onClick={onLogout}>
              {t('common:action.logout')}
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
