import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { LeftOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import dayjs, { type Dayjs } from 'dayjs';
import { SubjectSelect } from '../subject/SubjectSelect';
import { errorCodeMessage, expandedProperties, renderLogTime, statusTag } from '../meta/debug-columns';
import { getPlatformTimeZone, wallClockInTz } from '../time-range/resolve';
import { getCohortMembers, getCohorts } from '../../services/cohort.service';
import { getEvents, getUserProperties } from '../../services/meta.service';
import {
  deleteUserTimelineRecord,
  queryUserTimelineNeighbors,
  getUserTimelineProfile,
  getUserTimelineRecord,
  listUserTimelineRecords,
  queryUserTimeline,
} from '../../services/user-timeline.service';
import { formatNumber } from '../../i18n/format';
import { useT } from '../../i18n';
import { isTimelineHandoff } from '../../types/user-timeline.types';
import type {
  UserTimelineNeighbors,
  UserTimelineOutcome,
  UserTimelineOverview,
  UserTimelineProfile,
  UserTimelineRecordDetail,
  UserTimelineRecordSummary,
  UserTimelineResult,
  UserTimelineRow,
} from '../../types/user-timeline.types';
import './user-timeline.css';

const POLL_INTERVAL_MS = 2000;
const POLL_LIMIT_SECONDS = 120;
const DEFAULT_RANGE_DAYS = 7;
const DEFAULT_ROWS = 500;
const ACTIVE_POLL_MS = 5000;
/** 外显属性选择在本地记忆 */
const EXTERNAL_KEYS_STORAGE = 'clklog-user-timeline-external-keys';
/** 从分群最多带入多少个用户 */
const MAX_IDS = 200;

/**
 * 表格列宽下限 + `scroll.x`（长语言版式，G.29 / i18n 设计 §14.10）。
 *
 * antd 的列只要带 `ellipsis` 就锁 `table-layout: fixed`，而列自身的 `minWidth` 只在 auto 布局下
 * 才被 rc-table 写进 `<col>` —— 所以**必须把 `scroll.x` 撑到各列下限之和**，否则俄/德/越/泰
 * （比中文长 30–100%）下每一列都会被等比压窄再截字。
 * 数值按最长语言估宽，不按中文；时间/标识列是格式串与数据，与语言无关。
 */
const DETAIL_COL_MIN = { time: 170, event: 220, distinctId: 170, property: 160, neighbors: 150 };
const DETAIL_SCROLL_X =
  DETAIL_COL_MIN.time + DETAIL_COL_MIN.event + DETAIL_COL_MIN.distinctId + DETAIL_COL_MIN.neighbors;
const RECORD_COL_MIN = { archivedAt: 170, value: 160, status: 120, count: 190, actions: 160 };
const RECORD_SCROLL_X =
  RECORD_COL_MIN.archivedAt +
  RECORD_COL_MIN.value +
  RECORD_COL_MIN.status +
  RECORD_COL_MIN.count +
  RECORD_COL_MIN.actions;
const NEIGHBORS_COL_MIN = { time: 170, event: 240, distinctId: 200 };
const NEIGHBORS_SCROLL_X =
  NEIGHBORS_COL_MIN.time + NEIGHBORS_COL_MIN.event + NEIGHBORS_COL_MIN.distinctId;

/** dayjs → 平台时区墙钟串（`YYYY-MM-DD HH:mm`），服务端按平台时区解释 */
function toWallClock(value: Dayjs, tz: string): string {
  const w = wallClockInTz(tz, value.valueOf());
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}`;
}

/**
 * 用户行为序列（phase: clklog-analytics-user-timeline-ux-v1 改版）。
 *
 * 与 Debug 的区别（用户反馈过「太像 Debug」）：这里是**画像 + 概览 + 明细**三段式 ——
 * 左栏回答「这个人是谁」（用户属性/标签），右栏先给「他这段时间怎么样」（每日趋势 + 事件占比），
 * 明细在下面且支持**外显属性**（关注的事件属性直接成列）；查询记录收进抽屉，不再占主界面。
 */
export function UserTimeline({
  pollIntervalMs = POLL_INTERVAL_MS,
  activePollMs = ACTIVE_POLL_MS,
}: { pollIntervalMs?: number; activePollMs?: number } = {}) {
  const { t } = useT('analysis', 'meta', 'common');
  const tz = getPlatformTimeZone();

  const [subjectId, setSubjectId] = useState<string | undefined>();
  /** 标识口径：用户标识（预置主体）/ 用户属性 / 事件属性 —— 使用者往往只知道业务属性（如 massid） */
  const [idKind, setIdKind] = useState<'subject' | 'user_property'>('subject');
  const [idKey, setIdKey] = useState<string | undefined>();
  const [propOptions, setPropOptions] = useState<{ value: string; label: string }[]>([]);
  const [idsText, setIdsText] = useState('');
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(DEFAULT_RANGE_DAYS, 'day'), dayjs()]);
  const [events, setEvents] = useState<string[]>([]);
  const [eventOptions, setEventOptions] = useState<{ value: string; label: string }[]>([]);
  const [cohortId, setCohortId] = useState<string | undefined>();
  const [cohorts, setCohorts] = useState<{ value: string; label: string }[]>([]);
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [index, setIndex] = useState(0);

  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [profile, setProfile] = useState<UserTimelineProfile | null>(null);
  const [overview, setOverview] = useState<UserTimelineOverview | null>(null);
  const [result, setResult] = useState<UserTimelineResult | null>(null);
  const [handoff, setHandoff] = useState<{ recordId: string; waited: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState('');
  /** 服务端行级筛选（属性等值；应用后重查） */
  const [filterKey, setFilterKey] = useState<string | undefined>();
  const [filterValue, setFilterValue] = useState('');
  /** 查看前后行为 */
  const [neighbors, setNeighbors] = useState<{ anchor: UserTimelineRow; data: UserTimelineNeighbors } | null>(null);
  const [neighborsLoading, setNeighborsLoading] = useState(false);
  const [externalKeys, setExternalKeys] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(EXTERNAL_KEYS_STORAGE);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  const [recordsOpen, setRecordsOpen] = useState(false);
  const [records, setRecords] = useState<UserTimelineRecordSummary[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [detail, setDetail] = useState<UserTimelineRecordDetail | null>(null);
  const [recordsToken, setRecordsToken] = useState(0);
  const timerRef = useRef<number | null>(null);

  const ids = useMemo(() => idsText.split(/[\s,，;；]+/).map((v) => v.trim()).filter(Boolean), [idsText]);
  const currentId = ids[Math.min(index, Math.max(0, ids.length - 1))] ?? '';

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
  }, []);

  useEffect(() => {
    getEvents({ page: 1, pageSize: 200 })
      .then((res) =>
        setEventOptions(
          (res.items ?? []).map((e) => ({
            value: e.event_key,
            label: e.display_name ? `${e.display_name}（${e.event_key}）` : e.event_key,
          })),
        ),
      )
      .catch(() => setEventOptions([]));
    getCohorts()
      .then((res) =>
        setCohorts((res.items ?? []).map((c) => ({ value: c.cohort_id, label: c.display_name || c.name }))),
      )
      .catch(() => setCohorts([]));
  }, []);

  // 属性字典（用户属性 / 事件属性）——「按属性查」的候选项
  useEffect(() => {
    if (idKind === 'subject') return;
    const load = async () => {
      try {
        const res = await getUserProperties();
        setPropOptions(
          (res.items ?? []).map((item) => ({
            value: item.prop_key,
            // 展示名是用户自己起的（不译）；「展示名 +（键）」这套组合格式是平台生成的，按语言走键
            label: t('analysis:userTimeline.propertyOption', {
              name: item.display_name || item.prop_key,
              key: item.prop_key,
            }),
          })),
        );
      } catch {
        setPropOptions([]);
      }
    };
    void load();
  }, [idKind, t]);

  const eventLabel = useCallback(
    (key: string) => eventOptions.find((o) => o.value === key)?.label ?? key,
    [eventOptions],
  );

  const runQuery = useCallback(
    async (value: string) => {
      if (!value) {
        setError(t('analysis:error.timeline.valueRequired'));
        return;
      }
      setLoading(true);
      setError(null);
      setElapsed(0);
      setHandoff(null);
      setResult(null);
      setProfile(null);
      setOverview(null);
      const startedAt = Date.now();
      timerRef.current = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
      try {
        // 画像与行为并行：画像失败降级为空，不阻断行为数据
        // 按属性查时把口径传下去：后端解析出标识后回带，页面显示「已解析为用户标识 …」
        void getUserTimelineProfile({
          value,
          subject_id: idKind === 'subject' ? subjectId : undefined,
          ...(idKind !== 'subject' && idKey ? { id_kind: idKind, id_key: idKey } : {}),
        })
          .then(setProfile)
          .catch(() => setProfile({ attributes: {}, tags: [], resolved: null, matched_users: 0 }));

        const outcome: UserTimelineOutcome = await queryUserTimeline({
          subject_id: idKind === 'subject' ? subjectId : undefined,
          ...(idKind !== 'subject' && idKey ? { id_kind: idKind, id_key: idKey } : {}),
          ...(filterKey && filterValue.trim() ? { filter_key: filterKey, filter_value: filterValue.trim() } : {}),
          value,
          from: toWallClock(range[0], tz),
          to: toWallClock(range[1], tz),
          ...(events.length ? { events } : {}),
          order,
          limit: rows,
        });
        // 概览先行：明细转后台时图已经在了
        setOverview(outcome.overview ?? null);
        if (isTimelineHandoff(outcome)) {
          setHandoff({ recordId: outcome.record_id, waited: 0 });
          setRecordsToken(Date.now());
          return;
        }
        setResult(outcome);
        setRecordsToken(Date.now());
      } catch (e) {
        setError(e instanceof Error ? e.message : t('meta:debug.queryFailed'));
      } finally {
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        setLoading(false);
      }
    },
    [events, filterKey, filterValue, idKey, idKind, order, range, rows, subjectId, t, tz],
  );

  const goTo = useCallback(
    (nextIndex: number) => {
      if (!ids.length) return;
      const wrapped = (nextIndex + ids.length) % ids.length;
      setIndex(wrapped);
      void runQuery(ids[wrapped]);
    },
    [ids, runQuery],
  );

  // 转后台后轮询记录；完成后就地渲染（概览已在，只补明细）
  useEffect(() => {
    if (!handoff) return;
    const startedAt = Date.now();
    const id = window.setInterval(async () => {
      const waited = Math.floor((Date.now() - startedAt) / 1000);
      setHandoff((prev) => (prev ? { ...prev, waited } : prev));
      if (waited > POLL_LIMIT_SECONDS) {
        window.clearInterval(id);
        return;
      }
      try {
        const record = await getUserTimelineRecord(handoff.recordId);
        if (record.status === 'failed') {
          window.clearInterval(id);
          setHandoff(null);
          setError(errorCodeMessage(t, record.error_code));
          setRecordsToken(Date.now());
          return;
        }
        if (record.status === 'done' || record.status === undefined) {
          window.clearInterval(id);
          setHandoff(null);
          setResult({
            items: record.rows ?? [],
            matched_total: record.matched_total,
            shown_total: record.row_count,
            event_kinds: 0,
            first_log_time: null,
            last_log_time: null,
            truncated: record.truncated,
            from: '',
            to: '',
            order,
            archived: true,
            record_id: record.id,
          });
          setRecordsToken(Date.now());
        }
      } catch {
        // 网络抖动继续下一轮
      }
    }, pollIntervalMs);
    return () => window.clearInterval(id);
  }, [handoff?.recordId, order, pollIntervalMs, t]);

  const loadRecords = useCallback(async () => {
    setRecordsLoading(true);
    try {
      const res = await listUserTimelineRecords({ page: 1, pageSize: 10 });
      setRecords(res.items ?? []);
    } catch {
      // api 层已提示
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!recordsOpen) return;
    void loadRecords();
  }, [recordsOpen, loadRecords, recordsToken]);

  const hasActive = records.some((r) => r.status === 'pending' || r.status === 'running');
  useEffect(() => {
    if (!recordsOpen || !hasActive) return;
    const id = window.setInterval(() => void loadRecords(), activePollMs);
    return () => window.clearInterval(id);
  }, [recordsOpen, hasActive, loadRecords, activePollMs]);

  const openNeighbors = useCallback(
    async (anchor: UserTimelineRow) => {
      setNeighborsLoading(true);
      setNeighbors(null);
      try {
        const data = await queryUserTimelineNeighbors({
          subject_id: subjectId,
          value: currentId,
          from: toWallClock(range[0], tz),
          to: toWallClock(range[1], tz),
          anchor: anchor.log_time,
          ...(events.length ? { events } : {}),
          order,
          // 只取锚点前后各 10 条（契约里 limit 即「前后各 N 条」）
          limit: 10,
        });
        setNeighbors({ anchor, data });
      } catch (e) {
        message.error(e instanceof Error ? e.message : t('meta:debug.queryFailed'));
      } finally {
        setNeighborsLoading(false);
      }
    },
    [currentId, events, order, range, subjectId, t, tz],
  );

  const bringFromCohort = async (value: string) => {
    setCohortId(value);
    try {
      const res = await getCohortMembers(value, { limit: MAX_IDS });
      const members = Array.from(new Set((res.items ?? []).map((m) => m.uid).filter(Boolean))).slice(0, MAX_IDS);
      if (!members.length) {
        message.info(t('analysis:userTimeline.cohortEmpty'));
        return;
      }
      setIdsText(members.join('\n'));
      setIndex(0);
      message.success(t('analysis:userTimeline.cohortLoaded', { count: members.length }));
    } catch {
      // api 层已提示
    }
  };

  // 外显属性候选：明细里实际出现过的键（按频次）
  const externalCandidates = useMemo(() => {
    const freq = new Map<string, number>();
    for (const row of result?.items ?? []) {
      try {
        const parsed = JSON.parse(row.properties) as Record<string, unknown>;
        for (const key of Object.keys(parsed)) freq.set(key, (freq.get(key) ?? 0) + 1);
      } catch {
        // 非 JSON 跳过
      }
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([key]) => ({ value: key, label: key }));
  }, [result]);

  useEffect(() => {
    try {
      localStorage.setItem(EXTERNAL_KEYS_STORAGE, JSON.stringify(externalKeys));
    } catch {
      // 隐私模式下写入失败可忽略
    }
  }, [externalKeys]);

  const propertiesOf = useCallback((row: UserTimelineRow): Record<string, unknown> => {
    try {
      return JSON.parse(row.properties) as Record<string, unknown>;
    } catch {
      return {};
    }
  }, []);

  /** 明细列 = 时间/事件/distinct_id + **外显属性列**（选中的属性直接成列，不必展开） */
  const detailColumns = useMemo(
    () => [
      {
        title: t('meta:debug.column.time'),
        dataIndex: 'log_time',
        minWidth: DETAIL_COL_MIN.time,
        render: (v: string) => renderLogTime(v),
      },
      {
        title: t('analysis:userTimeline.events'),
        dataIndex: 'event',
        minWidth: DETAIL_COL_MIN.event,
        // 列头是译文（俄 «События» / 泰 «อีเวนต์»），值可能是长事件名（用户数据）：截断时给 title
        ellipsis: { showTitle: true },
        render: (v: string) => eventLabel(v),
      },
      {
        title: 'distinct_id',
        dataIndex: 'distinct_id',
        minWidth: DETAIL_COL_MIN.distinctId,
        ellipsis: { showTitle: true },
      },
      ...externalKeys.map((key) => ({
        title: key,
        key,
        minWidth: DETAIL_COL_MIN.property,
        ellipsis: { showTitle: true },
        render: (_: unknown, row: UserTimelineRow) => {
          const value = propertiesOf(row)[key];
          return value === undefined || value === null ? '-' : String(value);
        },
      })),
    ],
    [eventLabel, externalKeys, propertiesOf, t],
  );

  const dailyOption = useMemo(
    () => ({
      grid: { left: 44, right: 16, top: 24, bottom: 28 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: (overview?.daily ?? []).map((d) => d.date) },
      yAxis: { type: 'value' },
      series: [
        { type: 'line', smooth: true, areaStyle: { opacity: 0.15 }, data: (overview?.daily ?? []).map((d) => d.count) },
      ],
    }),
    [overview],
  );

  const pieOption = useMemo(() => {
    const items = overview?.events ?? [];
    const top = items.slice(0, 10);
    const rest = items.slice(10).reduce((sum, e) => sum + e.count, 0);
    const data = top.map((e) => ({ name: eventLabel(e.event), value: e.count }));
    if (rest > 0) data.push({ name: t('analysis:userTimeline.others'), value: rest });
    return {
      tooltip: { trigger: 'item' },
      legend: { type: 'scroll', orient: 'vertical', right: 0, top: 8, bottom: 8 },
      series: [{ type: 'pie', radius: ['40%', '68%'], center: ['34%', '50%'], data }],
    };
  }, [eventLabel, overview, t]);

  /** 明细行 = 服务端筛选后的结果（筛选会重查，界面如实标注） */
  const visibleRows = result?.items ?? [];

  /** 筛选键候选：已出现的属性键（来自当前结果） */
  const filterKeyOptions = useMemo(() => externalCandidates, [externalCandidates]);

  const filteredTags = (profile?.tags ?? []).filter((tag) =>
    tagFilter ? `${tag.name}${tag.value}`.toLowerCase().includes(tagFilter.toLowerCase()) : true,
  );

  /** KPI 卡标题：有值是用户标识（用户数据，可能是长 ID），没值才是译后的列名 */
  const valueTitle = currentId || t('analysis:userTimeline.value');

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }} className="user-timeline">
      <Card
        title={t('analysis:userTimeline.title')}
        extra={<Button onClick={() => setRecordsOpen(true)}>{t('analysis:userTimeline.recordsButton')}</Button>}
      >
        <Space wrap size={12} style={{ marginBottom: 12 }}>
          <Space size={6}>
            <Typography.Text type="secondary">{t('analysis:userTimeline.subject')}</Typography.Text>
            {/* 主体名是用户数据（俄/德主体名普遍比中文长），固定 140px 会截断值 → 下限 + 允许增长 */}
            <SubjectSelect value={subjectId} onChange={setSubjectId} style={{ minWidth: 180 }} />
          </Space>
          <Space size={6}>
            <Typography.Text type="secondary">{t('analysis:userTimeline.range')}</Typography.Text>
            <DatePicker
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              value={range[0]}
              onChange={(d) => d && setRange([d, range[1]])}
            />
            <Typography.Text type="secondary">~</Typography.Text>
            <DatePicker
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              value={range[1]}
              onChange={(d) => d && setRange([range[0], d])}
            />
          </Space>
          <Space size={6}>
            <Typography.Text type="secondary">{t('analysis:userTimeline.events')}</Typography.Text>
            <Select
              mode="multiple"
              allowClear
              value={events}
              onChange={setEvents}
              options={eventOptions}
              placeholder={t('analysis:userTimeline.eventsPlaceholder')}
              optionFilterProp="label"
              maxTagCount="responsive"
              // 下限按俄语占位符 «Все события (необязательно)»（≈235px）估；选项标签是字符串，
              // rc-select 会给已选项与标签自动加 title，截断可悬停看全称
              style={{ minWidth: 240 }}
            />
          </Space>
          {/* 分段控件是导航：俄 «Сначала новые» / «Сначала старые» 一旦被压窄就只剩省略号，
              真正的兜底是 .user-timeline .ant-segmented 的 min-width: max-content（按内容占宽），
              再加标签上的 title；容器（Space wrap）负责放不下时整块换行 */}
          <Segmented
            value={order}
            onChange={(v) => setOrder(v as 'desc' | 'asc')}
            options={[
              // title 落在 .ant-segmented-item-label（就是被 ellipsis 裁的那个元素）上，悬停可看全称
              {
                value: 'desc',
                label: t('analysis:userTimeline.orderDesc'),
                title: t('analysis:userTimeline.orderDesc'),
              },
              { value: 'asc', label: t('analysis:userTimeline.orderAsc'), title: t('analysis:userTimeline.orderAsc') },
            ]}
          />
          <Space size={6}>
            <Typography.Text type="secondary">{t('analysis:userTimeline.rows')}</Typography.Text>
            <InputNumber
              min={50}
              max={5000}
              step={50}
              value={rows}
              onChange={(v) => setRows(v ?? DEFAULT_ROWS)}
              style={{ width: 90 }}
            />
          </Space>
        </Space>

        <Space align="start" wrap size={12} style={{ marginBottom: 8 }}>
          <Space size={6}>
            <Typography.Text type="secondary">{t('analysis:userTimeline.idKind')}</Typography.Text>
            {/* 选项是译文：俄 «ID пользователя» / «Свойство пользователя» 单选值约 200px，
                原 150px 固定宽会把值截成 «ID пользо…» —— 改下限，让控件按内容增长 */}
            <Select
              value={idKind}
              onChange={(v) => {
                setIdKind(v);
                setIdKey(undefined);
              }}
              style={{ minWidth: 200 }}
              options={[
                { value: 'subject', label: t('analysis:userTimeline.idKindSubject') },
                { value: 'user_property', label: t('analysis:userTimeline.idKindUserProperty') },
              ]}
            />
          </Space>
          {idKind !== 'subject' && (
            <Select
              value={idKey}
              onChange={setIdKey}
              options={propOptions}
              placeholder={t('analysis:userTimeline.idKeyPlaceholder')}
              showSearch
              optionFilterProp="label"
              // 占位符俄 «Выберите свойство (например massid)» ≈ 300px，选项是用户属性名（数据）
              style={{ minWidth: 260 }}
            />
          )}
          {/* 口径说明是整句话（俄 ≈ 2.2×中文）：允许换行 + 长词折行，并给下限避免被挤成一条窄柱 */}
          <Typography.Text
            type="secondary"
            style={{
              fontSize: 12,
              display: 'inline-block',
              minWidth: 220,
              maxWidth: '100%',
              whiteSpace: 'normal',
              overflowWrap: 'break-word',
            }}
          >
            {idKind === 'subject' ? t('analysis:userTimeline.idHintSubject') : t('analysis:userTimeline.idHintProperty')}
          </Typography.Text>
          {idKind !== 'subject' && profile?.resolved && (
            <Tag
              color="blue"
              // antd Tag 是 nowrap：俄 «Определён идентификатор пользователя … · Совпало пользователей: N» 会顶出卡片
              style={{ fontSize: 12, whiteSpace: 'normal', overflowWrap: 'break-word', maxWidth: '100%' }}
            >
              {t('analysis:userTimeline.resolvedTo', {
                id: profile.resolved.user_key || profile.resolved.distinct_id,
              })}
              {profile.matched_users && profile.matched_users > 1
                ? ` · ${t('analysis:userTimeline.resolvedMany', { users: profile.matched_users })}`
                : ''}
            </Tag>
          )}
        </Space>

        <Space align="start" wrap size={12}>
          <Input.TextArea
            value={idsText}
            onChange={(e) => setIdsText(e.target.value)}
            // 占位符是整句话（俄 «По одному ID пользователя в строке…» ≈ 440px）：TextArea 内自动折行，
            // 宽度取下限，窄视口不再把输入框压到比内容还窄
            placeholder={t('analysis:userTimeline.idsPlaceholder')}
            autoSize={{ minRows: 2, maxRows: 4 }}
            style={{ minWidth: 320, maxWidth: '100%' }}
          />
          <Space direction="vertical" size={6}>
            <Select
              value={cohortId}
              onChange={(v) => void bringFromCohort(v)}
              options={cohorts}
              placeholder={t('analysis:userTimeline.cohortPlaceholder')}
              // 分群名是用户数据（可长）；占位符俄 «Взять из когорты» 约 130px
              style={{ minWidth: 220 }}
              allowClear
            />
            <Typography.Text
              type="secondary"
              // 俄 «Распознано ID пользователей: N» ≈ 250px，要能折行而不是被截
              style={{ fontSize: 12, whiteSpace: 'normal', overflowWrap: 'break-word' }}
            >
              {t('analysis:userTimeline.idsHint', { count: ids.length })}
            </Typography.Text>
          </Space>
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={loading}
            onClick={() => void runQuery(currentId)}
            // 按属性查必须先选属性键：否则会按标识口径静默跑出空结果（服务端同样有 400 兜底）
            disabled={!ids.length || (idKind !== 'subject' && !idKey)}
          >
            {t('meta:debug.query')}
          </Button>
        </Space>

        {loading && (
          <Alert
            type={elapsed >= 8 ? 'warning' : 'info'}
            showIcon
            style={{ marginTop: 12 }}
            message={t('meta:debug.querying', { seconds: elapsed })}
          />
        )}
        {handoff && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message={t('meta:debug.handoff', { seconds: handoff.waited })}
            description={handoff.waited > POLL_LIMIT_SECONDS ? t('meta:debug.handoffSlow') : undefined}
          />
        )}
        {error && <Alert type="error" showIcon style={{ marginTop: 12 }} message={error} />}
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={6}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card
              size="small"
              // 标题是「用户标识」或数据里的长 ID（用户数据）：容器放开换行（见 user-timeline.css），
              // 再补 title 让被折/被截的值可悬停看全称
              title={<span title={valueTitle}>{valueTitle}</span>}
              extra={
                ids.length > 1 ? (
                  <Space size={4}>
                    <Button size="small" icon={<LeftOutlined />} onClick={() => goTo(index - 1)} />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {Math.min(index + 1, ids.length)}/{ids.length}
                    </Typography.Text>
                    <Button size="small" icon={<RightOutlined />} onClick={() => goTo(index + 1)} />
                  </Space>
                ) : null
              }
            >
              <Descriptions size="small" column={1} colon={false}>
                <Descriptions.Item label={t('analysis:userTimeline.hitTotalLabel')}>
                  {formatNumber(result?.matched_total ?? 0)}
                </Descriptions.Item>
                <Descriptions.Item label={t('analysis:userTimeline.shownTotalLabel')}>
                  {formatNumber(result?.shown_total ?? 0)}
                </Descriptions.Item>
                <Descriptions.Item label={t('analysis:userTimeline.kindsLabel')}>
                  {overview?.events?.length ?? 0}
                </Descriptions.Item>
                {profile && (
                  <Descriptions.Item label={t('analysis:userTimeline.attributesLabel')}>
                    {Object.keys(profile.attributes).length}
                  </Descriptions.Item>
                )}
                {profile && (
                  <Descriptions.Item label={t('analysis:userTimeline.tagsLabel')}>{profile.tags.length}</Descriptions.Item>
                )}
              </Descriptions>
              {result?.first_log_time && result?.last_log_time && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {result.first_log_time} ~ {result.last_log_time}
                </Typography.Text>
              )}
            </Card>

            <Card size="small" title={t('analysis:userTimeline.attributesTitle')}>
              {profile && Object.keys(profile.attributes).length ? (
                <Descriptions
                  size="small"
                  column={1}
                  colon={false}
                  // 左栏在 lg 断点只占 1/4 宽（约 248px），值列只剩 ~120px。标签/值都是用户数据
                  // （属性键与属性值，长度不受控）：标签允许换行 + 长词折行，值截断时用 tooltip 兜底可读
                  labelStyle={{ width: 120, fontSize: 12, whiteSpace: 'normal', overflowWrap: 'break-word' }}
                  contentStyle={{ minWidth: 0 }}
                >
                  {Object.entries(profile.attributes)
                    .slice(0, 30)
                    .map(([key, value]) => {
                      const text = String(value ?? '-');
                      return (
                        <Descriptions.Item key={key} label={<span title={key}>{key}</span>}>
                          <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: text }}>
                            {text}
                          </Typography.Text>
                        </Descriptions.Item>
                      );
                    })}
                </Descriptions>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('analysis:userTimeline.noAttributes')} />
              )}
            </Card>

            <Card
              size="small"
              title={t('analysis:userTimeline.tagsTitle')}
              extra={
                <Input
                  size="small"
                  allowClear
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                  placeholder={t('analysis:userTimeline.tagSearch')}
                  // 占位符是译文（俄 «Поиск меток» / 德 «Tags suchen» / 法 «Rechercher une étiquette»）：
                  // 下限 + 上限：卡片头很窄（左栏 1/4 宽），无上限时 input 的 width:100% 会把标题挤掉
                  style={{ minWidth: 120, maxWidth: 180 }}
                />
              }
            >
              {filteredTags.length ? (
                <Space size={[4, 4]} wrap>
                  {filteredTags.slice(0, 60).map((tag) => (
                    <Tag
                      key={tag.tag_id}
                      color={tag.value ? 'blue' : undefined}
                      // antd Tag 是 nowrap：长标签（用户自己起的名 + 值）在 1/4 宽的卡片里会顶出卡片，
                      // 改成换行 + 长词折行（不用 break-all）
                      style={{ whiteSpace: 'normal', overflowWrap: 'break-word', maxWidth: '100%' }}
                    >
                      {tag.name}
                      {tag.value ? `：${tag.value}` : ''}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('analysis:userTimeline.noTags')} />
              )}
            </Card>
          </Space>
        </Col>

        <Col xs={24} lg={18}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card
              size="small"
              title={t('analysis:userTimeline.overviewTitle')}
              extra={
                result?.first_log_time ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {result.first_log_time} ~ {result.last_log_time}
                  </Typography.Text>
                ) : null
              }
            >
              {overview && (overview.daily.length || overview.events.length) ? (
                <Row gutter={8}>
                  <Col span={13}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('analysis:userTimeline.dailyTrend')}
                    </Typography.Text>
                    <ReactECharts option={dailyOption} style={{ height: 220 }} notMerge />
                  </Col>
                  <Col span={11}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('analysis:userTimeline.eventShare')}
                    </Typography.Text>
                    <ReactECharts option={pieOption} style={{ height: 220 }} notMerge />
                  </Col>
                </Row>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('analysis:userTimeline.noOverview')} />
              )}
            </Card>

            <Card
              size="small"
              title={t('analysis:userTimeline.detailTitle')}
              extra={
                <Space size={6}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('analysis:userTimeline.externalAttributes')}
                  </Typography.Text>
                  <Select
                    mode="multiple"
                    allowClear
                    value={externalKeys}
                    onChange={setExternalKeys}
                    options={externalCandidates}
                    placeholder={t('analysis:userTimeline.externalPlaceholder')}
                    maxTagCount="responsive"
                    // 占位符俄 «Выберите свойства для показа» ≈ 250px；已选标签由 rc-select 自动带 title
                    style={{ minWidth: 260 }}
                  />
                </Space>
              }
            >
              <Space size={8} wrap style={{ marginBottom: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('analysis:userTimeline.filterLabel')}
                </Typography.Text>
                <Select
                  allowClear
                  value={filterKey}
                  onChange={(v) => setFilterKey(v)}
                  options={filterKeyOptions}
                  placeholder={t('analysis:userTimeline.filterKeyPlaceholder')}
                  // 值/选项是用户属性键（数据，可长）：下限 + 允许增长，截断由 rc-select 自带 title 兜底
                  style={{ minWidth: 190 }}
                />
                <Input
                  allowClear
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                  placeholder={t('analysis:userTimeline.filterValuePlaceholder')}
                  // 占位符俄 «Значение содержит» ≈ 150px：下限 + 允许增长
                  style={{ minWidth: 180 }}
                  disabled={!filterKey}
                />
                <Button size="small" onClick={() => void runQuery(currentId)} disabled={!currentId}>
                  {t('analysis:userTimeline.filterApply')}
                </Button>
                <Typography.Text
                  type="secondary"
                  // 俄 «Фильтр по текущему результату» ≈ 220px，允许换行而不是被截
                  style={{ fontSize: 12, whiteSpace: 'normal', overflowWrap: 'break-word' }}
                >
                  {t('analysis:userTimeline.filterHint')}
                </Typography.Text>
              </Space>
              <Alert type="info" showIcon style={{ marginBottom: 8 }} message={t('analysis:userTimeline.externalHint')} />
              {result ? (
                <>
                  <Space size={16} wrap style={{ marginBottom: 8 }}>
                    <Typography.Text>
                      {t('analysis:userTimeline.hitTotal', { total: formatNumber(result.matched_total) })}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {t('analysis:userTimeline.shownTotal', { shown: formatNumber(result.shown_total) })}
                    </Typography.Text>
                    {result.first_log_time && result.last_log_time && (
                      <Typography.Text type="secondary">
                        {t('analysis:userTimeline.span', {
                          first: result.first_log_time,
                          last: result.last_log_time,
                        })}
                      </Typography.Text>
                    )}
                  </Space>
                  {result.truncated && (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 8 }}
                      message={t('analysis:userTimeline.truncatedNote')}
                    />
                  )}
                  <Table<UserTimelineRow>
                    size="small"
                    rowKey={(r) => `${r.log_time}-${r.event}-${r.distinct_id}`}
                    dataSource={visibleRows}
                    columns={[
                      ...detailColumns,
                      {
                        title: t('analysis:userTimeline.neighbors'),
                        key: 'neighbors',
                        // 列头/按钮文案是译文（俄 «Окрестность» / 泰 «เหตุการณ์ข้างเคียง»）：下限按最长语言定
                        minWidth: DETAIL_COL_MIN.neighbors,
                        ellipsis: { showTitle: true },
                        render: (_: unknown, row: UserTimelineRow) => (
                          <Button type="link" size="small" onClick={() => void openNeighbors(row)}>
                            {t('analysis:userTimeline.neighbors')}
                          </Button>
                        ),
                      },
                    ]}
                    expandable={{ expandedRowRender: expandedProperties }}
                    pagination={{ pageSize: 50, showSizeChanger: false }}
                    // 外显属性列数由用户选择决定，scroll.x 必须跟着列下限之和走（见 DETAIL_COL_MIN 注释）
                    scroll={{ x: DETAIL_SCROLL_X + externalKeys.length * DETAIL_COL_MIN.property }}
                    locale={{ emptyText: t('analysis:userTimeline.empty') }}
                  />
                </>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={handoff ? t('analysis:userTimeline.waitingDetail') : t('analysis:userTimeline.empty')}
                />
              )}
            </Card>
          </Space>
        </Col>
      </Row>

      <Drawer
        title={t('analysis:userTimeline.recordsButton')}
        width={860}
        open={recordsOpen}
        onClose={() => setRecordsOpen(false)}
      >
        <Table<UserTimelineRecordSummary>
          size="small"
          rowKey="id"
          loading={recordsLoading}
          dataSource={records}
          pagination={false}
          locale={{ emptyText: t('meta:debug.historyEmpty') }}
          // 列宽全改下限 + scroll.x 撑到下限之和（见 RECORD_COL_MIN 注释）
          scroll={{ x: RECORD_SCROLL_X }}
          columns={[
            {
              title: t('meta:debug.column.archivedAt'),
              dataIndex: 'created_at',
              minWidth: RECORD_COL_MIN.archivedAt,
              render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
            },
            {
              title: t('analysis:userTimeline.value'),
              key: 'value',
              minWidth: RECORD_COL_MIN.value,
              // 查询条件摘要（用户数据 + 区间）：截断要能悬停看全称
              ellipsis: { showTitle: true },
              render: (_, row) => specSummary(row),
            },
            {
              title: t('meta:debug.column.status'),
              dataIndex: 'status',
              minWidth: RECORD_COL_MIN.status,
              render: (v, row) => statusTag(t, v ?? 'done', row.error_code),
            },
            {
              title: t('meta:debug.column.hitReturn'),
              key: 'count',
              minWidth: RECORD_COL_MIN.count,
              render: (_, row) =>
                row.status === 'pending' || row.status === 'running' ? (
                  <Typography.Text type="secondary">—</Typography.Text>
                ) : (
                  // 命中数 + 「已截断」标签都是译文（俄 «Совпадений: N» + «Обрезано»）：放不下就换行，不压窄
                  <Space size={4} wrap>
                    <span>{t('meta:debug.hitTotal', { total: row.matched_total })}</span>
                    {row.truncated ? <Tag color="warning">{t('meta:debug.column.truncatedTag')}</Tag> : null}
                  </Space>
                ),
            },
            {
              title: t('meta:debug.column.actions'),
              key: 'actions',
              minWidth: RECORD_COL_MIN.actions,
              render: (_, row) => (
                // 「查看 / 删除」两段是译文（法 «Consulter» + «Supprimer» ≈ 150px）：列窄时整块换行
                <Space size={4} wrap>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => void getUserTimelineRecord(row.id).then(setDetail).catch(() => undefined)}
                  >
                    {t('common:action.view')}
                  </Button>
                  <Popconfirm
                    title={t('meta:debug.deleteConfirm')}
                    okText={t('common:action.delete')}
                    cancelText={t('common:action.cancel')}
                    onConfirm={() =>
                      void deleteUserTimelineRecord(row.id).then(() => {
                        message.success(t('meta:debug.deleteOk'));
                        setRecordsToken(Date.now());
                      })
                    }
                  >
                    <Button type="link" size="small" danger>
                      {t('common:action.delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Drawer>

      <Modal
        open={neighbors !== null || neighborsLoading}
        title={t('analysis:userTimeline.neighborsTitle')}
        width={880}
        footer={null}
        onCancel={() => setNeighbors(null)}
      >
        {neighbors && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('analysis:userTimeline.neighborsHint')}
            </Typography.Text>
            {(['before', 'after'] as const).map((side) => (
              <div key={side}>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  {side === 'before'
                    ? t('analysis:userTimeline.neighborsBefore')
                    : t('analysis:userTimeline.neighborsAfter')}
                </Typography.Text>
                <Table<UserTimelineRow>
                  size="small"
                  rowKey={(r) => `${side}-${r.log_time}-${r.event}`}
                  dataSource={side === 'before' ? neighbors.data.before : neighbors.data.after}
                  pagination={false}
                  columns={[
                    {
                      title: t('meta:debug.column.time'),
                      dataIndex: 'log_time',
                      minWidth: NEIGHBORS_COL_MIN.time,
                      render: (v: string) => (
                        <Typography.Text type={v === neighbors.anchor.log_time ? 'success' : undefined}>
                          {renderLogTime(v)}
                        </Typography.Text>
                      ),
                    },
                    {
                      title: t('analysis:userTimeline.events'),
                      dataIndex: 'event',
                      minWidth: NEIGHBORS_COL_MIN.event,
                      ellipsis: { showTitle: true },
                      render: (v: string) => eventLabel(v),
                    },
                    {
                      title: 'distinct_id',
                      dataIndex: 'distinct_id',
                      minWidth: NEIGHBORS_COL_MIN.distinctId,
                      ellipsis: { showTitle: true },
                    },
                  ]}
                  expandable={{ expandedRowRender: expandedProperties }}
                  // 弹窗内表格同样按「列下限之和」撑宽度（见 NEIGHBORS_COL_MIN 注释）
                  scroll={{ x: NEIGHBORS_SCROLL_X }}
                />
              </div>
            ))}
          </Space>
        )}
      </Modal>

      <Modal
        open={detail !== null}
        title={t('meta:debug.detailTitle')}
        width={1100}
        footer={null}
        onCancel={() => setDetail(null)}
      >
        {detail && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text type="secondary">{specSummary(detail)}</Typography.Text>
            <Divider style={{ margin: '4px 0' }} />
            {detail.truncated && <Alert type="warning" showIcon message={t('analysis:userTimeline.truncatedNote')} />}
            {(detail.status === 'failed' || detail.error_code) && (
              <Alert type="error" showIcon message={errorCodeMessage(t, detail.error_code)} />
            )}
            <Table
              size="small"
              rowKey="id"
              dataSource={detail.rows ?? []}
              columns={[
                {
                  title: t('meta:debug.column.time'),
                  dataIndex: 'log_time',
                  minWidth: DETAIL_COL_MIN.time,
                  render: (v: string) => renderLogTime(v),
                },
                {
                  title: t('analysis:userTimeline.events'),
                  dataIndex: 'event',
                  minWidth: DETAIL_COL_MIN.event,
                  ellipsis: { showTitle: true },
                  render: (v: string) => eventLabel(v),
                },
                {
                  title: 'distinct_id',
                  dataIndex: 'distinct_id',
                  minWidth: DETAIL_COL_MIN.distinctId,
                  ellipsis: { showTitle: true },
                },
              ]}
              expandable={{ expandedRowRender: expandedProperties }}
              pagination={{ pageSize: 50 }}
              // 同上：列下限之和兜住 scroll.x，长语言下列不再被等比压窄
              scroll={{ x: DETAIL_COL_MIN.time + DETAIL_COL_MIN.event + DETAIL_COL_MIN.distinctId }}
            />
          </Space>
        )}
      </Modal>
    </Space>
  );
}

/** 记录条件摘要（spec_json 里的 value + 区间） */
function specSummary(row: UserTimelineRecordSummary): string {
  if (!row.spec_json) return '-';
  try {
    const spec = JSON.parse(row.spec_json) as { value?: string; from?: string; to?: string; events?: string[] };
    const events = spec.events?.length ? ` · ${spec.events.join(', ')}` : '';
    return `${spec.value ?? '-'} · ${spec.from ?? ''} ~ ${spec.to ?? ''}${events}`;
  } catch {
    return '-';
  }
}
