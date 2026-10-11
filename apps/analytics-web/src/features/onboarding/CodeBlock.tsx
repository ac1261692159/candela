import { Button, Space, Typography, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';

interface Props {
  code: string;
  lang?: string;
  label?: string;
}

/** 代码块 + 复制（沿用仓库既有裸 <pre> 视觉，不引入高亮依赖） */
export function CodeBlock({ code, lang, label }: Props) {
  const { t } = useT('onboarding', 'common');

  const copy = () => {
    void navigator.clipboard
      .writeText(code)
      .then(() => message.success(t('onboarding:code.copied')))
      .catch(() => message.error(t('onboarding:code.copyFailed')));
  };

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space size={8}>
        {label && <Typography.Text type="secondary">{label}</Typography.Text>}
        {lang && <Typography.Text code>{lang}</Typography.Text>}
        <Button size="small" type="text" icon={<CopyOutlined />} onClick={copy}>
          {t('common:action.copy')}
        </Button>
      </Space>
      <pre
        style={{
          margin: 0,
          padding: 12,
          background: '#fafafa',
          border: '1px solid #f0f0f0',
          borderRadius: 6,
          overflowX: 'auto',
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        {code}
      </pre>
    </Space>
  );
}
