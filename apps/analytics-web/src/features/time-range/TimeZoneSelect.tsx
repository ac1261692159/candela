/**
 * IANA 时区选择器（phase: clklog-analytics-timezone-v1/v2）。
 * 从 TimeRangePanel 内部选择器提炼——时间面板、个人设置、联系人表单共用。
 * 空值语义 = 跟随上级（文案由调用方给足上下文，如「跟随平台」「跟随项目」「跟随项目/平台」）。
 */
import { useMemo } from 'react';
import { Select } from 'antd';
import { useT } from '../../i18n';
import { getPlatformTimeZone } from './resolve';

/** IANA 时区全集（env 不支持时退化为空列表） */
const ALL_TIME_ZONES: string[] = (() => {
  const intlExtended = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  return typeof intlExtended.supportedValuesOf === 'function' ? intlExtended.supportedValuesOf('timeZone') : [];
})();

/** 选中时区的 GMT 偏移文案（UTC+8 / UTC-4） */
export function gmtOffsetLabel(tz: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value;
    return name ? name.replace('GMT', 'UTC') : '';
  } catch {
    return '';
  }
}

export interface TimeZoneSelectProps {
  /** 当前值；undefined/'' = 跟随上级 */
  value?: string;
  /** 变更回调；嵌进 antd Form.Item 时可省（由 Form 注入 value/onChange） */
  onChange?: (tz: string | undefined) => void;
  /** 空值选项文案（默认「跟随平台（当前平台时区）」） */
  followLabel?: string;
  style?: React.CSSProperties;
  size?: 'small' | 'middle';
  ariaLabel?: string;
}

export function TimeZoneSelect({ value, onChange, followLabel, style, size = 'small', ariaLabel }: TimeZoneSelectProps) {
  const { t } = useT('analysis');
  const platformTz = getPlatformTimeZone();
  const options = useMemo(
    () => [
      { value: '', label: followLabel ?? `${t('analysis:timeRange.followPlatform')}（${platformTz}）` },
      ...ALL_TIME_ZONES.filter((zone) => zone !== platformTz).map((zone) => ({
        value: zone,
        label: `${zone}（${gmtOffsetLabel(zone)}）`,
      })),
    ],
    [platformTz, followLabel, t],
  );
  return (
    <Select
      size={size}
      showSearch
      value={value ?? ''}
      options={options}
      onChange={(next) => onChange?.(typeof next === 'string' && next ? next : undefined)}
      popupMatchSelectWidth={false}
      optionFilterProp="label"
      style={{ minWidth: 240, ...style }}
      aria-label={ariaLabel ?? t('analysis:timeRange.timezone')}
    />
  );
}
