import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '../../i18n/format';
import ReactECharts from 'echarts-for-react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  getDiskTrend,
  getServerStatus,
  getLogCleanupConfigs,
  previewLogCleanup,
  executeLogCleanup,
  updateLogCleanupConfig,
  type ServerStatus,
  type LogCleanupConfigItem,
} from '../../services/ops.service';
import { buildDiskTrendView } from './disk-trend-chart';
import { useT, type TFunction } from '../../i18n';

/**
 * 运维 · 服务器状态（phase: clklog-analytics-ops-console-v1 + 数据管理 V1.1）。
 * 磁盘趋势：多目录切换（整盘 / 日志目录），GB 纵轴、按天横轴、每 7 天一个刻度、默认 180 天。
 * 日志治理（程序内实现，不依赖 cron/Puppet）：保留天数可配 + 手动清理 + 每小时自动清理（log-cleanup.service）。
 */

const STALE_LINK_MINUTES = 30;
const DEFAULT_TREND_DAYS = 180;

/** 受监控路径（与后端白名单一致）；显示名随语言变化，故由组件内的 t 构造 */
const monitoredPathsOf = (t: TFunction) => [
  { path: '/data', label: t('ops:diskTrend.pathWholeDisk') },
  { path: '/data/clklog/clklog-docker-compose/clklog_dc_data/receiver', label: t('ops:diskTrend.pathReceiver') },
];

function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** GB 固定单位（用户要求纵轴用 GB，不出现大数字） */
function formatUptime(seconds: number, t: TFunction): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return t('ops:serverStatus.uptimeDays', { days, hours });
  if (hours > 0) return t('ops:serverStatus.uptimeHours', { hours, minutes });
  return t('ops:serverStatus.uptimeMinutes', { minutes });
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? '-' : `${value.toFixed(1)}%`;
}

function loadColor(value: number, cores: number): string | undefined {
  if (!Number.isFinite(value) || cores <= 0) return undefined;
  if (value >= cores) return 'red';
  if (value >= cores * 0.7) return 'orange';
  return 'green';
}

