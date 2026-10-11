import { useMemo, useRef, useEffect } from 'react';
import { Empty, Typography } from 'antd';
import GridLayout from 'react-grid-layout';
import { CardWidget } from './CardWidget';
import { createRefreshGate } from './dashboard-refresh-gate';
import { useT } from '../../i18n';
import {
  DEFAULT_GRID_COLUMNS,
  ROW_HEIGHT,
  layoutsEqual,
  toGridLayout,
  type GridItem,
} from './grafana-layout';
import { saveDashboardLayout } from '../../services/report.service';
import type { DashboardCard } from '../../types/report.types';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const Grid = GridLayout.WidthProvider(GridLayout);

/**
 * 卡片头（长语言下的三处系统性策略之一，AGENTS.md G.29）：
 * - `min-height` 而不是固定 32px：俄/德/越/泰的译后类型标签比中文长 30–100%，
 *   窄卡片里宁可换行到第二行，也不把标题/标签压成一字一列；
 * - 头部 tag 允许省略号截断（截断处由 TSX 里的 Tooltip 兜底看全称）；
 * - 操作按钮 `flex-shrink:0`，不被标题挤压或裁掉。
 *
 * 注：CSS 内注释保持 ASCII——`i18n_scan.py` 把模板字符串里的中文计为待翻译文案，
 * 在这里写中文会让覆盖率棘轮上升（1446 → 1447）。
 */
const PANEL_CSS = `
.grafana-grid{min-height:120px;}
.grafana-grid .react-grid-item > div{height:100%;}
.grafana-panel{height:100%;display:flex;flex-direction:column;background:#fff;border-radius:2px;overflow:hidden;}
/* panel header: min-height instead of fixed 32px, long-language tags wrap instead of squeezing */
.grafana-panel-header{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;min-height:32px;height:auto;padding:2px 4px 2px 0;flex-shrink:0;background:#fff;}
.grafana-panel-header .ant-tag{max-width:100%;overflow:hidden;text-overflow:ellipsis;}
.grafana-panel .grafana-panel-title{cursor:pointer;color:rgba(0,0,0,.88);transition:color .15s;}
.grafana-panel .grafana-panel-title:hover{color:#1677ff;}
.grafana-panel-actions{opacity:0;pointer-events:none;transition:opacity .15s;flex-shrink:0;}
.grafana-panel:hover .grafana-panel-actions,.grafana-panel:focus-within .grafana-panel-actions{opacity:1;pointer-events:auto;}
@media (hover:none){.grafana-panel-actions{opacity:1;pointer-events:auto;}}
.grafana-panel-drag{width:14px;align-self:stretch;cursor:move;background:
  repeating-linear-gradient(90deg,#d9d9d9 0 2px,transparent 2px 4px);
  background-size:4px 10px;background-repeat:repeat-y;background-position:center;opacity:.7;}
.grafana-panel-body{flex:1;min-height:0;overflow:hidden;padding:8px 10px;display:flex;flex-direction:column;}
.grafana-panel-body-flush{padding:0;}
.grafana-fill{flex:1;min-height:0;display:flex;flex-direction:column;height:100%;}
.react-grid-item.react-grid-placeholder{background:#1677ff;opacity:.12;border-radius:2px;}
.react-resizable-handle{z-index:2;}
`;

interface DashboardGridProps {
  cards: DashboardCard[];
  dbId: string;
  cols?: number;
  editable?: boolean;
  refreshEpoch?: number;
  onRemoveCard?: (cardId: string) => void;
  onCardsChanged?: () => void;
  onLayoutDraft?: (layout: GridItem[]) => void;
  showTypeTag?: boolean;
}

export function DashboardGrid({
  cards,
  dbId,
  cols = DEFAULT_GRID_COLUMNS,
  editable,
  refreshEpoch,
  onRemoveCard,
  onCardsChanged,
  onLayoutDraft,
  showTypeTag = false,
}: DashboardGridProps) {
  const { t } = useT('report');
  const scheduleRefresh = useMemo(() => createRefreshGate(2), []);
  const layout = useMemo(() => toGridLayout(cards, cols), [cards, cols]);
  const persistTimer = useRef<number | null>(null);
  const lastSent = useRef(layout);

  useEffect(() => {
    lastSent.current = layout;
  }, [layout]);

  const persist = (next: GridItem[]) => {
    onLayoutDraft?.(next);
    if (!editable) return;
    if (layoutsEqual(next.map(compact), lastSent.current.map(compact))) return;
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      lastSent.current = next;
      void saveDashboardLayout(
        dbId,
        next.map((item) => ({
          card_id: item.i,
          position_x: item.x,
          position_y: item.y,
          width: item.w,
          height: item.h,
        })),
      );
    }, 300);
  };

  if (!cards || cards.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Typography.Text type="secondary">
            {t('report:dashboard.emptyCards')}
          </Typography.Text>
        }
      />
    );
  }

  return (
    <div className="grafana-grid">
      <style>{PANEL_CSS}</style>
      <Grid
        className="layout"
        layout={layout}
        cols={cols}
        rowHeight={ROW_HEIGHT}
        margin={[8, 8]}
        containerPadding={[0, 0]}
        compactType="vertical"
        draggableHandle=".grafana-panel-drag"
        resizeHandles={['se']}
        isDraggable={editable}
        isResizable={editable}
        onDragStop={(next) => persist(next as GridItem[])}
        onResizeStop={(next) => persist(next as GridItem[])}
      >
        {cards.map((card) => (
          <div key={card.card_id} style={{ height: '100%' }}>
            <CardWidget
              card={card}
              dbId={dbId}
              editable={editable}
              showTypeTag={showTypeTag}
              refreshEpoch={refreshEpoch}
              scheduleRefresh={scheduleRefresh}
              onRemove={onRemoveCard}
              onCardUpdated={onCardsChanged}
            />
          </div>
        ))}
      </Grid>
    </div>
  );
}

function compact(item: GridItem) {
  return { i: item.i, x: item.x, y: item.y, w: item.w, h: item.h };
}
