import { Tooltip } from 'antd';

interface AssetNameProps {
  name: string;
  /** 有描述时悬停显示；无描述不加空浮层 */
  description?: string | null;
  onClick: () => void;
}

/**
 * 看板 / 卡片名称：常态黑色，鼠标移到名称上才变蓝（样式见 asset-list.css），
 * 有描述时悬停显示描述。
 */
export function AssetName({ name, description, onClick }: AssetNameProps) {
  const node = (
    <span className="asset-name" onClick={onClick}>
      {name}
    </span>
  );
  return description ? <Tooltip title={description}>{node}</Tooltip> : node;
}
