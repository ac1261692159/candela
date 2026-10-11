import type { ReactNode } from 'react';
import { Button, Popover, Typography } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';

interface AnalysisResultSettingsProps {
  children?: ReactNode;
}

export function AnalysisResultSettings({ children }: AnalysisResultSettingsProps) {
  const { t } = useT('analysis');
  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      overlayClassName="analysis-result-settings-overlay"
      /* 380 是按中文/短英文定的；窄视口（<420px）里弹层会被顶出屏幕。
         设置面板内的标签在长语言下更宽（德 «Staffelung nach der Konversionsrate…»），
         这里改成随视口收缩，配合面板内部换行而不是截断。 */
      styles={{ body: { maxWidth: 'min(380px, calc(100vw - 32px))', maxHeight: 520, overflow: 'auto' } }}
      getPopupContainer={() => document.body}
      content={children ?? <Typography.Text type="secondary">{t('analysis:settings.empty')}</Typography.Text>}
    >
      <Button type="text" size="small" icon={<SettingOutlined />} aria-label={t('analysis:settings.aria')} />
    </Popover>
  );
}
