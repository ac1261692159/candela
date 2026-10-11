import type { CSSProperties, ReactNode } from 'react';
import { Empty } from 'antd';
import { useT, type TFunction } from '../i18n';
import { BRAND_BORDER, BRAND_ILLUS_GRID, BRAND_ILLUS_LIGHT, BRAND_PRIMARY } from '../styles/tokens';

export type EmptyStateVariant = 'dashboard' | 'analysis' | 'sql' | 'meta' | 'cohort' | 'tag';

export interface EmptyStateProps {
  /** 决定插画与默认文案 */
  variant: EmptyStateVariant;
  /** 覆盖默认主文案；传 null 隐藏主文案行（仅插画 + 说明） */
  title?: string | null;
  /** 覆盖默认说明 */
  description?: string;
  /** CTA 插槽（按钮/链接） */
  action?: ReactNode;
  className?: string;
  /**
   * 窄容器（看板卡片、抽屉内）用：插画缩到 96px、上下留白收紧。
   * 长语言文案本身就比中文长 30–100%，固定 240px 插画 + 32px 留白会把文案挤出可视区（G.29）。
   */
  compact?: boolean;
}

/** 默认文案按当前语言取（模块级常量带中文，故做成接收 t 的工厂） */
function defaultCopy(t: TFunction): Record<EmptyStateVariant, { title: string; description: string }> {
  return {
    dashboard: {
      title: t('common:emptyState.dashboardTitle'),
      description: t('common:emptyState.dashboardDescription'),
    },
    analysis: {
      title: t('common:emptyState.analysisTitle'),
      description: t('common:emptyState.analysisDescription'),
    },
    sql: {
      title: t('common:emptyState.sqlTitle'),
      description: t('common:emptyState.sqlDescription'),
    },
    meta: {
      title: t('common:emptyState.metaTitle'),
      description: t('common:emptyState.metaDescription'),
    },
    cohort: {
      title: t('common:emptyState.cohortTitle'),
      description: t('common:emptyState.cohortDescription'),
    },
    tag: {
      title: t('common:emptyState.tagTitle'),
      description: t('common:emptyState.tagDescription'),
    },
  };
}

/** 数据感空状态插画：空坐标系 + 虚线柱 + 虚线折线 + 强调数据点（"数据待产生"隐喻） */
function EmptyChartIllustration({ width = 240 }: { width?: number }): React.JSX.Element {
  const gridLines: React.JSX.Element[] = [];
  for (let x = 48; x <= 192; x += 16) {
    gridLines.push(<line key={`v${x}`} x1={x} y1={32} x2={x} y2={116} stroke={BRAND_ILLUS_GRID} strokeWidth={1} />);
  }
  for (let y = 44; y <= 108; y += 16) {
    gridLines.push(<line key={`h${y}`} x1={40} y1={y} x2={200} y2={y} stroke={BRAND_ILLUS_GRID} strokeWidth={1} />);
  }
  return (
    <svg
      viewBox="0 0 240 160"
      width={width}
      height={Math.round((width * 160) / 240)}
      role="img"
      aria-hidden="true"
      focusable="false"
      // 容器比插画窄时整体等比缩小，而不是溢出被裁掉（窄看板卡片）
      style={{ maxWidth: '100%', height: 'auto' }}
    >
      {gridLines}
      <path d="M40 116 L200 116" stroke={BRAND_BORDER} strokeWidth={1.5} />
      <path d="M40 116 L40 32" stroke={BRAND_BORDER} strokeWidth={1.5} />
      <rect x="52" y="88" width="20" height="28" rx="3" stroke={BRAND_ILLUS_LIGHT} strokeWidth={1.5} strokeDasharray="4 3" fill="none" />
      <rect x="88" y="70" width="20" height="46" rx="3" stroke={BRAND_ILLUS_LIGHT} strokeWidth={1.5} strokeDasharray="4 3" fill="none" />
      <rect x="124" y="52" width="20" height="64" rx="3" stroke={BRAND_ILLUS_LIGHT} strokeWidth={1.5} strokeDasharray="4 3" fill="none" />
      <rect x="160" y="34" width="20" height="82" rx="3" stroke={BRAND_ILLUS_LIGHT} strokeWidth={1.5} strokeDasharray="4 3" fill="none" />
      <path d="M52 88 L88 70 L124 52 L160 34" stroke={BRAND_PRIMARY} strokeWidth={2} strokeDasharray="5 3" strokeLinecap="round" fill="none" />
      <circle cx="160" cy="34" r="4" fill={BRAND_PRIMARY} />
    </svg>
  );
}

export function EmptyState({
  variant,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps): React.JSX.Element {
  const { t } = useT();
  const copy = defaultCopy(t)[variant];
  const resolvedTitle = title === null ? null : title ?? copy.title;
  const style: CSSProperties = {
    // 不留固定高：文案换行后容器自然长高，窄卡片里也不会把说明裁成半行
    margin: compact ? '8px 0' : '32px 0',
    minWidth: 0,
  };
  return (
    <div className={className} style={style}>
      <Empty
        image={<EmptyChartIllustration width={compact ? 96 : 240} />}
        styles={{ image: { height: 'auto', marginBottom: compact ? 4 : 8 } }}
        description={
          // 文案块：允许换行 + 长单词（俄/德）断行，不写死宽度、不裁切
          <div
            style={{
              maxWidth: '100%',
              margin: '0 auto',
              whiteSpace: 'normal',
              overflowWrap: 'break-word',
              lineHeight: 1.6,
            }}
          >
            {resolvedTitle !== null && (
              <div style={{ fontWeight: 600, color: 'rgba(0,0,0,0.88)', marginBottom: 4, fontSize: compact ? 13 : undefined }}>
                {resolvedTitle}
              </div>
            )}
            <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: compact ? 12 : 13 }}>
              {description ?? copy.description}
            </div>
          </div>
        }
      >
        {action}
      </Empty>
    </div>
  );
}
