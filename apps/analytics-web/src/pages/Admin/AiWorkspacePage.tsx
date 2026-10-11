import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '../../i18n/format';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tree,
  Typography,
  Upload,
  message,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import {
  DeleteOutlined,
  FileAddOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  LockOutlined,
  ReloadOutlined,
  SaveOutlined,
  SyncOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  createWorkspaceTemplateDirectory,
  deleteWorkspaceTemplateEntry,
  getWorkspaceSyncJob,
  getWorkspaceTemplateTree,
  initializeLegacyWorkspace,
  listAdminAiWorkspaces,
  listWorkspaceTemplateVersions,
  patchWorkspaceTemplateEntry,
  previewWorkspaceTemplate,
  publishWorkspaceTemplate,
  putWorkspaceTemplateFile,
  restoreWorkspaceTemplateVersion,
  retryWorkspaceSyncJob,
  startWorkspaceSync,
} from '../../services/ai.service';
import type { AiWorkspace, WorkspaceTemplateDraftEntry } from '../../types/ai.types';
import { ModelProviderPanel } from '../../features/ai-model-providers/ModelProviderPanel';
import { useT, type TFunction } from '../../i18n';

type Policy = 'managed_readonly' | 'seed_once';

interface VersionRow {
  version: number;
  state: string;
  content_digest: string;
  published_by: string;
  published_at: string;
}

interface SyncJob {
  id: string;
  state: string;
  planned_count: number;
  success_count: number;
  failed_count: number;
  items: Array<{ workspace_id: string; state: string; error_code?: string }>;
}

interface SyncScopeDraft {
  project_name?: string;
  user_id?: string;
  kind?: 'persistent' | 'temporary';
  workspace_ids?: string[];
}

