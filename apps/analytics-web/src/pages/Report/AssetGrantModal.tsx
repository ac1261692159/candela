import { useEffect, useState } from 'react';
import { Modal, Space, Typography, message } from 'antd';
import {
  listGroups,
  listMembers,
  type AssetAclRow,
} from '../../services/iam.service';
import { useT } from '../../i18n';
import { GrantTransfer, type GrantCandidate } from './GrantTransfer';

export interface GrantDraft {
  subject_type: 'user' | 'group';
  subject_id: string;
  perm: 'edit' | 'view';
}

export function AssetGrantModal(props: {
  open: boolean;
  title: string;
  allowView?: boolean;
  /** 「可查看」区块下方的补充说明（文件夹授权时提示继承范围） */
  viewHint?: string;
  loadGrants: () => Promise<AssetAclRow[]>;
  saveGrants: (grants: GrantDraft[]) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useT('report');
  const [editCandidates, setEditCandidates] = useState<GrantCandidate[]>([]);
  const [viewCandidates, setViewCandidates] = useState<GrantCandidate[]>([]);
  const [grants, setGrants] = useState<GrantDraft[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    void (async () => {
      const [members, groups, existing] = await Promise.all([
        listMembers(),
        listGroups(),
        props.loadGrants(),
      ]);
      const analystMembers = members.filter((m) => m.role_key === 'analyst');
      const analystGroups = groups.filter((g) => g.role_key === 'analyst');
      const memberCandidate = (m: (typeof members)[number], kind: 'analyst' | 'any'): GrantCandidate => ({
        key: `user:${m.user_id}`,
        label:
          kind === 'analyst'
            ? t('report:grant.memberOption', { name: m.user.display_name || m.user.username })
            : t('report:grant.memberOptionAny', { name: m.user.display_name || m.user.username }),
        kind: 'member',
      });
      const groupCandidate = (g: (typeof groups)[number]): GrantCandidate => ({
        key: `group:${g.id}`,
        label: t('report:grant.groupOption', { name: g.name }),
        kind: 'group',
      });
      // 可编辑：仅分析师个人与分析师组（口径不变）
      setEditCandidates([
        ...analystGroups.map(groupCandidate),
        ...analystMembers.map((m) => memberCandidate(m, 'analyst')),
      ]);
      // 可查看：全部成员组 + 全部成员（外部人员只能靠这条路开放）
      setViewCandidates([...groups.map(groupCandidate), ...members.map((m) => memberCandidate(m, 'any'))]);
      setGrants(
        existing.map((row) => ({
          subject_type: row.subject_type === 'group' ? 'group' : 'user',
          subject_id: row.subject_id,
          perm: row.perm === 'view' ? 'view' : 'edit',
        })),
      );
    })();
    // 只在打开时拉一次，避免父组件 inline 函数导致循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const keysOf = (perm: 'edit' | 'view') =>
    grants.filter((g) => g.perm === perm).map((g) => `${g.subject_type}:${g.subject_id}`);

  const applyKeys = (perm: 'edit' | 'view', keys: string[]) => {
    const rest = grants.filter((g) => g.perm !== perm);
    setGrants([
      ...rest,
      ...keys.map((key) => {
        const [subject_type, subject_id] = key.split(':') as ['user' | 'group', string];
        return { subject_type, subject_id, perm };
      }),
    ]);
  };

  return (
    <Modal
      title={props.title}
      open={props.open}
      width={760}
      confirmLoading={saving}
      onCancel={props.onClose}
      onOk={async () => {
        setSaving(true);
        try {
          await props.saveGrants(grants);
          message.success(t('report:grant.saved'));
          props.onClose();
        } finally {
          setSaving(false);
        }
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <div>{t('report:grant.editors')}</div>
        <GrantTransfer
          testId="grant-transfer-edit"
          candidates={editCandidates}
          selected={keysOf('edit')}
          onChange={(keys) => applyKeys('edit', keys)}
        />
        {props.allowView ? (
          <>
            <div style={{ marginTop: 8 }}>{t('report:grant.viewers')}</div>
            <GrantTransfer
              testId="grant-transfer-view"
              candidates={viewCandidates}
              selected={keysOf('view')}
              onChange={(keys) => applyKeys('view', keys)}
            />
            {props.viewHint ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {props.viewHint}
              </Typography.Text>
            ) : null}
          </>
        ) : null}
      </Space>
    </Modal>
  );
}
