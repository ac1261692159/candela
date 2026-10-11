import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CheckCircleOutlined, PictureOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import {
  applyModelProviders,
  createModelProvider,
  deleteModelProvider,
  getModelProviders,
  saveModelDefaults,
  testModelProvider,
  updateModelProvider,
} from '../../services/ai.service';
import type {
  ModelProviderAdminView,
  ModelProviderDefaults,
  ModelProviderView,
} from '../../types/ai.types';
import { ProviderFormModal, toSavePayload, useProviderFormState, type ProviderFormValues } from './ProviderFormModal';

/** 各列宽度之和 = scroll.x：留成弹性列会被压到只剩一个字（2026-09-22 实测） */
const COLUMN_WIDTHS = { provider: 240, protocol: 170, baseUrl: 300, key: 200, models: 320, actions: 220 };
const TABLE_WIDTH = Object.values(COLUMN_WIDTHS).reduce((sum, width) => sum + width, 0);

/** 供应商密钥状态：不读回明文，只按来源与末 4 位展示 */
function KeyTag({ provider, t }: { provider: ModelProviderView; t: ReturnType<typeof useT>['t'] }) {
  if (provider.key.unreadable) return <Tag color="red">{t('ai:provider.key.unreadable')}</Tag>;
  if (provider.key.configured && provider.key.hint) {
    return <Tag color="green">{t('ai:provider.key.configured', { hint: provider.key.hint })}</Tag>;
  }
  return <Tag>{t('ai:provider.key.missing')}</Tag>;
}

/**
 * 模型供应商设置（phase: clklog-ai-model-providers-v1）。
 *
 * 库是供应商与密钥的唯一来源（v1.1）：初始为空，超管在这里添加并填写密钥，
 * 没有任何配置文件或环境变量来源。保存后新会话立即生效，运行中的会话按惰性回收，
 * 也可手动「立即应用」。
 */
