import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Layout, Menu, Button, Drawer, ConfigProvider, theme } from 'antd';
import {
  BarChartOutlined,
  DatabaseOutlined,
  DashboardOutlined,
  DownOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TableOutlined,
  LogoutOutlined,
  TeamOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { ProjectSelector } from '../components/ProjectSelector';
import { BrandLogo } from '../components/BrandLogo';
import { useAuthStore } from '../stores/auth.store';
import { useProjectStore } from '../stores/project.store';
import { logout } from '../services/auth.service';
import { me } from '../services/auth.service';
import { listAccessibleProjects } from '../services/iam.service';
import { setPlatformTimeZone, setProjectTimeZone, setUserTimeZone } from '../features/time-range/resolve';
import { AiAssistantPanel } from '../features/ai/AiAssistantPanel';
import { ForcedPasswordChange } from '../pages/Settings/ForcedPasswordChange';
import { useAiChatStore } from '../stores/ai-chat.store';
import { useAnalysisStore } from '../stores/analysis.store';
import { useFunnelStore } from '../stores/funnel.store';
import { useRetentionStore } from '../stores/retention.store';
import { SIDER_COLLAPSED } from './shell-layout';
import { ShellLayoutProvider, useShellLayout } from './shell-layout-context';
import { useSiderWidth } from './use-sider-width';
import { SHELL_LOGOUT_KEY, SHELL_PROJECT_KEY, filterMenuByPermissions, isShellRouteMenuKey } from './shell-menu';
import { useIamStore } from '../stores/iam.store';
import { useT, type TFunction } from '../i18n';
import { ANALYTICS_LOGIN_HREF } from '../services/login-path';
import './shell-sider.css';

const { Header, Sider, Content } = Layout;

/** 基础菜单按权限码裁剪（导出供 main-layout-menu.spec 断言分组裁剪） */
export function buildMenuItems(permissions: Set<string>, t: TFunction) {
  const flags = filterMenuByPermissions(permissions);
  const items: {
    key: string;
    icon?: ReactNode;
    label: ReactNode;
    children?: { key: string; label: ReactNode; icon?: ReactNode; danger?: boolean; onClick?: () => void }[];
    danger?: boolean;
  }[] = [];
  const reportChildren = [
    ...(flags.showReport ? [{ key: '/report/dashboards', label: t('shell:menu.dashboards') }] : []),
    ...(flags.showCards ? [{ key: '/report/cards', label: t('shell:menu.cards') }] : []),
  ];
  if (reportChildren.length) {
    items.push({
      key: 'report',
      icon: <DashboardOutlined />,
      label: t('shell:menu.report'),
      children: reportChildren,
    });
  }
  const analysisChildren = [
    ...(flags.showAnalysis ? [{ key: '/analysis/event', label: t('shell:menu.event') }] : []),
    ...(flags.showAnalysis ? [{ key: '/analysis/funnel', label: t('shell:menu.funnel') }] : []),
    ...(flags.showAnalysis ? [{ key: '/analysis/retention', label: t('shell:menu.retention') }] : []),
    ...(flags.showSql ? [{ key: '/report/sql', label: t('shell:menu.sql') }] : []),
  ];
  if (analysisChildren.length) {
    items.push({
      key: 'analysis',
      icon: <BarChartOutlined />,
      label: t('shell:menu.analysis'),
      children: analysisChildren,
    });
  }
  const userChildren = [
    ...(flags.showTimeline ? [{ key: '/analysis/user-timeline', label: t('shell:menu.userTimeline') }] : []),
    ...(permissions.has('cohort.view') ? [{ key: '/analysis/cohorts', label: t('shell:menu.cohorts') }] : []),
    ...(permissions.has('tag.view') ? [{ key: '/analysis/tags', label: t('shell:menu.tags') }] : []),
    ...(permissions.has('subject.view') ? [{ key: '/analysis/subjects', label: t('shell:menu.subjects') }] : []),
  ];
  if (userChildren.length) {
    items.push({
      key: 'user',
      icon: <TeamOutlined />,
      label: t('shell:menu.user'),
      children: userChildren,
    });
  }
  if (flags.showMeta) {
    items.push({
      key: 'meta',
      icon: <DatabaseOutlined />,
      label: t('shell:menu.meta'),
      children: [
        { key: '/meta/events', label: t('shell:menu.events') },
        { key: '/meta/virtual-properties', label: t('shell:menu.virtualProperties') },
        { key: '/meta/event-attributes', label: t('shell:menu.eventAttributes') },
        { key: '/meta/user-properties', label: t('shell:menu.userProperties') },
        { key: '/meta/virtual-events', label: t('shell:menu.virtualEvents') },
      ],
    });
  }
  // 数据管理：指标 / Debug / 数据表（原属埋点管理，按职责拆出）。
  // 「数据质量」已迁到运维组（phase: clklog-data-quality-ops-ia-v1）：它是链路对账，不是埋点定义。
  // 子项各按自己的码显示（rbac-v3 §7）：分析师持 metric.view，故只看到「指标」。
  const dataChildren = [
    ...(flags.showMeta ? [{ key: '/meta/onboarding', label: t('shell:menu.onboarding') }] : []),
    ...(permissions.has('metric.view') ? [{ key: '/meta/metrics', label: t('shell:menu.metrics') }] : []),
    ...(flags.showMeta
      ? [
          { key: '/meta/debug', label: 'Debug' },
          { key: '/meta/datatables', label: t('shell:menu.datatables') },
        ]
      : []),
  ];
  if (flags.showData && dataChildren.length) {
    items.push({
      key: 'data',
      icon: <TableOutlined />,
      label: t('shell:menu.data'),
      children: dataChildren,
    });
  }
  if (flags.showIam) {
    items.push({
      key: 'iam',
      icon: <SafetyCertificateOutlined />,
      label: t('shell:menu.iam'),
      children: [
        { key: '/iam/members', label: t('shell:menu.members') },
        { key: '/iam/groups', label: t('shell:menu.groups') },
        { key: '/iam/roles', label: t('shell:menu.roles') },
        { key: '/iam/data-policies', label: t('shell:menu.dataPolicies') },
      ],
    });
  }
  // 运维：仅平台超管可见（ops.* 只有超管持有，见 shell-menu 说明）
  if (flags.showOps) {
    items.push({
      key: 'ops',
      icon: <ToolOutlined />,
      label: t('shell:menu.ops'),
      children: [
        { key: '/ops/slow-queries', label: t('shell:menu.slowQueries') },
        { key: '/ops/server-status', label: t('shell:menu.serverStatus') },
        { key: '/ops/alerts', label: t('shell:menu.alerts') },
        { key: '/ops/data-management', label: t('shell:menu.dataManagement') },
        { key: '/ops/quality', label: t('shell:menu.quality') },
      ],
    });
  }
  return items;
}

function buildSettingsMenu(permissions: Set<string>, onLogout: () => void, t: TFunction) {
  const flags = filterMenuByPermissions(permissions);
  return {
    key: 'settings',
    icon: <SettingOutlined />,
    label: t('shell:menu.settings'),
    children: [
      { key: '/settings/profile', label: t('shell:menu.profile') },
      ...(flags.showUsers ? [{ key: '/settings/users', label: t('shell:menu.users') }] : []),
      ...(flags.showOwners ? [{ key: '/settings/project-owners', label: t('shell:menu.projectOwners') }] : []),
      ...(flags.showApiKeys ? [{ key: '/settings/api-keys', label: t('shell:menu.apiKeys') }] : []),
      ...(flags.showAiWorkspace ? [{ key: '/admin/ai/workspace', label: 'AI Workspace' }] : []),
      {
        key: SHELL_PROJECT_KEY,
        label: (
          <div
            className="shell-sider-project"
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <ProjectSelector />
          </div>
        ),
      },
      {
        key: SHELL_LOGOUT_KEY,
        icon: <LogoutOutlined />,
        label: t('shell:menu.logout'),
        danger: true,
        onClick: () => onLogout(),
      },
    ],
  };
}

const SIDER_PREF_KEY = 'clklog.sider';

/**
 * 菜单悬停展开会让 ShellChrome 频繁重渲染；Outlet 只需跟随路由与项目切换，
 * memo 化后避免悬停菜单时连带重渲染整个内容页。
 */
const ShellOutlet = memo(Outlet);

function ShellChrome() {
  const [menuDrawer, setMenuDrawer] = useState(false);
  // 实例级平台时区引导（phase: clklog-analytics-timezone-v1）：持久化会话缺登录路径时补齐；
  // v2 同时引导用户偏好与项目时区（timezone-v2）
  useEffect(() => {
    let mounted = true;
    me()
      .then((res) => {
        if (mounted) {
          setPlatformTimeZone(res.platform_timezone);
          setUserTimeZone(res.timezone);
          // 以服务端为准刷新账号动态标记（account-lifecycle-v1：强制改密/邮箱可能被管理员改动）
          const store = useAuthStore.getState();
          if (store.user) {
            store.setUser({
              ...store.user,
              email: res.email ?? null,
              must_change_password: res.must_change_password ?? false,
            });
          }
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  // 项目时区引导：可访问项目列表落 store 后按当前项目同步；切换项目随行
  useEffect(() => {
    let mounted = true;
    listAccessibleProjects()
      .then((list) => {
        if (!mounted || list.length === 0) return;
        useProjectStore
          .getState()
          .setProjects(list.map((p) => ({ name: p.name, display_name: p.display_name, timezone: p.timezone ?? null })));
        const current = useProjectStore.getState().currentProject;
        setProjectTimeZone(list.find((p) => p.name === current)?.timezone ?? null);
      })
      .catch(() => undefined);
    const unsubscribe = useProjectStore.subscribe((state) => {
      const tz = state.projects.find((p) => p.name === state.currentProject)?.timezone ?? null;
      setProjectTimeZone(tz);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  // 悬停展开：板块默认全折叠，鼠标进入哪个板块只展开哪个，离开菜单整体折叠
  const [menuOpenKeys, setMenuOpenKeys] = useState<string[]>([]);
  // 默认折叠（用户要求）；持久化用户偏好
  const [userSider, setUserSider] = useState<'auto' | 'expanded' | 'collapsed'>(() => {
    const saved = localStorage.getItem(SIDER_PREF_KEY);
    return saved === 'expanded' || saved === 'collapsed' ? saved : 'collapsed';
  });
  const { t, i18n } = useT('shell');
  const location = useLocation();
  const navigate = useNavigate();
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const mustChangePassword = useAuthStore((s) => Boolean(s.user?.must_change_password));
  const permissions = useIamStore((s) => s.permissions);
  const loadMe = useIamStore((s) => s.loadMe);
  const iamLoadFailed = useIamStore((s) => s.lastLoadFailed);
  const iamReady = useIamStore((s) => s.hydrated && !s.loading);
  const currentProject = useProjectStore((s) => s.currentProject);
  const resetAiForProject = useAiChatStore((s) => s.resetForProject);
  const previousProject = useRef(currentProject);
  const contentRef = useRef<HTMLDivElement>(null);
  const { layout, setSiderExpanded } = useShellLayout();
  // 侧栏展开宽度随语言实测（俄/德/越/泰标签显著更长，见 useSiderWidth）
  const menuRef = useRef<HTMLDivElement>(null);
  const siderWidth = useSiderWidth(menuRef, `${i18n.language}|${permissions.size}`);
  useEffect(() => {
    setSiderExpanded(siderWidth);
  }, [siderWidth, setSiderExpanded]);
  const {
    token: { colorBgContainer },
  } = theme.useToken();

  const selectedKeys = location.pathname.startsWith('/analysis/cohorts')
    ? ['/analysis/cohorts']
    : location.pathname.startsWith('/analysis/tags')
      ? ['/analysis/tags']
      : location.pathname.startsWith('/analysis/subjects')
        ? ['/analysis/subjects']
        : [location.pathname];
  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // 即使接口失败也清除本地登录态
    }
    clearAuth();
    useIamStore.getState().reset();
    window.location.assign(ANALYTICS_LOGIN_HREF);
  }, [clearAuth]);

  // 菜单结构只随权限重建：悬停展开时不重算 items，避免连带打断内容区
  const menuItems = useMemo(() => {
    const items = [
      ...buildMenuItems(permissions, t),
      buildSettingsMenu(permissions, () => void handleLogout(), t),
    ];
    // 子项标签套一层可截断 span + title：长语言（俄/德/越/泰）超出侧栏宽度时显示省略号，
    // 悬停仍能看到全称（AGENTS_front：装不下要换结构或给兜底，不许压成竖字/切一半）
    return items.map((item) =>
      'children' in item && item.children
        ? {
            ...item,
            children: item.children.map((child) =>
              typeof child.label === 'string'
                ? {
                    ...child,
                    label: (
                      <span className="shell-sider-menu-label" title={child.label}>
                        {child.label}
                      </span>
                    ),
                  }
                : child,
            ),
          }
        : item,
    );
  }, [permissions, handleLogout, t]);
  // 板块标题包一层并标 data-menu-key：悬停命中交给菜单容器代理，热区覆盖整行标题
  const hoverMenuItems = useMemo(
    () =>
      menuItems.map((item) =>
        'children' in item && item.children
          ? {
              ...item,
              label: (
                <span
                  className="shell-sider-menu-label"
                  data-menu-key={String(item.key)}
                  title={typeof item.label === 'string' ? item.label : undefined}
                >
                  {item.label}
                </span>
              ),
            }
          : item,
      ),
    [menuItems],
  );

  // 当前选中项所属的顶层板块：鼠标移出菜单时只折叠其它板块，选中板块保持展开
  const activeMenuGroupKey = (() => {
    for (const item of menuItems) {
      const children = 'children' in item && item.children ? item.children : [];
      if (children.some((child) => selectedKeys.includes(String(child.key)))) return String(item.key);
    }
    return null;
  })();

  useEffect(() => {
    if (!activeMenuGroupKey) return;
    setMenuOpenKeys((prev) => (prev.includes(activeMenuGroupKey) ? prev : [...prev, activeMenuGroupKey]));
  }, [activeMenuGroupKey]);

  /** 悬停展开是累加的：允许同时展开多个板块，避免板块间实时折叠造成的位置跳动 */
  const openMenuGroup = (key: string) => setMenuOpenKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
  const dockAiAssistant = [
    '/analysis/event',
    '/analysis/funnel',
    '/analysis/retention',
    '/report/sql',
  ].includes(location.pathname);

  useEffect(() => {
    void loadMe();
  }, [currentProject, loadMe]);

  /**
   * 权限求值瞬时失败（发版重启 / 网络抖动）时退避重试：3s → 6s → 12s → 20s，最多 4 次。
   * 期间沿用上次已知权限（store 不清空），重试成功后自动恢复；失败次数用尽则停手，
   * 等下一次项目切换或页面刷新。
   */
  useEffect(() => {
    if (!iamLoadFailed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (cancelled) return;
        attempt += 1;
        await loadMe();
        if (!cancelled && useIamStore.getState().lastLoadFailed && attempt < 4) schedule();
      }, Math.min(3000 * 2 ** (attempt - 1), 20000));
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [iamLoadFailed, loadMe]);

  useEffect(() => {
    if (previousProject.current !== currentProject) {
      resetAiForProject();
      useAnalysisStore.getState().reset();
      useFunnelStore.getState().reset();
      useRetentionStore.getState().reset();
      previousProject.current = currentProject;
    }
  }, [currentProject, resetAiForProject]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, left: 0 });
  }, [location.pathname]);

  useEffect(() => {
    setMenuDrawer(false);
  }, [layout.band, location.pathname]);

  useEffect(() => {
    setUserSider('auto');
  }, [layout.band]);

  const onMenuClick = useCallback(
    ({ key }: { key: string }) => {
      if (key === SHELL_LOGOUT_KEY) {
        void handleLogout();
        return;
      }
      if (!isShellRouteMenuKey(key)) return;
      navigate(key);
      setMenuDrawer(false);
    },
    [handleLogout, navigate],
  );

  const siderCollapsed =
    userSider === 'expanded'
      ? false
      : userSider === 'collapsed'
        ? true
        : layout.sider !== 'expanded';

  const toggleSider = () => {
    const next = siderCollapsed ? 'expanded' : 'collapsed';
    setUserSider(next);
    localStorage.setItem(SIDER_PREF_KEY, next);
  };

  const renderMenu = (collapsed: boolean) => (
    <ConfigProvider theme={{ components: { Menu: { collapsedWidth: SIDER_COLLAPSED } } }}>
      <div
        className="shell-sider-menu-hover"
        onMouseOver={(event) => {
          if (collapsed) return;
          // 命中整个 submenu 标题行（含图标与行尾空白），不只在文字上
          const title = (event.target as HTMLElement).closest('.ant-menu-submenu-title');
          const key = title?.querySelector('[data-menu-key]')?.getAttribute('data-menu-key');
          if (key) openMenuGroup(key);
        }}
        onMouseLeave={() => {
          // 只在鼠标移出菜单时折叠，且保留选中项所在板块
          setMenuOpenKeys(activeMenuGroupKey ? [activeMenuGroupKey] : []);
        }}
      >
        <Menu
          key={collapsed ? 'collapsed' : 'expanded'}
          className="shell-sider-menu"
          rootClassName="shell-sider-menu"
          mode="inline"
          inlineCollapsed={collapsed}
          inlineIndent={12}
          selectedKeys={selectedKeys}
          openKeys={collapsed ? undefined : menuOpenKeys}
          onOpenChange={(keys) => {
            // 折叠态走 popup，不写入悬停展开状态，切回展开态时保持全折叠
            if (!collapsed) setMenuOpenKeys(keys);
          }}
          items={collapsed ? menuItems : hoverMenuItems}
          onClick={onMenuClick}
          triggerSubMenuAction="hover"
          getPopupContainer={() => document.body}
          style={collapsed ? { width: SIDER_COLLAPSED } : undefined}
        />
      </div>
    </ConfigProvider>
  );

  return (
    <Layout style={{ height: '100vh' }}>
      {layout.siderInFlow > 0 ? (
        <Sider
          className="shell-sider"
          trigger={null}
          collapsible
          collapsed={siderCollapsed}
          collapsedWidth={SIDER_COLLAPSED}
          width={siderWidth}
          theme="light"
          style={{ ['--shell-sider-collapsed' as string]: `${SIDER_COLLAPSED}px` }}
        >
          {/* brand 行：折叠钮在 logo 旁；折叠后图形标，点击展开侧栏 */}
          <div className="shell-sider__brand" style={{ fontSize: 15, gap: 4, justifyContent: siderCollapsed ? 'center' : 'space-between', padding: siderCollapsed ? 0 : '0 8px' }}>
            {siderCollapsed ? (
              <button type="button" className="shell-sider__brand-toggle" onClick={toggleSider} aria-label={t('shell:header.expandMenu')}>
                <BrandLogo variant="mark" size={20} />
                {/* 折叠态保留可点击展开的视觉暗示 */}
                <DownOutlined style={{ fontSize: 10 }} />
              </button>
            ) : (
              <>
                <BrandLogo variant="full" />
                <Button
                  type="text"
                  size="small"
                  icon={<MenuFoldOutlined />}
                  onClick={toggleSider}
                  aria-label={t('shell:header.collapseMenu')}
                />
              </>
            )}
          </div>
          <div className="shell-sider__menu" ref={menuRef}>
            {renderMenu(siderCollapsed)}
          </div>
        </Sider>
      ) : null}
      <Layout>
        {layout.sider === 'overlay' ? (
          <Header className="shell-overlay-header" style={{ background: colorBgContainer }}>
            <Button
              type="text"
              icon={menuDrawer ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
              onClick={() => setMenuDrawer(true)}
              aria-label={t('shell:header.openMenu')}
            />
          </Header>
        ) : null}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
          <Content
            ref={contentRef}
            className="shell-content"
            style={{
              margin: 0,
              padding: dockAiAssistant ? '16px 12px 16px 16px' : 16,
              background: colorBgContainer,
              overflow: 'hidden',
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div className="shell-page">
              {mustChangePassword ? (
                <ForcedPasswordChange onLogout={() => void handleLogout()} />
              ) : iamReady ? (
                <ShellOutlet key={currentProject} />
              ) : (
                <div>{t('auth:gate.loadingPermissions')}</div>
              )}
            </div>
          </Content>
          <AiAssistantPanel docked={dockAiAssistant} />
        </div>
      </Layout>
      <Drawer
        title={t('shell:drawer.title')}
        placement="left"
        width={siderWidth}
        open={menuDrawer}
        onClose={() => setMenuDrawer(false)}
      >
        {renderMenu(false)}
      </Drawer>
    </Layout>
  );
}

export function MainLayout() {
  return (
    <ShellLayoutProvider>
      <ShellChrome />
    </ShellLayoutProvider>
  );
}
