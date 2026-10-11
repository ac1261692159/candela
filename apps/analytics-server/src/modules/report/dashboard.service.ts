import { Injectable, Logger } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { conflict, forbidden, notFound } from '../../i18n/domain-error';
import { Prisma } from '@prisma/client';
import { DashboardRepository } from './dashboard.repository';
import { CreateDashboardDto, UpdateDashboardDto } from './dto/dashboard.dto';
import type { AuthUser } from '../auth/auth.service';
import { cacheIsStale } from './card-cache.policy';
import { parseStoredDisplay } from './card-display';
import { expandGrantedFolders, visibleDashboards } from './dashboard-visibility';
import { parseDashboardCohortFilter } from './sql-cohort-filter';
import { AssetPolicyService } from '../iam/asset-policy.service';
import { PrismaService } from '../shared/prisma.service';
import { isProjectAdminRole } from '../iam/iam-evaluate';
import type { IamContext } from '../iam/iam.types';
import type { AssetAclGrant } from '../iam/asset-policy.service';

/**
 * 看板业务。观看走 view_all / ACL；写入只问 AssetPolicy。
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly repo: DashboardRepository,
    private readonly policy: AssetPolicyService,
    private readonly prisma: PrismaService,
  ) {}

  async list(project: string, user: AuthUser, iam: IamContext) {
    const rows = await this.repo.findMany(project);
    const viewAll = iam.permissions.has('dashboard.view_all');
    const subjectIds = [user.id, ...iam.group_ids];
    let grantedDashboardIds = new Set<string>();
    let grantedFolderIds = new Set<string>();
    if (!viewAll) {
      // rbac-v5：可见性 = 创建者例外 ∨ 看板级 view 授权 ∨ 所在文件夹（含父文件夹）view 授权
      // rbac-v6：edit 蕴含可见——只被授编辑权的分析师也应在列表里看到该看板
      const viewAcls = await this.prisma.saAssetAcl.findMany({
        where: { project_name: project, perm: { in: ['view', 'edit'] }, subject_id: { in: subjectIds } },
        select: { asset_type: true, asset_id: true },
      });
      grantedDashboardIds = new Set(
        viewAcls.filter((a) => a.asset_type === 'dashboard').map((a) => a.asset_id),
      );
      const folderGrants = new Set(viewAcls.filter((a) => a.asset_type === 'folder').map((a) => a.asset_id));
      if (folderGrants.size > 0) {
        const folders = await this.prisma.saDashboardFolder.findMany({
          where: { project_name: project },
          select: { folder_id: true, parent_id: true },
        });
        grantedFolderIds = expandGrantedFolders(folderGrants, folders);
      }
    }
    const folderOf = new Map(rows.map((r) => [r.db_id, r.folder_id ?? null]));
    const visible = visibleDashboards(rows, {
      userId: user.id,
      viewAll,
      grantedDashboardIds,
      grantedFolderIds,
      folderOf,
    });
    const isAdmin = isProjectAdminRole(iam.role_key);
    const grantCounts = isAdmin
      ? await this.prisma.saAssetAcl.groupBy({
          by: ['asset_id'],
          where: { project_name: project, asset_type: 'dashboard', perm: 'edit' },
          _count: { asset_id: true },
        })
      : [];
    const grantMap = new Map(grantCounts.map((g) => [g.asset_id, g._count.asset_id]));
    const out = [];
    for (const r of visible) {
      const asset = await this.policy.loadDashboard(project, r.db_id);
      const canEdit = await this.policy.canUpdate(user.id, iam, asset);
      out.push({
        ...this.toSummary(r),
        card_count: r._count?.dashboard_cards ?? 0,
        locked: this.policy.effectivelyLocked(asset),
        grant_count: isAdmin ? grantMap.get(r.db_id) ?? 0 : undefined,
        can_edit: canEdit && !isAdmin,
      });
    }
    return out;
  }

  /** 同项目内名称唯一（重命名时排除自身） */
  private async assertNameFree(project: string, name: string, exceptDbId?: string) {
    if (await this.repo.findByName(project, name, exceptDbId)) {
      throw conflict({
        code: 'report.dashboard.nameExists',
        messageKey: 'report:error.dashboard.nameExists',
        params: { name },
        message: `已存在同名看板「${name}」，请换一个名称`,
      });
    }
  }

  async create(dto: CreateDashboardDto, project: string, user: AuthUser) {
    if (dto.folder_id) {
      const folder = await this.prisma.saDashboardFolder.findFirst({
        where: { folder_id: dto.folder_id, project_name: project },
      });
      if (!folder) {
        throw notFound({
          code: 'report.dashboard.folderNotFound',
          messageKey: 'report:error.dashboard.folderNotFound',
          message: '文件夹不存在',
        });
      }
    }
    await this.assertNameFree(project, dto.name);
    const db = await this.repo.create({
      db_id: `db_${nanoid(10)}`,
      project_name: project,
      name: dto.name,
      description: dto.description?.trim() || null,
      layout_json: dto.layout_json ? JSON.stringify(dto.layout_json) : null,
      owner: user.id,
      share_token: dto.create_share_token ? `sh_${nanoid(10)}` : null,
      refresh_interval_sec: dto.refresh_interval_sec ?? 0,
      cache_ttl_sec: dto.cache_ttl_sec ?? 300,
      grid_columns: dto.grid_columns ?? 24,
      show_card_type: dto.show_card_type ?? false,
      cohort_filter_json: dto.cohort_filter ? JSON.stringify(dto.cohort_filter) : null,
      folder_id: dto.folder_id || null,
    });
    return this.toSummary(db);
  }

  async update(dbId: string, project: string, user: AuthUser, iam: IamContext, dto: UpdateDashboardDto) {
    const asset = await this.policy.loadDashboard(project, dbId);
    await this.policy.assert(user.id, iam, 'update', asset);
    if (dto.folder_id) {
      const folder = await this.prisma.saDashboardFolder.findFirst({
        where: { folder_id: dto.folder_id, project_name: project },
      });
      if (!folder) {
        throw notFound({
          code: 'report.dashboard.folderNotFound',
          messageKey: 'report:error.dashboard.folderNotFound',
          message: '文件夹不存在',
        });
      }
    }

    const data: Prisma.DashboardUncheckedUpdateInput = {};
    if (dto.name !== undefined) {
      // 查重排除自身，因此不改名的保存也能通过
      await this.assertNameFree(project, dto.name, dbId);
      data.name = dto.name;
    }
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.layout_json !== undefined) data.layout_json = JSON.stringify(dto.layout_json);
    if (dto.create_share_token) data.share_token = `sh_${nanoid(10)}`;
    if (dto.refresh_interval_sec !== undefined) data.refresh_interval_sec = dto.refresh_interval_sec;
    if (dto.cache_ttl_sec !== undefined) data.cache_ttl_sec = dto.cache_ttl_sec;
    if (dto.grid_columns !== undefined) data.grid_columns = dto.grid_columns;
    if (dto.show_card_type !== undefined) data.show_card_type = dto.show_card_type;
    if (dto.cohort_filter !== undefined) {
      data.cohort_filter_json = dto.cohort_filter ? JSON.stringify(dto.cohort_filter) : null;
    }
    if (dto.folder_id !== undefined) data.folder_id = dto.folder_id || null;

    await this.repo.update(dbId, project, data);
    const db = await this.repo.findById(dbId, project);
    return this.toSummary(db!);
  }

  async delete(dbId: string, project: string, user: AuthUser, iam: IamContext) {
    const asset = await this.policy.loadDashboard(project, dbId);
    await this.policy.assert(user.id, iam, 'delete', asset);
    await this.repo.delete(dbId, project);
    return { deleted: 1 };
  }

  async getDetail(dbId: string, project: string, user: AuthUser, iam: IamContext) {
    const db = await this.repo.findDetail(dbId, project);
    if (!db) {
      throw notFound({
        code: 'report.dashboard.notFound',
        messageKey: 'report:error.dashboard.notFound',
        params: { id: dbId },
        message: `看板不存在: ${dbId}`,
      });
    }
    const asset = await this.policy.loadDashboard(project, dbId);
    const canView =
      iam.permissions.has('dashboard.view_all') ||
      db.owner === user.id ||
      (await this.policy.hasViewGrant(user.id, iam, dbId));
    if (!canView) {
      throw forbidden({
        code: 'report.asset.forbidden',
        messageKey: 'report:error.asset.forbidden',
        message: '无权访问该资源',
      });
    }
    const canEdit = await this.policy.canUpdate(user.id, iam, asset);
    return {
      ...this.toDetail(db),
      locked: this.policy.effectivelyLocked(asset),
      can_edit: canEdit,
      can_filter: iam.permissions.has('dashboard.filter'),
    };
  }

  async lock(
    dbId: string,
    project: string,
    user: AuthUser,
    iam: IamContext,
    dto: { locked: boolean; lock_cards?: boolean },
  ) {
    const asset = await this.policy.loadDashboard(project, dbId);
    await this.policy.assert(user.id, iam, 'lock', asset, { locking: dto.locked });
    if (dto.lock_cards && dto.locked) {
      const links = await this.prisma.dashboardCard.findMany({
        where: { db_id: dbId },
        select: { card_id: true },
      });
      for (const link of links) {
        const cardAsset = await this.policy.loadCard(project, link.card_id);
        await this.policy.assert(user.id, iam, 'lock', cardAsset, { locking: true });
      }
      await this.prisma.$transaction([
        this.prisma.dashboard.updateMany({ where: { db_id: dbId, project_name: project }, data: { locked: true } }),
        ...links.map((l) =>
          this.prisma.card.updateMany({ where: { card_id: l.card_id, project_name: project }, data: { locked: true } }),
        ),
      ]);
    } else {
      await this.repo.update(dbId, project, { locked: dto.locked });
    }
    return { ok: true, locked: dto.locked };
  }

  async putAcl(dbId: string, project: string, user: AuthUser, iam: IamContext, grants: AssetAclGrant[]) {
    const asset = await this.policy.loadDashboard(project, dbId);
    await this.policy.replaceAcl(user.id, iam, project, asset, grants);
    return { ok: true };
  }

  async listAcl(dbId: string, project: string) {
    return this.policy.listAcl(project, 'dashboard', dbId);
  }

  /** 只读分享详情 */
  async getByShareToken(token: string) {
    const db = await this.repo.findDetailByShareToken(token);
    if (!db) {
      throw notFound({
        code: 'report.dashboard.shareTokenInvalid',
        messageKey: 'report:error.dashboard.shareTokenInvalid',
        message: '分享链接无效',
      });
    }
    return {
      db_id: db.db_id,
      name: db.name,
      description: db.description ?? null,
      layout_json: db.layout_json ? JSON.parse(db.layout_json) : null,
      refresh_interval_sec: db.refresh_interval_sec,
      cache_ttl_sec: db.cache_ttl_sec,
      grid_columns: db.grid_columns,
      show_card_type: db.show_card_type ?? false,
      cohort_filter: parseDashboardCohortFilter(db.cohort_filter_json),
      cards: db.dashboard_cards.map((l) => this.toLinkedCard(l, db.cache_ttl_sec)),
    };
  }

  private toDetail(db: {
    db_id: string;
    name: string;
    description?: string | null;
    layout_json: string | null;
    owner: string;
    share_token: string | null;
    refresh_interval_sec: number;
    cache_ttl_sec: number;
    grid_columns: number;
    show_card_type?: boolean;
    cohort_filter_json?: string | null;
    folder_id?: string | null;
    created_at: Date;
    updated_at: Date;
    dashboard_cards: Parameters<DashboardService['toLinkedCard']>[0][];
  }) {
    return {
      db_id: db.db_id,
      name: db.name,
      description: db.description ?? null,
      layout_json: db.layout_json ? JSON.parse(db.layout_json) : null,
      owner: db.owner,
      share_token: db.share_token,
      refresh_interval_sec: db.refresh_interval_sec,
      cache_ttl_sec: db.cache_ttl_sec,
      grid_columns: db.grid_columns,
      show_card_type: db.show_card_type ?? false,
      cohort_filter: parseDashboardCohortFilter(db.cohort_filter_json),
      folder_id: db.folder_id ?? null,
      created_at: db.created_at,
      updated_at: db.updated_at,
      cards: db.dashboard_cards.map((l) => this.toLinkedCard(l, db.cache_ttl_sec)),
    };
  }

  /** 关联行 → 卡片内容 + 布局 + 缓存（卡片含名称） */
  private toLinkedCard(
    l: {
      position_x: number;
      position_y: number;
      width: number;
      height: number;
      display_json?: string | null;
      card: {
        card_id: string;
        name: string;
        type: string;
        dsl_json: string;
        chart_type: string;
        refresh_policy: string;
        cache: {
          result_json: string | null;
          error: string | null;
          row_count: number;
          refreshed_at: Date;
        } | null;
      };
    },
    cacheTtlSec: number,
  ) {
    return {
      card_id: l.card.card_id,
      name: l.card.name,
      type: l.card.type,
      dsl: JSON.parse(l.card.dsl_json),
      chart_type: l.card.chart_type,
      refresh_policy: l.card.refresh_policy,
      position_x: l.position_x,
      position_y: l.position_y,
      width: l.width,
      height: l.height,
      display: parseStoredDisplay(l.display_json),
      cache: this.toCachePayload(l.card.cache, cacheTtlSec),
    };
  }

  private toCachePayload(
    cache: {
      result_json: string | null;
      error: string | null;
      row_count: number;
      refreshed_at: Date;
    } | null,
    ttlSec: number,
  ) {
    if (!cache) return null;
    let result: unknown = null;
    if (cache.result_json) {
      try {
        result = JSON.parse(cache.result_json);
      } catch {
        result = null;
      }
    }
    return {
      result,
      error: cache.error,
      row_count: cache.row_count,
      refreshed_at: cache.refreshed_at.toISOString(),
      stale: cacheIsStale(cache.refreshed_at, ttlSec),
    };
  }

  private toSummary(db: {
    db_id: string;
    name: string;
    description?: string | null;
    layout_json: string | null;
    owner: string;
    share_token: string | null;
    refresh_interval_sec?: number;
    cache_ttl_sec?: number;
    grid_columns?: number;
    show_card_type?: boolean;
    cohort_filter_json?: string | null;
    folder_id?: string | null;
    locked?: boolean;
    visibility?: string;
    created_at: Date;
    updated_at: Date;
  }) {
    return {
      db_id: db.db_id,
      name: db.name,
      description: db.description ?? null,
      layout_json: db.layout_json ? JSON.parse(db.layout_json) : null,
      owner: db.owner,
      share_token: db.share_token,
      refresh_interval_sec: db.refresh_interval_sec ?? 0,
      cache_ttl_sec: db.cache_ttl_sec ?? 300,
      grid_columns: db.grid_columns ?? 24,
      show_card_type: db.show_card_type ?? false,
      cohort_filter: parseDashboardCohortFilter(db.cohort_filter_json),
      folder_id: db.folder_id ?? null,
      locked: db.locked ?? false,
      visibility: db.visibility ?? 'project',
      created_at: db.created_at,
      updated_at: db.updated_at,
    };
  }
}