export function ModelProviderPanel() {
  const { t } = useT('ai');
  const [view, setView] = useState<ModelProviderAdminView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [defaultsForm] = Form.useForm<ModelProviderDefaults>();
  const formState = useProviderFormState();
  const selectedProvider = Form.useWatch('provider', defaultsForm);
  const selectedModel = Form.useWatch('model', defaultsForm);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getModelProviders();
      setView(next);
      defaultsForm.setFieldsValue(next.defaults);
    } catch {
      // 错误已由拦截器提示
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [defaultsForm]);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = useMemo(() => view?.providers ?? [], [view]);
  // 默认模型只能选可用模型：不可用的设成默认，用户侧必然失败
  const providerOptions = useMemo(
    () =>
      providers
        .filter((provider) => provider.usable)
        .map((provider) => ({ value: provider.provider_id, label: provider.display_name })),
    [providers],
  );
  const activeProvider = providers.find((provider) => provider.provider_id === selectedProvider);
  const modelOptions = useMemo(
    () =>
      (activeProvider?.models ?? [])
        .filter((model) => model.usable)
        .map((model) => ({ value: model.id, label: model.display_name })),
    [activeProvider],
  );
  const effortOptions = useMemo(() => {
    const model = activeProvider?.models.find((candidate) => candidate.id === selectedModel);
    return (model?.reasoning_efforts ?? []).map((value) => ({ value, label: value }));
  }, [activeProvider, selectedModel]);

  const refreshDefaults = (providerId: string, modelId?: string) => {
    const provider = providers.find((candidate) => candidate.provider_id === providerId);
    const usable = (provider?.models ?? []).filter((model) => model.usable);
    const model = usable.find((candidate) => candidate.id === modelId) ?? usable[0];
    defaultsForm.setFieldsValue({
      provider: providerId,
      model: model?.id,
      reasoning_effort: model?.default_reasoning_effort,
    });
  };

  const handleSubmit = async (values: ProviderFormValues) => {
    const { provider_id: providerId, payload, editing } = toSavePayload(values, formState.editing !== null);
    setSaving(true);
    try {
      if (editing) await updateModelProvider(providerId, payload);
      else await createModelProvider({ provider_id: providerId, ...payload });
      formState.close();
      setJustSaved(true);
      await load();
    } catch {
      // 错误已由拦截器提示
    } finally {
      setSaving(false);
    }
  };

  /** 测试连接：逐个测试该供应商下全部模型；只有通过的才进入助手的模型列表 */
  const handleTest = async (provider: ModelProviderView) => {
    setBusyProvider(provider.provider_id);
    try {
      const { results } = await testModelProvider(provider.provider_id);
      const okCount = results.filter((item) => item.ok).length;
      const failures = results.filter((item) => !item.ok);
      if (failures.length === 0) {
        message.success(t('ai:provider.test.allOk', { count: okCount }));
      } else if (okCount === 0) {
        Modal.error({
          title: t('ai:provider.test.failed'),
          width: 560,
          content: (
            <Space direction="vertical" size={8} style={{ display: 'flex' }}>
              {failures.map((item) => (
                <Typography.Paragraph key={item.model} style={{ marginBottom: 0, wordBreak: 'break-all' }}>
                  <Typography.Text strong>{item.model}</Typography.Text>
                  {' — '}
                  {item.error_key
                    ? t(item.error_key, item.error_code === 'provider_not_configured' ? { provider: provider.provider_id } : undefined)
                    : item.detail || `HTTP ${item.status}`}
                </Typography.Paragraph>
              ))}
            </Space>
          ),
        });
      } else {
        Modal.warning({
          title: t('ai:provider.test.partialTitle'),
          width: 560,
          content: (
            <Space direction="vertical" size={8} style={{ display: 'flex' }}>
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                {t('ai:provider.test.partial', { ok: okCount, count: results.length })}
              </Typography.Paragraph>
              {failures.map((item) => (
                <Typography.Paragraph key={item.model} style={{ marginBottom: 0, wordBreak: 'break-all' }}>
                  <Typography.Text strong>{item.model}</Typography.Text>
                  {' — '}
                  {item.error_key
                    ? t(item.error_key, item.error_code === 'provider_not_configured' ? { provider: provider.provider_id } : undefined)
                    : item.detail || `HTTP ${item.status}`}
                </Typography.Paragraph>
              ))}
            </Space>
          ),
        });
      }
      await load();
    } catch {
      // 错误已由拦截器提示
    } finally {
      setBusyProvider(null);
    }
  };

  const handleDelete = (provider: ModelProviderView) => {
    Modal.confirm({
      title: t('common:action.delete'),
      content: t('ai:provider.delete.confirm', { name: provider.display_name }),
      okText: t('common:action.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common:action.cancel'),
      onOk: async () => {
        await deleteModelProvider(provider.provider_id);
        await load();
      },
    });
  };

  const handleApply = () => {
    const count = view?.applyable_runtimes ?? 0;
    Modal.confirm({
      title: t('ai:provider.apply.title'),
      content: t('ai:provider.apply.confirm', { count }),
      okText: t('ai:provider.action.apply', { count }),
      cancelText: t('common:action.cancel'),
      onOk: async () => {
        setApplying(true);
        try {
          const result = await applyModelProviders();
          message.success(t('ai:provider.apply.done', { count: result.recycled }));
          await load();
        } finally {
          setApplying(false);
        }
      },
    });
  };

  const handleSaveDefaults = async () => {
    const values = await defaultsForm.validateFields();
    setSaving(true);
    try {
      await saveModelDefaults(values);
      setJustSaved(true);
      await load();
    } catch {
      // 错误已由拦截器提示
    } finally {
      setSaving(false);
    }
  };

  if (loading && !view) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  const unreadable = providers.filter((provider) => provider.key.unreadable);
  const columns: ColumnsType<ModelProviderView> = [
    {
      title: t('ai:provider.column.provider'),
      dataIndex: 'display_name',
      width: COLUMN_WIDTHS.provider,
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{row.display_name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.provider_id}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('ai:provider.column.protocol'),
      dataIndex: 'protocol',
      width: COLUMN_WIDTHS.protocol,
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: t('ai:provider.column.baseUrl'),
      dataIndex: 'base_url',
      width: COLUMN_WIDTHS.baseUrl,
      ellipsis: { showTitle: true },
    },
    {
      title: t('ai:provider.column.key'),
      width: COLUMN_WIDTHS.key,
      render: (_value, row) => <KeyTag provider={row} t={t} />,
    },
    {
      title: t('ai:provider.column.models'),
      width: COLUMN_WIDTHS.models,
      render: (_value, row) => (
        <Space direction="vertical" size={2} style={{ display: 'flex' }}>
          <Space size={4} wrap>
            {row.models.map((model) => (
              <Tag
                key={model.id}
                color={model.usable ? 'green' : undefined}
                icon={model.usable ? <CheckCircleOutlined /> : undefined}
                title={
                  model.usable
                    ? t('ai:provider.model.verified')
                    : t('ai:provider.model.unverified')
                }
              >
                {model.id}
              </Tag>
            ))}
          </Space>
          <Space size={4} wrap>
            {row.models.some((model) => model.supports_image) ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                <PictureOutlined /> {t('ai:provider.form.supportsImage')}
              </Typography.Text>
            ) : null}
            {!row.usable ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('ai:provider.model.notInUse')}
              </Typography.Text>
            ) : null}
          </Space>
        </Space>
      ),
    },
    {
      title: t('common:label.actions'),
      width: COLUMN_WIDTHS.actions,
      fixed: 'right',
      render: (_value, row) => (
        <Space size={4}>
          <Button
            size="small"
            loading={busyProvider === row.provider_id}
            onClick={() => void handleTest(row)}
          >
            {t('common:action.testConnection')}
          </Button>
          <Button size="small" onClick={() => formState.openEdit(row)}>
            {t('common:action.edit')}
          </Button>
          <Button size="small" danger onClick={() => handleDelete(row)}>
            {t('common:action.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const readonlyRuntime = view?.readonly ? String(view.readonly.runtime.max_runtimes ?? '') : '';

  return (
    <Space direction="vertical" size={12} style={{ display: 'flex' }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t('ai:provider.intro')}
      </Typography.Paragraph>

      {justSaved ? (
        <Alert
          type="success"
          closable
          onClose={() => setJustSaved(false)}
          message={
            (view?.applyable_runtimes ?? 0) > 0
              ? t('ai:provider.saved.pending', { count: view?.applyable_runtimes })
              : t('ai:provider.saved.done')
          }
          action={
            (view?.applyable_runtimes ?? 0) > 0 ? (
              <Button size="small" loading={applying} onClick={handleApply}>
                {t('ai:provider.action.apply', { count: view?.applyable_runtimes })}
              </Button>
            ) : null
          }
        />
      ) : null}

      {unreadable.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={t('ai:provider.key.alertTitle')}
          description={`${t('ai:provider.key.alertBody')}（${unreadable
            .map((provider) => provider.provider_id)
            .join('、')}）`}
        />
      ) : null}

      {view?.key_master_missing ? (
        <Alert type="warning" showIcon message={t('ai:error.provider.masterKeyMissing')} />
      ) : null}

      {view && view.readonly && !view.readonly.enabled ? (
        <Alert type="warning" showIcon message={t('ai:provider.disabled.title')} description={t('ai:provider.disabled.body')} />
      ) : null}

      <Card
        size="small"
        title={t('ai:provider.tabLabel')}
        extra={
          <Space>
            <Button size="small" icon={<SyncOutlined />} onClick={() => void load()} />
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={formState.openCreate}
            >
              {t('ai:provider.action.add')}
            </Button>
          </Space>
        }
      >
        {providers.length === 0 && !loading ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text>{t('ai:provider.empty.title')}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('ai:provider.empty.body')}
                </Typography.Text>
              </Space>
            }
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={formState.openCreate}>
              {t('ai:provider.action.add')}
            </Button>
          </Empty>
        ) : (
          <Table
            rowKey="provider_id"
            size="small"
            loading={loading}
            dataSource={providers}
            pagination={false}
            scroll={{ x: TABLE_WIDTH }}
            columns={columns}
          />
        )}
      </Card>

      <Card
        size="small"
        title={t('ai:provider.defaults.title')}
        extra={
          <Button
            size="small"
            type="primary"
            loading={saving}
            disabled={providerOptions.length === 0}
            onClick={() => void handleSaveDefaults()}
          >
            {t('common:action.save')}
          </Button>
        }
      >
        <Form form={defaultsForm} layout="inline">
          <Form.Item name="provider" label={t('ai:provider.defaults.provider')}>
            <Select
              style={{ width: 220 }}
              options={providerOptions}
              onChange={(value: string) => refreshDefaults(value)}
            />
          </Form.Item>
          <Form.Item name="model" label={t('ai:provider.defaults.model')}>
            <Select
              style={{ width: 240 }}
              options={modelOptions}
              onChange={(value: string) => refreshDefaults(selectedProvider, value)}
            />
          </Form.Item>
          <Form.Item name="reasoning_effort" label={t('ai:provider.defaults.reasoningEffort')}>
            <Select style={{ width: 160 }} options={effortOptions} />
          </Form.Item>
        </Form>
      </Card>

      {view?.readonly ? (
        <Card size="small" title={t('ai:provider.readonly.title')}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            {t('ai:provider.readonly.body')}
          </Typography.Paragraph>
          <Space wrap>
            <Tag color={view.readonly.enabled ? 'green' : 'default'}>
              {view.readonly.enabled ? t('common:state.enabled') : t('common:state.disabled')}
            </Tag>
            <Tag>{view.readonly.permission_preset}</Tag>
            {readonlyRuntime ? <Tag>max_runtimes: {readonlyRuntime}</Tag> : null}
          </Space>
        </Card>
      ) : null}

      <ProviderFormModal
        open={formState.formOpen}
        provider={formState.editing}
        saving={saving}
        onCancel={formState.close}
        onSubmit={handleSubmit}
      />
    </Space>
  );
}
