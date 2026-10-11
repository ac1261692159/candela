import { useState } from 'react';
import { Button, Popover } from 'antd';
import { CalendarOutlined } from '@ant-design/icons';
import type { TimeRange } from '../../types/dsl.types';
import { useT } from '../../i18n';
import { timeRangeTriggerLabel } from './presets';
import { TimeRangePanel } from './TimeRangePanel';
import { displayTodayYmd, materializeTimeRange, slashYmd } from './resolve';
import './time-range-panel.css';

interface TimeRangeControlProps {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
  size?: 'small' | 'middle' | 'large';
  maxDays?: number;
}

export function TimeRangeControl({ value, onChange, size = 'small', maxDays }: TimeRangeControlProps) {
  const { t } = useT('analysis');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TimeRange>(value);
  const todayYmd = displayTodayYmd(value);
  const label = timeRangeTriggerLabel(value, t);
  let span = '';
  try {
    const live = materializeTimeRange(value, todayYmd);
    span = `${slashYmd(live.start)} → ${slashYmd(live.end)}`;
  } catch {
    span = '';
  }
  const showSpan = Boolean(value.relative) && Boolean(span);

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={(next) => {
        if (next) {
          try {
            setDraft(materializeTimeRange(value, todayYmd));
          } catch {
            setDraft(value);
          }
        }
        setOpen(next);
      }}
      // bottom：以触发器为中心展开，左右两侧各有余量，贴右边界时不会被推到左边界之外
      placement="bottom"
      arrow={false}
      // 面板在窄容器/靠右锚点时会被视口裁切：限宽 + autoAdjustOverflow 让它整体避让
      autoAdjustOverflow
      overlayInnerStyle={{ padding: 0 }}
      // 宽度提前给定：面板内部日历渲染会改变尺寸，若让 antd 先量再定位，
      // 会出现「右溢 24px、应用按钮被推到视口外」这类测量竞态（窄视口实测）
      overlayStyle={{ width: 'min(848px, calc(100vw - 40px))', maxWidth: 'calc(100vw - 24px)' }}
      getPopupContainer={() => document.body}
      content={
        <TimeRangePanel
          draft={draft}
          todayYmd={displayTodayYmd(draft)}
          maxDays={maxDays}
          onDraftChange={setDraft}
          onCancel={() => setOpen(false)}
          onApply={() => {
            onChange(materializeTimeRange(draft));
            setOpen(false);
          }}
        />
      }
    >
      <Button size={size} className="time-range-control" aria-label={t('analysis:timeRange.triggerAria', { label: `${label}${span ? ` ${span}` : ''}` })}>
        <span className="time-range-control__label" title={label}>
          {label}
        </span>
        {showSpan ? <span className="time-range-control__span">{span}</span> : null}
        {value.timezone ? <span className="time-range-control__span">{value.timezone}</span> : null}
        <CalendarOutlined />
      </Button>
    </Popover>
  );
}
