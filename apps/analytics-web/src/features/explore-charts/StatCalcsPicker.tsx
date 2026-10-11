import { Checkbox, Typography } from 'antd';
import { useT } from '../../i18n';
import { allowedStatCalcs, statCalcLabels, type StatCalc } from './series-stats';

interface StatCalcsPickerProps {
  kind: string;
  value: StatCalc[];
  onChange: (next: StatCalc[]) => void;
  disabled?: boolean;
  hideLabel?: boolean;
}

export function StatCalcsPicker({ kind, value, onChange, disabled, hideLabel }: StatCalcsPickerProps) {
  const { t } = useT('analysis');
  const allowed = allowedStatCalcs(kind);
  const labels = statCalcLabels(t);
  return (
    <div>
      {hideLabel ? null : (
        <Typography.Text strong className="funnel-view-settings__label">
          {t('analysis:chart.showValues')}
        </Typography.Text>
      )}
      <Checkbox.Group
        disabled={disabled}
        value={value}
        onChange={(next) => onChange(next as StatCalc[])}
        options={allowed.map((calc) => ({ label: labels[calc], value: calc }))}
      />
    </div>
  );
}