export function ServerStatusPage() {
  const { t } = useT('ops');
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 磁盘趋势：多目录 + 180 天默认
  const [trendDays, setTrendDays] = useState(DEFAULT_TREND_DAYS);
  const [trendPath, setTrendPath] = useState('/data');
  const [diskSamples, setDiskSamples] = useState<{ sampled_at: string; value: number }[]>([]);
  const [diskTotal, setDiskTotal] = useState<number | null>(null);

  // 日志治理
  const [logConfigs, setLogConfigs] = useState<LogCleanupConfigItem[]>([]);
  const [cleaningPath, setCleaningPath] = useState<string | null>(null);
  const [previewInfo, setPreviewInfo] = useState<{ file_count: number; total_bytes: number } | null>(null);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);

  const load = useCallback(
    async (path = trendPath, days = trendDays) => {
      setLoading(true);
      setError(null);
      try {
        const hours = days * 24;
        const [next, trend, logs] = await Promise.all([
          getServerStatus(),
          getDiskTrend(hours, path).catch(() => null),
          getLogCleanupConfigs().catch(() => []),
        ]);
        setStatus(next);
        if (trend) {
          setDiskSamples(trend.samples ?? []);
          setDiskTotal(trend.current?.totalBytes ?? null);
        } else {
          setDiskSamples([]);
        }
        setLogConfigs(logs ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : t('common:message.loadFailed'));
      } finally {
        setLoading(false);
      }
    },
    [trendPath, trendDays, t],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchPath = (path: string) => {
    setTrendPath(path);
    void load(path, trendDays);
  };

  const switchDays = (days: number) => {
    setTrendDays(days);
    void load(trendPath, days);
  };

  const diskView = useMemo(
    () => buildDiskTrendView(diskSamples, diskTotal, trendDays, Date.now(), t),
    [diskSamples, diskTotal, trendDays, t],
  );

  const openCleanup = async (path: string) => {
    setCleaningPath(path);
    try {
      const p = await previewLogCleanup(path);
      setPreviewInfo({ file_count: p.file_count, total_bytes: p.total_bytes });
    } catch {
      setPreviewInfo(null);
    }
  };

  const runCleanup = async () => {
    if (!cleaningPath) return;
    setExecuting(true);
    try {
      const r = await executeLogCleanup(cleaningPath);
      message.success(
        t('ops:logCleanup.deletedFiles', { count: r.deleted_count, size: formatBytes(r.freed_bytes) }),
      );
      setConfirmPath(null);
      void load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('ops:message.executeFailed'));
    } finally {
      setExecuting(false);
    }
  };

  const toggleAuto = async (path: string, enabled: boolean) => {
    try {
      const next = await updateLogCleanupConfig(path, { enabled });
      setLogConfigs(next);
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('ops:message.updateFailed'));
    }
  };

  const changeRetainDays = async (path: string, days: number) => {
    try {
      const next = await updateLogCleanupConfig(path, { retain_days: days });
      setLogConfigs(next);
      message.success(t('ops:logCleanup.retentionUpdated', { days }));
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('ops:message.updateFailed'));
    }
  };

  const memory = status?.host.memory ?? null;
  const hostLoad = status?.host.load ?? null;
  const disk = status?.host.disks.find((d) => d.path === '/data') ?? status?.host.disks[0] ?? null;
  const ch = status?.clickhouse;

  // 数据链路停滞判定（后端给 CH 侧最后写入时间；不用 max(stat_date)，见架构文档 §4.2）
  let linkStale = false;
  let linkText = t('ops:serverStatus.unavailable');
  if (ch?.lastWriteAt) {
    const lastMs = Date.parse(ch.lastWriteAt.replace(' ', 'T'));
    if (Number.isFinite(lastMs)) {
      const minutes = Math.floor((Date.now() - lastMs) / 60000);
      linkStale = minutes > STALE_LINK_MINUTES;
      linkText = minutes < 1 ? t('ops:serverStatus.justNow') : t('ops:serverStatus.minutesAgo', { minutes });
    }
  }

  return (
    <Card
      title={t('ops:serverStatus.title')}
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          {t('common:action.refresh')}
        </Button>
      }
    >
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {!status && !error ? (
        <Typography.Text type="secondary">{t('common:state.loadingAscii')}</Typography.Text>
      ) : null}

      {status ? (
        <>
          {/* ① 概览 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={24} sm={12} md={6}>
              <Card size="small">
                <Statistic title={t('ops:serverStatus.appVersion')} value={status.app.version || '-'} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('ops:serverStatus.uptime', { value: formatUptime(status.app.uptimeSeconds, t) })}
                </Typography.Text>
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card size="small">
                <Statistic
                  title={t('ops:serverStatus.hostMemory')}
                  value={memory ? formatPercent(memory.usedPercent) : t('ops:serverStatus.unavailable')}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {memory
                    ? `${formatBytes(memory.totalBytes - memory.availableBytes)} / ${formatBytes(memory.totalBytes)}`
                    : t('ops:serverStatus.readFailed')}
                </Typography.Text>
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card size="small">
                <Statistic
                  title={t('ops:serverStatus.cpuLoad1m')}
                  value={hostLoad ? hostLoad.load1 : t('ops:serverStatus.unavailable')}
                  valueStyle={hostLoad ? { color: loadColor(hostLoad.load1, status.host.cpuCores) ?? undefined } : undefined}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {hostLoad
                    ? t('ops:serverStatus.loadDetail', {
                        load5: hostLoad.load5,
                        load15: hostLoad.load15,
                        cores: status.host.cpuCores,
                      })
                    : t('ops:serverStatus.readFailed')}
                </Typography.Text>
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card size="small">
                <Statistic
                  title={t('ops:serverStatus.diskPath', { path: disk?.path ?? '' })}
                  value={disk ? formatPercent(disk.usedPercent) : t('ops:serverStatus.unavailable')}
                  valueStyle={disk && disk.usedPercent >= 90 ? { color: 'red' } : undefined}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {disk
                    ? t('ops:serverStatus.diskUsed', {
                        used: formatBytes(disk.totalBytes - disk.freeBytes),
                        total: formatBytes(disk.totalBytes),
                      })
                    : t('ops:serverStatus.readFailed')}
                </Typography.Text>
              </Card>
            </Col>
          </Row>

          {/* ② 依赖与数据链路 */}
          <Card size="small" title={t('ops:serverStatus.dependencies')} style={{ marginBottom: 16 }}>
            <Descriptions column={{ xs: 1, sm: 2 }} size="small">
              <Descriptions.Item label="ClickHouse">
                {ch?.ok ? (
                  <Tag color="green">
                    {t('ops:serverStatus.connected', { version: ch.chVersion ?? '' })}
                  </Tag>
                ) : ch?.error ? (
                  <Tag color="red">{t('ops:serverStatus.unreachableError', { error: ch.error })}</Tag>
                ) : (
                  <Tag color="red">{t('ops:serverStatus.unreachable')}</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('ops:serverStatus.eventRowsLabel')}>
                {ch?.ok
                  ? t('ops:serverStatus.eventRowsCount', {
                      rows: (ch.eventRows ?? 0).toLocaleString('zh-CN'),
                      size: formatBytes(ch.eventBytes),
                    })
                  : '-'}
              </Descriptions.Item>
              <Descriptions.Item label={t('ops:serverStatus.lastWrite')}>
                {ch?.ok ? (
                  <Typography.Text type={linkStale ? 'danger' : undefined}>
                    {linkText}
                    {linkStale ? t('ops:serverStatus.maybeStalled') : ''}
                  </Typography.Text>
                ) : (
                  '-'
                )}
              </Descriptions.Item>
              <Descriptions.Item label="Node">
                {status.app.nodeVersion}
              </Descriptions.Item>
              <Descriptions.Item label={t('ops:serverStatus.processMemory')}>
                {formatBytes(status.app.heapUsedBytes)} / {formatBytes(status.app.rssBytes)}
              </Descriptions.Item>
              <Descriptions.Item label={t('ops:serverStatus.diskDetail')}>
                {status.host.disks.length
                  ? status.host.disks.map((d) => `${d.path} ${formatPercent(d.usedPercent)}`).join(' · ')
                  : '-'}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          {/* ③ 磁盘使用量预估：GB 纵轴 + 按天横轴（每 7 天一刻度）+ 180 天默认 + 多目录 */}
          <Card
            size="small"
            title={t('ops:diskTrend.title')}
            extra={
              <Space wrap>
                <Select
                  size="small"
                  style={{ minWidth: 220 }}
                  value={trendPath}
                  onChange={switchPath}
                  options={monitoredPathsOf(t).map((p) => ({ value: p.path, label: p.label }))}
                />
                <Select
                  size="small"
                  style={{ minWidth: 150 }}
                  value={trendDays}
                  onChange={switchDays}
                  options={[
                    { value: 7, label: t('common:time.last7Days') },
                    { value: 30, label: t('common:time.last30Days') },
                    { value: 90, label: t('ops:range.last90Days') },
                    { value: 180, label: t('ops:range.last180Days') },
                  ]}
                />
              </Space>
            }
          >
            <Typography.Paragraph style={{ marginTop: 0 }}>
              <Typography.Text strong>{diskView.forecastText}</Typography.Text>
            </Typography.Paragraph>
            {diskView.option ? (
              <ReactECharts option={diskView.option} style={{ height: 300 }} notMerge lazyUpdate />
            ) : (
              <Typography.Text type="secondary">{t('ops:diskTrend.hint')}</Typography.Text>
            )}
          </Card>

          {/* ④ 日志治理（程序内实现：每小时自动清理 + 手动治理 + 审计） */}
          <Card
            size="small"
            title={t('ops:logCleanup.title')}
            style={{ marginTop: 16 }}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('ops:logCleanup.hint')}
              </Typography.Text>
            }
          >
            <Table<LogCleanupConfigItem>
              size="small"
              rowKey="path"
              dataSource={logConfigs}
              pagination={false}
              scroll={{ x: 1100 }}
              columns={[
                {
                  title: t('ops:logCleanup.column.path'),
                  dataIndex: 'path',
                  minWidth: 340,
                  ellipsis: { showTitle: true },
                  render: (v: string, r) => (
                    <Space direction="vertical" size={0} style={{ width: '100%' }}>
                      <Typography.Text strong ellipsis={{ tooltip: r.label }}>
                        {r.label}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }} code ellipsis={{ tooltip: v }}>
                        {v}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: t('ops:logCleanup.column.current'),
                  minWidth: 170,
                  render: (_: unknown, r) =>
                    t('ops:logCleanup.currentUsage', {
                      count: r.current.file_count,
                      size: formatBytes(r.current.total_bytes),
                    }),
                },
                {
                  title: t('ops:logCleanup.column.lastRun'),
                  minWidth: 220,
                  render: (_: unknown, r) =>
                    r.last_run_at
                      ? t('ops:logCleanup.lastRun', {
                          time: formatDateTime(r.last_run_at),
                          count: r.last_file_count ?? 0,
                          size: formatBytes(r.last_freed_bytes ?? 0),
                        })
                      : t('ops:logCleanup.notRunYet'),
                },
                {
                  title: t('ops:logCleanup.column.retainDays'),
                  minWidth: 130,
                  render: (_: unknown, r) => (
                    <InputNumber
                      size="small"
                      min={1}
                      max={365}
                      value={r.retain_days}
                      onChange={(v) => v && void changeRetainDays(r.path, v)}
                    />
                  ),
                },
                {
                  title: t('ops:logCleanup.column.autoClean'),
                  minWidth: 120,
                  render: (_: unknown, r) => (
                    <Switch size="small" checked={r.enabled} onChange={(v) => void toggleAuto(r.path, v)} />
                  ),
                },
                {
                  title: t('common:label.actions'),
                  minWidth: 150,
                  render: (_: unknown, r) => (
                    <Button size="small" onClick={() => void openCleanup(r.path)}>
                      {t('ops:logCleanup.cleanNow')}
                    </Button>
                  ),
                },
              ]}
            />
          </Card>
        </>
      ) : null}

      <Modal
        title={t('ops:logCleanup.confirmTitle')}
        open={confirmPath !== null}
        onCancel={() => setConfirmPath(null)}
        onOk={() => void runCleanup()}
        confirmLoading={executing}
        okText={t('ops:logCleanup.confirmOk')}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('ops:logCleanup.confirmMessage', {
            path: cleaningPath,
            count: previewInfo?.file_count ?? 0,
            size: formatBytes(previewInfo?.total_bytes ?? 0),
          })}
          description={t('ops:logCleanup.confirmDescription')}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('ops:logCleanup.auditHint')}
        </Typography.Text>
      </Modal>
    </Card>
  );
}
