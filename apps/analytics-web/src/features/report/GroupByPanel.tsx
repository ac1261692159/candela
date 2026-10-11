import { Button, Form, Select, Space, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { type TFunction, useT } from '../../i18n';
import type { SqlSchema } from '../../types/report.types';
import { dslToSql } from './dsl-sql';

export interface BuilderDsl {
  event?: string;
  groups: Array<
    | { kind: 'time'; granularity: string }
    | { kind: 'property'; prop: string }
    | { kind: 'column'; prop: string }
    | { kind: 'cohort'; prop: string }
    | { kind: 'tag'; prop: string }
  >;
  metrics: Array<{ fn: string; prop?: string }>;
  filters?: {
    logic: 'and';
    items: Array<{
      scope: 'cohort' | 'tag';
      prop: string;
      op: 'in' | 'not_in' | '=';
      value?: unknown;
    }>;
  };
}

interface GroupByPanelProps {
  schema: SqlSchema | null;
  onGenerate: (dsl: BuilderDsl, sqlText: string) => void;
}

const timeOptions = (t: TFunction) => [
  { value: 'day', label: t('report:builder.byDay') },
  { value: 'hour', label: t('report:builder.byHour') },
  { value: 'week', label: t('report:builder.byWeek') },
  { value: 'month', label: t('report:builder.byMonth') },
];

const metricOptions = (t: TFunction) => [
  { value: 'count', label: t('report:builder.eventCount') },
  { value: 'uniq', label: t('report:builder.uniqueUsers') },
];

/**
 * Builder 模式分组/指标配置面板。
 * 点选分组维度 + 指标，生成 DSL 交给后端生成 SQL。
 */
export function GroupByPanel({ schema, onGenerate }: GroupByPanelProps) {
  const { t } = useT('report');
  const [form] = Form.useForm();

  const handleGenerate = () => {
    const values = form.getFieldsValue();
    const dsl: BuilderDsl = {
      event: values.event,
      groups: [],
      metrics: [],
    };
    if (values.time_granularity) {
      dsl.groups.push({ kind: 'time', granularity: values.time_granularity });
    }
    (values.props ?? []).forEach((prop: string) =>
      dsl.groups.push(prop.startsWith('col:') ? { kind: 'column', prop: prop.slice(4) } : { kind: 'property', prop }),
    );
    if (values.group_cohort) {
      dsl.groups.push({ kind: 'cohort', prop: values.group_cohort });
    }
    if (values.group_tag) {
      dsl.groups.push({ kind: 'tag', prop: values.group_tag });
    }
    (values.metrics ?? ['count']).forEach((m: string) => dsl.metrics.push({ fn: m }));
    const filterItems: NonNullable<BuilderDsl['filters']>['items'] = [];
    if (values.filter_cohort) {
      filterItems.push({
        scope: 'cohort',
        prop: values.filter_cohort,
        op: values.filter_cohort_op === 'not_in' ? 'not_in' : 'in',
      });
    }
    if (values.filter_tag) {
      filterItems.push({
        scope: 'tag',
        prop: values.filter_tag,
        op: values.filter_tag_op === 'not_in' ? 'not_in' : values.filter_tag_op === '=' ? '=' : 'in',
        value: values.filter_tag_values,
      });
    }
    if (filterItems.length) {
      dsl.filters = { logic: 'and', items: filterItems };
    }
    onGenerate(dsl, dslToSql(dsl));
  };

  return (
    <div style={{ padding: 8 }}>
      <Typography.Text strong>{t('report:builder.title')}</Typography.Text>
      <Form form={form} layout="vertical" size="small" initialValues={{ metrics: ['count'] }}>
        <Form.Item label={t('report:builder.eventOptional')} name="event">
          <Select
            allowClear
            showSearch
            placeholder={t('report:builder.selectEvent')}
            optionFilterProp="label"
            options={(schema?.events ?? []).map((e) => ({
              value: e.event_key,
              label: e.display_name && e.display_name !== e.event_key ? `${e.display_name} (${e.event_key})` : e.event_key,
            }))}
          />
        </Form.Item>
        <Form.Item label={t('report:builder.timeGranularity')} name="time_granularity">
          <Select allowClear placeholder={t('report:builder.noTimeGrouping')} options={timeOptions(t)} />
        </Form.Item>
        <Form.Item label={t('report:builder.propsGroup')} name="props">
          <Select
            mode="multiple"
            allowClear
            placeholder={t('report:builder.propsGroupPlaceholder')}
            optionFilterProp="label"
            options={[
              {
                label: t('report:builder.systemColumns'),
                options: (schema?.system_columns ?? [])
                  .filter((c) => !['event', 'log_time', 'stat_date', 'properties', 'project_name'].includes(c.name))
                  .map((c) => ({ value: `col:${c.name}`, label: `${c.desc_key ? t(c.desc_key) : c.desc}（${c.name}）` })),
              },
              {
                label: t('report:property.event'),
                options: (schema?.event_properties ?? []).map((p) => ({ value: p.prop_key, label: p.prop_key })),
              },
            ]}
          />
        </Form.Item>
        <Form.Item label={t('report:builder.cohortFilter')} name="filter_cohort">
          <Select
            allowClear
            showSearch
            placeholder={t('report:builder.noCohortFilter')}
            optionFilterProp="label"
            options={(schema?.cohorts ?? []).map((c) => ({
              value: c.cohort_id,
              label: `${c.display_name}（${c.name}）`,
            }))}
          />
        </Form.Item>
        <Form.Item label={t('report:builder.cohortFilterOp')} name="filter_cohort_op" initialValue="in">
          <Select
            options={[
              { value: 'in', label: t('report:filter.in') },
              { value: 'not_in', label: t('report:filter.notIn') },
            ]}
          />
        </Form.Item>
        <Form.Item label={t('report:builder.cohortGroup')} name="group_cohort">
          <Select
            allowClear
            showSearch
            placeholder={t('report:builder.noCohortGroup')}
            optionFilterProp="label"
            options={(schema?.cohorts ?? []).map((c) => ({
              value: c.cohort_id,
              label: `${c.display_name}（${c.name}）`,
            }))}
          />
        </Form.Item>
        <Form.Item label={t('report:builder.tagFilter')} name="filter_tag">
          <Select
            allowClear
            showSearch
            placeholder={t('report:builder.noTagFilter')}
            optionFilterProp="label"
            options={(schema?.tags ?? []).map((tag) => ({
              value: tag.tag_id,
              label: `${tag.display_name}（${tag.name}）`,
            }))}
          />
        </Form.Item>
        <Form.Item label={t('report:builder.tagFilterOp')} name="filter_tag_op" initialValue="in">
          <Select
            options={[
              { value: '=', label: t('report:filter.equals') },
              { value: 'in', label: t('report:filter.in') },
              { value: 'not_in', label: t('report:filter.notIn') },
            ]}
          />
        </Form.Item>
        <Form.Item label={t('report:builder.tagValues')} name="filter_tag_values">
          <Select
            mode="tags"
            allowClear
            placeholder={t('report:builder.tagValuesPlaceholder')}
            options={(schema?.tags ?? []).flatMap((tag) =>
              (tag.values ?? []).map((value) => ({ value, label: value })),
            )}
          />
        </Form.Item>
        <Form.Item label={t('report:builder.tagGroup')} name="group_tag">
          <Select
            allowClear
            showSearch
            placeholder={t('report:builder.noTagGroup')}
            optionFilterProp="label"
            options={(schema?.tags ?? []).map((tag) => ({
              value: tag.tag_id,
              label: `${tag.display_name}（${tag.name}）`,
            }))}
          />
        </Form.Item>
        <Form.Item label={t('report:builder.metrics')} name="metrics">
          <Select mode="multiple" options={metricOptions(t)} />
        </Form.Item>
        <Space>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleGenerate}>
            {t('report:builder.generateSql')}
          </Button>
        </Space>
      </Form>
    </div>
  );
}
