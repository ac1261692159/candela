import { useEffect, useMemo, useState } from 'react';
import { formatDateTimeFixed } from '../../i18n/format';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { TimeRangeControl } from '../time-range/TimeRangeControl';
import type { TimeRange } from '../../types/dsl.types';
import { deleteSavedMetric, getEvents, updateSavedMetric } from '../../services/meta.service';
import { createCard } from '../../services/report.service';
import type { MetaEvent, SavedMetric } from '../../types/meta.types';
import { useT } from '../../i18n';
import {
  buildEventDefinition,
  buildRetentionDefinition,
  cohortOptions,
  describeMetric,
  granularityOptions,
  measureOptions,
  toFormValues,
} from './metric-definition';
import { MetricDefinitionForm, patchFromFormValues } from './MetricDefinitionForm';

interface Props {
  metric: SavedMetric | null;
  onClose: () => void;
  onSaved: () => void;
  /** 删除成功后的回调（列表刷新并关闭） */
  onDeleted?: () => void;
}

function fmtTime(value?: string | null): string {
  if (!value) return '—';
  return formatDateTimeFixed(value);
}

/**
 * 指标详情（phase: clklog-analytics-metric-detail-v1）。
 *
 * 查看态给完整口径与元信息；编辑态就地改元信息与口径，**保持 metric_id 不变**，
 * 因此不影响分析引用与告警绑定。指标名与类型只读（是资产唯一键与口径类型）。
 */
