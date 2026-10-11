import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Form, Input, InputNumber, Modal, Space, Switch, Tag, Typography, message } from 'antd';
import { MailOutlined } from '@ant-design/icons';
import { getMailConfig, saveMailConfig, testMailConfig, type MailConfigView } from '../../services/auth.service';
import { useT } from '../../i18n';

/**
 * 账号域 SMTP 网页配置（phase: clklog-analytics-account-lifecycle-v2 增补 v1.1）。
 * 密码只写不读（has_password 标记）；保存后 60 秒内全站热生效。
 */
export function MailConfigCard() {
  const { t } = useT('auth');
  const [view, setView] = useState<MailConfigView | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [form] = Form.useForm();
  const [testForm] = Form.useForm();

  const load = useCallback(async () => {
    const v = await getMailConfig();
    setView(v);
    form.setFieldsValue({
      enabled: v.enabled,
      host: v.host,
      port: v.port,
      secure: v.secure,
      user: v.user,
      from: v.from,
      pass: '',
    });
  }, [form]);

  useEffect(() => {
    load().catch(() => setView(null));
  }, [load]);

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const result = await saveMailConfig({
        enabled: values.enabled ?? false,
        host: values.host ?? '',
        port: values.port || undefined,
        secure: values.secure ?? true,
        user: values.user?.trim(),
        from: values.from?.trim(),
        pass: values.pass || undefined,
      });
      setView(result);
      message.success(t('auth:mailConfig.saved'));
      setOpen(false);
    } catch {
      // 错误已由拦截器提示
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const values = await testForm.validateFields();
    setTesting(true);
    try {
      await testMailConfig(values.to?.trim() || undefined);
      message.success(t('auth:mailConfig.testSent'));
    } catch {
      // 错误已由拦截器提示
    } finally {
      setTesting(false);
    }
  };

  const statusTag = (() => {
    if (!view || view.source === 'none') return <Tag>{t('auth:mailConfig.statusNone')}</Tag>;
    const enabled = <Tag color="green">{t('auth:mailConfig.statusEnabled')}</Tag>;
    return (
      <>
        {enabled}
        {view.source === 'db' ? (
          <Tag color="blue">{t('auth:mailConfig.sourceDb')}</Tag>
        ) : (
          <Tag>{t('auth:mailConfig.sourceEnv')}</Tag>
        )}
      </>
    );
  })();

  return (
    <Card
      title={
        <>
          <MailOutlined /> {t('auth:mailConfig.title')}
        </>
      }
      extra={
        <Space wrap>
          {statusTag}
          <Button type="primary" size="small" onClick={() => setOpen(true)}>
            {t('auth:mailConfig.configure')}
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {t('auth:mailConfig.hint')}
      </Typography.Paragraph>
      {view?.stored && view.updated_by ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {t('auth:mailConfig.updatedBy', { operator: view.updated_by, at: view.updated_at })}
        </Typography.Paragraph>
      ) : null}
      <Form form={testForm} layout="inline" onFinish={() => void handleTest()}>
        <Form.Item name="to" style={{ marginBottom: 0 }}>
          <Input placeholder={t('auth:mailConfig.testPlaceholder')} style={{ width: 280 }} />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Button htmlType="submit" loading={testing} disabled={!view || view.source === 'none'}>
            {t('auth:mailConfig.sendTest')}
          </Button>
        </Form.Item>
      </Form>

      <Modal
        title={t('auth:mailConfig.title')}
        open={open}
        onOk={() => void handleSave()}
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="enabled" label={t('auth:mailConfig.enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            name="host"
            label={t('auth:mailConfig.host')}
            rules={[{ required: true, message: t('auth:mailConfig.hostRequired') }]}
          >
            <Input placeholder="smtp.example.com" />
          </Form.Item>
          <Space size="large" wrap>
            <Form.Item name="port" label={t('auth:mailConfig.port')}>
              <InputNumber min={1} max={65535} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="secure" label={t('auth:mailConfig.secure')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="user" label={t('auth:mailConfig.user')}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="pass"
            label={t('auth:mailConfig.pass')}
            extra={view?.has_password ? t('auth:mailConfig.passKeepHint') : undefined}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="from" label={t('auth:mailConfig.from')}>
            <Input placeholder="noreply@example.com" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
