import { Button, DatePicker, Form, Input, Select, Space, Table, message } from 'antd';
import { formatDateTimeFixed } from '../../i18n/format';
import dayjs from 'dayjs';
import { useT } from '../../i18n';
import { epochOfWallClock, getPlatformTimeZone } from '../time-range/resolve';
import {
  createAlertMute,
  deleteAlertMute,
  mutePresetsOf,
  type AlertMuteItem,
  type AlertRuleItem,
} from './alerting-api';

/** 选择器墙钟按平台时区解释转 ISO（与告警窗口、查询日历同口径；原来是浏览器时区直发） */
export function dayjsToPlatformIso(value: dayjs.Dayjs): string {
  const ms = epochOfWallClock(
    getPlatformTimeZone(),
    value.year(),
    value.month() + 1,
    value.date(),
    value.hour(),
    value.minute(),
    value.second(),
  );
  return new Date(ms).toISOString();
}

export async function muteForHours(ruleCode: string | null, hours: number, reason?: string) {
  await createAlertMute({
    rule_code: ruleCode,
    duration_hours: hours,
    reason,
  });
}

export function MuteQuickButtons({
  ruleCode,
  onChanged,
}: {
  ruleCode: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useT('alerting');
  return (
    <Space wrap size={4}>
      {mutePresetsOf(t).map((preset) => (
        <Button
          key={preset.hours}
          size="small"
          onClick={() =>
            void muteForHours(ruleCode, preset.hours)
              .then(onChanged)
              .then(() => message.success(t('alerting:mute.muted', { duration: preset.label })))
          }
        >
          {preset.label}
        </Button>
      ))}
    </Space>
  );
}

export function MutePanel({
  rules,
  mutes,
  onChanged,
}: {
  rules: AlertRuleItem[];
  mutes: AlertMuteItem[];
  onChanged: () => Promise<void>;
}) {
  const [form] = Form.useForm();
  const { t } = useT('alerting');
  const submit = async () => {
    const values = await form.validateFields();
    const range = values.range as [dayjs.Dayjs, dayjs.Dayjs] | undefined;
    if (values.duration_hours) {
      await createAlertMute({
        rule_code: values.rule_code || null,
        duration_hours: Number(values.duration_hours),
        reason: values.reason,
      });
    } else if (range) {
      await createAlertMute({
        rule_code: values.rule_code || null,
        starts_at: dayjsToPlatformIso(range[0]),
        ends_at: dayjsToPlatformIso(range[1]),
        reason: values.reason,
      });
    } else {
      message.error(t('alerting:mute.needDuration'));
      return;
    }
    form.resetFields();
    await onChanged();
    message.success(t('alerting:mute.added'));
  };
  return (
    <>
    <Form form={form} layout="inline" style={{ marginBottom: 12 }} onFinish={() => void submit()}>
      <Form.Item name="rule_code" label={t('alerting:mute.scope')}>
        <Select
          allowClear
          placeholder={t('alerting:mute.allRules')}
          style={{ minWidth: 240 }}
          options={rules.map((r) => ({ value: r.code, label: r.name }))}
        />
      </Form.Item>
      <Form.Item name="duration_hours" label={t('alerting:mute.duration')}>
        <Select
          allowClear
          placeholder={t('alerting:mute.pickDuration')}
          style={{ minWidth: 170 }}
          options={mutePresetsOf(t).map((p) => ({ value: p.hours, label: p.label }))}
        />
      </Form.Item>
      <Form.Item name="range" label={t('alerting:mute.orRange')}>
        <DatePicker.RangePicker showTime />
      </Form.Item>
      <Form.Item name="reason" label={t('alerting:mute.reason')}>
        <Input placeholder={t('alerting:mute.reasonPlaceholder')} />
      </Form.Item>
      <Button type="primary" htmlType="submit">
        {t('alerting:mute.add')}
      </Button>
    </Form>
    <Table
      rowKey="id"
      size="small"
      dataSource={mutes}
      pagination={false}
      columns={[
        {
          title: t('alerting:mute.scope'),
          dataIndex: 'rule_code',
          render: (v: string | null) => v ?? t('alerting:mute.allRules'),
        },
        { title: t('alerting:mute.start'), dataIndex: 'starts_at', render: (v: string) => formatDateTimeFixed(v) },
        { title: t('alerting:mute.end'), dataIndex: 'ends_at', render: (v: string) => formatDateTimeFixed(v) },
        { title: t('alerting:mute.reason'), dataIndex: 'reason' },
        {
          title: t('common:label.actions'),
          key: 'del',
          minWidth: 130,
          render: (_: unknown, row: AlertMuteItem) => (
            <Button size="small" danger onClick={() => void deleteAlertMute(row.id).then(onChanged)}>
              {t('alerting:mute.release')}
            </Button>
          ),
        },
      ]}
    />
    </>
  );
}
