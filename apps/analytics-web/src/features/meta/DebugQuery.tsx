import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Form, Input, InputNumber, Select, Space, Table, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { debugQuery, debugRecordDetail } from '../../services/meta.service';
import { formatNumber } from '../../i18n/format';
import { useT } from '../../i18n';
import type { TFunction } from '../../i18n';
import { buildDebugColumns, errorCodeMessage, expandedProperties, windowLabel } from './debug-columns';
import { DebugHistory } from './DebugHistory';
import { isQueryHandoff } from '../../types/meta.types';
import type { DebugRecord, DebugWindow } from '../../types/meta.types';

/**
 * Debug 实时查询（phase: clklog-analytics-debug-query-v1）。
 * 按 distinct_id / user_key / 事件名查窗口内 sa_events 原始行，用于埋点接入验证。
 * 口径要点：① 时间列按「平台时区墙钟」还原（原始 log_time 是墙钟串，不是 UTC）；
 * ② 「命中 N 条」是窗口内真实命中总数，「已显示最近 M 条」才是本次返回行数；
 * ③ 窗口默认近 24 小时（1h/24h/7d 可选）——7 天 + 设备/账号维度在生产要读近 1 亿行；
 * ④ 查询结果自动留档（可在下方历史里回看，项目可关）。
 */
const WINDOWS: DebugWindow[] = ['1h', '24h', '7d'];
const DEFAULT_WINDOW: DebugWindow = '24h';
/** 超过这个秒数就提示「建议同时填事件名」（事件名是索引前缀，实测快两个数量级） */
const SLOW_HINT_SECONDS = 10;
/** 转后台后轮询留档的间隔与上限（上限到点即停轮询，结果仍会出现在历史记录里） */
const POLL_INTERVAL_MS = 2000;
const POLL_LIMIT_SECONDS = 120;

type ArchiveNote = 'archived' | 'failed' | 'disabled' | 'truncated';

/** 留档状态文案：字面量键写在 switch 里，i18n 键存在性检查才扫得到 */
function archiveNoteMessage(t: TFunction, note: ArchiveNote): string {
  switch (note) {
    case 'archived':
      return t('meta:debug.archiveSaved');
    case 'failed':
      return t('meta:debug.archiveFailed');
    case 'disabled':
      return t('meta:debug.archiveDisabled');
    case 'truncated':
      return t('meta:debug.archiveTruncated');
  }
}

