import { Component, Suspense, lazy, type ReactNode } from 'react';
import { Navigate, RouteObject } from 'react-router-dom';
import { Button, Result } from 'antd';
import { MainLayout } from './layouts/MainLayout';
import { filterMenuByPermissions } from './layouts/shell-menu';
import { useAuthStore } from './stores/auth.store';
import { useIamStore } from './stores/iam.store';
import { useT } from './i18n';

const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })),
);
const ForbiddenPage = lazy(() =>
  import('./pages/ForbiddenPage').then((m) => ({ default: m.ForbiddenPage })),
);

function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function IamGate({ children }: { children: ReactNode }) {
  const { t } = useT('auth');
  const hydrated = useIamStore((s) => s.hydrated);
  const loading = useIamStore((s) => s.loading);
  if (!hydrated || loading) {
    return <div style={{ padding: 24 }}>{t('auth:gate.loadingPermissions')}</div>;
  }
  return <>{children}</>;
}

function RequirePermission({ code, children }: { code: string; children: ReactNode }) {
  const { t } = useT('auth');
  const hydrated = useIamStore((s) => s.hydrated);
  const loading = useIamStore((s) => s.loading);
  const has = useIamStore((s) => s.has);
  if (!hydrated || loading) {
    return <div style={{ padding: 24 }}>{t('auth:gate.loadingPermissions')}</div>;
  }
  if (!has(code)) {
    return (
      <LazyWrap>
        <ForbiddenPage />
      </LazyWrap>
    );
  }
  return <>{children}</>;
}

function HomeRedirect() {
  const permissions = useIamStore((s) => s.permissions);
  const flags = filterMenuByPermissions(permissions);
  if (flags.showReport) return <Navigate to="/report/dashboards" replace />;
  if (flags.showOwners) return <Navigate to="/settings/project-owners" replace />;
  if (flags.showApiKeys) return <Navigate to="/settings/api-keys" replace />;
  if (flags.showAnalysis) return <Navigate to="/analysis/event" replace />;
  return <Navigate to="/settings/profile" replace />;
}

