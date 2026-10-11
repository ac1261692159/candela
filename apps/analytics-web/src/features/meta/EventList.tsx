import { useEffect, useRef, useState } from 'react';
import { Table, Input, Tag, Space, Button, Select, Typography, Tooltip, message, Alert } from 'antd';
import {
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  DeleteOutlined,
  SyncOutlined,
  ExclamationCircleOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import type { MetaEvent } from '../../types/meta.types';
import { EntityIcon } from '../../components/EntityIcon';
import { EmptyState } from '../../components/EmptyState';
import { getEvents, batchEvents, refreshEventStats } from '../../services/meta.service';
import { formatNumber, formatDateTime } from '../../i18n/format';
import { useT } from '../../i18n';

interface EventListProps {
  onEdit?: (event: MetaEvent) => void;
  /** 递增时按当前筛选和分页静默重载，不卸载组件 */
  reloadToken?: number;
}

function ColumnTitle({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <Space size={4}>
      {label}
      <Tooltip title={tooltip}>
        <QuestionCircleOutlined style={{ color: '#999', cursor: 'help' }} />
      </Tooltip>
    </Space>
  );
}

export function EventList({ onEdit, reloadToken = 0 }: EventListProps) {
  const { t } = useT('meta');
  const statusMap: Record<string, { label: string; color: string }> = {
    pending: { label: t('meta:status.pending'), color: 'orange' },
    visible: { label: t('meta:status.visible'), color: 'green' },
    hidden: { label: t('meta:status.hidden'), color: 'default' },
  };

  const availabilityMap: Record<string, { label: string; color: string; icon?: React.ReactNode }> = {
    available: { label: t('meta:event.availability.available'), color: 'green' },
    no_data: { label: t('meta:event.availability.noData'), color: 'orange' },
    hidden: { label: t('common:state.hidden'), color: 'default' },
    deprecated: { label: t('meta:event.availability.deprecated'), color: 'red' },
  };

  const dataStatusMap: Record<string, { label: string; color: string; icon?: React.ReactNode }> = {
    normal: { label: t('meta:event.dataStatus.normal'), color: 'green' },
    no_recent_data: { label: t('meta:event.dataStatus.noRecentData'), color: 'orange' },
    abnormal: { label: t('meta:event.dataStatus.abnormal'), color: 'red', icon: <ExclamationCircleOutlined /> },
  };

  const eventTypeMap: Record<string, { label: string; color: string }> = {
    report: { label: t('meta:event.type.report'), color: 'blue' },
    virtual: { label: t('meta:event.type.virtual'), color: 'purple' },
    preset: { label: t('meta:event.type.preset'), color: 'cyan' },
  };

  const statusColumnFilters = [
    { text: t('meta:status.pending'), value: 'pending' },
    { text: t('meta:status.visible'), value: 'visible' },
    { text: t('meta:status.hidden'), value: 'hidden' },
  ];

  const eventTypeColumnFilters = [
    { text: t('meta:event.type.report'), value: 'report' },
    { text: t('meta:event.type.virtual'), value: 'virtual' },
    { text: t('meta:event.type.preset'), value: 'preset' },
  ];

  const availabilityColumnFilters = [
    { text: t('meta:event.availability.available'), value: 'available' },
    { text: t('meta:event.availability.noData'), value: 'no_data' },
    { text: t('common:state.hidden'), value: 'hidden' },
    { text: t('meta:event.availability.deprecated'), value: 'deprecated' },
  ];

  const dataStatusColumnFilters = [
    { text: t('meta:event.dataStatus.normal'), value: 'normal' },
    { text: t('meta:event.dataStatus.noRecentData'), value: 'no_recent_data' },
    { text: t('meta:event.dataStatus.abnormal'), value: 'abnormal' },
  ];

  const connectionStatusColumnFilters = [
    { text: t('meta:event.connection.auto'), value: 'auto' },
    { text: t('meta:event.connection.virtualFrom'), value: 'virtual_from' },
    { text: t('meta:event.connection.preset'), value: 'preset' },
  ];

  const availabilityTooltip = t('meta:event.tooltip.availability');
  const dataStatusTooltip = t('meta:event.tooltip.dataStatus');
  const connectionStatusTooltip = t('meta:event.tooltip.connection');

  const [events, setEvents] = useState<MetaEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<string | undefined>();
  const [eventType, setEventType] = useState<string | undefined>();
  const [availability, setAvailability] = useState<string | undefined>();
  const [dataStatus, setDataStatus] = useState<string | undefined>();
  const [connectionStatus, setConnectionStatus] = useState<string | undefined>();
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const skipKeywordDebounce = useRef(true);

  const load = async (
    page = pagination.current,
    pageSize = pagination.pageSize,
    options?: { silent?: boolean },
  ) => {
    if (!options?.silent) setLoading(true);
    setLoadError(null);
    try {
      const res = await getEvents({
        status,
        event_type: eventType,
        availability_status: availability,
        data_status: dataStatus,
        connection_status: connectionStatus,
        keyword: keyword || undefined,
        sort_by: 'yesterday_count',
        sort_order: 'desc',
        page,
        pageSize,
      });
      setEvents(res.items);
      setPagination({ current: res.page, pageSize: res.pageSize, total: res.total });
      setSelectedRowKeys([]);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('meta:event.loadFailed'));
    } finally {
      if (!options?.silent) setLoading(false);
    }
  };

  useEffect(() => {
    load(1, pagination.pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, eventType, availability, dataStatus, connectionStatus]);

  useEffect(() => {
    if (skipKeywordDebounce.current) {
      skipKeywordDebounce.current = false;
      return;
    }
    const timer = setTimeout(() => load(1, pagination.pageSize), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  useEffect(() => {
    if (reloadToken === 0) return;
    void load(pagination.current, pagination.pageSize, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  const handleRefreshStats = async () => {
    setRefreshing(true);
    try {
      await refreshEventStats();
      message.success(t('meta:event.statsRefreshed'));
      load();
    } catch {
      // 错误已由拦截器转成可读提示
    } finally {
      setRefreshing(false);
    }
  };

  const handleBatch = async (action: 'hide' | 'show' | 'deprecate' | 'delete') => {
    if (selectedRowKeys.length === 0) return;
    const actionLabel = {
      hide: t('meta:event.batchAction.hide'),
      show: t('meta:event.batchAction.show'),
      deprecate: t('meta:event.batchAction.deprecate'),
      delete: t('meta:event.batchAction.delete'),
    }[action];
    try {
      await batchEvents(action, selectedRowKeys as string[]);
      message.success(t('meta:event.batchResult', { action: actionLabel, count: selectedRowKeys.length }));
      load();
    } catch {
      // 错误已由拦截器转成可读提示
    }
  };

  const handleTableChange: import('antd').TableProps<MetaEvent>['onChange'] = (
    p,
    filters,
  ) => {
    const getFilterValue = (key: string) =>
      ((filters as Record<string, (React.Key | boolean)[] | null>)?.[key]?.[0] as string | undefined);
    setStatus(getFilterValue('status'));
    setEventType(getFilterValue('event_type'));
    setAvailability(getFilterValue('availability_status'));
    setDataStatus(getFilterValue('data_status'));
    setConnectionStatus(getFilterValue('connection_status'));
    if ('current' in p && (p.current !== pagination.current || p.pageSize !== pagination.pageSize)) {
      load(p.current, p.pageSize);
    }
  };

  const columns = [
    {
      title: t('meta:label.eventName'),
      dataIndex: 'event_key',
      key: 'event_key',
      minWidth: 280,
      fixed: 'left' as const,
      render: (v: string, record: MetaEvent) => (
        <Tooltip title={record.remark || undefined} placement="topLeft">
          <Space size={6} align="start">
            <EntityIcon
              type={record.event_type === 'virtual' ? 'virtual-event' : 'event'}
              style={{ marginTop: 4 }}
            />
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <Typography.Text strong ellipsis={{ tooltip: v }}>
                {v}
              </Typography.Text>
              {record.display_name && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: record.display_name }}>
                  {record.display_name}
                </Typography.Text>
              )}
              {record.remark && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: record.remark }}>
                  {record.remark}
                </Typography.Text>
              )}
            </Space>
          </Space>
        </Tooltip>
      ),
    },
    {
      title: t('meta:label.eventType'),
      dataIndex: 'event_type',
      key: 'event_type',
      minWidth: 130,
      filters: eventTypeColumnFilters,
      filteredValue: eventType ? [eventType] : null,
      render: (v: string) => {
        const map = eventTypeMap[v] || { label: v, color: 'default' };
        return <Tag color={map.color}>{map.label}</Tag>;
      },
    },
    {
      title: t('common:label.status'),
      dataIndex: 'status',
      key: 'status',
      minWidth: 120,
      filters: statusColumnFilters,
      filteredValue: status ? [status] : null,
      render: (v: string) => {
        const map = statusMap[v] || { label: v, color: 'default' };
        return <Tag color={map.color}>{map.label}</Tag>;
      },
    },
    {
      title: t('meta:label.yesterday'),
      dataIndex: 'yesterday_count',
      key: 'yesterday_count',
      minWidth: 130,
      sorter: true,
      render: (v?: number) => formatNumber(v ?? 0),
    },
    {
      title: t('meta:label.recent7d'),
      dataIndex: 'recent_7d_count',
      key: 'recent_7d_count',
      minWidth: 130,
      sorter: true,
      render: (v?: number) => formatNumber(v ?? 0),
    },
    {
      title: <ColumnTitle label={t('meta:label.availability')} tooltip={availabilityTooltip} />,
      dataIndex: 'availability_status',
      key: 'availability_status',
      minWidth: 160,
      filters: availabilityColumnFilters,
      filteredValue: availability ? [availability] : null,
      render: (v: string) => {
        const map = availabilityMap[v] || { label: v, color: 'default' };
        return <Tag color={map.color}>{map.label}</Tag>;
      },
    },
    {
      title: <ColumnTitle label={t('meta:label.dataStatus')} tooltip={dataStatusTooltip} />,
      dataIndex: 'data_status',
      key: 'data_status',
      minWidth: 170,
      filters: dataStatusColumnFilters,
      filteredValue: dataStatus ? [dataStatus] : null,
      render: (v: string) => {
        const map = dataStatusMap[v] || { label: v, color: 'default' };
        return <Tag icon={map.icon} color={map.color}>{map.label}</Tag>;
      },
    },
    {
      title: <ColumnTitle label={t('meta:label.connection')} tooltip={connectionStatusTooltip} />,
      dataIndex: 'connection_status',
      key: 'connection_status',
      minWidth: 170,
      filters: connectionStatusColumnFilters,
      filteredValue: connectionStatus ? [connectionStatus] : null,
      render: (v: string) => {
        if (v?.startsWith('virtual_from:')) {
          return <Tag color="purple">{t('meta:event.connection.virtualLabel', { name: v.split(':')[1] })}</Tag>;
        }
        return v === 'preset' ? (
          <Tag color="cyan">{t('meta:event.connection.preset')}</Tag>
        ) : (
          <Tag color="blue">{t('meta:event.connection.auto')}</Tag>
        );
      },
    },
    {
      title: t('meta:label.owner'),
      dataIndex: 'owner',
      key: 'owner',
      minWidth: 170,
      ellipsis: { showTitle: true },
      render: (v?: string) => v || '-',
    },
    {
      title: t('common:label.updatedAt'),
      dataIndex: 'updated_at',
      key: 'updated_at',
      minWidth: 180,
      render: (v?: string) => formatDateTime(v),
    },
    {
      title: t('common:label.actions'),
      key: 'action',
      minWidth: 140,
      fixed: 'right' as const,
      render: (_: unknown, record: MetaEvent) => (
        <Button
          size="small"
          icon={<EditOutlined />}
          onClick={(e) => {
            e.stopPropagation();
            onEdit?.(record);
          }}
        >
          {t('common:action.edit')}
        </Button>
      ),
    },
  ];

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          placeholder={t('common:label.status')}
          allowClear
          value={status}
          onChange={setStatus}
          options={statusColumnFilters.map((f) => ({ label: f.text, value: f.value }))}
          style={{ minWidth: 140 }}
        />
        <Select
          placeholder={t('meta:label.eventType')}
          allowClear
          value={eventType}
          onChange={setEventType}
          options={eventTypeColumnFilters.map((f) => ({ label: f.text, value: f.value }))}
          style={{ minWidth: 140 }}
        />
        <Select
          placeholder={t('meta:label.availability')}
          allowClear
          value={availability}
          onChange={setAvailability}
          options={availabilityColumnFilters.map((f) => ({ label: f.text, value: f.value }))}
          style={{ minWidth: 140 }}
        />
        <Select
          placeholder={t('meta:label.dataStatus')}
          allowClear
          value={dataStatus}
          onChange={setDataStatus}
          options={dataStatusColumnFilters.map((f) => ({ label: f.text, value: f.value }))}
          style={{ minWidth: 160 }}
        />
        <Select
          placeholder={t('meta:label.connection')}
          allowClear
          value={connectionStatus}
          onChange={setConnectionStatus}
          options={connectionStatusColumnFilters.map((f) => ({ label: f.text, value: f.value }))}
          style={{ minWidth: 160 }}
        />
        <Input.Search
          placeholder={t('meta:event.searchPlaceholder')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ minWidth: 300 }}
        />
        <Button icon={<SyncOutlined />} loading={refreshing} onClick={handleRefreshStats}>
          {t('meta:event.refreshStats')}
        </Button>
      </Space>

      {loadError && (
        <Alert
          type="error"
          showIcon
          role="alert"
          message={loadError}
          action={
            <Button size="small" onClick={() => load(pagination.current, pagination.pageSize)}>
              {t('common:action.reload')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {selectedRowKeys.length > 0 && (
        <Space style={{ marginBottom: 16 }}>
          <Typography.Text>{t('meta:event.selected', { count: selectedRowKeys.length })}</Typography.Text>
          <Button icon={<EyeInvisibleOutlined />} onClick={() => handleBatch('hide')}>
            {t('meta:event.batch.hide')}
          </Button>
          <Button icon={<EyeOutlined />} onClick={() => handleBatch('show')}>
            {t('meta:event.batch.show')}
          </Button>
          <Button icon={<ExclamationCircleOutlined />} onClick={() => handleBatch('deprecate')}>
            {t('meta:event.batch.deprecate')}
          </Button>
          <Button danger icon={<DeleteOutlined />} onClick={() => handleBatch('delete')}>
            {t('meta:event.batch.delete')}
          </Button>
        </Space>
      )}

      <Table
        rowKey="event_key"
        loading={loading}
        dataSource={events}
        columns={columns}
        pagination={{
          ...pagination,
          showSizeChanger: true,
          showTotal: (total) => t('meta:pagination.total', { count: total }),
        }}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        scroll={{ x: 1800 }}
        onRow={(record) => ({
          onClick: () => onEdit?.(record),
          style: { cursor: 'pointer' },
        })}
        onChange={handleTableChange}
        locale={{ emptyText: <EmptyState variant="meta" /> }}
      />
    </>
  );
}
