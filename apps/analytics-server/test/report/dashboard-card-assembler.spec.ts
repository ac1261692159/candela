/**
 * 看板-卡片关联装配：孤儿关联行容错（AC3 / AC4）。
 *
 * 回归背景：卡片删除后残留的关联行会让 Prisma 的 `include: { card }` 抛
 * `Inconsistent query result`，导致整个看板 500。
 */
import { attachCardsToLinks, type CardBatchReader } from '../../src/modules/report/dashboard-card-assembler';

function makeCard(cardId: string) {
  return {
    card_id: cardId,
    project_name: 'clklogapp',
    owner: 'u1',
    name: `卡片-${cardId}`,
    type: 'sql',
    dsl_json: '{}',
    chart_type: 'line',
    refresh_policy: 'auto',
    locked: false,
    created_at: new Date('2026-09-07T00:00:00.000Z'),
    updated_at: new Date('2026-09-07T00:00:00.000Z'),
    cache: null,
  };
}

function makeReader(existing: string[]): { reader: CardBatchReader; findMany: jest.Mock } {
  const findMany = jest.fn().mockResolvedValue(existing.map(makeCard));
  return { reader: { card: { findMany } } as unknown as CardBatchReader, findMany };
}

function makeLink(id: string, cardId: string, positionY: number) {
  return {
    id,
    db_id: 'db1',
    card_id: cardId,
    position_x: 0,
    position_y: positionY,
    width: 6,
    height: 4,
    created_at: new Date('2026-09-07T00:00:00.000Z'),
  };
}

describe('attachCardsToLinks', () => {
  it('无关联行时不查询卡片', async () => {
    const { reader, findMany } = makeReader([]);
    await expect(attachCardsToLinks(reader, [])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('关联行对应的卡片缺失时忽略该行，不抛错', async () => {
    const { reader } = makeReader(['c1']);
    const links = [makeLink('l1', 'c1', 0), makeLink('l2', 'c_gone', 4)];

    const result = await attachCardsToLinks(reader, links);

    expect(result).toHaveLength(1);
    expect(result[0].card_id).toBe('c1');
    expect(result[0].card.card_id).toBe('c1');
  });

  it('全部关联行都是孤儿时返回空数组', async () => {
    const { reader } = makeReader([]);
    const links = [makeLink('l1', 'c_gone', 0), makeLink('l2', 'c_gone2', 4)];

    await expect(attachCardsToLinks(reader, links)).resolves.toEqual([]);
  });

  it('保持入参顺序并带上布局字段', async () => {
    const { reader } = makeReader(['c1', 'c2']);
    const links = [makeLink('l1', 'c2', 10), makeLink('l2', 'c1', 0)];

    const result = await attachCardsToLinks(reader, links);

    expect(result.map((l) => l.card_id)).toEqual(['c2', 'c1']);
    expect(result[0].position_y).toBe(10);
    expect(result[0].height).toBe(4);
  });

  it('同一卡片被多次引用时只查询一次', async () => {
    const { reader, findMany } = makeReader(['c1']);
    const links = [makeLink('l1', 'c1', 0), makeLink('l2', 'c1', 4)];

    const result = await attachCardsToLinks(reader, links);

    expect(result).toHaveLength(2);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toEqual({
      where: { card_id: { in: ['c1'] } },
      include: { cache: true },
    });
  });
});
