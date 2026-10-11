import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { Prisma } from '@prisma/client';
import { attachCardsToLinks } from './dashboard-card-assembler';

/**
 * 卡片数据访问（2026-09 重设计）。
 * 卡片是全局资产（不归属看板）；看板通过 dashboardcard 关联表引用卡片并存储布局。
 */
@Injectable()
export class CardRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 全局卡片列表（按项目 + 类型过滤，RBAC 过滤由 service 传入 owner） */
  async findMany(project: string, type?: string, owner?: string) {
    const where: Prisma.CardWhereInput = { project_name: project };
    if (type) where.type = type;
    if (owner) where.owner = owner;
    return this.prisma.card.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        // 带上引用看板的 TTL：列表要按与温热一致的规则判定缓存是否过期
        dashboard_cards: {
          select: { db_id: true, dashboard: { select: { cache_ttl_sec: true } } },
        },
        // 只取缓存行元信息：列表不搬运 result_json（LongText）
        cache: { select: { error: true, refreshed_at: true } },
      },
    });
  }

  /** 同项目内是否已有同名卡片（排除自身，供创建与重命名查重） */
  async findByName(project: string, name: string, exceptCardId?: string) {
    return this.prisma.card.findFirst({
      where: {
        project_name: project,
        name,
        ...(exceptCardId ? { card_id: { not: exceptCardId } } : {}),
      },
      select: { card_id: true },
    });
  }

  /** 全局卡片详情 */
  async findById(cardId: string) {
    return this.prisma.card.findUnique({
      where: { card_id: cardId },
      include: { dashboard_cards: { select: { db_id: true } }, cache: true },
    });
  }

  /** 创建全局卡片 */
  async create(data: Prisma.CardUncheckedCreateInput) {
    return this.prisma.card.create({ data });
  }

  /** 更新全局卡片 */
  async update(cardId: string, data: Prisma.CardUncheckedUpdateInput) {
    return this.prisma.card.update({ where: { card_id: cardId }, data });
  }

  /**
   * 删除全局卡片：同时清理所有看板对该卡片的引用。
   *
   * `dashboardcard` 表没有数据库外键，schema 也未启用 `relationMode = "prisma"`，
   * 因此 `onDelete: Cascade` 不会生效，必须在此显式清理，否则残留孤儿关联行
   * 会让看板详情接口 500（线上事故 2026-09-07）。
   * `cardcache` 有真实外键，仍由数据库级联。
   */
  async delete(cardId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.dashboardCard.deleteMany({ where: { card_id: cardId } });
      return tx.card.delete({ where: { card_id: cardId } });
    });
  }

  // ---- 看板-卡片关联 ----

  /**
   * 看板引用的卡片（联查卡片内容 + 布局）。
   *
   * 不用 `include: { card: true }`：卡片可能已被删除而残留关联行，Prisma 非空
   * 关联遇缺失会抛 `Inconsistent query result`，导致整个列表失败。这里改为
   * 两段查询，孤儿行被忽略。
   */
  async findDashboardCards(dbId: string) {
    const links = await this.prisma.dashboardCard.findMany({
      where: { db_id: dbId },
      orderBy: [{ position_y: 'asc' }, { position_x: 'asc' }],
    });
    return attachCardsToLinks(this.prisma, links);
  }

  /** 看板内是否已引用某卡片 */
  async findLink(dbId: string, cardId: string) {
    return this.prisma.dashboardCard.findUnique({
      where: { db_id_card_id: { db_id: dbId, card_id: cardId } },
    });
  }

  /** 添加卡片到看板 */
  async addLink(data: Prisma.DashboardCardUncheckedCreateInput) {
    return this.prisma.dashboardCard.create({ data });
  }

  /** 更新布局 */
  async updateLink(dbId: string, cardId: string, data: Prisma.DashboardCardUncheckedUpdateInput) {
    return this.prisma.dashboardCard.update({
      where: { db_id_card_id: { db_id: dbId, card_id: cardId } },
      data,
    });
  }

  /** 从看板移除（仅删关联，不删卡片） */
  async removeLink(dbId: string, cardId: string) {
    return this.prisma.dashboardCard.delete({
      where: { db_id_card_id: { db_id: dbId, card_id: cardId } },
    });
  }

  /** 批量更新看板内布局（未知 card_id 忽略） */
  async saveLayouts(
    dbId: string,
    items: Array<{ card_id: string; position_x: number; position_y: number; width: number; height: number }>,
  ) {
    await this.prisma.$transaction(
      items.map((item) =>
        this.prisma.dashboardCard.updateMany({
          where: { db_id: dbId, card_id: item.card_id },
          data: {
            position_x: item.position_x,
            position_y: item.position_y,
            width: item.width,
            height: item.height,
          },
        }),
      ),
    );
  }

  /** 后台温热：已被看板引用的查询卡 */
  async findWorkerCandidates() {
    return this.prisma.card.findMany({
      where: {
        // metric（指标卡）也必须进候选集：否则放到看板上也永远不会刷新（v3 验收实测）
        type: { in: ['sql', 'event', 'funnel', 'metric'] },
        dashboard_cards: { some: {} },
      },
      include: {
        cache: true,
        dashboard_cards: { include: { dashboard: { select: { cache_ttl_sec: true } } } },
      },
    });
  }

  async upsertCache(
    cardId: string,
    data: { result_json: string | null; error: string | null; row_count: number; refreshed_at: Date },
  ) {
    return this.prisma.cardCache.upsert({
      where: { card_id: cardId },
      create: { card_id: cardId, ...data },
      update: data,
    });
  }
}
