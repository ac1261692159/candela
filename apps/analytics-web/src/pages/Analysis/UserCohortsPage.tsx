import { useEffect, useMemo, useState } from 'react';
import { formatDateTimeFixed } from '../../i18n/format';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Dropdown,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ExclamationCircleFilled,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  deleteCohort,
  getCohorts,
  refreshCohort,
  type UserCohort,
} from '../../services/cohort.service';
import { getEvents } from '../../services/meta.service';
import { getUserProperties } from '../../services/meta.service';
import { EntityIcon } from '../../components/EntityIcon';
import { EmptyState } from '../../components/EmptyState';
import { useT } from '../../i18n';
import { lockCohort } from '../../services/iam.service';
import { useIamStore } from '../../stores/iam.store';
import { useProjectStore } from '../../stores/project.store';
import { useSubjects } from '../../features/subject/use-subjects';
import { CohortMembersDrawer } from '../../features/cohort/CohortMembersDrawer';
import { CohortTypePicker } from '../../features/cohort/CohortTypePicker';
import { cohortSummary } from '../../features/cohort/cohort-summary';

type FilterValue = 'all' | string;

function formatTime(value: string | null) {
  if (!value) return '—';
  return formatDateTimeFixed(value);
}

export function UserCohortsPage() {
  const { t } = useT('cohort');
  const navigate = useNavigate();
  const project = useProjectStore((state) => state.currentProject);
  const [items, setItems] = useState<UserCohort[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [kindFilter, setKindFilter] = useState<FilterValue>('all');
  const [statusFilter, setStatusFilter] = useState<FilterValue>('all');
  const [subjectFilter, setSubjectFilter] = useState<FilterValue>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [members, setMembers] = useState<UserCohort | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [eventLabels, setEventLabels] = useState<Record<string, string>>({});
  const [propLabels, setPropLabels] = useState<Record<string, string>>({});
  const canLock = useIamStore((s) => s.has('asset.lock'));
  const { subjects, presetId, preset } = useSubjects();
  const kindLabels = useMemo<Record<UserCohort['kind'], string>>(
    () => ({
      condition: t('cohort:kind.condition'),
      id_upload: t('cohort:kind.idUpload'),
      result: t('cohort:kind.result'),
      sql: t('cohort:kind.sql'),
    }),
    [t],
  );

  const load = async (search = keyword, options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    try {
      const res = await getCohorts({ keyword: search || undefined });
      setItems(res.items);
    } catch {
      // 静默轮询失败保留现有行：一次网络抖动不该让列表变成空状态
      if (!options.silent) setItems([]);
    } finally {
      if (!options.silent) setLoading(false);
    }
  };

  useEffect(() => {
    void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 摘要里的事件/属性显示名（取不到就回落 key——用户自己起的标识不翻译）
  useEffect(() => {
    getEvents({ page: 1, pageSize: 500 })
      .then((res) => {
        const map: Record<string, string> = {};
        res.items.forEach((item) => {
          if (item.display_name) map[item.event_key] = item.display_name;
        });
        setEventLabels(map);
      })
      .catch(() => setEventLabels({}));
    getUserProperties()
      .then((res) => {
        const map: Record<string, string> = {};
        res.items.forEach((item) => {
          if (item.display_name) map[item.prop_key] = item.display_name;
        });
        setPropLabels(map);
      })
      .catch(() => setPropLabels({}));
  }, [project]);

  const hasPending = items.some((item) => item.status === 'pending');
  useEffect(() => {
    if (!hasPending) return;
    // 静默刷新：不打开 loading（否则每 3 秒整表蒙一层 spin）
    const timer = window.setInterval(() => void load(keyword, { silent: true }), 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPending, keyword]);

  const subjectOf = (row: UserCohort) => row.subject_id || presetId;
  const subjectName = (row: UserCohort) => {
    const id = subjectOf(row);
    if (!id) return '—';
    if (id === presetId) return preset?.display_name ?? t('cohort:label.preset');
    return subjects.find((item) => item.subject_id === id)?.display_name ?? '—';
  };

  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (kindFilter === 'all' || item.kind === kindFilter) &&
          (statusFilter === 'all' || item.status === statusFilter) &&
          (subjectFilter === 'all' || subjectOf(item) === subjectFilter),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, kindFilter, statusFilter, subjectFilter, presetId, subjects],
  );

  const hasFilter = kindFilter !== 'all' || statusFilter !== 'all' || subjectFilter !== 'all';
  const clearFilters = () => {
    setKindFilter('all');
    setStatusFilter('all');
    setSubjectFilter('all');
  };

  const handleDelete = (row: UserCohort) => {
    Modal.confirm({
      title: t('cohort:cohortList.deleteTitle'),
      content: t('cohort:cohortList.deleteContent', { name: row.display_name }),
      okText: t('common:action.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common:action.cancel'),
      onOk: async () => {
        try {
          await deleteCohort(row.cohort_id);
          message.success(t('cohort:message.deleted'));
          await load();
        } catch (err) {
          const text = err instanceof Error ? err.message : '';
          // 优先按机器码判断（文案会随语言变化，机器码不会）；老后端无 errorCode 时回退文案匹配
          const errCode = (err as { errorCode?: string })?.errorCode;
          if (errCode ? errCode !== 'cohort.cardReferenced' : !text.includes('已被卡片引用') && !text.includes('已被引用')) return;
          Modal.confirm({
            title: t('cohort:cohortList.deleteReferencedTitle'),
            content: t('cohort:cohortList.deleteReferencedContent', { message: text }),
            okText: t('cohort:action.deleteAnyway'),
            okButtonProps: { danger: true },
            cancelText: t('common:action.cancel'),
            onOk: async () => {
              await deleteCohort(row.cohort_id, true);
              message.success(t('cohort:message.deleted'));
              await load();
            },
          });
        }
      },
    });
  };

  const handleRefresh = async (row: UserCohort) => {
    setRefreshing(row.cohort_id);
    try {
      await refreshCohort(row.cohort_id);
      message.success(t('cohort:message.refreshed'));
      await load();
    } finally {
      setRefreshing(null);
    }
  };

  const columns = [
    {
      title: t('cohort:label.displayName'),
      dataIndex: 'display_name',
      width: 220,
      render: (name: string, row: UserCohort) => (
        <Space size={6} wrap style={{ rowGap: 4 }}>
          <EntityIcon type="cohort" />
          <Typography.Link
            ellipsis
            /* Link 的 ellipsis 只接受布尔值（不支持 tooltip 形态），截断可读性用原生 title 兜底 */
            title={name}
            style={{ maxWidth: 150 }}
            onClick={() => navigate(`/analysis/cohorts/${row.cohort_id}`)}
          >
            {name}
          </Typography.Link>
          {row.locked ? <Tag>{t('cohort:status.locked')}</Tag> : null}
          {row.status === 'failed' ? (
            <Tooltip title={row.compute_error || t('cohort:status.computeFailed')}>
              <ExclamationCircleFilled
                style={{ color: '#ff4d4f' }}
                aria-label={t('cohort:status.computeFailed')}
              />
            </Tooltip>
          ) : null}
          {row.status === 'pending' ? <Tag>{t('cohort:status.computing')}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t('cohort:label.cohortName'),
      dataIndex: 'name',
      width: 180,
      render: (name: string) => (
        <Typography.Text type="secondary" ellipsis={{ tooltip: name }} copyable={{ text: name }} style={{ maxWidth: 150 }}>
          {name}
        </Typography.Text>
      ),
    },
    {
      title: t('cohort:cohortList.summaryColumn'),
      key: 'summary',
      width: 320,
      render: (_: unknown, row: UserCohort) => {
        const text = cohortSummary(row, t, {
          eventLabel: (key) => eventLabels[key],
          propLabel: (key) => propLabels[key],
        });
        return (
          <Tooltip title={text}>
            <Typography.Text type="secondary" ellipsis={{ tooltip: text }} style={{ maxWidth: 300 }}>
              {text}
            </Typography.Text>
          </Tooltip>
        );
      },
    },
    {
      title: t('common:label.type'),
      dataIndex: 'kind',
      /* 列内是 nowrap 的 Tag（俄 «Когорта по результату» 21 字符 ≈ 150px + Tag 内边距 + 单元格 32px）。
         110px 只够中文，长语言下 Tag 会横溢出格、压到相邻列；按最长语言（俄/泰）估宽。 */
      width: 200,
      render: (kind: UserCohort['kind']) => <Tag>{kindLabels[kind]}</Tag>,
    },
    {
      title: t('cohort:label.subject'),
      key: 'subject',
      width: 140,
      ellipsis: true,
      render: (_: unknown, row: UserCohort) => subjectName(row),
    },
    {
      title: t('cohort:label.memberCount'),
      dataIndex: 'member_count',
      /* 表头带排序图标：俄 «Число пользователей»（19 字符 ≈ 143px）+ 图标 24px，
         110px 会把表头压成三行；按最长语言估宽。 */
      width: 180,
      sorter: (a: UserCohort, b: UserCohort) => a.member_count - b.member_count,
      render: (count: number, row: UserCohort) => (
        <Button
          type="link"
          size="small"
          style={{ padding: 0 }}
          aria-label={t('cohort:member.openAria', { name: row.display_name })}
          onClick={() => setMembers(row)}
        >
          {count}
        </Button>
      ),
    },
    {
      title: t('cohort:label.lastComputedAt'),
      dataIndex: 'last_computed_at',
      width: 170,
      sorter: (a: UserCohort, b: UserCohort) =>
        String(a.last_computed_at ?? '').localeCompare(String(b.last_computed_at ?? '')),
      render: (value: string | null) => formatTime(value),
    },
    { title: t('common:label.creator'), dataIndex: 'owner', width: 140, ellipsis: true },
    {
      title: t('cohort:label.schedule'),
      dataIndex: 'schedule',
      /* 单元格文案 nowrap：俄 «По расписанию» 13 字符 ≈ 91px，加上「Способ расчёта」表头，
         100px 会截断/挤出；按最长语言估宽。 */
      width: 140,
      render: (schedule: string) =>
        schedule === 'daily' ? t('cohort:label.scheduleDaily') : t('cohort:label.scheduleManual'),
    },
    {
      title: t('common:label.actions'),
      key: 'actions',
      width: 210,
      fixed: 'right' as const,
      render: (_: unknown, row: UserCohort) => (
        <Space wrap style={{ rowGap: 4 }}>
          {row.kind === 'condition' || row.kind === 'sql' ? (
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={refreshing === row.cohort_id}
              onClick={() => void handleRefresh(row)}
            >
              {t('common:action.refresh')}
            </Button>
          ) : null}
          <Button size="small" onClick={() => navigate(`/analysis/cohorts/${row.cohort_id}`)}>
            {row.kind === 'result' ? t('common:action.view') : t('common:action.edit')}
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: 'members', label: t('cohort:action.members') },
                ...(canLock
                  ? [{ key: 'lock', label: row.locked ? t('cohort:action.unlock') : t('cohort:action.lock') }]
                  : []),
                { key: 'delete', label: t('common:action.delete'), danger: true },
              ],
              onClick: ({ key }) => {
                if (key === 'members') setMembers(row);
                if (key === 'lock') void lockCohort(row.cohort_id, !row.locked).then(() => load());
                if (key === 'delete') handleDelete(row);
              },
            }}
          >
            <Button
              size="small"
              icon={<MoreOutlined />}
              aria-label={t('cohort:action.moreAria', { name: row.display_name })}
            />
          </Dropdown>
        </Space>
      ),
    },
  ];

  const emptyText = hasFilter ? (
    <EmptyState
      variant="cohort"
      title={t('cohort:cohortList.emptyFiltered')}
      description={t('cohort:cohortList.emptyFilteredHint')}
      action={<Button onClick={clearFilters}>{t('cohort:cohortList.clearFilter')}</Button>}
    />
  ) : (
    <EmptyState
      variant="cohort"
      action={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreateOpen(true)}
          aria-label={t('cohort:cohortList.createFirstAria')}
        >
          {t('cohort:cohortList.create')}
        </Button>
      }
    />
  );

  return (
    <Card
      title={t('cohort:cohortList.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          {t('cohort:cohortList.create')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('cohort:cohortList.hint')}</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          allowClear
          placeholder={t('cohort:cohortList.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={() => void load()}
          style={{ width: 260 }}
        />
        <Button onClick={() => void load()}>{t('common:action.search')}</Button>
        <Select
          value={kindFilter}
          onChange={setKindFilter}
          style={{ minWidth: 140 }}
          options={[
            { value: 'all', label: t('cohort:cohortList.filterAllKind') },
            { value: 'condition', label: t('cohort:kind.condition') },
            { value: 'id_upload', label: t('cohort:kind.idUpload') },
            { value: 'sql', label: t('cohort:kind.sql') },
            { value: 'result', label: t('cohort:kind.result') },
          ]}
        />
        <Select
          value={statusFilter}
          onChange={setStatusFilter}
          style={{ minWidth: 140 }}
          options={[
            { value: 'all', label: t('cohort:cohortList.filterAllStatus') },
            { value: 'ready', label: t('cohort:status.ready') },
            { value: 'pending', label: t('cohort:status.computing') },
            { value: 'failed', label: t('cohort:status.computeFailed') },
          ]}
        />
        <Select
          value={subjectFilter}
          onChange={setSubjectFilter}
          style={{ minWidth: 160 }}
          options={[
            { value: 'all', label: t('cohort:cohortList.filterAllSubject') },
            ...subjects.map((item) => ({ value: item.subject_id, label: item.display_name })),
          ]}
        />
        {hasFilter ? (
          <Button type="link" onClick={clearFilters}>
            {t('cohort:cohortList.clearFilter')}
          </Button>
        ) : null}
      </Space>
      <Table
        rowKey="cohort_id"
        loading={loading}
        dataSource={filtered}
        scroll={{ x: 1920 }}
        locale={{ emptyText }}
        pagination={{
          defaultPageSize: 20,
          pageSizeOptions: [10, 20, 50],
          showSizeChanger: true,
          showTotal: (total) => t('meta:pagination.total', { count: total }),
        }}
        columns={columns}
      />
      <CohortTypePicker open={createOpen} onClose={() => setCreateOpen(false)} />
      <CohortMembersDrawer cohort={members} onClose={() => setMembers(null)} />
    </Card>
  );
}
