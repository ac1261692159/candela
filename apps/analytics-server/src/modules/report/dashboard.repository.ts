import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { Dashboard, Prisma } from '@prisma/client';
import { attachCardsToLinks } from './dashboard-card-assembler';

/**
 * 看板数据访问。
 * 数据模型见 prisma/schema.prisma model Dashboard。
 */
@Injectable()
export class DashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 项目下的看板列表（含卡片数）；owner 可选过滤（RBAC） */
  async findMany(project: string, owner?: string) {
    return this.prisma.dashboard.findMany({
      where: {
        project_name: project,
        ...(owner ? { owner } : {}),
      },
      orderBy: { updated_at: 'desc' },
      include: { _count: { select: { dashboard_cards: true } }, folder: true },
    });
  }

  /** 按 id + 项目查单个看板 */
  async findById(dbId: string, project: string) {
    return this.prisma.dashboard.findFirst({
      where: { db_id: dbId, project_name: project },
    });
  }

  /** 同项目内是否已有同名看板（排除自身，供创建与重命名查重） */
  async findByName(project: string, name: string, exceptDbId?: string) {
    return this.prisma.dashboard.findFirst({
      where: {
        project_name: project,
        name,
        ...(exceptDbId ? { db_id: { not: exceptDbId } } : {}),
      },
      select: { db_id: true },
    });
  }

  /** 按分享 token 查（只读分享，不校验项目归属） */
  async findByShareToken(token: string) {
    return this.prisma.dashboard.findUnique({
      where: { share_token: token },
    });
  }

  /** 创建看板 */
  async create(data: Prisma.DashboardUncheckedCreateInput) {
    return this.prisma.dashboard.create({ data });
  }

  /** 更新看板（仅归属项目） */
  async update(dbId: string, project: string, data: Prisma.DashboardUncheckedUpdateInput) {
    return this.prisma.dashboard.updateMany({
      where: { db_id: dbId, project_name: project },
      data,
    });
  }

  /** 删除看板（仅归属项目） */
  async delete(dbId: string, project: string) {
    return this.prisma.dashboard.deleteMany({
      where: { db_id: dbId, project_name: project },
    });
  }

  /**
   * 看板详情（含关联卡片 + 布局 + 缓存，按 position 排序）。
   *
   * 不用 `include: { card: ... }`：卡片被删除后可能残留关联行，Prisma 的非空
   * 关联遇缺失会抛 `Inconsistent query result`，使整个看板 500。孤儿行在此忽略。
   */
  async findDetail(dbId: string, project: string) {
    const db = await this.prisma.dashboard.findFirst({
      where: { db_id: dbId, project_name: project },
    });
    if (!db) return null;

    const links = await this.prisma.dashboardCard.findMany({
      where: { db_id: dbId },
      orderBy: [{ position_y: 'asc' }, { position_x: 'asc' }],
    });
    const dashboard_cards = await attachCardsToLinks(this.prisma, links);
    return { ...db, dashboard_cards };
  }

  /**
   * 按分享 token 查详情（含关联卡片 + 布局 + 缓存）。
   * 孤儿关联行同样忽略，避免一条脏数据让分享页 500。
   */
  async findDetailByShareToken(token: string) {
    const db = await this.prisma.dashboard.findUnique({
      where: { share_token: token },
    });
    if (!db) return null;

    const links = await this.prisma.dashboardCard.findMany({
      where: { db_id: db.db_id },
      orderBy: [{ position_y: 'asc' }, { position_x: 'asc' }],
    });
    const dashboard_cards = await attachCardsToLinks(this.prisma, links);
    return { ...db, dashboard_cards };
  }
}
