import { useEffect, useState, type ReactNode } from 'react';
import { Input } from 'antd';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import './analysis-workbench.css';

interface QueryStepProps {
  /** 仅同级列表需要序号（漏斗第 1/2 步）。分区标题不传。 */
  index?: number;
  title: string;
  extra?: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  titleEditable?: boolean;
  onTitleChange?: (title: string) => void;
  /** 无内容时整块淡显（神策风空态） */
  dimmed?: boolean;
  /** 长按标题进入拖动模式的 pointerdown 入口（漏斗步骤排序） */
  onHeadPointerDown?: (e: React.PointerEvent) => void;
  /** 拖动判定期间的移动/抬手/移出（取消长按计时或结束拖动） */
  onHeadPointerMove?: (e: React.PointerEvent) => void;
  onHeadPointerUp?: (e: React.PointerEvent) => void;
  onHeadPointerLeave?: (e: React.PointerEvent) => void;
  /** 该步骤正处于拖动中（视觉强调） */
  dragging?: boolean;
  /** data-step-index：拖动时用于命中检测 */
  stepIndex?: number;
}

export function QueryStep({
  index,
  title,
  extra,
  children,
  collapsible = false,
  titleEditable = false,
  onTitleChange,
  dimmed = false,
  onHeadPointerDown,
  onHeadPointerMove,
  onHeadPointerUp,
  onHeadPointerLeave,
  dragging = false,
  stepIndex,
}: QueryStepProps) {
  const { t } = useT('analysis');
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  useEffect(() => {
    setDraft(title);
  }, [title]);

  const commitTitle = () => {
    const next = draft.trim() || title;
    setDraft(next);
    setEditing(false);
    if (next !== title) onTitleChange?.(next);
  };

  return (
    <section
      className={`analysis-step${dimmed ? ' is-empty' : ''}${dragging ? ' is-dragging' : ''}`}
      {...(stepIndex != null ? { 'data-step-index': stepIndex } : {})}
    >
      <div
        className="analysis-step__head"
        onPointerDown={
          onHeadPointerDown
            ? (e) => {
                // 按钮上的按下不进入拖动判定
                if ((e.target as HTMLElement).closest('button')) return;
                onHeadPointerDown(e);
              }
            : undefined
        }
        onPointerMove={onHeadPointerMove}
        onPointerUp={onHeadPointerUp}
        onPointerLeave={onHeadPointerLeave}
      >
        {collapsible ? (
          <button
            type="button"
            className="analysis-step__toggle"
            aria-expanded={open}
            aria-label={open ? t('analysis:step.collapse') : t('analysis:step.expand')}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <DownOutlined /> : <RightOutlined />}
          </button>
        ) : null}
        {index != null ? (
          <span className="analysis-step__num" aria-hidden="true">
            {index}
          </span>
        ) : null}
        {editing ? (
          <Input
            size="small"
            autoFocus
            value={draft}
            aria-label={t('analysis:step.aliasAria')}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitTitle}
            onPressEnter={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraft(title);
                setEditing(false);
              }
            }}
          />
        ) : titleEditable ? (
          <button
            type="button"
            className="analysis-step__title"
            title={t('analysis:step.renameHint')}
            onClick={() => setEditing(true)}
          >
            {title}
          </button>
        ) : (
          <span className="analysis-step__title" title={title}>{title}</span>
        )}
        {extra ? <span className="analysis-step__extra">{extra}</span> : null}
      </div>
      {collapsible && !open ? null : children}
    </section>
  );
}
