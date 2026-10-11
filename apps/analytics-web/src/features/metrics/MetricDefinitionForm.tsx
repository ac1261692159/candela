import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, InputNumber, Select, Space, Tag, Typography, message } from 'antd';
import type { FormInstance } from 'antd';
import type { FilterGroup, TimeRange, TimeRangeRelative } from '../../types/dsl.types';
import type { MetaEvent, MetaUserProperty } from '../../types/meta.types';
import {
  getEventProperties,
  getEvents,
  getUserProperties,
  getVirtualProperties,
  previewSavedMetric,
} from '../../services/meta.service';
import { FilterEditor } from '../../components/FilterEditor';
import { labeledEventProperties } from '../../components/event-property-options';
import { TimeRangeControl } from '../../features/time-range/TimeRangeControl';
import { SubjectSelect } from '../../features/subject/SubjectSelect';
import { useProjectStore } from '../../stores/project.store';
import { useT } from '../../i18n';
import { useReadyCohorts } from '../../features/cohort/use-ready-cohorts';
import { useReadyTags } from '../../features/tag/use-ready-tags';
import {
  analysisMethodLabels,
  methodsForDataType,
  percentilePresets,
  valuePickHint,
  valuePickOptions,
  valuePickWarning,
} from '../../features/query/event-metric-editor/analysis-methods';
import { analysisNeedsProp, metricWindowPayloadLabel, valuePickLabel, valuePickNote, type MetricWindowPayload } from './metric-definition';
import { transformOpOptions, type TransformOp } from '../query/event-metric-editor/metric-transform';

interface Props {
  form: FormInstance;
  /** 定义变更时回调（父级用于「未保存」提醒） */
  onDirty?: () => void;
}

/**
 * 事件指标口径表单（phase: clklog-analytics-metric-v2）。
 *
 * 与事件分析的指标卡**同深度**：分析主体 → 事件 → 属性 → 计算方法（含分位数）→ 数值变换 →
 * 取值选择 → 查询时间 → 条件组；底部「试算」直接调后端预演接口（与告警求值同一实现）。
 */
