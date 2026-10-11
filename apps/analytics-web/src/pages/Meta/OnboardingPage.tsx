import { useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Modal, Row, Space, Table, Typography, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { useProjectStore } from '../../stores/project.store';
import { CodeBlock } from '../../features/onboarding/CodeBlock';
import { GuideDrawer } from '../../features/onboarding/GuideDrawer';
import {
  reportEndpoint,
  encodingSample,
  groupHints,
  groupLabels,
  guidesByGroup,
  protocolFields,
  type SdkGroup,
  type SdkGuide,
} from '../../features/onboarding/sdk-guides';
import { t as translate, useT, type TFunction } from '../../i18n';

/**
 * 数据管理 · 接入指南（phase: clklog-analytics-onboarding-v2）。
 *
 * 自包含文档站：接入参数 + 三组 SDK 入口（客户端 / 服务端 / 其他）。
 * 已实测 SDK 在页面内给完整文档，不再指向仓库示例目录；未适配的只保留入口并提示「暂未开发」。
 * 协议口径以《数据上报规范与流程.md》为准，token 不在页面展示。
 */
const GROUPS: SdkGroup[] = ['client', 'server', 'other'];

function copyText(text: string, label: string, t: TFunction = translate) {
  void navigator.clipboard
    .writeText(text)
    .then(() => message.success(t('onboarding:page.copied', { label })))
    .catch(() => message.error(t('onboarding:code.copyFailed')));
}

export default function OnboardingPage() {
  const { t } = useT('onboarding', 'datatable');
  const [opened, setOpened] = useState<SdkGuide | null>(null);
  const [planned, setPlanned] = useState<SdkGuide | null>(null);
  // 直接用项目 store：切换项目时本页要跟着变（旧实现自己读 localStorage，
  // 解析不了 zustand 的 {"state":{...}} 结构，切换项目后 App_ID 永远显示 clklogapp）
  const currentProject = useProjectStore((s) => s.currentProject);
  const project = currentProject || 'clklogapp';
  const groups = useMemo(
    () => GROUPS.map((group) => ({ group, guides: guidesByGroup(group, t) })),
    [t],
  );
  const groupLabel = groupLabels(t);
  const groupHint = groupHints(t);
  const protocol = protocolFields(t);
  const encoding = encodingSample(t);

  const open = (guide: SdkGuide) => {
    // planned 才弹「暂未开发」；partial（语言级已实测、平台未打包）有完整文档，照常打开抽屉。
    if (guide.status === 'planned') setPlanned(guide);
    else setOpened(guide);
  };

  const endpoint = reportEndpoint();
  const curlSample = `curl -X POST '${endpoint}' \\
  -H 'Content-Type: application/x-www-form-urlencoded' \\
  --data-urlencode 'project=${project}' \\
  --data-urlencode 'token=${t('onboarding:page.curlTokenPlaceholder')}' \\
  --data-urlencode 'data=${t('onboarding:page.curlDataPlaceholder')}'`;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title={t('onboarding:page.paramsTitle')}>
        <Table
          rowKey="label"
          size="small"
          pagination={false}
          showHeader={false}
          columns={[
            { dataIndex: 'label', minWidth: 180 },
            { dataIndex: 'value' },
          ]}
          dataSource={[
            { label: t('onboarding:page.projectName'), value: project },
            {
              label: 'App_ID',
              value: (
                <Space size={6}>
                  <Typography.Text code>{project}</Typography.Text>
                  <Button
                    size="small"
                    type="text"
                    icon={<CopyOutlined />}
                    onClick={() => copyText(project, 'App_ID ', t)}
                  />
                </Space>
              ),
            },
            {
              label: t('onboarding:page.reportEndpoint'),
              value: (
                <Space size={6} wrap>
                  <Typography.Text code>{endpoint}</Typography.Text>
                  <Button
                    size="small"
                    type="text"
                    icon={<CopyOutlined />}
                    onClick={() => copyText(endpoint, t('onboarding:page.reportEndpoint'), t)}
                  />
                </Space>
              ),
            },
            {
              label: t('onboarding:page.projectToken'),
              value: (
                <Typography.Text type="secondary">
                  {t('onboarding:page.tokenHint')}
                </Typography.Text>
              ),
            },
          ]}
        />
      </Card>

      <Card title={t('onboarding:page.prereqTitle')}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {t('onboarding:page.prereqLead')}{' '}
          <Typography.Text code>application/x-www-form-urlencoded</Typography.Text>
          {t('onboarding:page.prereqTail')}
        </Typography.Paragraph>
        <Table
          rowKey="field"
          size="small"
          pagination={false}
          columns={[
            {
              title: t('datatable:column.field'),
              dataIndex: 'field',
              minWidth: 160,
              render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
            },
            { title: t('onboarding:page.descColumn'), dataIndex: 'desc' },
          ]}
          dataSource={protocol}
          style={{ marginBottom: 12 }}
        />
        <Alert
          type="warning"
          showIcon
          message={t('onboarding:page.pitfall')}
          description={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{encoding}</pre>}
        />
        <div style={{ marginTop: 12 }}>
          <CodeBlock code={curlSample} lang="bash" label={t('onboarding:page.curlLabel')} />
        </div>
      </Card>

      {groups.map(({ group, guides }) => (
        <Card key={group} title={groupLabel[group]} extra={<Typography.Text type="secondary">{groupHint[group]}</Typography.Text>}>
          <Row gutter={[12, 12]}>
            {guides.map((guide) => (
              <Col key={guide.key} xs={24} sm={12} md={8} lg={6}>
                <Card
                  size="small"
                  hoverable
                  onClick={() => open(guide)}
                  style={{ height: '100%' }}
                  data-testid={`sdk-${guide.key}`}
                >
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Space size={6} wrap>
                      <Typography.Text strong>{guide.name}</Typography.Text>
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {guide.platform}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {guide.summary}
                    </Typography.Text>
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        </Card>
      ))}

      <GuideDrawer guide={opened} onClose={() => setOpened(null)} />

      <Modal
        open={Boolean(planned)}
        title={planned ? t('onboarding:page.plannedTitle', { name: planned.name }) : ''}
        footer={<Button onClick={() => setPlanned(null)}>{t('onboarding:page.gotIt')}</Button>}
        onCancel={() => setPlanned(null)}
      >
        <Space direction="vertical" size={8}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            {t('onboarding:page.plannedBody')}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t('onboarding:page.plannedHint')}
          </Typography.Paragraph>
        </Space>
      </Modal>
    </Space>
  );
}
