import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Input, Row, Segmented, Space, Tag, Typography, message } from 'antd';
import { useT, type TFunction } from '../../i18n';
import { useProjectStore } from '../../stores/project.store';
import {
  getAlertTemplates,
  previewAlertTemplate,
  resetAlertTemplate,
  saveAlertTemplate,
  type AlertChannel,
  type AlertKind,
  type AlertTemplateItem,
  type AlertTemplateVar,
} from './alerting-api';

const kindsOf = (t: TFunction): { value: AlertKind; label: string }[] => [
  { value: 'fire', label: t('alerting:template.kindFire') },
  { value: 'resolve', label: t('alerting:template.kindResolve') },
];

const channelsOf = (t: TFunction): { value: AlertChannel; label: string }[] => [
  { value: 'chat', label: t('alerting:template.channelChat') },
  { value: 'email', label: t('alerting:channel.email') },
  { value: 'sms', label: t('alerting:channel.sms') },
];

/** 编辑停顿多久后自动刷新右侧预览 */
const PREVIEW_DEBOUNCE_MS = 500;

/**
 * 告警通知模板（alerting-v4）。
 *
 * 左编辑、右预览：左右并排便于对照，编辑停顿后自动刷新预览（也可手动「刷新预览」）。
 * 模板按「事件类型 × 通道组」配置，默认模板已**预填充占位符**，支持 Go 模板子集条件。
 */
export function TemplateEditor() {
  const currentProject = useProjectStore((s) => s.currentProject);
  const { t } = useT('alerting');
  const [items, setItems] = useState<AlertTemplateItem[]>([]);
  const [variables, setVariables] = useState<AlertTemplateVar[]>([]);
  const [kind, setKind] = useState<AlertKind>('fire');
  const [channel, setChannel] = useState<AlertChannel>('chat');
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  const current = useMemo(
    () => items.find((item) => item.kind === kind && item.channel === channel),
    [items, kind, channel],
  );

  const load = async () => {
    const res = await getAlertTemplates(currentProject);
    setItems(res.items ?? []);
    setVariables(res.variables ?? []);
    const found = (res.items ?? []).find((item) => item.kind === kind && item.channel === channel);
    setBody(found?.body ?? '');
    setSubject(found?.subject ?? '');
    setError(null);
  };

  useEffect(() => {
    void load();
    // 换项目/换通道/换事件类型都重新取有效模板（自定义优先，否则默认）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject, kind, channel]);

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const res = await previewAlertTemplate({ kind, channel, body, subject });
      setPreview({ subject: res.subject, body: res.body });
      setPreviewError(null);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  // 编辑停下约半秒后自动预览，右侧始终跟着左侧内容走
  useEffect(() => {
    const timer = setTimeout(() => void runPreview(), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, subject, kind, channel]);

  const insertVar = (name: string) => {
    const token = `{{.${name}}}`;
    const area = areaRef.current;
    if (!area) {
      setBody((prev) => prev + token);
      return;
    }
    const start = area.selectionStart ?? body.length;
    const end = area.selectionEnd ?? body.length;
    const next = `${body.slice(0, start)}${token}${body.slice(end)}`;
    setBody(next);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      await saveAlertTemplate(kind, channel, { body, subject }, currentProject);
      message.success(t('alerting:template.saved'));
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await resetAlertTemplate(kind, channel, currentProject);
      message.success(t('alerting:template.reset'));
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={t('alerting:template.hint.title')}
        description={
          <span>
            {t('alerting:template.hint.lead')}{' '}
            <Typography.Text code>{'{{if eq .status_code "resolve"}}…{{else}}…{{end}}'}</Typography.Text>{' '}
            {t('alerting:template.hint.tail')}
          </span>
        }
      />

      <Space wrap>
        <Segmented
          value={kind}
          onChange={(value) => setKind(value as AlertKind)}
          // 选项标签随语言变长（俄/德 ≈ 中文 ×2）：截断时给 title 兜底可读
          options={kindsOf(t).map((item) => ({
            value: item.value,
            label: <span title={item.label}>{item.label}</span>,
          }))}
        />
        <Segmented
          value={channel}
          onChange={(value) => setChannel(value as AlertChannel)}
          options={channelsOf(t).map((item) => ({
            value: item.value,
            label: <span title={item.label}>{item.label}</span>,
          }))}
        />
        {current && (
          <Tag color={current.is_default ? 'default' : 'blue'}>
            {current.is_default
              ? t('alerting:template.isDefault')
              : t('alerting:template.customized', { user: current.updated_by ?? '' })}
          </Tag>
        )}
      </Space>

      {/* 左右双栏在窄容器里会同时挤压编辑区与预览（长语言按钮更宽）：lg 以下改堆叠，xl 起并排 */}
      <Row gutter={16}>
        <Col xs={24} lg={24} xl={14}>
          <Card
            size="small"
            title={t('common:action.edit')}
            extra={
              <Space wrap size={8}>
                <Button size="small" onClick={() => void runPreview()} loading={previewing}>
                  {t('alerting:template.refreshPreview')}
                </Button>
                <Button size="small" type="primary" onClick={() => void save()} loading={busy}>
                  {t('common:action.save')}
                </Button>
                <Button
                  size="small"
                  onClick={() => void reset()}
                  disabled={!current || current.is_default}
                  loading={busy}
                >
                  {t('common:action.resetDefault')}
                </Button>
              </Space>
            }
          >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {channel === 'email' && (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Typography.Text type="secondary">{t('alerting:template.subject')}</Typography.Text>
                  <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={191} />
                </Space>
              )}

              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text type="secondary">{t('alerting:template.body')}</Typography.Text>
                <Input.TextArea
                  ref={areaRef}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={16}
                  style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: 12 }}
                />
              </Space>

              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text type="secondary">{t('alerting:template.variables')}</Typography.Text>
                <Space size={[6, 6]} wrap>
                  {variables.map((item) => {
                    // 服务端优先下发 label_key；无 key（旧接口）回退中文 label
                    const varLabel = item.label_key ? t(item.label_key) : item.label;
                    return (
                      <Tag
                        key={item.name}
                        style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                        title={t('alerting:template.varTooltip', { label: varLabel, sample: item.sample })}
                        onClick={() => insertVar(item.name)}
                      >
                        {varLabel}
                        <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                          {`{{.${item.name}}}`}
                        </Typography.Text>
                      </Tag>
                    );
                  })}
                </Space>
              </Space>

              {error && <Alert type="error" showIcon message={error} />}
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={24} xl={10}>
          <Card
            size="small"
            title={t('alerting:template.preview')}
            extra={
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, whiteSpace: 'normal' }}
              >
                {t('alerting:template.sampleHint')}
              </Typography.Text>
            }
          >
            {previewError ? (
              <Alert
                type="error"
                showIcon
                message={t('alerting:template.previewFailed')}
                description={previewError}
              />
            ) : preview ? (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {channel === 'email' ? (
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('alerting:template.previewSubject')}
                    </Typography.Text>
                    <div>
                      <Typography.Text strong>{preview.subject}</Typography.Text>
                    </div>
                  </div>
                ) : null}
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    background: '#fafafa',
                    border: '1px solid #f0f0f0',
                    borderRadius: 6,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: 12,
                    minHeight: 160,
                  }}
                >
                  {preview.body}
                </pre>
                {channel === 'sms' ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('alerting:template.smsNote', {
                      count: preview.body.replace(/\s+/g, ' ').trim().length,
                    })}
                  </Typography.Text>
                ) : null}
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {previewing ? t('alerting:template.rendering') : t('alerting:template.previewEmpty')}
              </Typography.Text>
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
