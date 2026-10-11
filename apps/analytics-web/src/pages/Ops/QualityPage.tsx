import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Collapse, DatePicker, Descriptions, Form, Input, InputNumber, Modal, Space, Switch, Tag, Typography } from 'antd';
import { SyncOutlined, SettingOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import {
  getDiscoveryLogs,
  getReconcileConfig,
  getReconcileReport,
  getReconcileSnapshot,
  saveReconcileConfig,
} from '../../services/meta.service';
import { QualityReport } from '../../features/ops/QualityReport';
import { useT } from '../../i18n';
import { formatDateTime } from '../../i18n/format';
import { useAuthStore } from '../../stores/auth.store';
import type { ReconcileConfig, ReconcileReport, ReconcileSnapshot } from '../../types/meta.types';

const { RangePicker } = DatePicker;

/**
 * 快照 → QualityReport 形状。
 * 快照自带事件级差异（diffs / only_in_one / ignored_events）与已清理区间，
 * 但**不含两侧全量事件清单**（太大，只在实时对拍响应里带回）。
 */
function snapshotToReport(s: ReconcileSnapshot): ReconcileReport {
  const events = s.events ?? { diffs: [], diff_total: 0, only_in_one: [], ignored_events: [] };
  return {
    range: s.range,
    threshold_pct: s.threshold_pct ?? 0,
    trigger: s.trigger as ReconcileReport['trigger'],
    summary: { ...s.summary, recent_changes: s.discovery_count },
    daily: s.daily ?? { items: [], has_alert: false },
    crc: s.crc ?? { total: 0, uniq: 0, dup_rows: 0, pass: true },
    events: { ...events, sa_events: [], log_analysis: [] },
    skipped: s.skipped ?? [],
    discovery_logs: [],
    report_path: s.report_path,
  } as ReconcileReport;
}

/** 对拍配置弹窗（读取人人可看，写入由后端校验平台超管） */
function ReconcileConfigModal({
  open,
  config,
  onClose,
  onSaved,
}: {
  open: boolean;
  config: ReconcileConfig | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT('ops');
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && config) {
      form.setFieldsValue({
        ...config,
        ignore_events: config.ignore_events.join('\n'),
      });
    }
  }, [open, config, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await saveReconcileConfig({
        enabled: values.enabled,
        run_at: values.run_at,
        threshold_pct: values.threshold_pct,
        ignore_events: String(values.ignore_events ?? '')
          .split('\n')
          .map((line: string) => line.trim())
          .filter(Boolean),
        skip_empty_event: values.skip_empty_event,
        stale_warn_hours: values.stale_warn_hours,
        stale_error_hours: values.stale_error_hours,
      });
      onSaved();
      onClose();
    } catch {
      // 错误提示由 api 拦截器统一处理
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('ops:quality.config.title')}
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={saving}
      okText={t('ops:quality.config.save')}
      width={560}
    >
      <Form form={form} layout="vertical" size="small">
        <Form.Item name="enabled" label={t('ops:quality.config.enabled')} valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item
          name="run_at"
          label={t('ops:quality.config.runAt')}
          extra={t('ops:quality.config.runAtHint')}
          rules={[{ pattern: /^([01]\d|2[0-3]):[0-5]\d$/, message: t('ops:quality.config.runAtInvalid') }]}
        >
          <Input placeholder="03:30" style={{ width: 140 }} />
        </Form.Item>
        <Form.Item
          name="threshold_pct"
          label={t('ops:quality.config.threshold')}
          extra={t('ops:quality.config.thresholdHint')}
          rules={[{ required: true }]}
        >
          <InputNumber min={0} max={100} step={0.1} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item
          name="ignore_events"
          label={t('ops:quality.config.ignoreEvents')}
          extra={t('ops:quality.config.ignoreEventsHint')}
        >
          <Input.TextArea rows={4} placeholder={'android_gateway_error'} />
        </Form.Item>
        <Form.Item
          name="skip_empty_event"
          label={t('ops:quality.config.skipEmpty')}
          valuePropName="checked"
          extra={t('ops:quality.config.skipEmptyHint')}
        >
          <Switch />
        </Form.Item>
        <Space size="large">
          <Form.Item name="stale_warn_hours" label={t('ops:quality.config.staleWarn')} rules={[{ required: true }]}>
            <InputNumber min={1} max={720} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="stale_error_hours" label={t('ops:quality.config.staleError')} rules={[{ required: true }]}>
            <InputNumber min={1} max={720} style={{ width: 120 }} />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}

