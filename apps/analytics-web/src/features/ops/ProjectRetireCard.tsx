import { useState } from 'react';
import { Alert, Button, Card, Input, Select, Space, Table, Typography } from 'antd';
import { useT } from '../../i18n';
import { useProjectStore } from '../../stores/project.store';
import { projectRetireExecute, projectRetirePreview, projectRetireToken, type ProjectRetirePreviewView } from '../../services/ops.service';

/**
 * 项目退役预演（phase: clklog-data-management-v1.2，R4-b 第一步）。
 * 只读：把影响面摊开（sa 5 张 + MySQL 31 张）并检查最近 24h 是否仍在写入；
 * 破坏性执行尚未提供（设计：预演优先、执行需显式确认——下一阶段）。
 */
export function ProjectRetireCard() {
  const { t } = useT('ops');
  const current = useProjectStore((s) => s.currentProject) || 'clklogapp';
  const [project, setProject] = useState(current);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ProjectRetirePreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 执行（分步）：先取令牌，再选步骤 + 输入项目名确认
  const [step, setStep] = useState<'sa' | 'mysql'>('sa');
  const [token, setToken] = useState<{ token: string; rows: number } | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [result, setResult] = useState<{ message_key: string; message_params: Record<string, unknown>; backup: string | null; done: boolean } | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await projectRetirePreview(project));
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const getToken = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const tk = await projectRetireToken(project);
      setToken({ token: tk.token, rows: tk.rows });
    } catch (e) {
      setToken(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runStep = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const out = await projectRetireExecute({ project, step, confirm_token: token.token });
      setResult(out);
      setToken(null);
      setConfirmName('');
      await run(); // 重新预演，看剩余影响面
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('ops:projectRetire.title')} size="small">
      <Space wrap>
        <Input
          style={{ width: 220 }}
          value={project}
          onChange={(e) => setProject(e.target.value)}
          placeholder="clklogapp"
        />
        <Button type="primary" loading={busy} onClick={() => void run()}>
          {t('ops:dataCleanup.preview')}
        </Button>
      </Space>

      {error ? <Alert style={{ marginTop: 12 }} type="error" showIcon message={error} /> : null}

      {preview ? (
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size="small">
          <Alert
            type={preview.writes_last_24h > 0 ? 'warning' : 'info'}
            showIcon
            message={t('ops:projectRetire.communityNote')}
            description={t('ops:projectRetire.step.stopWrites')}
          />
          <Table
            size="small"
            rowKey="table"
            title={() => <b>sa（{preview.sa_tables.reduce((s, x) => s + x.rows, 0)} 行）</b>}
            dataSource={preview.sa_tables}
            pagination={false}
            columns={[
              { title: 'table', dataIndex: 'table', minWidth: 220, ellipsis: { showTitle: true } },
              { title: 'rows', dataIndex: 'rows', minWidth: 120, align: 'right' as const },
              {
                title: 'range',
                key: 'range',
                minWidth: 220,
                render: (_: unknown, r: { min_date: string | null; max_date: string | null }) =>
                  r.min_date ? `${r.min_date} ~ ${r.max_date}` : '-',
              },
            ]}
          />
          <Table
            size="small"
            rowKey="table"
            title={() => <b>MySQL（{preview.mysql_total_rows} 行 / {preview.mysql_tables.length} 张表）</b>}
            dataSource={preview.mysql_tables.filter((x) => x.rows > 0)}
            pagination={{ pageSize: 8 }}
            columns={[
              { title: 'table', dataIndex: 'table', minWidth: 220, ellipsis: { showTitle: true } },
              { title: 'rows', dataIndex: 'rows', minWidth: 100, align: 'right' as const },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {preview.next_step_keys.map((k) => t(`ops:projectRetire.step.${k}`)).join(' · ')}
          </Typography.Text>

          <Space wrap>
            <Button onClick={() => void getToken()} loading={busy}>
              {t('ops:projectRetire.getToken')}
            </Button>
            <Select
              style={{ width: 110 }}
              value={step}
              onChange={(v) => setStep(v)}
              options={[
                { value: 'sa', label: 'sa' },
                { value: 'mysql', label: 'mysql' },
              ]}
            />
            <Input
              style={{ width: 300 }}
              placeholder={t('ops:dataCleanup.confirmPlaceholder', { table: project })}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
            />
            <Button
              danger
              type="primary"
              loading={busy}
              disabled={!token || confirmName !== project}
              onClick={() => void runStep()}
            >
              {t('ops:dataCleanup.execute', { rows: token?.rows ?? 0 })}
            </Button>
          </Space>
          {result ? (
            <Alert
              type={result.done ? 'success' : 'warning'}
              showIcon
              message={t(`ops:projectRetire.result.${result.message_key}`, result.message_params)}
              description={result.backup ? `${result.backup}` : undefined}
            />
          ) : null}
        </Space>
      ) : null}
    </Card>
  );
}
