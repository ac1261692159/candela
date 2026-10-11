import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Dropdown,
  Input,
  Modal,
  Select,
  Spin,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import {
  CloseOutlined,
  MoreOutlined,
  ReloadOutlined,
  RobotOutlined,  FullscreenExitOutlined,
  FullscreenOutlined,
} from '@ant-design/icons';
import { useAiChatStore } from '../../stores/ai-chat.store';
import { useAiContextStore } from '../../stores/ai-context.store';
import { useProjectStore } from '../../stores/project.store';
import { useAuthStore } from '../../stores/auth.store';
import {
  createPersistentAiWorkspace,
  createTemporaryAiWorkspace,
  deleteAiWorkspace,
  getAiTabId,
  issueHarnessHostTicket,
  listAiWorkspaces,
  promoteTemporaryAiWorkspace,
} from '../../services/ai.service';
import type { AiAnalysisPage, AiWorkspace } from '../../types/ai.types';
import { useT } from '../../i18n';
import { usePageBridge } from './usePageBridge';
import { useShellLayout } from '../../layouts/shell-layout-context';
import {
  HARNESS_DIALOG_MIN,
  HARNESS_DOCK_MIN,
  HARNESS_OVERLAY_MIN,
  SPLIT_MIN,
  STACK_MIN,
  boundedDockedHarnessWidth,
} from '../../layouts/shell-layout';
import { AI_DRAG_THRESHOLD_PX } from './ai-panel-layout';
import './ai-assistant-panel.css';
import { useHarnessConnection } from '../ai-connection/useHarnessConnection';

const PEER_ALERT_DISMISS_KEY = 'clklog-ai-peer-workspace-alert-dismissed';

