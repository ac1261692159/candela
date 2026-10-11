import { Radio, Typography } from 'antd';
import { useT } from '../../i18n';
import type { RetentionResultLayout } from './retention-view';
import './analysis-workbench.css';

interface RetentionViewSettingsProps {
  layout: RetentionResultLayout;
  onLayoutChange: (layout: RetentionResultLayout) => void;
}

export function RetentionViewSettings({ layout, onLayoutChange }: RetentionViewSettingsProps) {
  const { t } = useT('analysis');
  return (
    <div className="funnel-view-settings">
      <Typography.Text strong className="funnel-view-settings__label">
        {t('analysis:view.display')}
      </Typography.Text>
      <Radio.Group
        value={layout}
        onChange={(e) => onLayoutChange(e.target.value)}
        optionType="button"
        buttonStyle="solid"
        size="small"
        className="chrome-chip-group"
        options={[
          { label: t('analysis:view.chartAndTable'), value: 'both' },
          { label: t('analysis:view.chart'), value: 'chart' },
          { label: t('analysis:view.table'), value: 'table' },
        ]}
      />
    </div>
  );
}
