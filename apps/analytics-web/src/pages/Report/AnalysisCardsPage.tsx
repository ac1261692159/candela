import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '../../i18n/format';
import { Button, Card, Input, Modal, Segmented, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CheckOutlined, EditOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import './asset-list.css';
import { listCards, updateCard } from '../../services/report.service';
import type { AnalysisCard, CardType } from '../../types/report.types';
import { getCardAcl, lockCard, putCardAcl } from '../../services/iam.service';
import { useIamStore } from '../../stores/iam.store';
import { type TFunction, useT } from '../../i18n';
import { AssetGrantModal } from './AssetGrantModal';
import { AssetName } from './AssetName';

const ANALYSIS_CARD_TYPES: CardType[] = ['event', 'funnel', 'retention', 'sql'];

const cardTypeLabels = (t: TFunction): Record<string, string> => ({
  event: t('report:cardType.event'),
  funnel: t('report:cardType.funnel'),
  retention: t('report:cardType.retention'),
  sql: t('report:cardType.sql'),
});

const typeRoutes: Record<string, string> = {
  event: '/analysis/event',
  funnel: '/analysis/funnel',
  retention: '/analysis/retention',
  sql: '/report/sql',
};

const typeColors: Record<string, string> = {
  event: 'blue',
  funnel: 'purple',
  retention: 'cyan',
  sql: 'geekblue',
};

function fmtDate(v: string) {
  return formatDateTime(v);
}

/** 距当前时间的天/小时/分钟：列表里绝对日期不如相对时长直观 */
function fmtRelative(iso: string, t: TFunction, now = Date.now()) {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const totalMinutes = Math.floor((now - time) / 60_000);
  if (totalMinutes < 1) return t('report:time.justNow');
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(t('report:time.days', { count: days }));
  if (hours) parts.push(t('report:time.hours', { count: hours }));
  if (minutes) parts.push(t('report:time.minutes', { count: minutes }));
  return t('report:time.ago', { value: parts.join(' ') });
}

export function AnalysisCardsPage() {
  const { t } = useT('report');
  const [items, setItems] = useState<AnalysisCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState<CardType | 'all'>('all');
  const [grantId, setGrantId] = useState<AnalysisCard | null>(null);
  const [renameTarget, setRenameTarget] = useState<AnalysisCard | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const navigate = useNavigate();
  const canLock = useIamStore((s) => s.has('asset.lock'));
  const canGrant = useIamStore((s) => s.has('asset.grant'));

  const openCard = (record: AnalysisCard) => {
    const route = typeRoutes[record.type];
    if (!route) return;
    navigate(`${route}?card=${record.card_id}`);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cards = await listCards(typeFilter === 'all' ? undefined : typeFilter);
      setItems(cards.filter((card) => ANALYSIS_CARD_TYPES.includes(card.type)));
    } catch {
      // 拦截器已提示
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const columns: ColumnsType<AnalysisCard> = [
    {
      title: t('report:card.name'),
      dataIndex: 'name',
      key: 'name',
      // 名称列只给下限（名称是用户数据），截断时悬停看全称
      minWidth: 300,
      render: (name: string, record) => (
        <Space size={4} wrap style={{ rowGap: 4 }}>
          <Typography.Text ellipsis={{ tooltip: name }} style={{ maxWidth: 260 }}>
            <AssetName name={name} description={record.description} onClick={() => openCard(record)} />
          </Typography.Text>
          {record.locked ? <Tag>{t('report:state.locked')}</Tag> : null}
          {(record.grant_count ?? 0) > 0 ? <Tag color="gold">{t('report:state.granted')}</Tag> : null}
          {record.can_edit ? <Tag color="blue">{t('report:state.editable')}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t('common:label.type'),
      dataIndex: 'type',
      key: 'type',
      // 「类型」在俄/德是 Тип / Typ，但列内标签是译后的类型名（Воронка/Удержание）——按最长语言留下限
      minWidth: 132,
      ellipsis: { showTitle: true },
      // 创建/更新时间不再单独占列，改为悬停类型标签时显示
      render: (type: string, record) => (
        <Tooltip
          title={
            <div>
              <div>{t('report:card.createdAt', { value: fmtDate(record.created_at) })}</div>
              <div>{t('report:card.updatedAt', { value: fmtDate(record.updated_at) })}</div>
            </div>
          }
        >
          <Tag color={typeColors[type] ?? 'default'}>{cardTypeLabels(t)[type] ?? type}</Tag>
        </Tooltip>
      ),
    },
    // 图型值是用户数据（line/table…），列名「图表」译后仍短
    { title: t('report:card.chart'), dataIndex: 'chart_type', key: 'chart_type', minWidth: 96, ellipsis: { showTitle: true } },
    {
      title: t('report:card.referencedBy'),
      key: 'dashboards',
      minWidth: 120,
      ellipsis: { showTitle: true },
      render: (_, r) => (
        <Typography.Text>{t('report:card.refCount', { count: r.dashboard_ids?.length ?? 0 })}</Typography.Text>
      ),
    },
    {
      title: t('report:card.cache'),
      key: 'cache_state',
      // 列内是译后状态标签（俄「Ошибка запроса」≈14 字符）：下限比中文状态「查询失败」宽
      minWidth: 140,
      ellipsis: { showTitle: true },
      render: (_, r) => {
        const c = r.cache_summary;
        if (!c?.has_cache) return <Tag>{t('report:card.noCache')}</Tag>;
        if (c.error) return <Tag color="red">{t('report:card.queryFailed')}</Tag>;
        return c.stale ? <Tag color="orange">{t('report:state.stale')}</Tag> : <Tag color="green">{t('report:state.valid')}</Tag>;
      },
    },
    {
      title: t('report:card.lastQuery'),
      key: 'cache_at',
      // 相对时间是译后长串（俄「3 дня 2 часа назад」≈19 字符 ≈ 中文 2 倍）：下限放宽 + 截断可悬停
      minWidth: 168,
      ellipsis: { showTitle: true },
      render: (_, r) =>
        r.cache_summary?.refreshed_at ? fmtRelative(r.cache_summary.refreshed_at, t) : '—',
    },
    {
      title: t('common:label.actions'),
      key: 'actions',
      // 操作列：3 个译后按钮，允许换行而不是被压成一字一列
      minWidth: 200,
      render: (_, row) => (
        <Space onClick={(e) => e.stopPropagation()} wrap style={{ rowGap: 4 }}>
          {canLock ? (
            <Button
              size="small"
              onClick={async () => {
                try {
                  const res = await lockCard(row.card_id, !row.locked);
                  const confirm = res as { need_confirm?: boolean; ref_count?: number };
                  if (confirm.need_confirm) {
                    Modal.confirm({
                      title: t('report:card.referencedTitle'),
                      content: t('report:card.referencedConfirm', { count: confirm.ref_count ?? 0 }),
                      onOk: async () => {
                        await lockCard(row.card_id, true, true);
                        await load();
                      },
                    });
                    return;
                  }
                  await load();
                } catch {
                  message.error(t('report:card.lockFailed'));
                }
              }}
            >
              {row.locked ? t('report:action.unlock') : t('report:action.lock')}
            </Button>
          ) : null}
          {canGrant ? (
            <Button size="small" disabled={Boolean(row.locked)} onClick={() => setGrantId(row)}>
              {t('report:action.grant')}
            </Button>
          ) : null}
          <Button
            size="small"
            onClick={() => {
              setRenameTarget(row);
              setRenameDraft(row.name);
              setDescDraft(row.description ?? '');
            }}
          >
            {t('report:action.settings')}
          </Button>
        </Space>
      ),
    },
  ];

  // 默认只读：操作列只在编辑态出现
  const shownColumns = editing ? columns : columns.filter((col) => col.key !== 'actions');

  return (
    <Card
      title={t('report:card.pageTitle')}
      extra={
        <Space wrap>
          <Button
            icon={editing ? <CheckOutlined /> : <EditOutlined />}
            onClick={() => {
              if (!editing) {
                setEditing(true);
                return;
              }
              Modal.confirm({
                title: t('report:edit.confirmTitle'),
                content: t('report:card.finishEditBody'),
                okText: t('common:action.save'),
                cancelText: t('common:action.cancel'),
                onOk: () => {
                  setEditing(false);
                  void load();
                },
                onCancel: () => setEditing(false),
              });
            }}
          >
            {editing ? t('report:action.done') : t('common:action.edit')}
          </Button>
          <Button onClick={() => navigate('/report/dashboards')}>{t('report:card.goToDashboards')}</Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        {t('report:card.pageHint')}
      </Typography.Paragraph>
      {/* 分段控件本身不能换行：容器层允许横向滚动，长语言下选项不会被裁掉半个字 */}
      <div style={{ marginBottom: 16, maxWidth: '100%', overflowX: 'auto' }}>
        <Segmented
          value={typeFilter}
          onChange={(v) => setTypeFilter(v as CardType | 'all')}
          options={[
            { value: 'all', label: t('common:state.all') },
            { value: 'event', label: t('report:cardType.event') },
            { value: 'funnel', label: t('report:cardType.funnel') },
            { value: 'retention', label: t('report:cardType.retention') },
            { value: 'sql', label: t('report:cardType.sql') },
          ]}
        />
      </div>
      <Table
        rowKey="card_id"
        loading={loading}
        columns={shownColumns}
        dataSource={items}
        pagination={false}
        // 表格宽度下限 = 各列下限之和：容器更窄时整表横滚，而不是把每列压成一字一列（G.29）
        scroll={{ x: 300 + 132 + 96 + 120 + 140 + 168 + 200 }}
        onRow={(record) => ({
          onClick: () => openCard(record),
          style: { cursor: 'pointer' },
        })}
      />
      <AssetGrantModal
        open={Boolean(grantId)}
        title={t('report:grant.title', { name: grantId?.name ?? '' })}
        loadGrants={async () => (grantId ? getCardAcl(grantId.card_id) : [])}
        saveGrants={async (grants) => {
          if (!grantId) return;
          await putCardAcl(grantId.card_id, grants);
          await load();
        }}
        onClose={() => setGrantId(null)}
      />
      <Modal
        title={t('report:card.settingsTitle')}
        open={Boolean(renameTarget)}
        okText={t('common:action.save')}
        width={480}
        onCancel={() => setRenameTarget(null)}
        onOk={() => {
          const name = renameDraft.trim();
          if (!name || !renameTarget) return;
          void (async () => {
            try {
              await updateCard(renameTarget.card_id, { name, description: descDraft.trim() || null });
              setRenameTarget(null);
              await load();
              message.success(t('report:card.updated'));
            } catch {
              // 拦截器已提示（重名返回 409）
            }
          })();
        }}
      >
        <Typography.Text>{t('report:card.name')}</Typography.Text>
        <Input
          autoFocus
          maxLength={80}
          value={renameDraft}
          placeholder={t('report:card.name')}
          onChange={(event) => setRenameDraft(event.target.value)}
          style={{ marginTop: 8 }}
        />
        <Typography.Text style={{ display: 'block', marginTop: 16 }}>
          {t('report:label.descriptionOptional')}
        </Typography.Text>
        <Input.TextArea
          maxLength={200}
          showCount
          autoSize={{ minRows: 2, maxRows: 4 }}
          value={descDraft}
          placeholder={t('report:card.descriptionPlaceholder')}
          onChange={(event) => setDescDraft(event.target.value)}
          style={{ marginTop: 8 }}
        />
      </Modal>
    </Card>
  );
}