function readPeerAlertDismissed(): boolean {
  try {
    return sessionStorage.getItem(PEER_ALERT_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writePeerAlertDismissed(): void {
  try {
    sessionStorage.setItem(PEER_ALERT_DISMISS_KEY, '1');
  } catch {
    // 隐私模式等写不了时，本窗口仍用 state 藏掉
  }
}

interface AiAssistantPanelProps {
  docked?: boolean;
}

export function AiAssistantPanel({ docked = true }: AiAssistantPanelProps) {
  const { t } = useT('ai');
  const pageNames: Record<AiAnalysisPage, string> = {
    event: t('shell:menu.event'),
    funnel: t('shell:menu.funnel'),
    retention: t('shell:menu.retention'),
    sql: t('shell:menu.sql'),
  };
  usePageBridge();
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadEpoch, setReloadEpoch] = useState(0);
  const [workspaces, setWorkspaces] = useState<AiWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [peerSessions, setPeerSessions] = useState(0);
  const [peerAlertDismissed, setPeerAlertDismissed] = useState(readPeerAlertDismissed);
  const drag = useRef<{ pointerId: number; x: number; width: number; armed: boolean } | null>(null);
  const connectedKey = useRef('');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const context = useAiContextStore((state) => state.context);
  const contextProject = useAiContextStore((state) => state.project);
  const project = useProjectStore((state) => state.currentProject);
  const user = useAuthStore((state) => state.user);
  const { viewportWidth, layout, overlayOpen, overlayWidth, setOverlayOpen } = useShellLayout();
  const { width, activateUser, setExpanded, setWidth } = useAiChatStore();
  const workbenchFloor = layout.sider === 'expanded' ? SPLIT_MIN : STACK_MIN;
  const panelWidth = layout.harness === 'docked' ? layout.harnessInFlow : overlayWidth;
  const showDocked = docked && layout.harness === 'docked';
  const showOverlay = docked && overlayOpen;
  const visible = showDocked || showOverlay;
  const {
    token: { colorBgContainer, colorBorderSecondary },
  } = theme.useToken();
  const tabId = useMemo(() => getAiTabId(), []);
  /**
   * 官方弹层需要更宽的面（phase: clklog-analytics-ai-panel-surface-v1）。
   * 官方设置弹窗实测要 ≥640 才排得开，更窄时说明文字会逐字断行成竖排；
   * 所以弹层一开、当前面不够宽，就临时离开文档流走覆盖层，关闭后自动还原。
   */
  const promotedRef = useRef(false);
  const [promotedByDialog, setPromotedByDialog] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const markPromoted = useCallback((value: boolean) => {
    promotedRef.current = value;
    setPromotedByDialog(value);
  }, []);
  const onDialogChange = useCallback((open: boolean) => {
    setDialogOpen(open);
    if (!docked) return;
    if (open) {
      // 已经够宽（在覆盖层，或用户自己拖到 ≥640）就不打扰
      if (overlayOpen || panelWidth >= HARNESS_DIALOG_MIN) return;
      markPromoted(true);
      setOverlayOpen(true);
      return;
    }
    if (!promotedRef.current) return;
    markPromoted(false);
    setOverlayOpen(false);
  }, [docked, markPromoted, overlayOpen, panelWidth, setOverlayOpen]);
  const connectionNotice = useHarnessConnection(iframeRef, source, tabId, { onDialogChange });
  // 弹窗打开时的**实际**面宽：视口本身比弹窗下限还窄时，覆盖层也只有 100% 视口，
  // 救不回来——如实说，不假装正常（AGENTS_front.md §2 认可这一点，但要求说清楚）。
  const surfaceWidth = overlayOpen ? overlayWidth : panelWidth;
  const dialogTooNarrow = dialogOpen && surfaceWidth < HARNESS_DIALOG_MIN;
  const activeContext = contextProject === project ? context : null;

  const refreshWorkspaces = useCallback(async () => {
    try {
      const items = await listAiWorkspaces();
      setWorkspaces(items.filter((item) => item.status === 'active'));
    } catch {
      setWorkspaces([]);
    }
  }, []);

  useEffect(() => {
    if (user?.id) activateUser(user.id);
  }, [activateUser, user?.id]);

  useEffect(() => {
    setWorkspaceId('');
  }, [project, user?.id]);

  useEffect(() => {
    void refreshWorkspaces();
  }, [project, reloadEpoch, refreshWorkspaces]);

  const connectKey = `${project}|${user?.id ?? ''}|${workspaceId}|${reloadEpoch}`;

  useEffect(() => {
    let cancelled = false;
    if (connectedKey.current === connectKey && source) return undefined;
    setLoading(true);
    setError('');
    void issueHarnessHostTicket(tabId, workspaceId || undefined)
      .then((ticket) => {
        if (cancelled) return;
        connectedKey.current = connectKey;
        setSource(ticket.launch_url);
        setPeerSessions(ticket.peer_sessions ?? 0);
        void refreshWorkspaces();
      })
      .catch((reason) => {
        if (!cancelled) {
          setLoading(false);
          setError(reason instanceof Error ? reason.message : t('ai:panel.harnessUnavailable'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectKey, refreshWorkspaces, source, t, tabId, workspaceId]);

  const askForName = useCallback((title: string, action: (name: string) => Promise<void>) => {
    let name = '';
    Modal.confirm({
      title,
      content: (
        <Input
          autoFocus
          maxLength={80}
          placeholder={t('ai:workspace.namePlaceholder')}
          onChange={(event) => {
            name = event.target.value;
          }}
        />
      ),
      okText: t('ai:workspace.confirm'),
      cancelText: t('common:action.cancel'),
      onOk: async () => {
        if (!name.trim()) throw new Error(t('ai:workspace.nameRequired'));
        await action(name.trim());
      },
    });
  }, [t]);

  const workspaceMenuClick = useCallback(({ key }: { key: string }) => {
    if (key === 'persistent') {
      askForName(t('ai:workspace.newPersistent'), async (name) => {
        const created = await createPersistentAiWorkspace(name);
        await refreshWorkspaces();
        setWorkspaceId(created.id);
      });
      return;
    }
    if (key === 'temporary') {
      void createTemporaryAiWorkspace().then(async (created) => {
        await refreshWorkspaces();
        setWorkspaceId(created.id);
      });
      return;
    }
    const current = workspaces.find((workspace) => workspace.id === workspaceId);
    if (!current) return;
    if (key === 'promote' && current.kind === 'temporary') {
      askForName(t('ai:workspace.promoteTitle'), async (name) => {
        const promoted = await promoteTemporaryAiWorkspace(current.id, name);
        await refreshWorkspaces();
        setWorkspaceId(promoted.id);
      });
      return;
    }
    if (key === 'delete') {
      Modal.confirm({
        title: t('ai:workspace.deleteTitle', { name: current.display_name }),
        content: t('ai:workspace.deleteContent'),
        okText: t('common:action.delete'),
        okButtonProps: { danger: true },
        cancelText: t('common:action.cancel'),
        onOk: async () => {
          await deleteAiWorkspace(current.id);
          setWorkspaceId('');
          await refreshWorkspaces();
          message.success(t('ai:workspace.deleted'));
        },
      });
    }
  }, [askForName, refreshWorkspaces, t, workspaceId, workspaces]);

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!showDocked || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        width: panelWidth,
        armed: false,
      };
    },
    [showDocked, panelWidth],
  );

  const onResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const session = drag.current;
      if (!session || session.pointerId !== event.pointerId) return;
      const delta = session.x - event.clientX;
      if (!session.armed) {
        if (Math.abs(delta) < AI_DRAG_THRESHOLD_PX) return;
        session.armed = true;
      }
      setWidth(boundedDockedHarnessWidth(
        session.width + delta,
        viewportWidth,
        layout.siderInFlow,
        workbenchFloor,
      ));
    },
    [layout.siderInFlow, setWidth, viewportWidth, workbenchFloor],
  );

  const onResizePointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const openAssistant = useCallback(() => {
    setExpanded(true);
    if (!layout.canDock) setOverlayOpen(true);
  }, [layout.canDock, setExpanded, setOverlayOpen]);

  const closeAssistant = useCallback(() => {
    setExpanded(false);
    setOverlayOpen(false);
  }, [setExpanded, setOverlayOpen]);

  const parked = !visible;
  const iframeNode = source ? (
    <iframe
      ref={iframeRef}
      key={source}
      src={source}
      title="DeepSeek Harness"
      onLoad={() => setLoading(false)}
      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
      referrerPolicy="no-referrer"
      allow="clipboard-read; clipboard-write"
      style={{ width: '100%', flex: 1, minHeight: 0, border: 0, display: 'block' }}
    />
  ) : null;

  return (
    <>
      {docked && !visible ? (
        <aside
          aria-label={t('ai:panel.assistantAria')}
          style={{
            position: 'fixed',
            right: 20,
            bottom: 20,
            zIndex: 1000,
          }}
        >
          <Tooltip title={t('ai:panel.expand')} placement="left">
            <Button
              type="primary"
              icon={<RobotOutlined />}
              onClick={openAssistant}
              style={{ width: 48, height: 48, borderRadius: 24 }}
              aria-label={t('ai:panel.expand')}
            />
          </Tooltip>
        </aside>
      ) : null}
      {showOverlay ? (
        <button
          type="button"
          aria-label={t('ai:panel.closeOverlay')}
          onClick={closeAssistant}
          style={{
            position: 'fixed',
            inset: 0,
            border: 0,
            padding: 0,
            background: 'rgba(15, 23, 42, 0.35)',
            zIndex: 999,
            cursor: 'pointer',
          }}
        />
      ) : null}
      <aside
        aria-label={t('ai:panel.assistantAria')}
        aria-hidden={parked}
        style={parked
          ? {
              position: 'fixed',
              left: -12000,
              top: 0,
              width: HARNESS_DOCK_MIN,
              height: '80vh',
              opacity: 0,
              pointerEvents: 'none',
              zIndex: -1,
            }
          : showOverlay
            ? {
                position: 'fixed',
                top: viewportWidth < HARNESS_OVERLAY_MIN ? 0 : 64,
                right: 0,
                bottom: 0,
                width: overlayWidth,
                zIndex: 1000,
                display: 'flex',
                flexDirection: 'column',
                background: colorBgContainer,
                boxShadow: '-8px 0 24px rgba(15, 23, 42, 0.18)',
              }
            : {
                position: 'relative',
                width: panelWidth,
                minWidth: panelWidth,
                margin: 0,
                border: 0,
                borderLeft: `1px solid ${colorBorderSecondary}`,
                background: colorBgContainer,
                borderRadius: 0,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'row',
                minHeight: 0,
                height: '100%',
                overflow: 'hidden',
              }}
      >
        {showDocked ? (
          <div
            className="ai-panel-resizer"
            role="separator"
            aria-label={t('ai:panel.resizeAria')}
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerEnd}
            onPointerCancel={onResizePointerEnd}
            onKeyDown={(event) => {
              const next = event.key === 'ArrowLeft'
                ? width + 20
                : event.key === 'ArrowRight'
                  ? width - 20
                  : null;
              if (next == null) return;
              setWidth(boundedDockedHarnessWidth(
                next,
                viewportWidth,
                layout.siderInFlow,
                workbenchFloor,
              ));
            }}
          />
        ) : null}

        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
        {visible ? (
          <div
            style={{
              minHeight: 52,
              padding: '8px 8px 8px 14px',
              borderBottom: `1px solid ${colorBorderSecondary}`,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexShrink: 0,
            }}
          >
            <RobotOutlined style={{ fontSize: 18 }} />
            <div style={{ minWidth: 104, maxWidth: 160 }}>
              <Typography.Text strong ellipsis style={{ display: 'block' }}>{t('ai:panel.title')}</Typography.Text>
              <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 11 }}>
                {activeContext ? pageNames[activeContext.page] : t('ai:panel.waitingContext')}
              </Typography.Text>
            </div>
            <Select
              size="small"
              value={workspaceId}
              onChange={setWorkspaceId}
              style={{ flex: 1, minWidth: 120 }}
              popupMatchSelectWidth={false}
              aria-label={t('ai:workspace.selectAria')}
              options={[
                { value: '', label: t('ai:workspace.defaultOption') },
                ...workspaces
                  .filter(
                    (workspace) =>
                      workspace.kind !== 'persistent' || workspace.display_name !== 'default',
                  )
                  .map((workspace) => ({
                    value: workspace.id,
                    label: workspace.kind === 'temporary'
                      ? t('ai:workspace.temporaryOption', { name: workspace.display_name })
                      : workspace.display_name,
                  })),
              ]}
            />
            <Dropdown
              trigger={['click']}
              menu={{
                onClick: workspaceMenuClick,
                items: [
                  { key: 'persistent', label: t('ai:workspace.newPersistent') },
                  { key: 'temporary', label: t('ai:workspace.newTemporary') },
                  {
                    key: 'promote',
                    label: t('ai:workspace.promote'),
                    disabled: workspaces.find((item) => item.id === workspaceId)?.kind !== 'temporary',
                  },
                  { type: 'divider' },
                  { key: 'delete', label: t('ai:workspace.deleteCurrent'), danger: true, disabled: !workspaceId },
                ],
              }}
            >
              <Button type="text" size="small" icon={<MoreOutlined />} aria-label={t('ai:workspace.actionsAria')} />
            </Dropdown>
            {showDocked ? (
              <Tooltip title={t('ai:panel.widen')}>
                <Button
                  type="text"
                  size="small"
                  icon={<FullscreenOutlined />}
                  onClick={() => { markPromoted(false); setOverlayOpen(true); }}
                  aria-label={t('ai:panel.widen')}
                />
              </Tooltip>
            ) : null}
            {showOverlay ? (
              <Tooltip title={t('ai:panel.restoreDock')}>
                <Button
                  type="text"
                  size="small"
                  icon={<FullscreenExitOutlined />}
                  onClick={() => { markPromoted(false); setOverlayOpen(false); }}
                  aria-label={t('ai:panel.restoreDock')}
                />
              </Tooltip>
            ) : null}
            <Tooltip title={t('ai:panel.reconnectHarness')}>
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => setReloadEpoch((value) => value + 1)}
                aria-label={t('ai:panel.reconnectHarness')}
              />
            </Tooltip>
            <Tooltip title={t('common:action.collapse')}>
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined />}
                onClick={closeAssistant}
                aria-label={t('ai:panel.collapse')}
              />
            </Tooltip>
          </div>
        ) : null}

        {visible && peerSessions > 0 && !peerAlertDismissed ? (
          <Alert
            type="info"
            showIcon
            banner
            closable
            onClose={() => {
              writePeerAlertDismissed();
              setPeerAlertDismissed(true);
            }}
            message={t('ai:panel.peerAlert')}
          />
        ) : null}

        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: parked ? '100%' : undefined, background: '#fff' }}>
          {visible && error ? (
            <Alert
              type="error"
              showIcon
              message={t('ai:panel.connectFailed')}
              description={error}
              action={
                <Button size="small" onClick={() => setReloadEpoch((value) => value + 1)}>
                  {t('common:action.retry')}
                </Button>
              }
              style={{ margin: 16 }}
            />
          ) : null}
          {visible && loading && !error ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                zIndex: 1,
                background: colorBgContainer,
              }}
            >
              <Spin tip={t('ai:panel.starting')} />
            </div>
          ) : null}
          {visible && connectionNotice ? <Alert role="status" type="warning" showIcon message={connectionNotice}
            action={<Button size="small" onClick={() => setReloadEpoch((value) => value + 1)}>{t('ai:panel.reconnect')}</Button>} /> : null}
          {visible && (promotedByDialog || dialogTooNarrow) ? (
            <Alert
              role="status"
              type={dialogTooNarrow ? 'warning' : 'info'}
              showIcon
              message={promotedByDialog ? t('ai:panel.widenedForDialog') : t('ai:panel.dialogTooNarrow')}
            />
          ) : null}
          {iframeNode}
        </div>
        </div>
      </aside>
    </>
  );
}
