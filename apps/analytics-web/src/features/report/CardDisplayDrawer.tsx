import { Button, Drawer, Radio, Typography } from 'antd';
import { displayOptions } from './card-display';
import { useT } from '../../i18n';

interface CardDisplayDrawerProps {
  open: boolean;
  type: string;
  view: string;
  saving?: boolean;
  onClose: () => void;
  onChange: (view: string) => void;
  onSave: () => void;
}

export function CardDisplayDrawer({
  open,
  type,
  view,
  saving,
  onClose,
  onChange,
  onSave,
}: CardDisplayDrawerProps) {
  const { t } = useT('report');
  const options = displayOptions(type, t);
  return (
    <Drawer
      title={t('report:card.settingsTitle')}
      open={open}
      onClose={onClose}
      width={360}
      destroyOnClose
      extra={
        <Button type="primary" loading={saving} onClick={onSave} disabled={!options.length}>
          {t('common:action.save')}
        </Button>
      }
    >
      {options.length ? (
        <>
          <Typography.Text strong style={{ display: 'block', marginBottom: 8, whiteSpace: 'normal' }}>
            {t('report:card.displayStyle')}
          </Typography.Text>
          {/* 展示形态名是译后文案（俄/德最长）：抽屉 360px 里按钮组换行，不压窄也不裁半个字（G.29） */}
          <Radio.Group
            value={view}
            onChange={(e) => onChange(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            options={options}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
          />
        </>
      ) : (
        <Typography.Text type="secondary" style={{ whiteSpace: 'normal', overflowWrap: 'break-word' }}>
          {t('report:card.noDisplayOptions')}
        </Typography.Text>
      )}
    </Drawer>
  );
}
