import type { CSSProperties } from 'react';
import {
  AppstoreOutlined,
  CalculatorOutlined,
  ClusterOutlined,
  DashboardOutlined,
  FilterOutlined,
  FundOutlined,
  IdcardOutlined,
  KeyOutlined,
  TagOutlined,
  TagsOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { BRAND_TEXT_SECONDARY } from '../styles/tokens';

export type EntityIconType =
  | 'event'
  | 'virtual-event'
  | 'event-property'
  | 'user-property'
  | 'metric'
  | 'dashboard'
  | 'card'
  | 'cohort'
  | 'tag'
  | 'subject'
  | 'api-key';

export interface EntityIconProps {
  type: EntityIconType;
  /** 默认 14（表格行内尺寸） */
  size?: number;
  style?: CSSProperties;
}

const ICON_BY_TYPE: Record<EntityIconType, typeof ThunderboltOutlined> = {
  event: ThunderboltOutlined,
  'virtual-event': FundOutlined,
  'event-property': TagsOutlined,
  'user-property': IdcardOutlined,
  metric: CalculatorOutlined,
  dashboard: DashboardOutlined,
  card: AppstoreOutlined,
  cohort: FilterOutlined,
  tag: TagOutlined,
  subject: ClusterOutlined,
  'api-key': KeyOutlined,
};

/** 实体类型 icon 单一分发（phase: clklog-analytics-visual-assets-v1） */
export function EntityIcon({ type, size = 14, style }: EntityIconProps): React.JSX.Element {
  const Icon = ICON_BY_TYPE[type];
  // 默认次级灰走品牌 token：接入点不必各自硬编码颜色，需换色时用 style 覆盖
  return <Icon style={{ fontSize: size, color: BRAND_TEXT_SECONDARY, ...style }} aria-hidden />;
}
