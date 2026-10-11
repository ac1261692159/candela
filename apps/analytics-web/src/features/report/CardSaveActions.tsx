import { Button, Space } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';

interface CardSaveActionsProps {
  bound: boolean;
  disabled?: boolean;
  overwriting?: boolean;
  size?: 'small' | 'middle';
  onOverwrite?: () => void;
  onSaveAs: () => void;
}

/** 无卡：保存为卡片。有卡：覆盖保存 + 另存为卡片。 */
export function CardSaveActions({
  bound,
  disabled,
  overwriting,
  size = 'small',
  onOverwrite,
  onSaveAs,
}: CardSaveActionsProps) {
  const { t } = useT('report');
  if (!bound) {
    return (
      <Button
        type="primary"
        size={size}
        icon={<SaveOutlined />}
        onClick={onSaveAs}
        disabled={disabled}
        aria-label={t('report:card.saveAs')}
      >
        {t('report:card.saveAs')}
      </Button>
    );
  }
  return (
    <Space size={8} wrap>
      <Button
        type="primary"
        size={size}
        icon={<SaveOutlined />}
        loading={overwriting}
        onClick={onOverwrite}
        disabled={disabled}
        aria-label={t('report:card.overwriteSave')}
      >
        {t('report:card.overwriteSave')}
      </Button>
      <Button size={size} onClick={onSaveAs} disabled={disabled} aria-label={t('report:card.saveAsNew')}>
        {t('report:card.saveAsNew')}
      </Button>
    </Space>
  );
}
