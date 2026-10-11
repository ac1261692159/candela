import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Select, Space, Switch, Typography } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import type {
  ModelProviderProtocol,
  ModelProviderView,
  SaveModelProviderInput,
  SaveModelProviderModel,
} from '../../types/ai.types';

export interface ProviderFormValues extends SaveModelProviderInput {
  provider_id: string;
}

const ADAPTERS = ['openai_compatible', 'deepseek'] as const;
const PROTOCOLS: ModelProviderProtocol[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
];

/** 与后端同口径的粗校验：非本机地址必须 HTTPS（后端仍会整组复核） */
function insecureBaseUrl(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return false;
    return !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  } catch {
    return true;
  }
}

/**
 * 供应商新增/编辑表单（phase: clklog-ai-model-providers-v1）。
 *
 * 密钥字段只写不读：编辑时留空表示不修改已保存的密文。
 */
export function ProviderFormModal({
  open,
  provider,
  saving,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  provider: ModelProviderView | null;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (values: ProviderFormValues) => Promise<void>;
}) {
  const { t } = useT('ai');
  const [form] = Form.useForm<ProviderFormValues>();
  const editing = provider !== null;

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      provider_id: provider?.provider_id ?? '',
      display_name: provider?.display_name ?? '',
      adapter: provider?.adapter ?? 'openai_compatible',
      protocol: provider?.protocol ?? 'openai-completions',
      base_url: provider?.base_url ?? '',
      api_key: '',
      models: provider?.models?.length
        ? provider.models
        : [
            {
              id: '',
              display_name: '',
              supports_image: false,
              reasoning_efforts: ['off', 'high'],
              default_reasoning_effort: 'off',
            },
          ],
    });
  }, [open, provider, form]);

  return (
    <Modal
      title={editing ? provider.display_name : t('ai:provider.action.add')}
      open={open}
      width={720}
      confirmLoading={saving}
      okText={t('common:action.save')}
      cancelText={t('common:action.cancel')}
      onCancel={onCancel}
      onOk={() => {
        void form.validateFields().then(onSubmit);
      }}
      destroyOnClose
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Space size="large" align="start" style={{ display: 'flex' }}>
          <Form.Item
            name="provider_id"
            label={t('ai:provider.form.providerId')}
            tooltip={editing ? t('ai:provider.form.providerIdLocked') : undefined}
            rules={[
              { required: true, message: t('ai:provider.form.required') },
              { pattern: /^[a-z0-9_-]+$/, message: t('ai:provider.form.providerIdRule') },
            ]}
            style={{ width: 260 }}
          >
            <Input disabled={editing} placeholder="tencent" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="display_name"
            label={t('ai:provider.form.displayName')}
            rules={[{ required: true, message: t('ai:provider.form.required') }]}
            style={{ width: 380 }}
          >
            <Input placeholder="Tencent TokenHub" autoComplete="off" />
          </Form.Item>
        </Space>
        <Space size="large" align="start" style={{ display: 'flex' }}>
          <Form.Item name="adapter" label={t('ai:provider.form.adapter')} style={{ width: 260 }}>
            <Select options={ADAPTERS.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="protocol" label={t('ai:provider.form.protocol')} style={{ width: 380 }}>
            <Select options={PROTOCOLS.map((value) => ({ value, label: value }))} />
          </Form.Item>
        </Space>
        <Form.Item
          name="base_url"
          label={t('ai:provider.form.baseUrl')}
          rules={[
            { required: true, message: t('ai:provider.form.required') },
            {
              validator: (_rule, value: string) =>
                insecureBaseUrl(value)
                  ? Promise.reject(new Error(t('ai:provider.form.baseUrlHttps')))
                  : Promise.resolve(),
            },
          ]}
        >
          <Input placeholder="https://api.example.com/v1" autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="api_key"
          label={t('ai:provider.form.apiKey')}
          extra={editing ? t('ai:provider.key.keepHint') : undefined}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>

        <Typography.Text strong>{t('ai:provider.form.models')}</Typography.Text>
        <Form.List name="models">
          {(fields, { add, remove }) => (
            <div style={{ marginTop: 8 }}>
              {fields.map(({ key, name, ...rest }) => (
                <div
                  key={key}
                  style={{
                    border: '1px solid #f0f0f0',
                    borderRadius: 6,
                    padding: '12px 12px 0',
                    marginBottom: 12,
                  }}
                >
                  <Space size="middle" align="start" style={{ display: 'flex' }}>
                    <Form.Item
                      {...rest}
                      name={[name, 'id']}
                      label={t('ai:provider.form.modelId')}
                      rules={[{ required: true, message: t('ai:provider.form.required') }]}
                      style={{ width: 240 }}
                    >
                      <Input placeholder="deepseek-v4-flash" autoComplete="off" />
                    </Form.Item>
                    <Form.Item
                      {...rest}
                      name={[name, 'display_name']}
                      label={t('ai:provider.form.modelName')}
                      rules={[{ required: true, message: t('ai:provider.form.required') }]}
                      style={{ width: 240 }}
                    >
                      <Input placeholder="DeepSeek V4 Flash" autoComplete="off" />
                    </Form.Item>
                    <Button
                      type="text"
                      danger
                      icon={<MinusCircleOutlined />}
                      onClick={() => remove(name)}
                      aria-label={t('common:action.delete')}
                    />
                  </Space>
                  <Space size="middle" align="start" style={{ display: 'flex' }}>
                    <Form.Item
                      {...rest}
                      name={[name, 'reasoning_efforts']}
                      label={t('ai:provider.form.reasoningEfforts')}
                      rules={[{ required: true, message: t('ai:provider.form.required') }]}
                      style={{ width: 300 }}
                    >
                      <Select
                        mode="tags"
                        tokenSeparators={[',']}
                        options={['off', 'low', 'high', 'max'].map((value) => ({ value, label: value }))}
                      />
                    </Form.Item>
                    <Form.Item
                      {...rest}
                      name={[name, 'default_reasoning_effort']}
                      label={t('ai:provider.form.defaultEffort')}
                      rules={[{ required: true, message: t('ai:provider.form.required') }]}
                      style={{ width: 240 }}
                    >
                      <Select
                        options={['off', 'low', 'high', 'max'].map((value) => ({ value, label: value }))}
                      />
                    </Form.Item>
                    <Form.Item
                      {...rest}
                      name={[name, 'supports_image']}
                      label={t('ai:provider.form.supportsImage')}
                      valuePropName="checked"
                      style={{ width: 200 }}
                    >
                      <Switch />
                    </Form.Item>
                  </Space>
                </div>
              ))}
              <Button
                type="dashed"
                block
                icon={<PlusOutlined />}
                onClick={() =>
                  add({
                    id: '',
                    display_name: '',
                    supports_image: false,
                    reasoning_efforts: ['off', 'high'],
                    default_reasoning_effort: 'off',
                  } satisfies SaveModelProviderModel)
                }
              >
                {t('ai:provider.form.addModel')}
              </Button>
            </div>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}

/** 表单值 → 接口载荷：编辑时不下发 provider_id（后端 UPDATE DTO 不接受该字段） */
export function toSavePayload(values: ProviderFormValues, editing: boolean) {
  const models = (values.models ?? [])
    .filter((model) => model?.id && model?.display_name)
    .map((model) => ({
      id: model.id.trim(),
      display_name: model.display_name.trim(),
      supports_image: Boolean(model.supports_image),
      reasoning_efforts: (model.reasoning_efforts ?? []).filter(Boolean),
      default_reasoning_effort: model.default_reasoning_effort,
    }));
  return {
    provider_id: values.provider_id?.trim() ?? '',
    payload: {
      display_name: values.display_name?.trim() ?? '',
      adapter: values.adapter,
      protocol: values.protocol,
      base_url: values.base_url?.trim() ?? '',
      // 密钥留空 = 不修改：空串与缺省在后端同义，这里直接省略
      ...(values.api_key ? { api_key: values.api_key } : {}),
      models,
    } satisfies SaveModelProviderInput,
    editing,
  };
}

export function useProviderFormState() {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ModelProviderView | null>(null);
  const close = useCallback(() => {
    setFormOpen(false);
    setEditing(null);
  }, []);
  return useMemo(
    () => ({
      formOpen,
      editing,
      openCreate: () => {
        setEditing(null);
        setFormOpen(true);
      },
      openEdit: (provider: ModelProviderView) => {
        setEditing(provider);
        setFormOpen(true);
      },
      close,
    }),
    [formOpen, editing, close],
  );
}