export function MetricDetailDrawer({ metric, onClose, onSaved, onDeleted }: Props) {
  const { t, i18n } = useT('metrics');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<{ value: string; label: string }[]>([]);
  const [form] = Form.useForm();

  /** 指标类型展示名（未登记的类型回落原值） */
  const kindLabel = (kind: string): string =>
    kind === 'event'
      ? t('metrics:kind.event')
      : kind === 'retention'
        ? t('metrics:kind.retention')
        : kind;

  useEffect(() => {
    if (!metric) return;
    setEditing(false);
    setError(null);
    form.setFieldsValue({ display_name: metric.display_name, remark: metric.remark ?? '', format: metric.format });
  }, [metric, form]);

  useEffect(() => {
    if (!metric || !editing) return;
    // 事件下拉：失败不阻塞编辑（仍可保留原值）
    void getEvents()
      .then((res) =>
        setEvents(
          (res.items ?? [])
            .filter((item: MetaEvent) => Boolean(item.event_key))
            .map((item: MetaEvent) => ({
              value: item.event_key,
              label: item.display_name
                ? t('metrics:event.optionWithName', { key: item.event_key, name: item.display_name })
                : item.event_key,
            })),
        ),
      )
      .catch(() => setEvents([]));
  }, [metric, editing]);

  /** 删除：破坏性操作放抽屉里（列表不再有操作列），二次确认；编辑态额外提醒未保存修改 */
  const confirmDelete = () => {
    if (!metric) return;
    Modal.confirm({
      title: t('metrics:confirm.deleteTitle', { name: metric.display_name }),
      content: editing
        ? t('metrics:confirm.deleteEditing')
        : t('metrics:confirm.deleteContent'),
      okText: t('common:action.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common:action.cancel'),
      onOk: async () => {
        await deleteSavedMetric(metric.metric_id);
        message.success(t('metrics:message.deleted'));
        if (onDeleted) onDeleted();
        else onSaved();
      },
    });
  };

  const timeRange = Form.useWatch('timeRange', form) as TimeRange | undefined;
  const [creatingCard, setCreatingCard] = useState(false);

  /**
   * 从指标创建看板卡片（metric-v3）：卡片按指标口径与查询时间求值，
   * 之后指标改口径，卡片会在下一个刷新周期跟着变（缓存不落永久副本）。
   */
  const createCardFromMetric = async () => {
    if (!metric) return;
    setCreatingCard(true);
    try {
      const card = await createCard({
        name: t('metrics:detail.cardName', { name: metric.display_name }),
        type: 'metric',
        dsl: { metric_id: metric.metric_id },
        chart_type: 'line',
      });
      message.success(t('metrics:message.cardCreated', { name: card.name }));
    } catch (err) {
      if (err instanceof Error && err.message) message.error(err.message);
    } finally {
      setCreatingCard(false);
    }
  };

  const rows = useMemo(
    () => (metric ? describeMetric(metric.kind, metric.definition_json, t) : []),
    // t 的引用不随语言变化，依赖里带上 i18n.language 才能让口径文案跟着刷新
    [metric, t, i18n.language],
  );

  const startEdit = () => {
    if (!metric) return;
    form.setFieldsValue(toFormValues(metric.kind, metric.definition_json));
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (!metric) return;
    const values = await form.validateFields();
    setSaving(true);
    setError(null);
    try {
      const patch: Parameters<typeof updateSavedMetric>[1] = {
        display_name: values.display_name,
        remark: values.remark ?? '',
        format: values.format,
      };
      if (metric.kind === 'event') {
        // v2：事件指标口径全字段都来自表单（含数值变换 / 取值选择 / 查询时间 / 条件组）
        patch.definition_json = buildEventDefinition(metric.definition_json, patchFromFormValues(values));
      } else {
        patch.definition_json = buildRetentionDefinition(metric.definition_json, {
          startEvent: values.startEvent,
          retainEvent: values.retainEvent,
          n: Number(values.n),
          measure: values.measure === 'count' ? 'count' : 'rate',
          cohort: values.cohort,
          granularity: values.granularity,
          timeRange: (values.timeRange as TimeRange | undefined) ?? null,
        });
      }
      await updateSavedMetric(metric.metric_id, patch);
      message.success(t('metrics:message.updated'));
      onSaved();
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 下拉选项 = 元事件表 ∪ 当前值：事件被删/改名后仍能保留原值，
   * 避免「一保存就把事件改掉」这种静默数据破坏。
   */
  const withCurrent = (current?: string) => {
    const options = [...events];
    if (current && !options.some((option) => option.value === current)) {
      options.unshift({ value: current, label: t('metrics:event.staleOption', { event: current }) });
    }
    return options;
  };

  const formValues = useMemo(
    () => toFormValues(metric?.kind ?? 'event', metric?.definition_json ?? {}),
    [metric],
  );
  const startOptions = withCurrent((formValues as { startEvent?: string }).startEvent);
  const retainOptions = withCurrent((formValues as { retainEvent?: string }).retainEvent);

  return (
    <Drawer
      title={metric ? t('metrics:detail.titleNamed', { name: metric.display_name }) : t('metrics:detail.title')}
      open={Boolean(metric)}
      onClose={onClose}
      width={720}
      destroyOnClose
      extra={
        <Space>
          {editing ? (
            <>
              <Typography.Link onClick={() => setEditing(false)}>{t('common:action.cancel')}</Typography.Link>
              <Typography.Link onClick={() => void save()} disabled={saving}>
                {saving ? t('metrics:detail.saving') : t('common:action.save')}
              </Typography.Link>
            </>
          ) : (
            <Button onClick={startEdit}>{t('common:action.edit')}</Button>
          )}
          {metric?.kind === 'event' ? (
            <Button loading={creatingCard} onClick={() => void createCardFromMetric()}>
              {t('metrics:detail.createCard')}
            </Button>
          ) : null}
          <Button danger icon={<DeleteOutlined />} onClick={confirmDelete}>
            {t('common:action.delete')}
          </Button>
        </Space>
      }
    >
      {metric && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space size={6} wrap>
            <Tag color="blue">{kindLabel(metric.kind)}</Tag>
            <Tag>{metric.format === 'percent' ? t('metrics:format.percent') : t('metrics:format.number')}</Tag>
            <Typography.Text type="secondary">
              {t('metrics:detail.meta', {
                owner: metric.owner,
                created: fmtTime(metric.created_at),
                updated: fmtTime(metric.updated_at),
              })}
            </Typography.Text>
          </Space>

          {error && <Alert type="error" showIcon message={error} />}

          {!editing ? (
            <>
              <Descriptions
                size="small"
                column={2}
                items={[
                  {
                    key: 'display_name',
                    label: t('metrics:label.displayName'),
                    children: metric.display_name,
                  },
                  {
                    key: 'name',
                    label: t('metrics:label.metricName'),
                    children: <Typography.Text code>{metric.name}</Typography.Text>,
                  },
                  {
                    key: 'remark',
                    label: t('common:label.remark'),
                    span: 2,
                    children: metric.remark || '—',
                  },
                ]}
              />
              <div>
                <Typography.Text strong>{t('metrics:label.definition')}</Typography.Text>
                <Descriptions
                  size="small"
                  column={2}
                  style={{ marginTop: 8 }}
                  items={rows.map((row) => ({ key: row.label, label: row.label, children: row.value }))}
                />
              </div>
              <Alert
                type="info"
                showIcon
                message={t('metrics:detail.alertTitle')}
                description={<span>{t('metrics:detail.alertBody')}</span>}
              />
            </>
          ) : (
            <Form form={form} layout="vertical">
              <Descriptions
                size="small"
                column={2}
                style={{ marginBottom: 12 }}
                items={[
                  {
                    key: 'name',
                    label: t('metrics:label.metricNameReadonly'),
                    children: <Typography.Text code>{metric.name}</Typography.Text>,
                  },
                  {
                    key: 'kind',
                    label: t('metrics:label.kindReadonly'),
                    children: kindLabel(metric.kind),
                  },
                ]}
              />
              <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
                {t('metrics:detail.readonlyNote')}
              </Typography.Paragraph>
              <Form.Item
                name="display_name"
                label={t('metrics:label.displayName')}
                rules={[{ required: true, message: t('metrics:validation.displayNameRequired') }]}
              >
                <Input maxLength={80} />
              </Form.Item>
              <Form.Item name="format" label={t('metrics:label.format')}>
                <Select
                  style={{ minWidth: 170 }}
                  options={[
                    { value: 'number', label: t('metrics:format.number') },
                    { value: 'percent', label: t('metrics:format.percent') },
                  ]}
                />
              </Form.Item>
              <Form.Item name="remark" label={t('common:label.remark')}>
                <Input.TextArea maxLength={200} showCount rows={2} />
              </Form.Item>

              {metric.kind === 'event' ? (
                <MetricDefinitionForm form={form} />
              ) : (
                <Space wrap align="start">
                  <Form.Item
                    name="startEvent"
                    label={t('metrics:label.startEvent')}
                    rules={[{ required: true, message: t('metrics:validation.startEventRequired') }]}
                  >
                    <Select showSearch optionFilterProp="label" style={{ minWidth: 240 }} options={startOptions} />
                  </Form.Item>
                  <Form.Item
                    name="retainEvent"
                    label={t('metrics:label.retainEvent')}
                    rules={[{ required: true, message: t('metrics:validation.retainEventRequired') }]}
                  >
                    <Select showSearch optionFilterProp="label" style={{ minWidth: 240 }} options={retainOptions} />
                  </Form.Item>
                  <Form.Item
                    name="n"
                    label={t('metrics:label.period')}
                    rules={[{ required: true, message: t('metrics:validation.periodFilled') }]}
                  >
                    <InputNumber min={1} max={90} style={{ width: 120 }} />
                  </Form.Item>
                  <Form.Item name="measure" label={t('metrics:label.measure')}>
                    <Select style={{ minWidth: 170 }} options={measureOptions(t)} />
                  </Form.Item>
                  <Form.Item name="cohort" label={t('metrics:label.cohort')}>
                    <Select style={{ minWidth: 180 }} options={cohortOptions(t)} />
                  </Form.Item>
                  <Form.Item
                    name="timeRange"
                    label={t('metrics:label.cohortRange')}
                    tooltip={t('metrics:detail.cohortRangeTooltip')}
                  >
                    <Space size={8} wrap>
                      <TimeRangeControl
                        maxDays={180}
                        value={(timeRange as TimeRange | undefined) ?? { start: '', end: '', relative: { kind: 'recent_n', n: 90 } }}
                        onChange={(next) => form.setFieldsValue({ timeRange: next })}
                      />
                      <Button size="small" type="link" onClick={() => form.setFieldsValue({ timeRange: undefined })}>
                        {t('metrics:detail.deriveFromCycle')}
                      </Button>
                      {!timeRange ? <Tag>{t('metrics:detail.derivedFromCycle')}</Tag> : null}
                    </Space>
                  </Form.Item>
                  <Form.Item name="granularity" label={t('metrics:label.granularity')}>
                    <Select style={{ minWidth: 150 }} options={granularityOptions(t)} />
                  </Form.Item>
                </Space>
              )}

              {metric.kind === 'retention' ? (
                <Alert
                  type="info"
                  showIcon
                  message={t('metrics:detail.retentionFiltersTitle')}
                  description={t('metrics:detail.retentionFiltersBody')}
                />
              ) : null}
            </Form>
          )}
        </Space>
      )}
    </Drawer>
  );
}