const EventAnalysisPage = lazy(() =>
  import('./pages/Analysis/EventAnalysisPage').then((m) => ({ default: m.EventAnalysisPage })),
);
const FunnelAnalysisPage = lazy(() =>
  import('./pages/Analysis/FunnelAnalysisPage').then((m) => ({ default: m.FunnelAnalysisPage })),
);
const RetentionAnalysisPage = lazy(() =>
  import('./pages/Analysis/RetentionAnalysisPage').then((m) => ({
    default: m.RetentionAnalysisPage,
  })),
);
const UserCohortsPage = lazy(() =>
  import('./pages/Analysis/UserCohortsPage').then((m) => ({ default: m.UserCohortsPage })),
);
const UserTagsPage = lazy(() =>
  import('./pages/Analysis/UserTagsPage').then((m) => ({ default: m.UserTagsPage })),
);
const TagEditPage = lazy(() =>
  import('./pages/Analysis/TagEditPage').then((m) => ({ default: m.TagEditPage })),
);
const UserTimelinePage = lazy(() =>
  import('./pages/Analysis/UserTimelinePage').then((m) => ({ default: m.UserTimelinePage })),
);
const AnalysisSubjectsPage = lazy(() =>
  import('./pages/Analysis/AnalysisSubjectsPage').then((m) => ({ default: m.AnalysisSubjectsPage })),
);
const CohortEditPage = lazy(() =>
  import('./pages/Analysis/CohortEditPage').then((m) => ({ default: m.CohortEditPage })),
);
const EventsPage = lazy(() =>
  import('./pages/Meta/EventsPage').then((m) => ({ default: m.EventsPage })),
);
const UserPropertiesPage = lazy(() =>
  import('./pages/Meta/UserPropertiesPage').then((m) => ({ default: m.UserPropertiesPage })),
);
const VirtualEventsPage = lazy(() =>
  import('./pages/Meta/VirtualEventsPage').then((m) => ({ default: m.VirtualEventsPage })),
);
const SavedMetricsPage = lazy(() =>
  import('./pages/Meta/SavedMetricsPage').then((m) => ({ default: m.SavedMetricsPage })),
);
const VirtualPropertiesPage = lazy(() =>
  import('./pages/Meta/VirtualPropertiesPage').then((m) => ({
    default: m.VirtualPropertiesPage,
  })),
);
const EventAttributesPage = lazy(() =>
  import('./pages/Meta/EventAttributesPage').then((m) => ({ default: m.EventAttributesPage })),
);
const DebugPage = lazy(() =>
  import('./pages/Meta/DebugPage').then((m) => ({ default: m.DebugPage })),
);
const QualityPage = lazy(() =>
  import('./pages/Ops/QualityPage').then((m) => ({ default: m.QualityPage })),
);
const DataTablesPage = lazy(() => import('./pages/Meta/DataTablesPage'));
const OnboardingPage = lazy(() => import('./pages/Meta/OnboardingPage'));
const DataManagementPage = lazy(() =>
  import('./pages/Ops/DataManagementPage').then((m) => ({ default: m.DataManagementPage })),
);
const DashboardListPage = lazy(() =>
  import('./pages/Report/DashboardListPage').then((m) => ({ default: m.DashboardListPage })),
);
const DashboardPage = lazy(() =>
  import('./pages/Report/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const SqlReportPage = lazy(() =>
  import('./pages/Report/SqlReportPage').then((m) => ({ default: m.SqlReportPage })),
);
const ApiKeysPage = lazy(() =>
  import('./pages/Settings/ApiKeysPage').then((m) => ({ default: m.ApiKeysPage })),
);
const AnalysisCardsPage = lazy(() =>
  import('./pages/Report/AnalysisCardsPage').then((m) => ({ default: m.AnalysisCardsPage })),
);
const ProfilePage = lazy(() =>
  import('./pages/Settings/ProfilePage').then((m) => ({ default: m.ProfilePage })),
);
const ForgotPasswordPage = lazy(() =>
  import('./pages/Auth/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })),
);
const ResetPasswordPage = lazy(() =>
  import('./pages/Auth/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })),
);
const InviteAcceptPage = lazy(() =>
  import('./pages/Auth/InviteAcceptPage').then((m) => ({ default: m.InviteAcceptPage })),
);
const UsersPage = lazy(() =>
  import('./pages/Settings/UsersPage').then((m) => ({ default: m.UsersPage })),
);
const AiWorkspacePage = lazy(() =>
  import('./pages/Admin/AiWorkspacePage').then((m) => ({ default: m.AiWorkspacePage })),
);
const IamMembersPage = lazy(() =>
  import('./pages/Iam/MembersPage').then((m) => ({ default: m.IamMembersPage })),
);
const IamGroupsPage = lazy(() =>
  import('./pages/Iam/GroupsPage').then((m) => ({ default: m.IamGroupsPage })),
);
const IamRolesPage = lazy(() =>
  import('./pages/Iam/RolesPage').then((m) => ({ default: m.IamRolesPage })),
);
const IamDataPoliciesPage = lazy(() =>
  import('./pages/Iam/DataPoliciesPage').then((m) => ({ default: m.IamDataPoliciesPage })),
);
const ProjectOwnersPage = lazy(() =>
  import('./pages/Settings/ProjectOwnersPage').then((m) => ({ default: m.ProjectOwnersPage })),
);
const SlowQueriesPage = lazy(() =>
  import('./pages/Ops/SlowQueriesPage').then((m) => ({ default: m.SlowQueriesPage })),
);
const ServerStatusPage = lazy(() =>
  import('./pages/Ops/ServerStatusPage').then((m) => ({ default: m.ServerStatusPage })),
);
const AlertsPage = lazy(() =>
  import('./pages/Ops/AlertsPage').then((m) => ({ default: m.AlertsPage })),
);

/** 分片加载失败（发版后旧页面请求已被替换的分片）自愈标记：同一会话只自动刷新一次，避免循环 */
export const CHUNK_RELOAD_KEY = 'clklog:chunk-reload';

/**
 * 懒加载路由的错误边界（2026-09-19 事故）。
 *
 * 发版会替换资产目录：停留在旧页面的浏览器再去请求那些分片时拿不到正确文件，应用会卡在
 * 加载态（此前表现为长时间白屏且无任何提示）。这里先自动刷新一次自愈；仍失败才给出可操作的
 * 提示，避免用户对着白屏无从下手。
 */
export class ChunkErrorBoundary extends Component<
  { children: ReactNode; failedText: string; reloadText: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
    window.location.reload();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ padding: 24 }}>
        <Result
          status="warning"
          title={this.props.failedText}
          extra={
            <Button type="primary" onClick={() => window.location.reload()}>
              {this.props.reloadText}
            </Button>
          }
        />
      </div>
    );
  }
}

function LazyWrap({ children }: { children: ReactNode }) {
  const { t } = useT('common');
  return (
    <ChunkErrorBoundary failedText={t('common:error.chunkFailed')} reloadText={t('common:action.refresh')}>
      <Suspense fallback={<div style={{ padding: 24 }}>{t('common:state.loadingAscii')}</div>}>{children}</Suspense>
    </ChunkErrorBoundary>
  );
}

function page(code: string, node: ReactNode) {
  return (
    <RequirePermission code={code}>
      <LazyWrap>{node}</LazyWrap>
    </RequirePermission>
  );
}

