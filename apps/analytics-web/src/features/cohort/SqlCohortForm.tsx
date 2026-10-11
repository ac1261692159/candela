import { Button, Input, Select, Space, Table, Typography } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import { SqlReportEditor } from '../report/SqlReportEditor';

export const DEFAULT_SQL_TEXT = `SELECT if(user_key != '', user_key, distinct_id) AS uid
FROM sa_events
WHERE event = 'AppStart'
  AND stat_date BETWEEN \${PartDate:start} AND \${PartDate:end}
GROUP BY uid`;

export type SqlTimeParam =
  | { name: string; mode: 'last_n_days'; n: number; bound: 'start' | 'end' }
  | { name: string; mode: 'static'; date: string };

export const DEFAULT_SQL_TIME_PARAMS: SqlTimeParam[] = [
  { name: 'start', mode: 'last_n_days', n: 7, bound: 'start' },
  { name: 'end', mode: 'last_n_days', n: 7, bound: 'end' },
];

interface SqlCohortFormProps {
  sqlText: string;
  timeParams: SqlTimeParam[];
  onSqlChange: (sql: string) => void;
  onTimeParamsChange: (params: SqlTimeParam[]) => void;
  previewing?: boolean;
  previewRows?: { uid: string }[];
  onPreview: () => void;
}

export function SqlCohortForm({
  sqlText,
  timeParams,
  onSqlChange,
  onTimeParamsChange,
  previewing,
  previewRows,
  onPreview,
}: SqlCohortFormProps) {
  const { t } = useT('cohort');
  const updateParam = (index: number, patch: Partial<SqlTimeParam>) => {
    onTimeParamsChange(
      timeParams.map((item, i) => {
        if (i !== index) return item;
        const next = { ...item, ...patch } as SqlTimeParam;
        if (next.mode === 'last_n_days') {
          return {
            name: next.name,
            mode: 'last_n_days',
            n: 'n' in next && next.n ? next.n : 7,
            bound: 'bound' in next && next.bound ? next.bound : 'start',
          };
        }
        return {
          name: next.name,
          mode: 'static',
          date: 'date' in next && next.date ? next.date : new Date().toISOString().slice(0, 10),
        };
      }),
    );
  };

  return (
    <div>
      <Typography.Paragraph type="secondary">
        {t('cohort:sql.hintColumn')}{' '}
        <code>uid</code>{' '}
        {t('cohort:sql.hintTables')}{' '}
        <code>sa_events</code>
        {' / '}
        <code>sa_user_profiles</code>
        {t('cohort:sql.hintTimeParam')}{' '}
        <code>{t('cohort:sql.paramExample')}</code>
        {t('cohort:sql.hintEnd')}
      </Typography.Paragraph>
      <div style={{ height: 280, marginBottom: 16 }}>
        <SqlReportEditor value={sqlText} onChange={onSqlChange} onRun={onPreview} />
      </div>
      <Typography.Paragraph strong>{t('cohort:sql.timeParamsTitle')}</Typography.Paragraph>
      {timeParams.map((param, index) => (
        <Space key={`${param.name}-${index}`} style={{ display: 'flex', marginBottom: 8 }} align="start">
          <Input
            aria-label={t('cohort:sql.paramNameAria', { index: index + 1 })}
            placeholder="name"
            value={param.name}
            style={{ width: 120 }}
            onChange={(e) => updateParam(index, { name: e.target.value })}
          />
          <Select
            aria-label={t('cohort:sql.paramModeAria', { index: index + 1 })}
            value={param.mode}
            style={{ width: 140 }}
            options={[
              { value: 'last_n_days', label: t('cohort:sql.timeLastNDays') },
              { value: 'static', label: t('cohort:sql.timeStatic') },
            ]}
            onChange={(mode: 'last_n_days' | 'static') => updateParam(index, { mode })}
          />
          {param.mode === 'last_n_days' ? (
            <>
              <Input
                aria-label={t('cohort:sql.daysAria', { index: index + 1 })}
                type="number"
                min={1}
                max={365}
                value={param.n}
                style={{ width: 88 }}
                onChange={(e) => updateParam(index, { n: Number(e.target.value) })}
              />
              <Select
                aria-label={t('cohort:sql.boundAria', { index: index + 1 })}
                value={param.bound}
                style={{ width: 88 }}
                options={[
                  { value: 'start', label: t('cohort:sql.boundStart') },
                  { value: 'end', label: t('cohort:sql.boundEnd') },
                ]}
                onChange={(bound: 'start' | 'end') => updateParam(index, { bound })}
              />
            </>
          ) : (
            <Input
              aria-label={t('cohort:sql.dateAria', { index: index + 1 })}
              type="date"
              value={param.date}
              style={{ width: 160 }}
              onChange={(e) => updateParam(index, { date: e.target.value })}
            />
          )}
          <Button
            type="text"
            icon={<MinusCircleOutlined />}
            aria-label={t('cohort:sql.removeParamAria', { name: param.name || index + 1 })}
            onClick={() => onTimeParamsChange(timeParams.filter((_, i) => i !== index))}
          />
        </Space>
      ))}
      <Button
        icon={<PlusOutlined />}
        onClick={() =>
          onTimeParamsChange([
            ...timeParams,
            { name: `p${timeParams.length + 1}`, mode: 'last_n_days', n: 7, bound: 'start' },
          ])
        }
      >
        {t('cohort:sql.addTimeParam')}
      </Button>
      <div style={{ marginTop: 16 }}>
        <Button onClick={() => void onPreview()} loading={previewing}>
          {t('cohort:sql.run')}
        </Button>
      </div>
      {previewRows ? (
        <Table
          size="small"
          style={{ marginTop: 12 }}
          rowKey="uid"
          pagination={{ pageSize: 10 }}
          dataSource={previewRows}
          columns={[{ title: t('cohort:label.userId'), dataIndex: 'uid', width: 280, ellipsis: true }]}
          scroll={{ x: 320 }}
        />
      ) : null}
    </div>
  );
}
