import type { CSSProperties } from 'react';
import { BRAND_PRIMARY, BRAND_TEXT } from '../styles/tokens';

export type BrandLogoVariant = 'mark' | 'full';

export interface BrandLogoProps {
  /** 'mark' 仅图形标；'full' 图形标 + "Candela" 字标 */
  variant?: BrandLogoVariant;
  /** 图形标边长 px，默认 24；'full' 时字标字号随 size 缩放 */
  size?: number;
  /** 图形标颜色，默认品牌主色 */
  color?: string;
  className?: string;
  /** 无障碍标签，折叠态按钮语义由调用方给出 */
  'aria-label'?: string;
}

/**
 * 品牌图形标：字母 C 弧线 + 三根上升柱状（数据增长隐喻）。
 * viewBox 0 0 24 24，全部用 currentColor 以便调用方换色。
 */
function BrandMark({ size, color }: { size: number; color: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', color }}
    >
      <path
        d="M18.2 5.8a7.8 7.8 0 1 0 0 12.4"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
      />
      <rect x="7.2" y="13.2" width="2.6" height="4" rx="1" fill="currentColor" />
      <rect x="10.7" y="10.4" width="2.6" height="6.8" rx="1" fill="currentColor" />
      <rect x="14.2" y="7.6" width="2.6" height="9.6" rx="1" fill="currentColor" />
    </svg>
  );
}

export function BrandLogo({
  variant = 'mark',
  size = 24,
  color = BRAND_PRIMARY,
  className,
  'aria-label': ariaLabel,
}: BrandLogoProps): React.JSX.Element {
  if (variant === 'mark') {
    return (
      <span className={className} role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
        <BrandMark size={size} color={color} />
      </span>
    );
  }
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontSize: Math.round(size * 0.75),
    fontWeight: 600,
    color: BRAND_TEXT,
    whiteSpace: 'nowrap',
  };
  return (
    <span className={className} style={style} role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
      <BrandMark size={size} color={color} />
      Candela
    </span>
  );
}