/** 轮询间隔可注入：生产用默认值，测试注入小间隔以获得确定性 */
export function DebugQuery({ pollIntervalMs = POLL_INTERVAL_MS }: { pollIntervalMs?: number } = {}) {
  const { t } = useT('meta');
  const columns = useMemo(() => buildDebugColumns(t), [t]);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [records, setRecords] = useState<DebugRecord[] | null>(null);
  const [matchedTotal, setMatchedTotal] = useState(0);
  const [archiveNote, setArchiveNote] = useState<ArchiveNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyToken, setHistoryToken] = useState(0);
  /** 已转后台的任务（轮询这条留档，完成后就地渲染结果） */
  const [handoff, setHandoff] = useState<{ recordId: string; waited: number } | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
  }, []);

  // 转后台后轮询留档：done → 就地渲染；failed → 显示稳定错误码对应文案。
  // 上限 2 分钟，超时后不再轮询（结果仍会在历史记录里出现）。
  useEffect(() => {
    if (!handoff) return;
    const startedAt = Date.now();
    const id = window.setInterval(async () => {
      const waited = Math.floor((Date.now() - startedAt) / 1000);
      if (waited > POLL_LIMIT_SECONDS) {
        window.clearInterval(id);
        setHandoff((prev) => (prev ? { ...prev, waited } : prev));
        return;
      }
      setHandoff((prev) => (prev ? { ...prev, waited } : prev));
      try {
        const detail = await debugRecordDetail(handoff.recordId);
        if (detail.status === 'failed') {
          window.clearInterval(id);
          setHandoff(null);
          setError(errorCodeMessage(t, detail.error_code));
          setHistoryToken(Date.now());
          return;
        }
        if (detail.status === 'done' || detail.status === undefined) {
          window.clearInterval(id);
          setHandoff(null);
          setRecords(detail.rows ?? []);
          setMatchedTotal(detail.matched_total ?? 0);
          setArchiveNote(detail.truncated ? 'truncated' : 'archived');
          setHistoryToken(Date.now());
        }
      } catch {
        // 轮询失败（网络抖动）继续下一轮；api 层已提示
      }
    }, pollIntervalMs);
    return () => window.clearInterval(id);
  }, [handoff?.recordId, t, pollIntervalMs]);

  const onFinish = async (values: {
    distinct_id?: string;
    user_key?: string;
    event?: string;
    window?: DebugWindow;
    limit?: number;
  }) => {
    if (!values.distinct_id && !values.user_key && !values.event) {
      setError(t('meta:debug.needCondition'));
      return;
    }
    setLoading(true);
    setError(null);
    setElapsed(0);
    setHandoff(null);
    const startedAt = Date.now();
    timerRef.current = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      500,
    );
    try {
      const res = await debugQuery({
        distinct_id: values.distinct_id?.trim() || undefined,
        user_key: values.user_key?.trim() || undefined,
        event: values.event?.trim() || undefined,
        window: values.window ?? DEFAULT_WINDOW,
        limit: values.limit ?? 20,
      });
      if (isQueryHandoff(res)) {
        // 超预算：结果由后台写入这条留档，前端轮询后渲染
        setRecords(null);
        setMatchedTotal(0);
        setArchiveNote(null);
        setHandoff({ recordId: res.record_id, waited: 0 });
        setHistoryToken(Date.now());
        return;
      }
      setRecords(res.items ?? []);
      setMatchedTotal(res.matched_total ?? 0);
      setArchiveNote(
        res.archive_disabled ? 'disabled' : !res.archived ? 'failed' : res.truncated ? 'truncated' : 'archived',
      );
      setHistoryToken(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : t('meta:debug.queryFailed'));
    } finally {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      setLoading(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title={t('meta:debug.title')}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('meta:debug.alertTitle')}
          description={
            <Space direction="vertical" size={2}>
              <span>{t('meta:debug.alertDesc')}</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('meta:debug.statDateNotice')}
              </Typography.Text>
            </Space>
          }
        />
        <Form form={form} layout="inline" onFinish={onFinish} style={{ marginBottom: 16, rowGap: 8 }}>
          <Form.Item name="distinct_id" label="distinct_id">
            <Input placeholder={t('meta:debug.distinctPlaceholder')} allowClear style={{ minWidth: 200 }} />
          </Form.Item>
          <Form.Item name="user_key" label="user_key">
            <Input placeholder={t('meta:debug.userKeyPlaceholder')} allowClear style={{ minWidth: 160 }} />
          </Form.Item>
          <Form.Item name="event" label={t('meta:label.eventName')}>
            <Input placeholder={t('meta:debug.eventPlaceholder')} allowClear style={{ minWidth: 200 }} />
          </Form.Item>
          <Form.Item name="window" label={t('meta:debug.window')} initialValue={DEFAULT_WINDOW}>
            <Select
              style={{ minWidth: 160 }}
              options={WINDOWS.map((w) => ({ value: w, label: windowLabel(t, w) }))}
            />
          </Form.Item>
          <Form.Item name="limit" label={t('meta:debug.limit')} initialValue={20}>
            <InputNumber min={1} max={100} style={{ width: 80 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={loading}>
              {t('meta:debug.query')}
            </Button>
          </Form.Item>
        </Form>

        {loading && (
          <Alert
            type={elapsed >= SLOW_HINT_SECONDS ? 'warning' : 'info'}
            showIcon
            style={{ marginBottom: 16 }}
            message={t('meta:debug.querying', { seconds: elapsed })}
            description={elapsed >= SLOW_HINT_SECONDS ? t('meta:debug.slowHint') : undefined}
          />
        )}

        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

        {handoff && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={t('meta:debug.handoff', { seconds: handoff.waited })}
            description={handoff.waited > POLL_LIMIT_SECONDS ? t('meta:debug.handoffSlow') : undefined}
          />
        )}

        {!loading && archiveNote && (
          <Alert
            type={archiveNote === 'archived' ? 'success' : 'warning'}
            showIcon
            style={{ marginBottom: 16 }}
            message={archiveNoteMessage(t, archiveNote)}
          />
        )}

        {records !== null && (
          <>
            <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
              {t('meta:debug.hitTotal', { total: formatNumber(matchedTotal) })}
              {' · '}
              {t('meta:debug.shownRecent', { shown: formatNumber(records.length) })}
            </Typography.Text>
            <Table<DebugRecord>
              size="small"
              rowKey={(r) => `${r.log_time}-${r.distinct_id}-${r.event}-${r.properties?.length ?? 0}`}
              dataSource={records}
              pagination={{ pageSize: 20 }}
              expandable={{ expandedRowRender: expandedProperties }}
              columns={columns}
              scroll={{ x: 1080 }}
              locale={{ emptyText: <Space direction="vertical">{t('meta:debug.empty')}</Space> }}
            />
          </>
        )}
      </Card>

      <DebugHistory refreshToken={historyToken} />
    </Space>
  );
}
