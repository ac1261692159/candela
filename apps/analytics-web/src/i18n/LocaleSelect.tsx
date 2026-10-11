/**
 * 语言选择器（登录页与个人设置共用）。
 * 选项文案用语言自身书写（简体中文 / English），不做翻译。
 * 服务端偏好同步由调用方通过 onChange 负责，本组件只负责切换与本地持久化。
 */
import { useState } from 'react';
import { Select, Tooltip } from 'antd';
import { GlobalOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { LOCALES } from './config';
import { changeLocale } from './index';

export interface LocaleSelectProps {
  /** 切换成功回调（登录用户在此同步服务端偏好）；失败不影响本地切换 */
  onChange?: (tag: string) => void | Promise<void>;
  /** 紧凑模式：只显示地球图标 + 下拉（登录页用） */
  compact?: boolean;
  className?: string;
}

export function LocaleSelect({ onChange, compact, className }: LocaleSelectProps) {
  const { i18n, t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const current = LOCALES.find((l) => l.tag === i18n.language)?.tag ?? LOCALES[0].tag;

  const handleChange = async (tag: string) => {
    setSaving(true);
    try {
      await changeLocale(tag);
      await onChange?.(tag);
    } finally {
      setSaving(false);
    }
  };

  const select = (
    <Select
      className={className}
      size={compact ? 'small' : 'middle'}
      variant={compact ? 'borderless' : undefined}
      value={current}
      loading={saving}
      onChange={handleChange}
      popupMatchSelectWidth={false}
      options={LOCALES.map((l) => ({ value: l.tag, label: l.label }))}
      aria-label={t('common:action.switchLanguage')}
    />
  );

  if (!compact) return select;

  return (
    <Tooltip title={t('common:action.switchLanguage')}>
      <span className="locale-select-compact">
        <GlobalOutlined />
        {select}
      </span>
    </Tooltip>
  );
}
