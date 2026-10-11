import type { Prisma } from '@prisma/client';

/**
 * 看板-卡片关联装配（2026-09 缺陷修复）。
 *
 * 背景：`dashboardcard` 表没有数据库外键，`schema.prisma` 也未启用
 * `relationMode = "prisma"`，因此删除卡片后残留的孤儿关联行不会被清理。
 * 而 Prisma 的 `include: { card: ... }` 把 `card` 视为**非空关联**，
 * 一旦某行关联缺失就抛出
 * `Inconsistent query result: Field card is required to return data, got null`，
 * 导致整个看板详情接口 500（线上事故 2026-09-07）。
 *
 * 对策：不使用 `include` 拉关联，改为两段查询 + 内存装配。关联行对应的卡片
 * 不存在时直接丢弃，使单条脏数据不再影响整个看板。
 */

type CardWithCache = Prisma.CardGetPayload<{ include: { cache: true } }>;

/** 只依赖「按 id 批量取卡片」这一能力，便于单测替换 */
export type CardBatchReader = {
  card: {
    findMany(args: {
      where: { card_id: { in: string[] } };
      include: { cache: true };
    }): Promise<CardWithCache[]>;
  };
};

/**
 * 给看板-卡片关联行装配卡片内容（含缓存）。
 *
 * @param reader  提供卡片查询的 Prisma 客户端
 * @param links   关联行（含布局，顺序由调用方保证）
 * @returns 仅保留卡片仍存在的关联行，保持入参顺序
 */
export async function attachCardsToLinks<L extends { card_id: string }>(
  reader: CardBatchReader,
  links: readonly L[],
): Promise<Array<L & { card: CardWithCache }>> {
  if (links.length === 0) return [];

  const cardIds = [...new Set(links.map((l) => l.card_id))];
  const cards = await reader.card.findMany({
    where: { card_id: { in: cardIds } },
    include: { cache: true },
  });
  const byId = new Map(cards.map((c) => [c.card_id, c]));

  const assembled: Array<L & { card: CardWithCache }> = [];
  for (const link of links) {
    const card = byId.get(link.card_id);
    if (!card) continue; // 孤儿关联行：卡片已删除，跳过而不是让整个查询失败
    assembled.push({ ...link, card });
  }
  return assembled;
}
