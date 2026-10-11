import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, Space, Table, Tag, Typography, message } from 'antd';
import { getIamCatalog, putAdminRole } from '../../services/iam.service';
import { useIamStore } from '../../stores/iam.store';
import { IamLoadError } from './load-error';
import { useT } from '../../i18n';

export function IamRolesPage() {
  const { t } = useT('iam');
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof getIamCatalog>> | null>(null);
  const [selected, setSelected] = useState('project_owner');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const canEditAdmin = useIamStore((s) => s.has('iam.role.edit_admin'));

  const [loadFailed, setLoadFailed] = useState(false);
  const load = () =>
    getIamCatalog()
      .then((data) => {
        setCatalog(data);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const role = catalog?.roles.find((r) => r.key === selected);
  const codes = useMemo(() => new Set(editing ? draft : role?.codes ?? []), [editing, draft, role]);

  return (
    <Card title={t('iam:roles.title')}>
      {selected === 'project_owner' ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message={t('iam:roles.ownerNotice')}
        />
      ) : null}
      {loadFailed ? <IamLoadError onRetry={() => void load()} /> : null}
      <Space align="start" style={{ width: '100%' }} size={24}>
        <div style={{ minWidth: 220 }}>
          {(catalog?.roles ?? []).map((r) => (
            <div
              key={r.key}
              onClick={() => {
                setSelected(r.key);
                setEditing(false);
              }}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                background: selected === r.key ? '#e6f4ff' : undefined,
                borderRadius: 6,
              }}
            >
              {r.label_key ? t(r.label_key) : r.label} {r.preset ? <Tag>{t('iam:roles.preset')}</Tag> : null}
              {r.adjusted ? <Tag color="gold">{t('iam:roles.adjusted')}</Tag> : null}
            </div>
          ))}
        </div>
        <div style={{ flex: 1 }}>
          {selected === 'analysis_admin' && canEditAdmin ? (
            <Space style={{ marginBottom: 12 }} wrap>
              {editing ? (
                <>
                  <Button
                    type="primary"
                    onClick={async () => {
                      await putAdminRole(draft);
                      message.success(t('iam:roles.saveSuccess'));
                      setEditing(false);
                      setCatalog(await getIamCatalog());
                    }}
                  >
                    {t('common:action.save')}
                  </Button>
                  <Button onClick={() => setEditing(false)}>{t('common:action.cancel')}</Button>
                </>
              ) : (
                <Button
                  onClick={() => {
                    setDraft(role?.codes ?? []);
                    setEditing(true);
                  }}
                >
                  {t('iam:roles.editDefinition')}
                </Button>
              )}
            </Space>
          ) : (
            <Typography.Paragraph type="secondary">{t('iam:roles.readonlyHint')}</Typography.Paragraph>
          )}
          <Table
            rowKey="code"
            size="small"
            pagination={false}
            scroll={{ x: 640 }}
            dataSource={catalog?.permissions ?? []}
            columns={[
              {
                title: t('iam:roles.feature'),
                minWidth: 180,
                render: (_, row) => (row.feature_key ? t(row.feature_key) : row.feature),
              },
              {
                title: t('iam:roles.op'),
                minWidth: 130,
                ellipsis: { showTitle: true },
                render: (_, row) => (row.op_key ? t(row.op_key) : row.op),
              },
              {
                title: t('iam:roles.detail'),
                minWidth: 220,
                ellipsis: { showTitle: true },
                render: (_, row) => (row.detail_key ? t(row.detail_key) : row.detail),
              },
              {
                title: t('iam:roles.granted'),
                minWidth: 110,
                render: (_, row) =>
                  editing ? (
                    <Checkbox
                      checked={codes.has(row.code)}
                      onChange={(e) => {
                        setDraft((prev) =>
                          e.target.checked ? [...prev, row.code] : prev.filter((c) => c !== row.code),
                        );
                      }}
                    />
                  ) : codes.has(row.code) ? (
                    '✓'
                  ) : (
                    ''
                  ),
              },
            ]}
          />
        </div>
      </Space>
    </Card>
  );
}
