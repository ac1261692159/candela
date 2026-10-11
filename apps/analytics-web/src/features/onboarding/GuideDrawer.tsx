import { Alert, Button, Collapse, Drawer, Space, Tag, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import { CodeBlock } from './CodeBlock';
import { demoArchiveFor, demoArchiveUrl } from './sdk-downloads';
import { STATUS_TAG_COLOR, groupLabels, statusLabels, type SdkGuide } from './sdk-guides';

interface Props {
  guide: SdkGuide | null;
  onClose: () => void;
}

/** 接入文档抽屉：前置条件 → 步骤（含可复制代码）→ 常见问题 */
export function GuideDrawer({ guide, onClose }: Props) {
  const { t } = useT('onboarding');
  const statusLabel = statusLabels(t);
  const groupLabel = groupLabels(t);
  // 演示工程下载：卡片上不展示状态标签后，抽屉是小字说明 + 一键拿样例工程的地方
  const archive = guide ? demoArchiveFor(guide.key) : undefined;

  return (
    <Drawer
      title={guide ? t('onboarding:drawer.title', { name: guide.name }) : t('onboarding:drawer.titleFallback')}
      open={Boolean(guide)}
      onClose={onClose}
      width={820}
      destroyOnClose
    >
      {guide && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space size={6} wrap>
            <Tag color={STATUS_TAG_COLOR[guide.status]}>{statusLabel[guide.status]}</Tag>
            <Tag>{groupLabel[guide.group]}</Tag>
            <Typography.Text type="secondary">{guide.platform}</Typography.Text>
          </Space>
          <Typography.Paragraph style={{ marginBottom: 0 }}>{guide.summary}</Typography.Paragraph>
          {archive && (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Button
                icon={<DownloadOutlined />}
                href={demoArchiveUrl(archive.file)}
                download={archive.file}
                data-testid={`demo-download-${guide.key}`}
              >
                {t('onboarding:drawer.downloadDemo')}
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('onboarding:drawer.downloadDemoHint', { contents: archive.contents })}
              </Typography.Text>
            </Space>
          )}

          {(guide.steps ?? []).map((step) => (
            <Space key={step.title} direction="vertical" size={8} style={{ width: '100%' }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                {step.title}
              </Typography.Title>
              {step.body && (
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  {step.body}
                </Typography.Paragraph>
              )}
              {step.notes?.length ? (
                <Alert
                  type="warning"
                  showIcon
                  message={
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {step.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  }
                />
              ) : null}
              {(step.codes ?? []).map((sample) => (
                <CodeBlock
                  key={`${step.title}-${sample.label ?? sample.lang}`}
                  code={sample.code}
                  lang={sample.lang}
                  label={sample.label}
                />
              ))}
            </Space>
          ))}

          {guide.faq?.length ? (
            <Collapse
              size="small"
              items={[
                {
                  key: 'faq',
                  label: t('onboarding:drawer.faqTitle', { count: guide.faq.length }),
                  children: (
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      {guide.faq.map((item) => (
                        <div key={item.q}>
                          <Typography.Text strong>{item.q}</Typography.Text>
                          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                            {item.a}
                          </Typography.Paragraph>
                        </div>
                      ))}
                    </Space>
                  ),
                },
              ]}
            />
          ) : null}
        </Space>
      )}
    </Drawer>
  );
}
