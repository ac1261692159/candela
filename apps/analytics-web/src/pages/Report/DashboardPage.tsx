import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Empty, Select, Skeleton, Space, Typography, message } from 'antd';
import { ArrowLeftOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { DashboardGrid } from '../../features/report/DashboardGrid';
import { CardConfigModal } from '../../features/report/CardConfigModal';
import { DashboardSettingsDrawer } from '../../features/report/DashboardSettingsDrawer';
import { DEFAULT_GRID_COLUMNS, remapColumns, toGridLayout, type GridItem } from '../../features/report/grafana-layout';
import {
  getDashboard,
  removeCardFromDashboard,
  saveDashboardLayout,
  updateDashboard,
} from '../../services/report.service';
import type { DashboardDetail } from '../../types/report.types';
import { useReadyCohorts } from '../../features/cohort/use-ready-cohorts';
import { useIamStore } from '../../stores/iam.store';
import { type TFunction, useT } from '../../i18n';

const refreshLabel = (t: TFunction): Record<number, string> => ({
  0: '',
  30: t('report:dashboard.autoRefreshSeconds', { count: 30 }),
  60: t('report:dashboard.autoRefreshMinutes', { count: 1 }),
  300: t('report:dashboard.autoRefreshMinutes', { count: 5 }),
  900: t('report:dashboard.autoRefreshMinutes', { count: 15 }),
});

export function DashboardPage() {
  const { t } = useT('report');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<DashboardDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [configOpen, setConfigOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const draftLayout = useRef<GridItem[] | null>(null);
  // rbac-v5：无 cohort.view 的角色（普通成员）不渲染分群筛选器——接口守卫是 cohort.view，渲染即 403
  const canViewCohorts = useIamStore((s) => s.has('cohort.view'));
  const readyCohorts = useReadyCohorts();

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const detail = await getDashboard(id);
      setDashboard(detail);
      draftLayout.current = toGridLayout(detail.cards, detail.grid_columns ?? DEFAULT_GRID_COLUMNS);
    } catch {
      setDashboard(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const sec = dashboard?.refresh_interval_sec ?? 0;
    if (!sec) return;
    const timer = window.setInterval(() => setRefreshEpoch((n) => n + 1), sec * 1000);
    return () => window.clearInterval(timer);
  }, [dashboard?.refresh_interval_sec, dashboard?.db_id]);

  const handleDeleteCard = async (cardId: string) => {
    if (!id) return;
    try {
      await removeCardFromDashboard(id, cardId);
      message.success(t('report:dashboard.cardRemoved'));
      load();
    } catch {
      // 拦截器已提示
    }
  };

  if (!loading && !dashboard) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('report:dashboard.notFound')}
      >
        <Link to="/report/dashboards">
          <Button>{t('report:dashboard.backToList')}</Button>
        </Link>
      </Empty>
    );
  }

  const cols = dashboard?.grid_columns ?? DEFAULT_GRID_COLUMNS;
  const refreshHint = refreshLabel(t)[dashboard?.refresh_interval_sec ?? 0];

  return (
    <div className="dashboard-page">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 16,
          minWidth: 0,
        }}
      >
        <Space size={8} style={{ minWidth: 0 }}>
          <Link to="/report/dashboards" aria-label={t('report:dashboard.backToList')}>
            <Button type="text" icon={<ArrowLeftOutlined />} />
          </Link>
          <Typography.Title level={4} style={{ margin: 0 }} ellipsis={{ tooltip: dashboard?.name }}>
            {dashboard?.name ?? t('common:state.loading')}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t('report:dashboard.cardCount', { count: dashboard?.cards.length ?? 0 })}
          </Typography.Text>
          {refreshHint ? <Typography.Text type="secondary">{refreshHint}</Typography.Text> : null}
        </Space>
        <Space>
          {canViewCohorts ? (
            <>
              <Select
                allowClear
                showSearch
                placeholder={t('report:dashboard.cohortFilter')}
                optionFilterProp="label"
                style={{ minWidth: 180 }}
                value={dashboard?.cohort_filter?.cohort_id}
                options={readyCohorts.map((c) => ({
                  value: c.cohort_id,
                  label: `${c.display_name}（${c.name}）`,
                }))}
                onChange={(cohortId?: string) => {
                  if (!dashboard) return;
                  void (async () => {
                    try {
                      await updateDashboard(dashboard.db_id, {
                        cohort_filter: cohortId
                          ? { cohort_id: cohortId, op: dashboard.cohort_filter?.op ?? 'in' }
                          : null,
                      });
                      await load();
                      setRefreshEpoch((n) => n + 1);
                    } catch {
                      // 拦截器已提示
                    }
                  })();
                }}
              />
              <Select
                style={{ width: 108 }}
                value={dashboard?.cohort_filter?.op ?? 'in'}
                disabled={!dashboard?.cohort_filter?.cohort_id}
                options={[
                  { value: 'in', label: t('report:filter.in') },
                  { value: 'not_in', label: t('report:filter.notIn') },
                ]}
                onChange={(op: 'in' | 'not_in') => {
                  if (!dashboard?.cohort_filter?.cohort_id) return;
                  void (async () => {
                    try {
                      await updateDashboard(dashboard.db_id, {
                        cohort_filter: { cohort_id: dashboard.cohort_filter!.cohort_id, op },
                      });
                      await load();
                      setRefreshEpoch((n) => n + 1);
                    } catch {
                      // 拦截器已提示
                    }
                  })();
                }}
              />
            </>
          ) : null}
          <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} aria-label={t('report:dashboard.settings')}>
            {t('report:action.settings')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setConfigOpen(true)}>
            {t('report:card.add')}
          </Button>
        </Space>
      </div>

      {dashboard ? (
        <div className="dashboard-page__body">
          <DashboardGrid
            cards={dashboard.cards}
            dbId={dashboard.db_id}
            cols={cols}
            editable
            refreshEpoch={refreshEpoch}
            showTypeTag={dashboard.show_card_type ?? false}
            onRemoveCard={handleDeleteCard}
            onCardsChanged={load}
            onLayoutDraft={(layout) => {
              draftLayout.current = layout;
            }}
          />
        </div>
      ) : (
        <Skeleton active title={false} paragraph={{ rows: 8 }} />
      )}

      {id ? (
        <CardConfigModal
          dbId={id}
          open={configOpen}
          onClose={() => setConfigOpen(false)}
          onCreated={load}
        />
      ) : null}

      {dashboard ? (
        <DashboardSettingsDrawer
          dashboard={dashboard}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSubmit={async (values) => {
            const prevCols = dashboard.grid_columns ?? DEFAULT_GRID_COLUMNS;
            if (values.grid_columns !== prevCols) {
              const current =
                draftLayout.current ?? toGridLayout(dashboard.cards, prevCols);
              const next = remapColumns(current, prevCols, values.grid_columns);
              await saveDashboardLayout(
                dashboard.db_id,
                next.map((item) => ({
                  card_id: item.i,
                  position_x: item.x,
                  position_y: item.y,
                  width: item.w,
                  height: item.h,
                })),
              );
            }
            await updateDashboard(dashboard.db_id, values);
            message.success(t('report:dashboard.settingsSaved'));
            await load();
          }}
          onDeleted={() => navigate('/report/dashboards')}
        />
      ) : null}
    </div>
  );
}
