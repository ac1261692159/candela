import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '../../i18n/format';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Checkbox,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { CheckOutlined, EditOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { EmptyState } from '../../components/EmptyState';
import { createDashboard, getDashboards, updateDashboard } from '../../services/report.service';
import type { DashboardSummary } from '../../types/report.types';
import {
  createFolder,
  deleteFolder,
  getDashboardAcl,
  getFolderAcl,
  getFolders,
  lockDashboard,
  lockFolder,
  patchFolder,
  putDashboardAcl,
  putFolderAcl,
  type FolderNode,
  type FolderTree,
} from '../../services/iam.service';
import { useIamStore } from '../../stores/iam.store';
import { useT } from '../../i18n';
import { AssetGrantModal } from './AssetGrantModal';
import { AssetName } from './AssetName';
import './asset-list.css';

const UNCATEGORIZED = '__uncategorized__';
const ROOT_FOLDER = '__root__';

function fmtDate(v: string) {
  return formatDateTime(v);
}

function flattenFolders(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((n) => [n, ...(n.children ? flattenFolders(n.children) : [])]);
}

function folderLabel(f: FolderNode, byId: Map<string, FolderNode>) {
  if (f.parent_id) {
    const parent = byId.get(f.parent_id);
    return parent ? `${parent.name} / ${f.name}` : f.name;
  }
  return f.name;
}

export function DashboardListPage() {
  const { t } = useT('report');
  const navigate = useNavigate();
  const canFolder = useIamStore((s) => s.has('dashboard.folder.manage'));
  const canLock = useIamStore((s) => s.has('asset.lock'));
  const canGrant = useIamStore((s) => s.has('asset.grant'));
  const canViewAll = useIamStore((s) => s.has('dashboard.view_all'));
  const canEdit = useIamStore((s) => s.has('dashboard.edit'));
  const [list, setList] = useState<DashboardSummary[]>([]);
  const [tree, setTree] = useState<FolderTree | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'folder' | 'list'>(() => {
    try {
      return localStorage.getItem('clklog-dashboard-view') === 'list' ? 'list' : 'folder';
    } catch {
      return 'folder';
    }
  });
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [createFolderId, setCreateFolderId] = useState<string>(UNCATEGORIZED);
  const [creating, setCreating] = useState(false);
  const [folderModal, setFolderModal] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [newFolderParent, setNewFolderParent] = useState<string>(ROOT_FOLDER);
  const [grantTarget, setGrantTarget] = useState<{ kind: 'dashboard' | 'folder'; id: string; name: string } | null>(
    null,
  );
  const [lockTarget, setLockTarget] = useState<DashboardSummary | null>(null);
  const [lockCards, setLockCards] = useState(false);
  // 列表默认只读：转移路径与操作列只在编辑态出现
  const [editing, setEditing] = useState(false);
  // 编辑态内的转移路径改动先落草稿：点「保存」才写库，「取消」直接丢弃
  const [draftDashboardFolders, setDraftDashboardFolders] = useState<Record<string, string>>({});
  const [draftFolderParents, setDraftFolderParents] = useState<Record<string, string>>({});
  const canManage = canEdit || canFolder || canLock || canGrant;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, folders] = await Promise.all([getDashboards(), getFolders()]);
      setList([...rows].sort((a, b) => a.name.localeCompare(b.name, 'zh')));
      setTree(folders);
    } catch {
      // 拦截器已提示
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const folderMap = useMemo(() => flattenFolders(tree?.folders ?? []), [tree]);
  const folderById = useMemo(() => new Map(folderMap.map((f) => [f.folder_id, f])), [folderMap]);
  const roots = tree?.folders ?? [];

  const folderOptions = useMemo(
    () => [
      { value: UNCATEGORIZED, label: t('report:folder.uncategorized') },
      ...folderMap.map((f) => ({ value: f.folder_id, label: folderLabel(f, folderById) })),
    ],
    [folderMap, folderById, t],
  );

  const parentOptionsFor = (folder: FolderNode) => {
    const hasChildren = (folder.children?.length ?? 0) > 0 || folderMap.some((f) => f.parent_id === folder.folder_id);
    const options = [{ value: ROOT_FOLDER, label: t('report:folder.root') }];
    if (hasChildren && !folder.parent_id) return options;
    for (const root of roots) {
      if (root.folder_id === folder.folder_id) continue;
      options.push({ value: root.folder_id, label: root.name });
    }
    return options;
  };

  const stageDashboardFolder = (row: DashboardSummary, next: string) =>
    setDraftDashboardFolders((prev) => ({ ...prev, [row.db_id]: next }));

  const stageFolderParent = (folder: FolderNode, next: string) =>
    setDraftFolderParents((prev) => ({ ...prev, [folder.folder_id]: next }));

  /** 保存编辑：把草稿里的转移路径一次性写库，再退出编辑态 */
  const saveEdits = async () => {
    const dashboardMoves = Object.entries(draftDashboardFolders);
    const folderMoves = Object.entries(draftFolderParents);
    setEditing(false);
    try {
      await Promise.all([
        ...dashboardMoves.map(([dbId, folderId]) =>
          updateDashboard(dbId, { folder_id: folderId === UNCATEGORIZED ? null : folderId }),
        ),
        ...folderMoves.map(([folderId, parentId]) =>
          patchFolder(folderId, { parent_id: parentId === ROOT_FOLDER ? null : parentId }),
        ),
      ]);
      if (dashboardMoves.length || folderMoves.length) message.success(t('report:folder.pathSaved'));
    } catch {
      message.warning(t('report:folder.pathSaveFailed'));
    }
    setDraftDashboardFolders({});
    setDraftFolderParents({});
    await load();
  };

  /** 取消编辑：丢弃草稿并退出编辑态（不写库） */
  const discardEdits = () => {
    setDraftDashboardFolders({});
    setDraftFolderParents({});
    setEditing(false);
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      message.warning(t('report:dashboard.nameRequired'));
      return;
    }
    setCreating(true);
    try {
      const db = await createDashboard({
        name: name.trim(),
        folder_id: createFolderId === UNCATEGORIZED ? null : createFolderId,
      });
      message.success(t('report:dashboard.created'));
      setModalOpen(false);
      setName('');
      setCreateFolderId(UNCATEGORIZED);
      navigate(`/report/dashboards/${db.db_id}`);
    } catch {
      // 拦截器已提示
    } finally {
      setCreating(false);
    }
  };

  const dashboardColumns: ColumnsType<DashboardSummary> = [
    {
      title: t('report:dashboard.name'),
      dataIndex: 'name',
      key: 'name',
      // 关键名称列：只给最小宽度（名称是用户数据，长度不受语言影响，按最长语言留足下限）
      // + ellipsis 截断；窄屏由 Table.scroll 出横滚，不再被挤压成每字一行
      minWidth: 280,
      render: (v: string, r) => (
        <Space size={4} wrap style={{ rowGap: 4 }}>
          {/* 名称最多显示 260px，截断时悬停看全称（原来写死 180px，长看板名过早截断） */}
          <Typography.Text ellipsis={{ tooltip: v }} style={{ maxWidth: 260 }}>
            <AssetName
              name={v}
              description={r.description}
              onClick={() => navigate(`/report/dashboards/${r.db_id}`)}
            />
          </Typography.Text>
          {r.locked ? <Tag>{t('report:state.locked')}</Tag> : null}
          {(r.grant_count ?? 0) > 0 ? <Tag color="gold">{t('report:state.granted')}</Tag> : null}
          {r.can_edit ? <Tag color="blue">{t('report:state.editable')}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t('report:dashboard.cardCountColumn'),
      dataIndex: 'card_count',
      key: 'card_count',
      // 列名是译后文案（俄「Кол-во карточек」≈14 字符）：下限按最长语言给，不用中文 90px 硬撑
      minWidth: 120,
      ellipsis: { showTitle: true },
      // 更新时间不再单独占列，改为悬停卡片数时显示
      render: (v: number, r) => (
        <Tooltip title={t('report:card.updatedAt', { value: fmtDate(r.updated_at) })}>{v ?? 0}</Tooltip>
      ),
    },
    {
      title: t('report:folder.path'),
      key: 'path',
      minWidth: 220,
      ellipsis: { showTitle: true },
      render: (_, row) =>
        canEdit ? (
          // 阻断冒泡：行点击会跳进看板，转移路径的下拉不能被行点击吞掉
          <Space onClick={(e) => e.stopPropagation()} style={{ width: '100%' }}>
            <Select
              size="small"
              style={{ width: '100%', minWidth: 180 }}
              value={draftDashboardFolders[row.db_id] ?? row.folder_id ?? UNCATEGORIZED}
              onChange={(next) => stageDashboardFolder(row, next)}
              options={folderOptions}
              aria-label={t('report:folder.pathAria', { name: row.name })}
            />
          </Space>
        ) : (
          folderOptions.find((o) => o.value === (row.folder_id || UNCATEGORIZED))?.label ??
          t('report:folder.uncategorized')
        ),
    },
    {
      title: t('common:label.actions'),
      key: 'actions',
      // 操作列：按钮文字是译后文案（俄「Снять блокировку」≈16 字符），换行而不是压成一字一列；
      // 固定列宽度由 rc-table 在运行时量测，这里只给下限
      minWidth: 200,
      fixed: 'right',
      render: (_, row) => (
        <Space onClick={(e) => e.stopPropagation()} wrap style={{ rowGap: 4 }}>
          {canLock ? (
            <Button size="small" onClick={() => setLockTarget(row)}>
              {row.locked ? t('report:action.unlock') : t('report:action.lock')}
            </Button>
          ) : null}
          {canGrant ? (
            <Button
              size="small"
              disabled={Boolean(row.locked)}
              onClick={() => setGrantTarget({ kind: 'dashboard', id: row.db_id, name: row.name })}
            >
              {t('report:action.grant')}
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  // 默认只读：转移路径与操作列只在编辑态出现
  const dashboardColumnsShown = dashboardColumns.filter(
    (col) => editing || (col.key !== 'path' && col.key !== 'actions'),
  );

  const dashboardsOf = (folderId: string | null) =>
    list.filter((row) => (folderId ? row.folder_id === folderId : !row.folder_id));

  const renderFolderActions = (folder: FolderNode) => (
    <Space wrap onClick={(e) => e.stopPropagation()}>
      {canFolder ? (
        <Button
          size="small"
          onClick={() => {
            const next = window.prompt(t('report:folder.name'), folder.name);
            if (next) void patchFolder(folder.folder_id, { name: next }).then(load);
          }}
        >
          {t('common:action.rename')}
        </Button>
      ) : null}
      {canLock ? (
        <Button size="small" onClick={() => void lockFolder(folder.folder_id, !folder.locked).then(load)}>
          {folder.locked ? t('report:action.unlock') : t('report:action.lock')}
        </Button>
      ) : null}
      {canGrant ? (
        <Button
          size="small"
          disabled={folder.locked}
          onClick={() => setGrantTarget({ kind: 'folder', id: folder.folder_id, name: folder.name })}
        >
          {t('report:action.grant')}
        </Button>
      ) : null}
      {canFolder ? (
        <Button size="small" danger onClick={() => void deleteFolder(folder.folder_id).then(load)}>
          {t('common:action.delete')}
        </Button>
      ) : null}
    </Space>
  );

  const nestedDashboardTable = (folderId: string | null) => (
    <Table
      rowKey="db_id"
      size="small"
      pagination={false}
      scroll={{ x: 980 }}
      dataSource={dashboardsOf(folderId)}
      columns={dashboardColumnsShown}
      onRow={(record) => ({
        onClick: () => navigate(`/report/dashboards/${record.db_id}`),
        style: { cursor: 'pointer' },
      })}
      locale={{
        emptyText: (
          <EmptyState
            variant="dashboard"
            title={t('report:folder.emptyTitle')}
            description={t('report:folder.emptyDescription')}
          />
        ),
      }}
    />
  );

  type FolderRow = {
    key: string;
    name: string;
    folder: FolderNode | null;
    count: number;
  };

  const folderRows: FolderRow[] = [
    {
      key: UNCATEGORIZED,
      name: t('report:folder.uncategorized'),
      folder: null,
      count: tree?.uncategorized.dashboard_count ?? dashboardsOf(null).length,
    },
    ...roots.map((f) => ({
      key: f.folder_id,
      name: f.name,
      folder: f,
      count: f.dashboard_count + (f.children ?? []).reduce((n, c) => n + c.dashboard_count, 0),
    })),
  ];

  const folderColumns: ColumnsType<FolderRow> = [
    {
      title: t('report:folder.title'),
      dataIndex: 'name',
      render: (name: string, row) => (
        <Space>
          <FolderOutlined />
          <span>{name}</span>
          {row.folder?.locked ? <Tag>{t('report:state.locked')}</Tag> : null}
          <Typography.Text type="secondary">{row.count}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('report:folder.path'),
      key: 'path',
      minWidth: 200,
      ellipsis: { showTitle: true },
      render: (_, row) =>
        row.folder ? (
          canFolder ? (
            <Space onClick={(e) => e.stopPropagation()} style={{ width: '100%' }}>
              <Select
                size="small"
                style={{ width: '100%', minWidth: 180 }}
                value={draftFolderParents[row.folder.folder_id] ?? row.folder.parent_id ?? ROOT_FOLDER}
                options={parentOptionsFor(row.folder)}
                onChange={(next) => stageFolderParent(row.folder!, next)}
                aria-label={t('report:folder.pathAria', { name: row.name })}
              />
            </Space>
          ) : (
            t('report:folder.root')
          )
        ) : (
          '—'
        )
    },
    {
      title: t('common:label.actions'),
      key: 'actions',
      // 4 个译后按钮（重命名/锁定/授权/删除）：只给下限，靠 Space wrap 换行而不是压成一字一列
      minWidth: 280,
      render: (_, row) => (row.folder ? renderFolderActions(row.folder) : null),
    },
  ];

  // 默认只读：转移路径与操作列只在编辑态出现
  const folderColumnsShown = folderColumns.filter(
    (col) => editing || (col.key !== 'path' && col.key !== 'actions'),
  );

  return (
    <Card
      title={t('report:dashboard.list')}
      extra={
        <Space wrap>
          <Segmented
            value={viewMode}
            options={[
              { label: t('report:dashboard.viewFolders'), value: 'folder' },
              { label: t('report:dashboard.viewList'), value: 'list' },
            ]}
            onChange={(v) => {
              const next = v === 'list' ? 'list' : 'folder';
              setViewMode(next);
              try {
                localStorage.setItem('clklog-dashboard-view', next);
              } catch {
                // ignore
              }
            }}
          />
          {canManage ? (
            <Button
              icon={editing ? <CheckOutlined /> : <EditOutlined />}
              onClick={() => {
                if (!editing) {
                  setEditing(true);
                  return;
                }
                Modal.confirm({
                  title: t('report:edit.confirmTitle'),
                  content: t('report:folder.finishEditBody'),
                  okText: t('common:action.save'),
                  cancelText: t('common:action.cancel'),
                  onOk: () => void saveEdits(),
                  onCancel: () => discardEdits(),
                });
              }}
            >
              {editing ? t('report:action.done') : t('common:action.edit')}
            </Button>
          ) : null}
          {canFolder ? (
            <Button icon={<FolderOutlined />} onClick={() => setFolderModal(true)}>
              {t('report:folder.create')}
            </Button>
          ) : null}
          {canEdit ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
              {t('report:dashboard.create')}
            </Button>
          ) : null}
        </Space>
      }
    >
      {viewMode === 'list' ? (
        <Table
          rowKey="db_id"
          loading={loading}
          dataSource={list}
          columns={dashboardColumnsShown}
          pagination={false}
          scroll={{ x: 980 }}
          onRow={(record) => ({
            onClick: () => navigate(`/report/dashboards/${record.db_id}`),
            style: { cursor: 'pointer' },
          })}
          locale={{
            emptyText: (
              <>
                <EmptyState
                  variant="dashboard"
                  action={
                    canEdit ? (
                      <Button
                        type="primary"
                        icon={<PlusOutlined />}
                        onClick={() => setModalOpen(true)}
                        aria-label={t('report:dashboard.createFirstAria')}
                      >
                        {t('report:dashboard.create')}
                      </Button>
                    ) : undefined
                  }
                />
                {/* rbac-v5：看板默认只对 owner / 分析管理员开放，无授权时说明原因 */}
                {!canViewAll ? (
                  <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
                    {t('report:dashboard.emptyNoGrant')}
                  </Typography.Paragraph>
                ) : null}
              </>
            ),
          }}
        />
      ) : (
        <Table
          rowKey="key"
          loading={loading}
          dataSource={folderRows}
          pagination={false}
          expandable={{
            defaultExpandAllRows: true,
            expandedRowRender: (row) => (
              <div style={{ padding: '4px 0 8px 12px' }}>
                {row.folder
                  ? (row.folder.children ?? []).map((child) => (
                      <div key={child.folder_id} style={{ marginBottom: 16 }}>
                        <Space style={{ marginBottom: 8 }} wrap>
                          <FolderOutlined />
                          <Typography.Text strong>{child.name}</Typography.Text>
                          {child.locked ? <Tag>{t('report:state.locked')}</Tag> : null}
                          <Typography.Text type="secondary">
                            {t('report:folder.dashboardCount', { count: child.dashboard_count })}
                          </Typography.Text>
                          {editing && canFolder ? (
                            <Select
                              size="small"
                              style={{ width: 160 }}
                              value={draftFolderParents[child.folder_id] ?? child.parent_id ?? ROOT_FOLDER}
                              options={parentOptionsFor(child)}
                              onChange={(next) => stageFolderParent(child, next)}
                              aria-label={t('report:folder.pathAria', { name: child.name })}
                            />
                          ) : null}
                          {editing ? renderFolderActions(child) : null}
                        </Space>
                        {nestedDashboardTable(child.folder_id)}
                      </div>
                    ))
                  : null}
                {nestedDashboardTable(row.folder?.folder_id ?? null)}
              </div>
            ),
          }}
          columns={folderColumnsShown}
        />
      )}
      <Modal
        title={t('report:dashboard.create')}
        open={modalOpen}
        onOk={handleCreate}
        onCancel={() => setModalOpen(false)}
        confirmLoading={creating}
        okText={t('report:action.create')}
        destroyOnClose
      >
        <Typography.Text id="dashboard-name-label">{t('common:label.name')}</Typography.Text>
        <Input
          aria-labelledby="dashboard-name-label"
          autoFocus
          maxLength={200}
          placeholder={t('report:dashboard.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={handleCreate}
          style={{ marginTop: 8 }}
        />
        <Typography.Text id="dashboard-folder-label" style={{ display: 'block', marginTop: 16 }}>
          {t('report:folder.field')}
        </Typography.Text>
        <Select
          aria-labelledby="dashboard-folder-label"
          style={{ width: '100%', marginTop: 8 }}
          value={createFolderId}
          options={folderOptions}
          onChange={setCreateFolderId}
        />
      </Modal>
      <Modal
        title={t('report:folder.create')}
        open={folderModal}
        onCancel={() => setFolderModal(false)}
        onOk={async () => {
          if (!folderName.trim()) return;
          await createFolder({
            name: folderName.trim(),
            parent_id: newFolderParent === ROOT_FOLDER ? null : newFolderParent,
          });
          message.success(t('report:folder.created'));
          setFolderName('');
          setNewFolderParent(ROOT_FOLDER);
          setFolderModal(false);
          await load();
        }}
      >
        <Input
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          placeholder={t('report:folder.name')}
          style={{ marginBottom: 12 }}
        />
        <Select
          style={{ width: '100%' }}
          value={newFolderParent}
          onChange={setNewFolderParent}
          options={[
            { value: ROOT_FOLDER, label: t('report:folder.root') },
            ...roots.map((f) => ({ value: f.folder_id, label: f.name })),
          ]}
        />
      </Modal>
      <Modal
        title={lockTarget?.locked ? t('report:dashboard.unlock') : t('report:dashboard.lock')}
        open={Boolean(lockTarget)}
        onCancel={() => {
          setLockTarget(null);
          setLockCards(false);
        }}
        onOk={async () => {
          if (!lockTarget) return;
          await lockDashboard(lockTarget.db_id, !lockTarget.locked, !lockTarget.locked && lockCards);
          setLockTarget(null);
          setLockCards(false);
          await load();
        }}
      >
        {lockTarget && !lockTarget.locked ? (
          <Checkbox checked={lockCards} onChange={(e) => setLockCards(e.target.checked)}>
            {t('report:dashboard.lockCardsHint')}
          </Checkbox>
        ) : (
          <Typography.Paragraph>{t('report:dashboard.unlockHint')}</Typography.Paragraph>
        )}
      </Modal>
      <AssetGrantModal
        open={Boolean(grantTarget)}
        title={t('report:grant.title', { name: grantTarget?.name ?? '' })}
        allowView={Boolean(grantTarget)}
        viewHint={grantTarget?.kind === 'folder' ? t('report:grant.viewHintFolder') : undefined}
        loadGrants={async () => {
          if (!grantTarget) return [];
          return grantTarget.kind === 'folder' ? getFolderAcl(grantTarget.id) : getDashboardAcl(grantTarget.id);
        }}
        saveGrants={async (grants) => {
          if (!grantTarget) return;
          if (grantTarget.kind === 'folder') await putFolderAcl(grantTarget.id, grants);
          else await putDashboardAcl(grantTarget.id, grants);
          await load();
        }}
        onClose={() => setGrantTarget(null)}
      />
    </Card>
  );
}
