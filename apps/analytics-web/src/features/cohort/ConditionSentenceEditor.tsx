import { useMemo } from 'react';
import { Button, DatePicker, Input, InputNumber, Select } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { EventSelect } from '../../components/EventSelect';
import { SELECT_POPUP } from '../../components/select-popup';
import { useT, type TFunction } from '../../i18n';
import type { CohortCondition, CohortTime } from './cohort-condition';
import '../query/analysis-workbench.css';

interface Props {
  value: CohortCondition;
  onChange: (next: CohortCondition) => void;
  onRemove?: () => void;
  userProperties?: { prop_key: string; display_name?: string }[];
  allowDidNot?: boolean;
}

function countOps(t: TFunction) {
  return [
    { label: t('cohort:condition.op.gt'), value: 'gt' },
    { label: t('cohort:condition.op.gte'), value: 'gte' },
    { label: t('cohort:condition.op.lt'), value: 'lt' },
    { label: t('cohort:condition.op.lte'), value: 'lte' },
    { label: t('cohort:condition.op.eq'), value: 'eq' },
  ];
}

function userOps(t: TFunction) {
  return [
    { label: t('cohort:condition.op.eq'), value: '=' },
    { label: t('cohort:condition.op.ne'), value: '!=' },
    { label: t('cohort:condition.op.in'), value: 'in' },
    { label: t('cohort:condition.op.notIn'), value: 'not_in' },
    { label: t('cohort:condition.op.contains'), value: 'contains' },
    { label: t('cohort:condition.op.notContains'), value: 'not_contains' },
    { label: t('cohort:condition.op.regex'), value: 'regex' },
    { label: t('cohort:condition.op.notRegex'), value: 'not_regex' },
    { label: t('cohort:condition.op.gt'), value: 'gt' },
    { label: t('cohort:condition.op.gte'), value: 'gte' },
    { label: t('cohort:condition.op.lt'), value: 'lt' },
    { label: t('cohort:condition.op.lte'), value: 'lte' },
    { label: t('cohort:condition.op.isSet'), value: 'is_set' },
    { label: t('cohort:condition.op.notSet'), value: 'not_set' },
  ];
}

function TimeControls({
  value,
  onChange,
}: {
  value: CohortTime;
  onChange: (time: CohortTime) => void;
}) {
  const { t } = useT('cohort');
  return (
    <>
      <Select
        {...SELECT_POPUP}
        value={value.mode}
        onChange={(mode) =>
          onChange(
            mode === 'static'
              ? { mode: 'static', start: dayjs().subtract(7, 'day').format('YYYY-MM-DD'), end: dayjs().subtract(1, 'day').format('YYYY-MM-DD') }
              : { mode: 'last_n_days', n: value.mode === 'last_n_days' ? value.n : 7 },
          )
        }
        options={[
          { label: t('cohort:condition.timeLastNDays'), value: 'last_n_days' },
          { label: t('cohort:condition.timeStatic'), value: 'static' },
        ]}
        style={{ minWidth: 120 }}
      />
      {value.mode === 'last_n_days' ? (
        <InputNumber min={1} max={365} value={value.n} onChange={(n) => onChange({ mode: 'last_n_days', n: n ?? 7 })} />
      ) : (
        <DatePicker.RangePicker
          value={[dayjs(value.start), dayjs(value.end)]}
          onChange={(range) => {
            if (!range?.[0] || !range[1]) return;
            onChange({ mode: 'static', start: range[0].format('YYYY-MM-DD'), end: range[1].format('YYYY-MM-DD') });
          }}
        />
      )}
    </>
  );
}

export function ConditionSentenceEditor({ value, onChange, onRemove, userProperties = [], allowDidNot = true }: Props) {
  const { t } = useT('cohort');
  const ops = useMemo(() => countOps(t), [t]);
  const propOps = useMemo(() => userOps(t), [t]);
  return (
    <div className="cohort-sentence">
      {value.type === 'did_event' ? (
        <>
          <Select
            {...SELECT_POPUP}
            value={value.polarity}
            onChange={(polarity) => onChange({ ...value, polarity })}
            options={[
              { label: t('cohort:condition.did'), value: 'did' },
              ...(allowDidNot ? [{ label: t('cohort:condition.didNot'), value: 'did_not' }] : []),
            ]}
            style={{ minWidth: 100 }}
          />
          <EventSelect showAnyEvent value={value.event || undefined} onChange={(event) => onChange({ ...value, event })} style={{ minWidth: 180 }} />
          <span>{t('cohort:condition.timesSuffix')}</span>
          <Select
            {...SELECT_POPUP}
            value={value.op}
            onChange={(op) => onChange({ ...value, op })}
            options={ops}
            style={{ minWidth: 110 }}
          />
          <InputNumber min={0} value={value.value} onChange={(n) => onChange({ ...value, value: n ?? 0 })} />
          <TimeControls value={value.time} onChange={(time) => onChange({ ...value, time })} />
        </>
      ) : null}
      {value.type === 'sequence' ? (
        <>
          <Select
            {...SELECT_POPUP}
            value={value.polarity}
            onChange={(polarity) => onChange({ ...value, polarity })}
            options={[
              { label: t('cohort:condition.sequenceDid'), value: 'did' },
              ...(allowDidNot ? [{ label: t('cohort:condition.sequenceDidNot'), value: 'did_not' }] : []),
            ]}
            style={{ minWidth: 130 }}
          />
          {value.events.map((event, index) => (
            <EventSelect
              key={index}
              showAnyEvent
              value={event || undefined}
              onChange={(next) => {
                const events = [...value.events];
                events[index] = next;
                onChange({ ...value, events });
              }}
              style={{ minWidth: 160 }}
            />
          ))}
          <Button
            size="small"
            onClick={() => onChange({ ...value, events: [...value.events, ''] })}
          >
            {t('cohort:condition.addStep')}
          </Button>
          <TimeControls value={value.time} onChange={(time) => onChange({ ...value, time })} />
        </>
      ) : null}
      {value.type === 'user_prop' ? (
        <>
          <span>{t('cohort:condition.userProp')}</span>
          <Select
            {...SELECT_POPUP}
            value={value.prop || undefined}
            onChange={(prop) => onChange({ ...value, prop })}
            options={userProperties.map((prop) => ({
              label: prop.display_name || prop.prop_key,
              value: prop.prop_key,
            }))}
            placeholder={t('cohort:condition.propPlaceholder')}
            showSearch
            optionFilterProp="label"
            style={{ minWidth: 160 }}
          />
          <Select
            {...SELECT_POPUP}
            value={value.op}
            onChange={(op) => onChange({ ...value, op })}
            options={propOps}
            style={{ minWidth: 110 }}
          />
          {value.op !== 'is_set' && value.op !== 'not_set' ? (
            <Input
              value={String(value.value ?? '')}
              onChange={(e) => onChange({ ...value, value: e.target.value })}
              placeholder={value.op === 'in' || value.op === 'not_in' ? t('cohort:condition.multiValuePlaceholder') : undefined}
              style={{ minWidth: 120 }}
            />
          ) : null}
        </>
      ) : null}
      {onRemove ? (
        <Button icon={<DeleteOutlined />} danger size="small" type="text" onClick={onRemove} aria-label={t('cohort:condition.removeAria')} />
      ) : null}
    </div>
  );
}
