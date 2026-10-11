import { useEffect } from 'react';
import { Select } from 'antd';
import { SELECT_POPUP } from '../../components/select-popup';
import { useT } from '../../i18n';
import { useSubjects } from './use-subjects';

interface Props {
  value?: string;
  onChange: (subjectId: string) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export function SubjectSelect({ value, onChange, disabled, style }: Props) {
  const { t } = useT('cohort');
  const { subjects, presetId } = useSubjects();
  const current = value || presetId;

  useEffect(() => {
    if (!value && presetId) onChange(presetId);
    // preset 就绪后补默认值；不把 onChange 放进依赖以免父组件 inline 函数反复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, presetId]);

  return (
    <Select
      {...SELECT_POPUP}
      value={current}
      onChange={onChange}
      disabled={disabled}
      options={subjects.map((item) => ({
        label: item.is_preset ? t('cohort:subjectSelect.presetOption', { name: item.display_name }) : item.display_name,
        value: item.subject_id,
      }))}
      placeholder={t('cohort:subjectSelect.placeholder')}
      style={{ minWidth: 160, ...style }}
    />
  );
}