/**
 * 页面自解释说明（phase: clklog-data-quality-ops-ia-v1，IA-AC5）。
 *
 * 背景：用户反馈「这个页面的作用没有说明」——本页术语（可信区间/已清理/超保留期/CRC）与判读方法
 * 原来只存在于仓库文档里。此区块默认展开、可收起，四段：做什么 / 术语 / 怎么读 / 谁该做什么。
 */
export function QualityGuide() {
  const { t } = useT('ops');
  const items = [
    {
      key: 'what',
      label: t('ops:quality.guide.whatTitle'),
      children: <Typography.Paragraph style={{ marginBottom: 0 }}>{t('ops:quality.guide.whatBody')}</Typography.Paragraph>,
    },
    {
      key: 'terms',
      label: t('ops:quality.guide.termsTitle'),
      children: (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {['range', 'threshold', 'crc', 'trusted', 'skipped', 'stale', 'events'].map((k) => (
            <li key={k} style={{ marginBottom: 4 }}>
              {t(`ops:quality.guide.terms.${k}`)}
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: 'how',
      label: t('ops:quality.guide.howTitle'),
      children: (
        <>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {['step1', 'step2', 'step3', 'step4'].map((k) => (
              <li key={k} style={{ marginBottom: 4 }}>
                {t(`ops:quality.guide.how.${k}`)}
              </li>
            ))}
          </ol>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('ops:quality.guide.footnote')}
          </Typography.Text>
        </>
      ),
    },
    {
      key: 'who',
      label: t('ops:quality.guide.whoTitle'),
      children: (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {['admin', 'oncall', 'analyst'].map((k) => (
            <li key={k} style={{ marginBottom: 4 }}>
              {t(`ops:quality.guide.who.${k}`)}
            </li>
          ))}
        </ul>
      ),
    },
  ];
  return (
    <Collapse
      size="small"
      style={{ marginBottom: 12 }}
      defaultActiveKey={['what']}
      items={items.map((it) => ({ ...it, label: <b>{it.label}</b> }))}
    />
  );
}

export function QualityPage() {
  const { t } = useT('ops');
  const isSuperAdmin = useAuthStore((s) => s.user?.platform_role === 'super_admin');
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [loading, setLoading] = useState(false);
  // 快照缓存：页面秒开；「开始对拍」手动触发重查询
  const [snapshot, setSnapshot] = useState<ReconcileSnapshot | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [fromSnapshot, setFromSnapshot] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [config, setConfig] = useState<ReconcileConfig | null>(null);
  const [discoveryLogs, setDiscoveryLogs] = useState<ReconcileReport['discovery_logs']>([]);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await getReconcileConfig());
    } catch {
      // 读取失败不阻塞页面（配置弹窗打开时仍是旧值）
    }
  }, []);

  // 打开页面：先读快照（毫秒级），不自动触发对拍；发现日志单独直读
  useEffect(() => {
    void (async () => {
      try {
        const [s, logs] = await Promise.all([getReconcileSnapshot(), getDiscoveryLogs(50).catch(() => [])]);
        setDiscoveryLogs(logs);
        if (s) {
          setSnapshot(s);
          setSnapshotAt(s.ran_at);
          setReport(snapshotToReport(s));
          setFromSnapshot(true);
          setRange([dayjs(s.range.from), dayjs(s.range.to)]);
        }
      } catch {
        // 无快照/读取失败：保持空态
      } finally {
        setSnapshotLoading(false);
      }
    })();
    void loadConfig();
  }, [loadConfig]);

  const load = useCallback(async (r: [Dayjs, Dayjs] | null) => {
    setLoading(true);
    setFromSnapshot(false);
    try {
      const from = r?.[0]?.format('YYYY-MM-DD');
      const to = r?.[1]?.format('YYYY-MM-DD');
      const res = await getReconcileReport({ from, to });
      const logs = await getDiscoveryLogs(50).catch(() => []);
      setReport(res);
      setDiscoveryLogs(logs);
      setSnapshotAt(new Date().toISOString());
      setSnapshot(null);
    } catch {
      // 错误提示由 api 拦截器统一处理
    } finally {
      setLoading(false);
    }
  }, []);

  const handleReconcile = () => {
    void load(range);
  };

  // 过期结论不能被当现状：快照超过阈值小时数 → 黄/红提示（PRD R1-2 / AC-2）
  const staleLevel = fromSnapshot ? snapshot?.stale_level ?? 'fresh' : 'fresh';
  const staleAlert = useMemo(() => {
    if (staleLevel === 'fresh' || !snapshot) return null;
    return (
      <Alert
        type={staleLevel === 'error' ? 'error' : 'warning'}
        showIcon
        style={{ marginBottom: 12 }}
        message={t(staleLevel === 'error' ? 'ops:quality.stale.errorTitle' : 'ops:quality.stale.warnTitle')}
        description={t('ops:quality.stale.desc', {
          time: dayjs(snapshot.ran_at).format('YYYY-MM-DD HH:mm:ss'),
          hours: snapshot.age_hours,
          warn: snapshot.stale_warn_hours,
        })}
      />
    );
  }, [staleLevel, snapshot, t]);

  return (
    <Card
      title={t('ops:quality.title')}
      extra={
        <Space>
          <Typography.Text type="secondary">
            {loading ? t('ops:quality.runningHint') : t('ops:quality.idleHint')}
          </Typography.Text>
          <Button icon={<SyncOutlined />} loading={loading} onClick={handleReconcile}>
            {t('ops:quality.start')}
          </Button>
          {isSuperAdmin ? (
            <Button icon={<SettingOutlined />} onClick={() => setConfigOpen(true)}>
              {t('ops:quality.config.button')}
            </Button>
          ) : null}
        </Space>
      }
    >
      {staleAlert}
      {snapshotAt && !loading ? (
        <Space style={{ marginBottom: 12 }} wrap>
          <Tag color={fromSnapshot ? (staleLevel === 'fresh' ? 'blue' : 'orange') : 'green'}>
            {fromSnapshot
              ? t('ops:quality.cachedTag', { time: dayjs(snapshotAt).format('YYYY-MM-DD HH:mm:ss') })
              : t('ops:quality.justFinishedTag', { time: dayjs(snapshotAt).format('YYYY-MM-DD HH:mm:ss') })}
          </Tag>
          {fromSnapshot ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('ops:quality.cachedHint')}
            </Typography.Text>
          ) : null}
        </Space>
      ) : null}
      <QualityGuide />
      {config ? (
        <Descriptions size="small" column={4} style={{ marginBottom: 12 }}>
          <Descriptions.Item label={t('ops:quality.config.enabled')}>
            {config.enabled ? (
              <Tag color="green">{t('ops:quality.config.enabledOn')}</Tag>
            ) : (
              <Tag>{t('ops:quality.config.enabledOff')}</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label={t('ops:quality.config.runAt')}>{config.run_at}</Descriptions.Item>
          <Descriptions.Item label={t('ops:quality.config.threshold')}>{`${config.threshold_pct}%`}</Descriptions.Item>
          {config.updated_at ? (
            <Descriptions.Item label={t('ops:quality.config.updatedAt')}>
              {formatDateTime(config.updated_at)}
            </Descriptions.Item>
          ) : null}
        </Descriptions>
      ) : null}
      {!snapshotLoading && !report && !loading ? (
        <Typography.Paragraph type="secondary">{t('ops:quality.emptyHint')}</Typography.Paragraph>
      ) : null}
      <Space style={{ marginBottom: 16 }}>
        <RangePicker value={range} onChange={(v) => setRange(v as [Dayjs, Dayjs] | null)} />
      </Space>
      <QualityReport
        report={report ? { ...report, discovery_logs: discoveryLogs } : null}
        loading={loading || snapshotLoading}
      />
      <ReconcileConfigModal
        open={configOpen}
        config={config}
        onClose={() => setConfigOpen(false)}
        onSaved={() => void loadConfig()}
      />
    </Card>
  );
}
