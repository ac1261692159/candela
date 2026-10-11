import { describe, expect, it } from 'vitest';
import { isLegacyTwelveCol, remapColumns, toGridLayout } from './grafana-layout';

describe('grafana-layout', () => {
  it('检测遗留 12 列并放大到 24', () => {
    expect(isLegacyTwelveCol([{ x: 0, w: 6 }, { x: 6, w: 6 }])).toBe(true);
    expect(isLegacyTwelveCol([{ x: 0, w: 12 }])).toBe(false);
    const layout = toGridLayout(
      [
        { card_id: 'a', position_x: 0, position_y: 0, width: 6, height: 4 },
        { card_id: 'b', position_x: 6, position_y: 0, width: 6, height: 4 },
      ],
      24,
    );
    expect(layout[0]).toMatchObject({ x: 0, w: 12, h: 4 });
    expect(layout[1]).toMatchObject({ x: 12, w: 12, h: 4 });
  });

  it('全板同高且偏高时收成 6 行', () => {
    const layout = toGridLayout(
      [
        { card_id: 'a', position_x: 0, position_y: 0, width: 12, height: 10 },
        { card_id: 'b', position_x: 12, position_y: 0, width: 12, height: 10 },
      ],
      24,
    );
    expect(layout[0].h).toBe(6);
    expect(layout[1].h).toBe(6);
    expect(layout[0].y).toBe(0);
  });

  it('高度不一致则不收', () => {
    const layout = toGridLayout(
      [
        { card_id: 'a', position_x: 0, position_y: 0, width: 12, height: 10 },
        { card_id: 'b', position_x: 12, position_y: 0, width: 12, height: 4 },
      ],
      24,
    );
    expect(layout[0].h).toBe(10);
    expect(layout[1].h).toBe(4);
  });

  it('多数卡同高偏高时仍收那些卡，少数标签高度不动', () => {
    const layout = toGridLayout(
      [
        { card_id: 'a', position_x: 0, position_y: 0, width: 12, height: 10 },
        { card_id: 'b', position_x: 12, position_y: 0, width: 12, height: 10 },
        { card_id: 'c', position_x: 0, position_y: 10, width: 24, height: 3 },
      ],
      24,
    );
    expect(layout.find((item) => item.i === 'a')?.h).toBe(6);
    expect(layout.find((item) => item.i === 'b')?.h).toBe(6);
    expect(layout.find((item) => item.i === 'c')?.h).toBe(3);
  });

  it('已是 24 列则不再放大', () => {
    const layout = toGridLayout(
      [{ card_id: 'a', position_x: 0, position_y: 0, width: 12, height: 8 }],
      24,
    );
    expect(layout[0]).toMatchObject({ x: 0, w: 12, h: 8 });
  });

  it('列数 24→12 按比例映射', () => {
    const next = remapColumns([{ i: 'a', x: 12, y: 0, w: 12, h: 8 }], 24, 12);
    expect(next[0]).toMatchObject({ x: 6, w: 6, h: 8 });
  });
});
