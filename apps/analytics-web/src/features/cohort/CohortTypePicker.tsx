import { Button, Card, Modal, Space, Typography } from 'antd';
import { CodeOutlined, FilterOutlined, TagsOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useT } from '../../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 创建入口：三张等权类型卡（图标 + 一句话 + 典型场景）。
 *
 * 「结果分群」不在这里——它是分析结果人数格的快照，弹窗底部说明来源并给入口，
 * 否则用户会以为少做了一种类型。
 */
export function CohortTypePicker({ open, onClose }: Props) {
  const { t } = useT('cohort');
  const navigate = useNavigate();
  const kinds = [
    {
      kind: 'condition',
      icon: <FilterOutlined />,
      title: t('cohort:kind.condition'),
      desc: t('cohort:typeCard.conditionDesc'),
      use: t('cohort:typeCard.conditionUse'),
    },
    {
      kind: 'id_upload',
      icon: <TagsOutlined />,
      title: t('cohort:kind.idUpload'),
      desc: t('cohort:typeCard.idUploadDesc'),
      use: t('cohort:typeCard.idUploadUse'),
    },
    {
      kind: 'sql',
      icon: <CodeOutlined />,
      title: t('cohort:kind.sql'),
      desc: t('cohort:typeCard.sqlDesc'),
      use: t('cohort:typeCard.sqlUse'),
    },
  ];

  const go = (kind: string) => {
    onClose();
    navigate(`/analysis/cohorts/new?kind=${kind}`);
  };

  const goEventAnalysis = () => {
    onClose();
    navigate('/analysis/event');
  };

  return (
    <Modal
      title={t('cohort:cohortList.chooseKind')}
      open={open}
      onCancel={onClose}
      width={720}
      footer={
        <Button onClick={onClose}>{t('common:action.cancel')}</Button>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {kinds.map((item) => (
          <Card
            key={item.kind}
            size="small"
            hoverable
            onClick={() => go(item.kind)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                go(item.kind);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={item.title}
          >
            <Space align="start" size={12}>
              <span style={{ fontSize: 20, lineHeight: '24px' }} aria-hidden="true">
                {item.icon}
              </span>
              <div>
                <Typography.Text strong>{item.title}</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  {item.desc}
                </Typography.Paragraph>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {item.use}
                </Typography.Text>
              </div>
            </Space>
          </Card>
        ))}
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
        {t('cohort:typeCard.resultHint')}{' '}
        <Typography.Link onClick={goEventAnalysis}>{t('shell:menu.event')}</Typography.Link>
      </Typography.Paragraph>
    </Modal>
  );
}
