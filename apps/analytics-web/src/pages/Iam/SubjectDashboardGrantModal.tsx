import { useEffect, useMemo, useState } from 'react';
import { Checkbox, Empty, Input, Modal, Space, Spin, Tag, Typography, message } from 'antd';
import {
  getFolders,
  getSubjectDashboardGrants,
  putSubjectDashboardGrants,
  type FolderNode,
} from '../../services/iam.service';
import { getDashboards } from '../../services/report.service';
import { useT } from '../../i18n';

interface FolderRow {
  id: string;
  name: string;
  count: number;
}

interface DashboardRow {
  id: string;
  name: string;
  folderName: string | null;
}

function flattenFolders(nodes: FolderNode[], out: FolderRow[] = []): FolderRow[] {
  for (const node of nodes) {
    out.push({ id: node.folder_id, name: node.name, count: node.dashboard_count });
    if (node.children?.length) flattenFolders(node.children, out);
  }
  return out;
}

/**
 * 成员 / 成员组视角的看板授权（rbac-v6）。
 *
 * 背景：ACL 是「资产 × 主体」的行，此前只有看板侧入口——要查「这个成员能看哪些看板」
 * 只能把每块看板逐个打开。这里反过来：以主体为中心列出全部文件夹与看板，勾选即授「可查看」。
 * 被授「可编辑」的资产是只读行（编辑授权只能在看板侧维护，且 edit 蕴含可见）。
 */
export function SubjectDashboardGrantModal(props: {
  open: boolean;
  subjectType: 'user' | 'group';
  subjectId: string;
  subjectName: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { t } = useT('iam');
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [dashboards, setDashboards] = useState<DashboardRow[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editableIds, setEditableIds] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setKeyword('');
    setLoading(true);
    void (async () => {
      try {
        const [tree, rows, grants] = await Promise.all([
          getFolders(),
          getDashboards(),
          getSubjectDashboardGrants(props.subjectType, props.subjectId),
        ]);
        const flatFolders = flattenFolders(tree.folders ?? []);
        const folderName = new Map(flatFolders.map((f) => [f.id, f.name]));
        setFolders(flatFolders);
        setDashboards(
          rows.map((d) => ({
            id: d.db_id,
            name: d.name,
            folderName: d.folder_id ? folderName.get(d.folder_id) ?? null : null,
          })),
        );
        const edit = new Set<string>();
        const view = new Set<string>();
        for (const g of grants) (g.perm === 'edit' ? edit : view).add(g.asset_id);
        setEditableIds(edit);
        // edit 蕴含可见：这类资产勾上且不可取消，避免出现「勾掉可查看却还能看见」
        setChecked(new Set([...view, ...edit]));
      } catch {
        message.error(t('iam:error.loadFailed'));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.subjectType, props.subjectId]);

  const match = (name: string) => name.toLowerCase().includes(keyword.trim().toLowerCase());
  const shownFolders = useMemo(() => folders.filter((f) => match(f.name)), [folders, keyword]);
  const shownDashboards = useMemo(() => dashboards.filter((d) => match(d.name)), [dashboards, keyword]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const row = (id: string, label: React.ReactNode, extra?: React.ReactNode) => {
    const locked = editableIds.has(id);
    return (
      <div key={id} style={{ padding: '6px 8px', borderRadius: 6 }}>
        <Checkbox checked={checked.has(id)} disabled={locked} onChange={() => toggle(id)}>
          {label}
        </Checkbox>
        {extra}
      </div>
    );
  };

  return (
    <Modal
      title={t('iam:subjectGrant.title', { name: props.subjectName })}
      open={props.open}
      width={640}
      confirmLoading={saving}
      onCancel={props.onClose}
      okText={t('common:action.save')}
      onOk={async () => {
        setSaving(true);
        try {
          await putSubjectDashboardGrants({
            subject_type: props.subjectType,
            subject_id: props.subjectId,
            asset_ids: [...checked],
          });
          message.success(t('iam:subjectGrant.saved'));
          props.onSaved?.();
          props.onClose();
        } finally {
          setSaving(false);
        }
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('iam:subjectGrant.hint')}
        </Typography.Text>
        <Input.Search
          allowClear
          placeholder={t('iam:subjectGrant.searchPlaceholder')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Spin spinning={loading}>
          <div style={{ height: 360, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 6 }}>
            {!loading && shownFolders.length === 0 && shownDashboards.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('iam:subjectGrant.empty')} />
            ) : null}
            {shownFolders.length ? (
              <>
                <div style={{ padding: '6px 8px', color: '#8c8c8c', fontSize: 12 }}>
                  {t('iam:subjectGrant.folders')}
                </div>
                {shownFolders.map((f) =>
                  row(f.id, f.name, <Tag style={{ marginLeft: 8 }}>{f.count}</Tag>),
                )}
              </>
            ) : null}
            {shownDashboards.length ? (
              <>
                <div style={{ padding: '6px 8px', color: '#8c8c8c', fontSize: 12 }}>
                  {t('iam:subjectGrant.dashboards')}
                </div>
                {shownDashboards.map((d) =>
                  row(
                    d.id,
                    d.name,
                    <>
                      <Tag style={{ marginLeft: 8 }}>{d.folderName ?? t('iam:subjectGrant.ungrouped')}</Tag>
                      {editableIds.has(d.id) ? (
                        <Tag color="gold">{t('iam:subjectGrant.editable')}</Tag>
                      ) : null}
                    </>,
                  ),
                )}
              </>
            ) : null}
          </div>
        </Spin>
      </Space>
    </Modal>
  );
}
