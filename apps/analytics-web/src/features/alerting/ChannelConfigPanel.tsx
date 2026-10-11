import { useEffect, useState } from 'react';
import { formatDateTimeFixed } from '../../i18n/format';
import {
  Alert,
  Button,
  Collapse,
  Divider,
  Form,
  Input,
  InputNumber,
  Popover,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { useT, type TFunction } from '../../i18n';
import { resolveParamKeys } from '../../services/error-params';
import {
  getAlertChannelConfigs,
  saveAlertChannelConfig,
  testAlertChannel,
  type AlertChannelConfigField,
  type AlertChannelConfigItem,
  type AlertChannelConfigSchema,
} from './alerting-api';

/** 本地化兜底：有 key 用 key，无 key 回退服务端中文（老客户端 / 旧接口） */
const schemaLabelOf = (t: TFunction, schema: AlertChannelConfigSchema): string =>
  schema.label_key ? t(schema.label_key) : schema.label;
const fieldLabelOf = (t: TFunction, field: AlertChannelConfigField): string =>
  field.label_key ? t(field.label_key) : field.label;
const fieldHintOf = (t: TFunction, field: AlertChannelConfigField): string | undefined =>
  field.hint_key ? t(field.hint_key) : field.hint;
const fieldPlaceholderOf = (t: TFunction, field: AlertChannelConfigField): string | undefined =>
  field.placeholder_key ? t(field.placeholder_key) : field.placeholder;

/**
 * 通道配置（phase: clklog-analytics-alert-channels-v1）。
 *
 * 开源分发不能预置任何厂商凭证：Webhook 类通道的凭证在「联系人」里填，
 * **凭证级**通道（SMTP / 短信 / Telegram / WhatsApp）在这里配。
 *
 * 交互约定（2026-09-16 用户两次反馈后定型）：
 * - 启用开关放在折叠标题栏，一眼看到状态、不用展开就能开关；
 * - 表单用「标签左 + 输入右」两列（antd horizontal），不再铺满整行造成参差；
 * - 凭证区单独一行并标注「只写不读」；底部一行放「测试目标 + 保存 + 发送测试」；
 * - 全表单 autoComplete=off、密码框 new-password，避免浏览器把登录信息自动填进来。
 */
export function ChannelConfigPanel() {
  const { t } = useT('alerting');
  const [items, setItems] = useState<AlertChannelConfigItem[]>([]);
  const [schemas, setSchemas] = useState<AlertChannelConfigSchema[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await getAlertChannelConfigs();
      setItems(res.items ?? []);
      setSchemas(res.schemas ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggle = async (schema: AlertChannelConfigSchema, item: AlertChannelConfigItem | undefined, next: boolean) => {
    const channel = schemaLabelOf(t, schema);
    const configured = Boolean(item?.updated_at) || Boolean(item?.env_fallback);
    if (next && !configured) {
      message.warning(t('alerting:channel.enableFirst', { channel }));
      return;
    }
    await saveAlertChannelConfig(schema.channel, { enabled: next });
    message.success(
      next ? t('alerting:channel.enabled', { channel }) : t('alerting:channel.disabled', { channel }),
    );
    await load();
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={t('alerting:channel.pageHint.title')}
        description={
          <span>
            {t('alerting:channel.pageHint.body')}
          </span>
        }
      />
      <Collapse
        accordion
        items={schemas.map((schema) => {
          const item = items.find((entry) => entry.channel === schema.channel);
          const envOnly = Boolean(item?.env_fallback) && !item?.updated_at;
          // 状态（是否生效）与来源（谁的凭证）分开表达：平台邮件通道兜底时这两件事不一样，
          // 只显示来源会让用户以为「没启用」（2026-10-09 用户反馈）。
          const active = Boolean(item?.enabled) || Boolean(item?.platform_fallback);
          // 暂停优先于一切：暂停时既不发信，标签也要盖过「已启用」
          const paused = Boolean(item?.muted);
          return {
            key: schema.channel,
            label: (
              <Space size={8} wrap>
                <Typography.Text strong>{schemaLabelOf(t, schema)}</Typography.Text>
                {paused ? (
                  <Tag color="orange">{t('alerting:channel.pausedTag')}</Tag>
                ) : active ? (
                  <Tag color="green">
                    {envOnly && item?.enabled ? t('alerting:channel.envOnly') : t('common:state.enabled')}
                  </Tag>
                ) : (
                  <Tag>{t('alerting:channel.notEnabled')}</Tag>
                )}
                {item?.platform_fallback ? (
                  <Tooltip title={t('alerting:channel.platformFallbackNote')}>
                    <Tag color="blue">{t('alerting:channel.platformFallbackTag')}</Tag>
                  </Tooltip>
                ) : null}
                {item?.secret.configured ? (
                  <Tag color="blue">{t('alerting:channel.secretTag', { hint: item.secret.hint })}</Tag>
                ) : null}
              </Space>
            ),
            extra: (
              // 整块 stopPropagation：点「?」只开说明，不要连带把卡片折叠/展开（开关同理）
              <Space size={8} onClick={(event) => event.stopPropagation()}>
                {schema.help_key || schema.help ? (
                  <Popover
                    placement="leftTop"
                    trigger={['click']}
                    title={t('alerting:channelConfig.helpTitle', { channel: schemaLabelOf(t, schema) })}
                    content={
                      <div style={{ whiteSpace: 'pre-line', maxWidth: 420 }}>
                        {schema.help_key ? t(schema.help_key) : schema.help}
                      </div>
                    }
                  >
                    <QuestionCircleOutlined
                      aria-label={t('alerting:channelConfig.helpTitle', { channel: schemaLabelOf(t, schema) })}
                      style={{ color: 'rgba(0, 0, 0, 0.45)', fontSize: 16, cursor: 'pointer' }}
                    />
                  </Popover>
                ) : null}
                {/* 开关只当**状态指示**用在这个场景：真正的停发/恢复在展开区的「暂停投递」——
                    开关的 off 位在平台兜底时并不代表停发，可点会给人错觉（2026-10-09 反馈） */}
                <Tooltip
                  title={
                    paused
                      ? t('alerting:channelConfig.muteHint')
                      : item?.platform_fallback && !item?.enabled
                        ? t('alerting:channel.platformFallbackNote')
                        : undefined
                  }
                >
                  <span>
                    <Switch
                      size="small"
                      checked={!paused && active}
                      disabled={paused || (Boolean(item?.platform_fallback) && !item?.enabled)}
                      onClick={(_, event) => event.stopPropagation()}
                      onChange={(next) => void toggle(schema, item, next)}
                    />
                  </span>
                </Tooltip>
              </Space>
            ),
            children: <ChannelConfigCard schema={schema} item={item} onSaved={load} />,
          };
        })}
      />
      <Typography.Text type="secondary">
        {t('alerting:channel.pageNote')}
      </Typography.Text>
      {loading ? <Typography.Text type="secondary">{t('common:state.loading')}</Typography.Text> : null}
    </Space>
  );
}

function ChannelConfigCard({
  schema,
  item,
  onSaved,
}: {
  schema: AlertChannelConfigSchema;
  item?: AlertChannelConfigItem;
  onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [muteSaving, setMuteSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { t } = useT('alerting');

  useEffect(() => {
    const initial: Record<string, unknown> = {};
    for (const field of schema.fields) {
      initial[field.key] = item?.config?.[field.key] ?? field.defaultValue;
    }
    form.setFieldsValue(initial);
  }, [schema, item, form]);

  /** 暂停/恢复投递：只改 muted，不动配置与密钥（后端对「纯暂停」不校验字段） */
  const toggleMute = async (next: boolean) => {
    const channel = schemaLabelOf(t, schema);
    setMuteSaving(true);
    try {
      await saveAlertChannelConfig(schema.channel, { muted: next });
      message.success(
        next ? t('alerting:channel.mutedOn', { channel }) : t('alerting:channel.mutedOff', { channel }),
      );
      await onSaved();
    } finally {
      setMuteSaving(false);
    }
  };

  const save = async () => {
    const values = await form.validateFields();
    const config: Record<string, unknown> = {};
    const secret: Record<string, unknown> = {};
    for (const field of schema.fields) config[field.key] = values[field.key];
    for (const field of schema.secretFields) {
      const value = values[`secret_${field.key}`];
      if (typeof value === 'string' && value.trim()) secret[field.key] = value.trim();
    }
    setSaving(true);
    try {
      await saveAlertChannelConfig(schema.channel, { enabled: item?.enabled ?? true, config, secret });
      message.success(t('alerting:channel.saved', { channel: schemaLabelOf(t, schema) }));
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    const values = form.getFieldsValue();
    setTesting(true);
    setResult(null);
    try {
      const res = await testAlertChannel(schema.channel, { address: values.test_target });
      // 目标校验失败时后端下发 error_key/error_params（加法式）：按当前语言渲染；
      // 老响应 / 厂商原始错误仍走 error 原文。
      const errorText = res.error_key
        ? t(res.error_key, resolveParamKeys(res.error_params, (key) => t(key)))
        : (res.error ?? '');
      setResult({
        ok: res.ok,
        text: res.ok ? res.detail : t('alerting:channel.testError', { detail: res.detail, error: errorText }),
      });
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const testLabel =
    schema.channel === 'smtp'
      ? t('alerting:channel.testSmtp')
      : schema.channel === 'telegram'
        ? t('alerting:channel.testChatId')
        : t('alerting:channel.testPhone');
  // 标签列按长语言留宽（俄/德 ≈ 中文 ×2）；labelWrap 让超长标签换行而不是压窄右侧输入框。
  const labelCol = { span: 8 } as const;
  const wrapperCol = { span: 16 } as const;

  return (
    <Form
      form={form}
      layout="horizontal"
      size="middle"
      autoComplete="off"
      labelWrap
      labelCol={labelCol}
      wrapperCol={wrapperCol}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {schema.hint_key ? t(schema.hint_key) : schema.hint}
      </Typography.Paragraph>
      {/* 暂停投递：这是**唯一**能真正让通道停发的开关（走平台邮件兜底的邮件通道也拦得住）。
          默认关闭 = 正常投递；开启 = 保留配置与密钥但此通道不参与任何告警投递。 */}
      <div style={{ marginBottom: 12 }}>
        <Space size={8} wrap>
          <Switch
            size="small"
            checked={Boolean(item?.muted)}
            loading={muteSaving}
            onChange={(next) => void toggleMute(next)}
          />
          <Typography.Text>{t('alerting:channelConfig.muteLabel')}</Typography.Text>
        </Space>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
          {t('alerting:channelConfig.muteHint')}
        </Typography.Paragraph>
      </div>
      {item?.platform_fallback ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('alerting:channel.platformFallbackNote')}
        />
      ) : null}
      {schema.fields.map((field) => (
        <Form.Item
          key={field.key}
          name={field.key}
          label={fieldLabelOf(t, field)}
          rules={
            field.required
              ? [{ required: true, message: t('alerting:validate.required', { field: fieldLabelOf(t, field) }) }]
              : undefined
          }
          tooltip={fieldHintOf(t, field)}
        >
          {field.type === 'number' ? (
            <InputNumber style={{ width: '100%' }} placeholder={fieldPlaceholderOf(t, field)} autoComplete="off" />
          ) : field.type === 'boolean' ? (
            <Switch
              checkedChildren={t('alerting:field.booleanOn')}
              unCheckedChildren={t('alerting:field.booleanOff')}
            />
          ) : (
            <Input placeholder={fieldPlaceholderOf(t, field)} autoComplete="off" />
          )}
        </Form.Item>
      ))}

      {schema.secretFields.length > 0 ? (
        <>
          <Divider orientation="left" plain style={{ margin: '4px 0 12px' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {item?.secret.configured
                ? t('alerting:channel.secretTitleConfigured', { hint: item.secret.hint })
                : t('alerting:channel.secretTitle')}
            </Typography.Text>
          </Divider>
          {schema.secretFields.map((field) => (
            <Form.Item
              key={field.key}
              name={`secret_${field.key}`}
              label={fieldLabelOf(t, field)}
              tooltip={item?.secret.configured ? t('alerting:field.keepSavedValue') : fieldHintOf(t, field)}
            >
              <Input.Password
                placeholder={item?.secret.configured ? t('alerting:field.keepBlank') : fieldPlaceholderOf(t, field)}
                autoComplete="new-password"
              />
            </Form.Item>
          ))}
        </>
      ) : null}

      <Divider plain style={{ margin: '4px 0 12px' }} />
      <Form.Item label={testLabel} name="test_target">
        <Input placeholder={t('alerting:channel.testTarget')} autoComplete="off" />
      </Form.Item>
      <Form.Item wrapperCol={{ offset: labelCol.span, span: wrapperCol.span }}>
        <Space wrap>
          <Button type="primary" onClick={() => void save()} loading={saving}>
            {t('common:action.save')}
          </Button>
          <Button onClick={() => void test()} loading={testing}>
            {t('alerting:channel.sendTest')}
          </Button>
          {item?.updated_by ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('alerting:channel.lastModified', { user: item.updated_by })}{' '}
              · {item.updated_at ? formatDateTimeFixed(item.updated_at) : '-'}
            </Typography.Text>
          ) : null}
        </Space>
      </Form.Item>
      {result ? (
        <Form.Item wrapperCol={{ offset: labelCol.span, span: wrapperCol.span }}>
          <Alert
            type={result.ok ? 'success' : 'error'}
            showIcon
            closable
            onClose={() => setResult(null)}
            message={result.ok ? t('alerting:channel.testOk') : t('alerting:channel.testFail')}
            description={result.text}
          />
        </Form.Item>
      ) : null}
    </Form>
  );
}