export const routes: RouteObject[] = [
  {
    path: '/login',
    element: (
      <LazyWrap>
        <LoginPage />
      </LazyWrap>
    ),
  },
  // 账号生命周期 v2：邮件链路的三个公开页（无需登录）
  {
    path: '/forgot-password',
    element: (
      <LazyWrap>
        <ForgotPasswordPage />
      </LazyWrap>
    ),
  },
  {
    path: '/reset-password',
    element: (
      <LazyWrap>
        <ResetPasswordPage />
      </LazyWrap>
    ),
  },
  {
    path: '/invite/:token',
    element: (
      <LazyWrap>
        <InviteAcceptPage />
      </LazyWrap>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <MainLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <IamGate><HomeRedirect /></IamGate> },
      { path: 'analysis/event', element: page('model.query', <EventAnalysisPage />) },
      { path: 'analysis/funnel', element: page('model.query', <FunnelAnalysisPage />) },
      { path: 'analysis/retention', element: page('model.query', <RetentionAnalysisPage />) },
      { path: 'analysis/cohorts/new', element: page('cohort.edit_own', <CohortEditPage />) },
      { path: 'analysis/cohorts/:id', element: page('cohort.view', <CohortEditPage />) },
      { path: 'analysis/cohorts', element: page('cohort.view', <UserCohortsPage />) },
      { path: 'analysis/tags/new', element: page('tag.edit_own', <TagEditPage />) },
      { path: 'analysis/tags/:id', element: page('tag.view', <TagEditPage />) },
      { path: 'analysis/tags', element: page('tag.view', <UserTagsPage />) },
      { path: 'analysis/subjects', element: page('subject.view', <AnalysisSubjectsPage />) },
      { path: 'analysis/user-timeline', element: page('timeline.view', <UserTimelinePage />) },
      { path: 'meta/events', element: page('meta.view', <EventsPage />) },
      { path: 'meta/virtual-properties', element: page('meta.view', <VirtualPropertiesPage />) },
      { path: 'meta/event-attributes', element: page('meta.view', <EventAttributesPage />) },
      { path: 'meta/user-properties', element: page('meta.view', <UserPropertiesPage />) },
      { path: 'meta/virtual-events', element: page('meta.view', <VirtualEventsPage />) },
      { path: 'meta/metrics', element: page('metric.view', <SavedMetricsPage />) },
      { path: 'meta/debug', element: page('meta.view', <DebugPage />) },
      // 数据质量属运维职责（phase: clklog-data-quality-ops-ia-v1）：新入口与「数据运维」同权
      { path: 'ops/quality', element: page('ops.runtime.access', <QualityPage />) },
      // 旧入口保留跳转：书签/文档/外链不 404
      // ⚠️ to 必须是**路由内路径**（BrowserRouter basename="/sa" 会自己加前缀）：
      // 写 '/sa/ops/quality' 会解析成 /sa/sa/... 而落到兜底跳转（2026-10-09 实测踩到）
      { path: 'meta/quality', element: <Navigate to="/ops/quality" replace /> },
      { path: 'meta/datatables', element: page('meta.view', <DataTablesPage />) },
      { path: 'meta/onboarding', element: page('meta.view', <OnboardingPage />) },
      { path: 'report/dashboards', element: page('dashboard.view', <DashboardListPage />) },
      { path: 'report/cards', element: page('model.card_save', <AnalysisCardsPage />) },
      { path: 'report/dashboards/:id', element: page('dashboard.view', <DashboardPage />) },
      { path: 'report/sql', element: page('model.sql', <SqlReportPage />) },
      {
        path: 'settings/profile',
        element: (
          <LazyWrap>
            <ProfilePage />
          </LazyWrap>
        ),
      },
      { path: 'settings/users', element: page('ops.user.manage', <UsersPage />) },
      { path: 'settings/project-owners', element: page('ops.owner.assign', <ProjectOwnersPage />) },
      { path: 'settings/api-keys', element: page('ops.apikey.manage', <ApiKeysPage />) },
      { path: 'admin/ai/workspace', element: page('ops.ai_workspace.manage', <AiWorkspacePage />) },
      { path: 'ops/slow-queries', element: page('ops.runtime.access', <SlowQueriesPage />) },
      { path: 'ops/server-status', element: page('ops.runtime.access', <ServerStatusPage />) },
      { path: 'ops/alerts', element: page('ops.runtime.access', <AlertsPage />) },
      { path: 'ops/data-management', element: page('ops.runtime.access', <DataManagementPage />) },
      { path: 'iam/members', element: page('iam.member.view', <IamMembersPage />) },
      { path: 'iam/groups', element: page('iam.member.view', <IamGroupsPage />) },
      { path: 'iam/roles', element: page('iam.member.view', <IamRolesPage />) },
      { path: 'iam/data-policies', element: page('iam.member.view', <IamDataPoliciesPage />) },
      {
        path: 'forbidden',
        element: (
          <LazyWrap>
            <ForbiddenPage />
          </LazyWrap>
        ),
      },
    ],
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
];