export function MetricDefinitionForm({ form, onDirty }: Props) {
  const { t, i18n } = useT('metrics');
  const project = useProjectStore((state) => state.currentProject);
  const [events, setEvents] = useState<MetaEvent[]>([]);
  const [userProperties, setUserProperties] = useState<MetaUserProperty[]>([]);
  const [eventProps, setEventProps] = useState<{ prop_key: string; display_name?: string; data_type?: string }[]>([]);
  const [preview, setPreview] = useState<{
    value_fmt: string;
    window: {
      start: string;
      end: string;
      days: number;
      label: string;
      source: string;
      /** 指标自带查询时间的相对结构（i18n 收口：界面按查看者语言渲染窗口文案） */
      relative?: TimeRangeRelative | null;
    };
    pick: string;
    pick_label: string;
    pick_note: string;
    pick_explicit: boolean;
    series: { date: string; value: number | null }[];
    elapsed_ms: number;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const event = Form.useWatch('event', form) as string | undefined;
  const analysis = Form.useWatch('analysis', form) as string | undefined;
  const prop = Form.useWatch('prop', form) as string | undefined;
  const valuePick = Form.useWatch('value_pick', form) as string | undefined;
  const timeRange = Form.useWatch('time_range', form) as TimeRange | undefined;

  useEffect(() => {
    getEvents({ pageSize: 200, exclude_hidden: true })
      .then((res) => setEvents(res.items ?? []))
      .catch(() => setEvents([]));
    getUserProperties()
      .then((res) => setUserProperties(res.items ?? []))
      .catch(() => setUserProperties([]));
  }, [project]);

  useEffect(() => {
    if (!event) {
      setEventProps([]);
      return;
    }
    let alive = true;
    void Promise.all([getEventProperties(event), getVirtualProperties(event)])
      .then(([props, virtual]) => {
        if (!alive) return;
        setEventProps(labeledEventProperties({ event: props, virtual }));
      })
      .catch(() => alive && setEventProps([]));
    return () => {
      alive = false;
    };
  }, [event, project]);

  const cohorts = useReadyCohorts();
  const tags = useReadyTags();

  const propDataType = useMemo(() => {
    if (!prop) return undefined;
    const hit = [...eventProps, ...userProperties].find((item) => item.prop_key === prop);
    return hit?.data_type;
  }, [prop, eventProps, userProperties]);

  const methodOptions = useMemo(() => {
    const labels = analysisMethodLabels(t);
    return prop
      ? methodsForDataType(propDataType).map((value) => ({ value, label: labels[value] }))
      : (Object.keys(labels) as (keyof typeof labels)[]).map((value) => ({ value, label: labels[value] }));
  }, [prop, propDataType, t]);

  const eventOptions = useMemo(
    () =>
      events
        .filter((item) => Boolean(item.event_key))
        .map((item) => ({
          value: item.event_key,
          label: item.display_name
            ? t('metrics:event.optionWithName', { key: item.event_key, name: item.display_name })
            : item.event_key,
        })),
    // t 的引用不随语言变化，依赖里带上 i18n.language 才能让下拉文案跟着刷新
    [events, t, i18n.language],
  );

  const pickWarning = valuePickWarning(analysis, valuePick);

  /** 试算：把当前表单值拼成定义直接发给后端（保存前先看数） */
  const runPreview = async () => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const values = form.getFieldsValue();
      const definition = {
        metric: {
          kind: 'event',
          event: values.event,
          analysis: values.analysis,
          prop: values.prop,
          percentile: values.percentile,
          transform:
            values.transform_value !== undefined || values.decimals !== undefined
              ? {
                  op: (values.transform_op as TransformOp | undefined) ?? 'mul',
                  value: values.transform_value,
                  decimals: values.decimals,
                }
              : undefined,
          value_pick: values.value_pick,
          time_range: values.time_range,
          filters: values.filters,
        },
      };
      const result = await previewSavedMetric(definition, project, values.format);
      setPreview(result);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  const markDirty = () => onDirty?.();

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Form.Item name="subject_id" label={t('metrics:label.subject')}>
        <SubjectSelect onChange={markDirty} />
      </Form.Item>

      <Form.Item
        name="event"
        label={t('metrics:label.event')}
        rules={[{ required: true, message: t('metrics:validation.eventRequired') }]}
      >
        <Select
          showSearch
          optionFilterProp="label"
          placeholder={t('metrics:event.searchPlaceholder')}
          options={
            event && !eventOptions.some((option) => option.value === event)
              ? [{ value: event, label: t('metrics:event.staleOption', { event }) }, ...eventOptions]
              : eventOptions
          }
          onChange={() => {
            form.setFieldsValue({ prop: undefined, analysis: 'total_times', percentile: undefined });
            markDirty();
          }}
        />
      </Form.Item>

      <Space wrap align="start" size={12}>
        <Form.Item
          name="analysis"
          label={t('metrics:label.analysis')}
          rules={[{ required: true, message: t('metrics:validation.analysisRequired') }]}
        >
          <Select
            style={{ minWidth: 200 }}
            options={methodOptions}
            onChange={(next: string) => {
              form.setFieldsValue({
                percentile: next === 'percentile' ? 50 : undefined,
                prop: analysisNeedsProp(next) ? form.getFieldValue('prop') : undefined,
              });
              markDirty();
            }}
          />
        </Form.Item>
        {analysis === 'percentile' ? (
          <Form.Item name="percentile" label={t('metrics:label.percentile')}>
            <Select
              style={{ minWidth: 160 }}
              options={percentilePresets(t)
                .filter((item) => item.value > 0)
                .map((item) => ({
                value: item.value,
                label: item.label,
              }))}
              onChange={markDirty}
            />
          </Form.Item>
        ) : null}
        <Form.Item name="prop" label={t('metrics:label.prop')} tooltip={t('metrics:prop.tooltip')}>
          <Select
            showSearch
            allowClear
            optionFilterProp="label"
            style={{ minWidth: 260 }}
            disabled={!analysisNeedsProp(analysis ?? 'total_times')}
            placeholder={
              analysisNeedsProp(analysis ?? 'total_times')
                ? t('metrics:prop.eventPlaceholder')
                : t('metrics:prop.eventDisabledPlaceholder')
            }
            options={[
              {
                label: t('metrics:prop.groupEvent'),
                options: eventProps.map((item) => ({
                  value: item.prop_key,
                  label: item.data_type
                    ? t('metrics:prop.eventWithType', { name: item.display_name || item.prop_key, type: item.data_type })
                    : item.display_name || item.prop_key,
                })),
              },
              {
                label: t('metrics:prop.groupUser'),
                options: userProperties.map((item) => ({
                  value: item.prop_key,
                  label: item.data_type
                    ? t('metrics:prop.userWithType', {
                        name: item.display_name || item.prop_key,
                        type: item.data_type,
                      })
                    : t('metrics:prop.userOnly', { name: item.display_name || item.prop_key }),
                })),
              },
            ]}
            onChange={(next: string | undefined) => {
              if (!next) {
                form.setFieldsValue({ analysis: 'total_times' });
              }
              markDirty();
            }}
          />
        </Form.Item>
      </Space>

      <Space wrap align="start" size={12}>
        <Form.Item label={t('metrics:label.transform')} tooltip={t('metrics:transform.tooltip')}>
          <Space.Compact>
            <Form.Item name="transform_op" noStyle>
              <Select
                style={{ minWidth: 120 }}
                options={transformOpOptions(t)}
                onChange={markDirty}
              />
            </Form.Item>
            <Form.Item name="transform_value" noStyle>
              <InputNumber
                style={{ width: 140 }}
                placeholder={t('metrics:transform.valuePlaceholder')}
                min={-1000000}
                max={1000000}
                step={0.01}
                onChange={markDirty}
              />
            </Form.Item>
          </Space.Compact>
        </Form.Item>
        <Form.Item name="decimals" label={t('metrics:label.decimals')}>
          <InputNumber
            style={{ width: 140 }}
            min={0}
            max={6}
            placeholder={t('metrics:decimals.placeholder')}
            onChange={markDirty}
          />
        </Form.Item>
      </Space>

      <Form.Item
        name="value_pick"
        label={t('metrics:label.valuePick')}
        extra={valuePickHint(valuePick, t) ?? t('metrics:valuePick.extra')}
      >
        <Select
          allowClear
          style={{ minWidth: 260 }}
          placeholder={t('metrics:valuePick.auto')}
          options={valuePickOptions(t).map((item) => ({ value: item.value, label: item.label }))}
          onChange={markDirty}
        />
      </Form.Item>
      {pickWarning ? <Alert type="warning" showIcon message={pickWarning} /> : null}

      <Form.Item name="time_range" label={t('metrics:label.timeRange')} extra={t('metrics:timeRange.extra')}>
        <div>
          <Space size={8} wrap>
            <TimeRangeControl
              // 未设置时用「近 7 天（含今天）」做占位（与告警默认窗口一致），但表单值仍为空 = 跟随告警窗口
              value={timeRange ?? { start: '', end: '', relative: { kind: 'recent_n', n: 7 } }}
              maxDays={90}
              onChange={(next) => {
                form.setFieldsValue({ time_range: next });
                markDirty();
              }}
            />
            <Button
              size="small"
              type="link"
              onClick={() => {
                form.setFieldsValue({ time_range: undefined });
                markDirty();
              }}
            >
              {t('metrics:timeRange.followAlert')}
            </Button>
            {!timeRange ? <Tag>{t('metrics:window.followAlert')}</Tag> : null}
          </Space>
        </div>
      </Form.Item>

      <Form.Item
        name="filters"
        label={t('metrics:label.conditionGroup')}
        extra={t('metrics:conditionGroup.extra')}
      >
        <FilterEditor
          eventProperties={eventProps}
          userProperties={userProperties.map((item) => ({
            prop_key: item.prop_key,
            display_name: item.display_name ?? undefined,
            data_type: item.data_type ?? undefined,
          }))}
          cohorts={cohorts}
          tags={tags}
        />
      </Form.Item>

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space>
          <Button onClick={() => void runPreview()} loading={previewing}>
            {t('metrics:trial.run')}
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('metrics:trial.hint')}
          </Typography.Text>
        </Space>
        {previewError ? (
          <Alert type="error" showIcon message={t('metrics:trial.failed')} description={previewError} />
        ) : null}
        {preview ? (
          <Alert
            type="success"
            showIcon
            message={t('metrics:trial.result', {
              value: preview.value_fmt,
              // 窗口 / 取值 / 说明都按查看者语言渲染：服务端给结构（days + relative + 枚举值），
              // 中文原文只在结构缺失（老响应）时兜底（i18n 收口）
              window: metricWindowPayloadLabel({
                days: preview.window.days,
                label: preview.window.label,
                source: preview.window.source as MetricWindowPayload['source'],
                relative: preview.window.relative ?? null,
              }, t),
              start: preview.window.start,
              end: preview.window.end,
              // 取值枚举值优先（按语言渲染），老响应只有中文 label 时兜底
              pick: preview.pick ? valuePickLabel(preview.pick, t) : preview.pick_label,
              auto: preview.pick_explicit ? '' : t('metrics:trial.autoSuffix'),
            })}
            description={
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('metrics:trial.note', {
                    note: (preview.pick ? valuePickNote(preview.pick, t) : null) ?? preview.pick_note,
                    ms: preview.elapsed_ms,
                  })}
                </Typography.Text>
                {preview.series.length > 0 ? (
                  <Typography.Text style={{ fontSize: 12 }}>
                    {preview.series
                      .map((point) => `${point.date.slice(5)} ${point.value ?? '—'}`)
                      .join('　')}
                  </Typography.Text>
                ) : null}
              </Space>
            }
          />
        ) : null}
      </Space>
    </Space>
  );
}

/** 表单初值 → 定义补丁（保存时调用；与 buildEventDefinition 配套） */
export function patchFromFormValues(values: Record<string, unknown>) {
  return {
    event: String(values.event ?? ''),
    analysis: String(values.analysis ?? 'total_times'),
    prop: (values.prop as string | undefined) ?? null,
    percentile: (values.percentile as number | undefined) ?? null,
    transform:
      values.transform_value !== undefined || values.decimals !== undefined
        ? {
            op: (values.transform_op as TransformOp | undefined) ?? 'mul',
            value: values.transform_value as number | undefined,
            decimals: values.decimals as number | undefined,
          }
        : null,
    value_pick: (values.value_pick as string | undefined) ?? null,
    time_range: (values.time_range as TimeRange | undefined) ?? null,
    subject_id: (values.subject_id as string | undefined) ?? null,
    filters: (values.filters as FilterGroup | undefined) ?? null,
  };
}

export function notifyValidationError(error: unknown): void {
  if (error instanceof Error && error.message) message.error(error.message);
}