function treeData(entries: WorkspaceTemplateDraftEntry[]): DataNode[] {
  const roots: DataNode[] = [];
  const nodes = new Map<string, DataNode>();
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const node: DataNode = {
      key: entry.path,
      title: (
        <Space size={4}>
          {entry.kind === 'directory' ? <FolderOpenOutlined /> : <FileOutlined />}
          <span>{entry.path.split('/').slice(-1)[0]}</span>
          {entry.policy === 'managed_readonly' && <LockOutlined style={{ color: '#8c8c8c' }} />}
        </Space>
      ),
      isLeaf: entry.kind === 'file',
      children: entry.kind === 'directory' ? [] : undefined,
    };
    nodes.set(entry.path, node);
    const slash = entry.path.lastIndexOf('/');
    const parent = slash < 0 ? '' : entry.path.slice(0, slash);
    const parentNode = parent ? nodes.get(parent) : undefined;
    if (parentNode?.children) parentNode.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function promptPath(t: TFunction, title: string, onConfirm: (path: string) => Promise<void>): void {
  let value = '';
  Modal.confirm({
    title,
    content: (
      <Input
        autoFocus
        placeholder={t('ai:template.pathPlaceholder')}
        onChange={(event) => {
          value = event.target.value;
        }}
      />
    ),
    okText: t('ai:template.createAction'),
    cancelText: t('common:action.cancel'),
    onOk: async () => {
      if (!value.trim()) throw new Error(t('ai:template.pathRequired'));
      await onConfirm(value.trim());
    },
  });
}

export function AiWorkspacePage() {
  const { t } = useT('ai');
  const [entries, setEntries] = useState<WorkspaceTemplateDraftEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [pathDraft, setPathDraft] = useState('');
  const [content, setContent] = useState('');
  const [policy, setPolicy] = useState<Policy>('seed_once');
  const [executable, setExecutable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [workspaces, setWorkspaces] = useState<AiWorkspace[]>([]);
  const [syncJob, setSyncJob] = useState<SyncJob | null>(null);
  const [syncScopeOpen, setSyncScopeOpen] = useState(false);
  const [syncScope, setSyncScope] = useState<SyncScopeDraft>({});
  const [syncStarting, setSyncStarting] = useState(false);

  const selected = entries.find((entry) => entry.path === selectedPath);
  const data = useMemo(() => treeData(entries), [entries]);
  const projects = useMemo(
    () => [...new Set(workspaces.map((workspace) => workspace.project_name))].sort(),
    [workspaces],
  );
  const users = useMemo(
    () => [...new Set(workspaces.map((workspace) => workspace.user_id))].sort(),
    [workspaces],
  );
  const scopedWorkspaces = useMemo(
    () => workspaces.filter((workspace) =>
      (!syncScope.project_name || workspace.project_name === syncScope.project_name)
      && (!syncScope.user_id || workspace.user_id === syncScope.user_id)
      && (!syncScope.kind || workspace.kind === syncScope.kind)),
    [syncScope.kind, syncScope.project_name, syncScope.user_id, workspaces],
  );

  const loadTree = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getWorkspaceTemplateTree();
      setEntries(result.entries);
      if (selectedPath && !result.entries.some((entry) => entry.path === selectedPath)) {
        setSelectedPath('');
      }
    } finally {
      setLoading(false);
    }
  }, [selectedPath]);

  const loadOperationalData = useCallback(async () => {
    const [versionRows, workspaceRows] = await Promise.all([
      listWorkspaceTemplateVersions(),
      listAdminAiWorkspaces(),
    ]);
    setVersions(versionRows);
    setWorkspaces(workspaceRows);
  }, []);

  useEffect(() => {
    void loadTree();
    void loadOperationalData();
  }, []);

  useEffect(() => {
    if (!selected) return;
    setPathDraft(selected.path);
    setContent(selected.content ?? '');
    setPolicy(selected.policy);
    setExecutable(selected.mode === '0555' || selected.mode === '0755');
  }, [selected]);

  useEffect(() => {
    if (!syncJob || !['planned', 'running'].includes(syncJob.state)) return;
    const timer = window.setInterval(() => {
      void getWorkspaceSyncJob(syncJob.id).then(setSyncJob).catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [syncJob]);

  const refresh = async () => {
    await Promise.all([loadTree(), loadOperationalData()]);
  };

  const saveEntry = async () => {
    if (!selected) return;
    if (selected.kind === 'file') {
      await putWorkspaceTemplateFile({
        path: selected.path,
        content,
        encoding: selected.encoding,
        executable,
      });
    }
    await patchWorkspaceTemplateEntry({
      path: selected.path,
      ...(pathDraft !== selected.path ? { new_path: pathDraft } : {}),
      policy,
      ...(selected.kind === 'file' ? { executable } : {}),
    });
    message.success(t('ai:template.draftSaved'));
    setSelectedPath(pathDraft);
    await loadTree();
  };

  const createFile = () => promptPath(t, t('ai:template.newFileTitle'), async (path) => {
    await putWorkspaceTemplateFile({ path, content: '', encoding: 'utf8' });
    setSelectedPath(path);
    await loadTree();
  });

  const createDirectory = () => promptPath(t, t('ai:template.newDirectoryTitle'), async (path) => {
    await createWorkspaceTemplateDirectory(path);
    setSelectedPath(path);
    await loadTree();
  });

  const removeEntry = () => {
    if (!selected) return;
    Modal.confirm({
      title: t('ai:template.removeTitle', { path: selected.path }),
      content: selected.kind === 'directory'
        ? t('ai:template.removeDirectoryContent')
        : t('ai:template.removeFileContent'),
      okText: t('common:action.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common:action.cancel'),
      onOk: async () => {
        await deleteWorkspaceTemplateEntry(selected.path);
        setSelectedPath('');
        await loadTree();
      },
    });
  };

  const showPreview = async () => {
    const preview = await previewWorkspaceTemplate();
    Modal.info({
      title: t('ai:template.previewTitle', { version: preview.next_version }),
      width: 680,
      content: (
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label={t('ai:template.diffAdded')}>
            {preview.diff.added.join(t('ai:label.listSeparator')) || t('ai:template.diffNone')}
          </Descriptions.Item>
          <Descriptions.Item label={t('ai:template.diffModified')}>
            {preview.diff.modified.join(t('ai:label.listSeparator')) || t('ai:template.diffNone')}
          </Descriptions.Item>
          <Descriptions.Item label={t('ai:template.diffDeleted')}>
            {preview.diff.deleted.join(t('ai:label.listSeparator')) || t('ai:template.diffNone')}
          </Descriptions.Item>
        </Descriptions>
      ),
    });
  };

  const publish = () => {
    Modal.confirm({
      title: t('ai:template.publishTitle'),
      content: t('ai:template.publishContent'),
      okText: t('ai:template.publishAction'),
      cancelText: t('common:action.cancel'),
      onOk: async () => {
        await publishWorkspaceTemplate();
        message.success(t('ai:template.published'));
        await loadOperationalData();
      },
    });
  };

  const syncAll = () => {
    Modal.confirm({
      title: t('ai:sync.allWorkspaces'),
      content: t('ai:sync.allContent'),
      okText: t('ai:sync.startAction'),
      cancelText: t('common:action.cancel'),
      onOk: async () => {
        setSyncStarting(true);
        try {
          const started = await startWorkspaceSync();
          setSyncJob(await getWorkspaceSyncJob(started.id));
        } finally {
          setSyncStarting(false);
        }
      },
    });
  };

  const startScopedSync = async () => {
    setSyncStarting(true);
    try {
      const scope = {
        ...(syncScope.project_name ? { project_name: syncScope.project_name } : {}),
        ...(syncScope.user_id ? { user_id: syncScope.user_id } : {}),
        ...(syncScope.kind ? { kind: syncScope.kind } : {}),
        ...(syncScope.workspace_ids?.length
          ? { workspace_ids: syncScope.workspace_ids }
          : {}),
      };
      const started = await startWorkspaceSync(scope);
      setSyncJob(await getWorkspaceSyncJob(started.id));
      setSyncScopeOpen(false);
      message.success(t('ai:sync.created', { count: started.planned_count }));
    } finally {
      setSyncStarting(false);
    }
  };

  const templateEditor = (
    <div>
      <Alert
        type="info"
        showIcon
        message={t('ai:template.separationTitle')}
        description={t('ai:template.separationDescription')}
        style={{ marginBottom: 16 }}
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<FileAddOutlined />} onClick={createFile}>{t('ai:template.newFile')}</Button>
        <Button icon={<FolderAddOutlined />} onClick={createDirectory}>{t('ai:template.newDirectory')}</Button>
        <Upload
          showUploadList={false}
          beforeUpload={(file) => {
            const reader = new FileReader();
            reader.onload = () => {
              const raw = String(reader.result ?? '');
              const comma = raw.indexOf(',');
              void putWorkspaceTemplateFile({
                path: file.name,
                content: comma >= 0 ? raw.slice(comma + 1) : '',
                encoding: 'base64',
              }).then(async () => {
                setSelectedPath(file.name);
                await loadTree();
              });
            };
            reader.readAsDataURL(file);
            return false;
          }}
        >
          <Button icon={<UploadOutlined />}>{t('ai:template.uploadFile')}</Button>
        </Upload>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>{t('common:action.refresh')}</Button>
      </Space>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 30%) 1fr', gap: 16, minHeight: 520 }}>
        <Card size="small" styles={{ body: { padding: 8, height: 520, overflow: 'auto' } }}>
          <Tree
            blockNode
            defaultExpandAll
            treeData={data}
            selectedKeys={selectedPath ? [selectedPath] : []}
            onSelect={(keys) => setSelectedPath(String(keys[0] ?? ''))}
          />
        </Card>
        <Card
          size="small"
          title={selected ? selected.path : t('ai:template.selectEntry')}
          extra={selected && (
            <Button danger type="text" icon={<DeleteOutlined />} onClick={removeEntry}>
              {t('common:action.delete')}
            </Button>
          )}
        >
          {selected ? (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <div>
                <Typography.Text type="secondary">{t('ai:template.relativePath')}</Typography.Text>
                <Input value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} />
              </div>
              <div>
                <Typography.Text type="secondary">{t('ai:template.syncPolicy')}</Typography.Text>
                <Select
                  value={policy}
                  onChange={setPolicy}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'managed_readonly', label: t('ai:template.policyManagedReadonly') },
                    { value: 'seed_once', label: t('ai:template.policySeedOnce') },
                  ]}
                />
              </div>
              {selected.kind === 'file' && (
                <Space>
                  <Switch checked={executable} onChange={setExecutable} />
                  <Typography.Text>{t('ai:template.allowExecute')}</Typography.Text>
                  {selected.encoding === 'base64' && <Tag>{t('ai:template.binaryBase64')}</Tag>}
                </Space>
              )}
              {selected.kind === 'file' && (
                <Input.TextArea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  autoSize={false}
                  style={{ height: 300, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                  spellCheck={false}
                />
              )}
              <Button type="primary" icon={<SaveOutlined />} onClick={() => void saveEntry()}>
                {t('ai:template.saveDraft')}
              </Button>
            </Space>
          ) : (
            <Typography.Text type="secondary">{t('ai:template.emptyHint')}</Typography.Text>
          )}
        </Card>
      </div>
      <Divider />
      <Space wrap>
        <Button onClick={() => void showPreview()}>{t('ai:template.previewChanges')}</Button>
        <Button type="primary" onClick={publish}>{t('ai:template.publishImmutable')}</Button>
        <Button icon={<SyncOutlined />} loading={syncStarting} onClick={syncAll}>
          {t('ai:sync.allWorkspaces')}
        </Button>
        <Button onClick={() => setSyncScopeOpen(true)}>{t('ai:sync.scopedAction')}</Button>
      </Space>
      {syncJob && (
        <Card size="small" title={t('ai:sync.jobTitle', { id: syncJob.id })} style={{ marginTop: 16 }}>
          <Progress
            percent={syncJob.planned_count === 0
              ? 100
              : Math.round(((syncJob.success_count + syncJob.failed_count) / syncJob.planned_count) * 100)}
            status={syncJob.failed_count > 0 ? 'exception' : syncJob.state === 'succeeded' ? 'success' : 'active'}
          />
          <Space wrap>
            <Tag>{syncJob.state}</Tag>
            <span>{t('ai:sync.successCount', { count: syncJob.success_count })}</span>
            <span>{t('ai:sync.failedCount', { count: syncJob.failed_count })}</span>
            {syncJob.failed_count > 0 && (
              <Button
                size="small"
                onClick={() => void retryWorkspaceSyncJob(syncJob.id).then(async (job) => {
                  setSyncJob(await getWorkspaceSyncJob(job.id));
                })}
              >
                {t('ai:sync.retryFailed')}
              </Button>
            )}
          </Space>
        </Card>
      )}
    </div>
  );

  const versionPanel = (
    <Table
      rowKey="version"
      dataSource={versions}
      pagination={false}
      columns={[
        { title: t('ai:version.version'), dataIndex: 'version', width: 90 },
        { title: t('common:label.status'), dataIndex: 'state', width: 110, render: (value: string) => <Tag>{value}</Tag> },
        { title: t('common:label.summary'), dataIndex: 'content_digest', ellipsis: true },
        { title: t('ai:version.publishedAt'), dataIndex: 'published_at', width: 190, render: (value: string) => formatDateTime(value) },
        {
          title: t('common:label.actions'),
          width: 160,
          render: (_value, row: VersionRow) => (
            <Button
              size="small"
              onClick={() => Modal.confirm({
                title: t('ai:version.restoreTitle', { version: row.version }),
                content: t('ai:version.restoreContent'),
                onOk: async () => {
                  await restoreWorkspaceTemplateVersion(row.version);
                  await loadTree();
                },
              })}
            >
              {t('ai:version.restoreAction')}
            </Button>
          ),
        },
      ]}
    />
  );

  const workspacePanel = (
    <Table
      rowKey="id"
      dataSource={workspaces}
      scroll={{ x: 1230 }}
      columns={[
        { title: 'Workspace', dataIndex: 'display_name', width: 200, ellipsis: true },
        { title: t('ai:label.project'), dataIndex: 'project_name', width: 160, ellipsis: true },
        { title: t('ai:label.userId'), dataIndex: 'user_id', width: 200, ellipsis: true },
        { title: t('common:label.type'), dataIndex: 'kind', width: 130, render: (value: string) => <Tag>{value}</Tag> },
        { title: t('ai:adminWorkspace.initializedFrom'), dataIndex: 'initialized_from', width: 180, ellipsis: true },
        { title: t('ai:adminWorkspace.templateVersion'), dataIndex: 'applied_template_version', width: 120, ellipsis: true },
        { title: t('common:label.status'), dataIndex: 'status', width: 120, ellipsis: true },
        {
          title: t('common:label.actions'),
          fixed: 'right',
          width: 140,
          render: (_value, row: AiWorkspace) => (
            <Button
              size="small"
              disabled={row.initialized_from !== 'legacy'}
              onClick={() => void initializeLegacyWorkspace(row.id).then(refresh)}
            >
              {t('ai:adminWorkspace.initializeLegacy')}
            </Button>
          ),
        },
      ]}
    />
  );

  return (
    <div>
      <Typography.Title level={3} style={{ marginTop: 0 }}>{t('ai:page.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">
        {t('ai:page.description')}
      </Typography.Paragraph>
      <Tabs
        items={[
          { key: 'editor', label: t('ai:template.tabLabel'), children: templateEditor },
          { key: 'versions', label: t('ai:version.tabLabel'), children: versionPanel },
          {
            key: 'workspaces',
            label: t('ai:adminWorkspace.tabLabel', { count: workspaces.length }),
            children: workspacePanel,
          },
          { key: 'providers', label: t('ai:provider.tabLabel'), children: <ModelProviderPanel /> },
        ]}
      />
      <Modal
        title={t('ai:sync.scopeTitle')}
        open={syncScopeOpen}
        okText={t('ai:sync.createJob')}
        cancelText={t('common:action.cancel')}
        confirmLoading={syncStarting}
        onOk={() => void startScopedSync()}
        onCancel={() => setSyncScopeOpen(false)}
      >
        <Alert
          type="warning"
          showIcon
          message={t('ai:sync.scopeAlert')}
          description={t('ai:sync.scopeAlertDescription')}
          style={{ marginBottom: 16 }}
        />
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary">{t('ai:label.project')}</Typography.Text>
            <Select
              allowClear
              value={syncScope.project_name}
              onChange={(value) => setSyncScope((current) => ({
                ...current,
                project_name: value,
                workspace_ids: undefined,
              }))}
              placeholder={t('ai:sync.allProjects')}
              style={{ width: '100%' }}
              options={projects.map((value) => ({ value, label: value }))}
            />
          </div>
          <div>
            <Typography.Text type="secondary">{t('ai:label.userId')}</Typography.Text>
            <Select
              allowClear
              showSearch
              value={syncScope.user_id}
              onChange={(value) => setSyncScope((current) => ({
                ...current,
                user_id: value,
                workspace_ids: undefined,
              }))}
              placeholder={t('ai:sync.allUsers')}
              style={{ width: '100%' }}
              options={users.map((value) => ({ value, label: value }))}
            />
          </div>
          <div>
            <Typography.Text type="secondary">{t('ai:label.workspaceKind')}</Typography.Text>
            <Select
              allowClear
              value={syncScope.kind}
              onChange={(value) => setSyncScope((current) => ({
                ...current,
                kind: value,
                workspace_ids: undefined,
              }))}
              placeholder={t('ai:sync.kindPlaceholder')}
              style={{ width: '100%' }}
              options={[
                { value: 'persistent', label: t('ai:workspace.persistent') },
                { value: 'temporary', label: t('ai:workspace.temporary') },
              ]}
            />
          </div>
          <div>
            <Typography.Text type="secondary">{t('ai:sync.specifiedWorkspaces')}</Typography.Text>
            <Select
              allowClear
              mode="multiple"
              value={syncScope.workspace_ids}
              onChange={(value) => setSyncScope((current) => ({
                ...current,
                workspace_ids: value.length ? value : undefined,
              }))}
              placeholder={t('ai:sync.scopedPlaceholder', { count: scopedWorkspaces.length })}
              style={{ width: '100%' }}
              options={scopedWorkspaces.map((workspace) => ({
                value: workspace.id,
                label: `${workspace.display_name} · ${workspace.project_name} · ${workspace.user_id}`,
              }))}
            />
          </div>
        </Space>
      </Modal>
    </div>
  );
}
