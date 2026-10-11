/**
 * 分析图横轴日期文案。ECharts time 轴默认只画日子（3、5、15），容易看成「3 号到 15 号」。
 */
import { t as i18nT, type TFunction } from '../../i18n';
import { getPlatformTimeZone, wallClockInTz } from '../time-range/resolve';

const YMD = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/;

/** `t` 缺省用当前语言（图表 formatter 由各调用方传入；纯函数单测不传即走 zh-CN） */
export function formatTimeAxisLabel(value: unknown, t: TFunction = i18nT): string {
  if (typeof value === 'string') {
    const match = value.trim().match(YMD);
    if (match) {
      const month = Number(match[2]);
      const day = Number(match[3]);
      const hour = match[4];
      const minute = match[5];
      if (hour && minute && (hour !== '00' || minute !== '00')) {
        return t('analysis:timeAxis.monthDayTime', { month, day, hour, minute });
      }
      return t('analysis:timeAxis.monthDay', { month, day });
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 数字（epoch 毫秒）按平台时区墙钟渲染（phase: clklog-analytics-timezone-v1）
    const w = wallClockInTz(getPlatformTimeZone(), value);
    const hour = w.hour;
    const minute = w.minute;
    if (hour || minute) {
      return t('analysis:timeAxis.monthDayTime', {
        month: w.month,
        day: w.day,
        hour: String(hour).padStart(2, '0'),
        minute: String(minute).padStart(2, '0'),
      });
    }
    return t('analysis:timeAxis.monthDay', { month: w.month, day: w.day });
  }
  if (value == null) return '';
  return String(value);
}
