/** Grafana 式网格坐标变换（纯函数）。 */

export const DEFAULT_GRID_COLUMNS = 24;
export const LEGACY_GRID_COLUMNS = 12;
export const ROW_HEIGHT = 40;

export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutCard {
  card_id: string;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
}

export function isLegacyTwelveCol(items: Array<{ x: number; w: number }>): boolean {
  if (items.length === 0) return false;
  // 旧默认半宽 w=6；新 24 列半宽为 12，不能再用 x+w<=12 判断。
  return items.every((item) => item.w <= 6 && item.x + item.w <= LEGACY_GRID_COLUMNS);
}

export function toGridLayout(cards: LayoutCard[], cols: number): GridItem[] {
  const raw: GridItem[] = cards.map((card) => ({
    i: card.card_id,
    x: card.position_x,
    y: card.position_y,
    w: card.width,
    h: card.height,
  }));
  const scaled =
    cols === DEFAULT_GRID_COLUMNS && isLegacyTwelveCol(raw)
      ? raw.map((item) => ({
          ...item,
          x: item.x * 2,
          w: item.w * 2,
        }))
      : raw;
  return compactUniformTall(scaled.map((item) => clampItem(item, cols)));
}

export function remapColumns(layout: GridItem[], fromCols: number, toCols: number): GridItem[] {
  if (fromCols === toCols || fromCols <= 0) return layout.map((item) => clampItem(item, toCols));
  const ratio = toCols / fromCols;
  return layout.map((item) =>
    clampItem(
      {
        ...item,
        x: Math.round(item.x * ratio),
        w: Math.max(1, Math.round(item.w * ratio)),
      },
      toCols,
    ),
  );
}

export function clampItem(item: GridItem, cols: number): GridItem {
  const w = Math.max(1, Math.min(item.w, cols));
  const x = Math.max(0, Math.min(item.x, cols - w));
  return { ...item, x, w, h: Math.max(1, item.h), y: Math.max(0, item.y) };
}

/** 多数卡同高且偏高时收成 6 行（工作室默认格）。少数不同高度的卡（如标签）不挡、也不改。 */
export function compactUniformTall(layout: GridItem[]): GridItem[] {
  if (layout.length < 2) return layout;
  const counts = new Map<number, number>();
  for (const item of layout) counts.set(item.h, (counts.get(item.h) ?? 0) + 1);
  let modeH = 0;
  let modeN = 0;
  for (const [h, n] of counts) {
    if (n > modeN) {
      modeH = h;
      modeN = n;
    }
  }
  if (modeH < 8 || modeN < 2) return layout;
  const nextH = 6;
  const ratio = nextH / modeH;
  return layout.map((item) =>
    item.h === modeH ? { ...item, h: nextH, y: Math.round(item.y * ratio) } : item,
  );
}

export function nextSlot(layout: GridItem[], cols: number, w: number, h: number): Omit<GridItem, 'i'> {
  const maxY = layout.reduce((m, item) => Math.max(m, item.y + item.h), 0);
  return clampItem({ i: '_', x: 0, y: maxY, w, h }, cols);
}

export function layoutsEqual(a: GridItem[], b: GridItem[]): boolean {
  if (a.length !== b.length) return false;
  const map = new Map(b.map((item) => [item.i, item]));
  return a.every((item) => {
    const other = map.get(item.i);
    return other && other.x === item.x && other.y === item.y && other.w === item.w && other.h === item.h;
  });
}
