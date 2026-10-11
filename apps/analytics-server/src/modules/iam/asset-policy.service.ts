import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { decideAssetWrite, type AssetDecision } from './asset-policy-decide';
import { isProjectAdminRole } from './iam-evaluate';
import type { AssetAction, AssetType, IamContext } from './iam.types';
import { conflict, forbidden, notFound } from '../../i18n/domain-error';
import { membershipExpired } from './membership-expiry';

export interface LoadedAsset {
  type: AssetType;
  id: string;
  ownerId: string;
  locked: boolean;
  folderId?: string | null;
  folderLocked?: boolean;
  parentFolderLocked?: boolean;
  folderIds: string[];
}

export interface AssetAclGrant {
  subject_type: 'user' | 'group';
  subject_id: string;
  perm: 'view' | 'edit';
}

@Injectable()
export class AssetPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async assert(
    userId: string,
    ctx: IamContext,
    action: AssetAction,
    asset: LoadedAsset,
    opts?: { locking?: boolean; grantingEdit?: boolean },
  ): Promise<void> {
    const decision = await this.decide(userId, ctx, action, asset, opts);
    throwIfDecision(decision);
  }

  async canUpdate(userId: string, ctx: IamContext, asset: LoadedAsset): Promise<boolean> {
    return (await this.decide(userId, ctx, 'update', asset)) === 'allow';
  }

  async decide(
    userId: string,
    ctx: IamContext,
    action: AssetAction,
    asset: LoadedAsset,
    opts?: { locking?: boolean; grantingEdit?: boolean },
  ): Promise<AssetDecision> {
    const isProjectAdmin = isProjectAdminRole(ctx.role_key);
    const hasEditGrant = await this.hasEditGrant(userId, ctx, asset);
    const hasEditAcls =
      action === 'lock' && opts?.locking ? await this.hasEditAclsOnTree(asset) : false;
    return decideAssetWrite({
      action,
      locking: opts?.locking,
      grantingEdit: opts?.grantingEdit,
      isProjectAdmin,
      hasLockPerm: ctx.permissions.has('asset.lock'),
      hasGrantPerm: ctx.permissions.has('asset.grant'),
      isCreator: asset.ownerId === userId,
      effectivelyLocked: this.effectivelyLocked(asset),
      hasEditGrant,
      hasEditAcls,
    });
  }

  effectivelyLocked(asset: LoadedAsset): boolean {
    if (asset.type === 'card' || asset.type === 'cohort' || asset.type === 'tag') {
      return asset.locked;
    }
    return Boolean(asset.locked || asset.folderLocked || asset.parentFolderLocked);
  }

  async hasEditGrant(userId: string, ctx: IamContext, asset: LoadedAsset): Promise<boolean> {
    if (asset.type === 'cohort' || asset.type === 'tag') return false;
    const ids: { type: string; id: string }[] = [{ type: asset.type, id: asset.id }];
    if (asset.type === 'dashboard') {
      for (const fid of asset.folderIds) ids.push({ type: 'folder', id: fid });
    }
    if (asset.type === 'folder' && asset.folderIds.length > 1) {
      const parentId = asset.folderIds.find((id) => id !== asset.id);
      if (parentId) ids.push({ type: 'folder', id: parentId });
    }
    const subjectIds = [userId, ...ctx.group_ids];
    const rows = await this.prisma.saAssetAcl.findMany({
      where: {
        perm: 'edit',
        subject_id: { in: subjectIds },
        OR: ids.map((item) => ({ asset_type: item.type, asset_id: item.id })),
      },
    });
    return rows.length > 0;
  }

  /**
   * 看板可见授权：看板级 `view`，或（rbac-v5 起）其所在文件夹及父文件夹上的 `view`。
   * 文件夹层级最多两层，故只需向上取一级。
   * rbac-v6：`edit` 蕴含可见——被授编辑权的分析师在 v5 收回 view_all 后出现「能改却看不到」，
   * 故两类 perm 都算命中。
   */
  async hasViewGrant(userId: string, ctx: IamContext, assetId: string): Promise<boolean> {
    const subjectIds = [userId, ...ctx.group_ids];
    const row = await this.prisma.saAssetAcl.findFirst({
      where: {
        asset_type: 'dashboard',
        asset_id: assetId,
        perm: { in: ['view', 'edit'] },
        subject_id: { in: subjectIds },
      },
    });
    if (row) return true;
    const dashboard = await this.prisma.dashboard.findFirst({
      where: { db_id: assetId },
      select: { folder_id: true },
    });
    if (!dashboard?.folder_id) return false;
    const folder = await this.prisma.saDashboardFolder.findFirst({
      where: { folder_id: dashboard.folder_id },
      select: { parent_id: true },
    });
    const folderIds = [dashboard.folder_id, ...(folder?.parent_id ? [folder.parent_id] : [])];
    const folderRow = await this.prisma.saAssetAcl.findFirst({
      where: {
        asset_type: 'folder',
        asset_id: { in: folderIds },
        perm: { in: ['view', 'edit'] },
        subject_id: { in: subjectIds },
      },
    });
    return Boolean(folderRow);
  }

  async grantCount(assetType: string, assetId: string): Promise<number> {
    return this.prisma.saAssetAcl.count({
      where: { asset_type: assetType, asset_id: assetId, perm: 'edit' },
    });
  }

  async loadFolder(project: string, folderId: string): Promise<LoadedAsset> {
    const folder = await this.prisma.saDashboardFolder.findFirst({
      where: { folder_id: folderId, project_name: project },
    });
    if (!folder) {
      throw notFound({
        code: 'iam.asset.folderNotFound',
        messageKey: 'iam:error.asset.folderNotFound',
        message: '文件夹不存在',
      });
    }
    const parent =
      folder.parent_id && folder.parent_id !== ''
        ? await this.prisma.saDashboardFolder.findFirst({
            where: { folder_id: folder.parent_id, project_name: project },
          })
        : null;
    return {
      type: 'folder',
      id: folder.folder_id,
      ownerId: '',
      locked: folder.locked,
      folderLocked: folder.locked,
      parentFolderLocked: parent?.locked ?? false,
      folderIds: parent ? [folder.folder_id, parent.folder_id] : [folder.folder_id],
    };
  }

  async loadDashboard(project: string, dbId: string): Promise<LoadedAsset & { visibility: string }> {
    const db = await this.prisma.dashboard.findFirst({
      where: { db_id: dbId, project_name: project },
    });
    if (!db) {
      throw notFound({
        code: 'iam.asset.dashboardNotFound',
        messageKey: 'iam:error.asset.dashboardNotFound',
        params: { id: dbId },
        message: `看板不存在: ${dbId}`,
      });
    }
    const chain = await this.folderChain(project, db.folder_id);
    return {
      type: 'dashboard',
      id: db.db_id,
      ownerId: db.owner,
      locked: db.locked,
      folderId: db.folder_id,
      folderLocked: chain.folderLocked,
      parentFolderLocked: chain.parentFolderLocked,
      folderIds: chain.folderIds,
      visibility: db.visibility,
    };
  }

  async loadCard(project: string, cardId: string): Promise<LoadedAsset> {
    const card = await this.prisma.card.findFirst({
      where: { card_id: cardId, project_name: project },
    });
    if (!card) {
      throw notFound({
        code: 'iam.asset.cardNotFound',
        messageKey: 'iam:error.asset.cardNotFound',
        params: { id: cardId },
        message: `卡片不存在: ${cardId}`,
      });
    }
    return {
      type: 'card',
      id: card.card_id,
      ownerId: card.owner,
      locked: card.locked,
      folderIds: [],
    };
  }

  async loadCohort(project: string, id: string): Promise<LoadedAsset> {
    const row = await this.prisma.metaUserCohort.findFirst({
      where: { cohort_id: id, project_name: project },
    });
    if (!row) {
      throw notFound({
        code: 'iam.asset.cohortNotFound',
        messageKey: 'iam:error.asset.cohortNotFound',
        message: '分群不存在',
      });
    }
    return {
      type: 'cohort',
      id: row.cohort_id,
      ownerId: row.owner,
      locked: row.locked,
      folderIds: [],
    };
  }

  async loadTag(project: string, id: string): Promise<LoadedAsset> {
    const row = await this.prisma.metaUserTag.findFirst({
      where: { tag_id: id, project_name: project },
    });
    if (!row) {
      throw notFound({
        code: 'iam.asset.tagNotFound',
        messageKey: 'iam:error.asset.tagNotFound',
        message: '标签不存在',
      });
    }
    return {
      type: 'tag',
      id: row.tag_id,
      ownerId: row.owner,
      locked: row.locked,
      folderIds: [],
    };
  }

  async replaceAcl(
    userId: string,
    ctx: IamContext,
    project: string,
    asset: LoadedAsset,
    grants: AssetAclGrant[],
  ): Promise<void> {
    const grantingEdit = grants.some((g) => g.perm === 'edit');
    await this.assert(userId, ctx, 'grant', asset, { grantingEdit });
    for (const g of grants) {
      if (g.perm === 'edit') await this.assertEditGrantTarget(project, g);
      // rbac-v5：文件夹上的 view 授权覆盖其内全部看板（含之后新建的）
      if (g.perm === 'view' && asset.type !== 'dashboard' && asset.type !== 'folder') {
        throw forbidden({
          code: 'iam.asset.viewGrantDashboardOnly',
          messageKey: 'iam:error.asset.viewGrantDashboardOnly',
          message: '仅看板与文件夹可授予查看',
        });
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.saAssetAcl.deleteMany({
        where: { project_name: project, asset_type: asset.type, asset_id: asset.id },
      });
      if (grants.length === 0) return;
      await tx.saAssetAcl.createMany({
        data: grants.map((g) => ({
          project_name: project,
          asset_type: asset.type,
          asset_id: asset.id,
          subject_type: g.subject_type,
          subject_id: g.subject_id,
          perm: g.perm,
        })),
      });
    });
  }

  async listAcl(project: string, assetType: string, assetId: string) {
    return this.prisma.saAssetAcl.findMany({
      where: { project_name: project, asset_type: assetType, asset_id: assetId },
      orderBy: { created_at: 'asc' },
    });
  }

  /**
   * 主体视角的看板授权（rbac-v6）：某成员或成员组在文件夹 / 看板上的直接 ACL 行。
   * 用于「这个成员/组能看到哪些看板」的反查与反向授权。
   */
  async listSubjectGrants(project: string, subjectType: 'user' | 'group', subjectId: string) {
    const rows = await this.prisma.saAssetAcl.findMany({
      where: { project_name: project, subject_type: subjectType, subject_id: subjectId },
      select: { asset_type: true, asset_id: true, perm: true },
      orderBy: { created_at: 'asc' },
    });
    return rows.filter((r) => r.asset_type === 'folder' || r.asset_type === 'dashboard');
  }

  /**
   * 反向授权：把某主体在给定资产集合上的 `view` 行置为「存在」，其余**该主体的** `view` 行删除。
   *
   * 边界（单测锁死）：只动该主体的 `view` 行——其他主体在同一资产上的授权、以及该主体自己的
   * `edit` 行一律不动；资产 id 必须在当前项目的文件夹/看板集合内，其余忽略。
   */
  async replaceSubjectViewGrants(
    project: string,
    subjectType: 'user' | 'group',
    subjectId: string,
    assetIds: string[],
  ): Promise<void> {
    const [folders, dashboards, current] = await Promise.all([
      this.prisma.saDashboardFolder.findMany({ where: { project_name: project }, select: { folder_id: true } }),
      this.prisma.dashboard.findMany({ where: { project_name: project }, select: { db_id: true } }),
      this.prisma.saAssetAcl.findMany({
        where: { project_name: project, subject_type: subjectType, subject_id: subjectId },
        select: { id: true, asset_type: true, asset_id: true, perm: true },
      }),
    ]);

    const grantable = new Map<string, string>([
      ...folders.map((f) => [f.folder_id, 'folder'] as const),
      ...dashboards.map((d) => [d.db_id, 'dashboard'] as const),
    ]);
    const wanted = new Set(assetIds.filter((id) => grantable.has(id)));

    const currentView = current.filter(
      (r) => r.perm === 'view' && (r.asset_type === 'folder' || r.asset_type === 'dashboard'),
    );
    const currentIds = new Set(currentView.map((r) => r.asset_id));
    // 只清理「编辑器里看得见」的资产：不在本项目文件夹/看板集合内的历史行（例如已删资产）不动，
    // 因为它们在界面上无法被取消勾选。
    const removeIds = currentView
      .filter((r) => grantable.has(r.asset_id) && !wanted.has(r.asset_id))
      .map((r) => r.id);
    const addIds = [...wanted].filter((id) => !currentIds.has(id));

    await this.prisma.$transaction(async (tx) => {
      if (removeIds.length) await tx.saAssetAcl.deleteMany({ where: { id: { in: removeIds } } });
      if (addIds.length) {
        await tx.saAssetAcl.createMany({
          data: addIds.map((assetId) => ({
            project_name: project,
            asset_type: grantable.get(assetId) as string,
            asset_id: assetId,
            subject_type: subjectType,
            subject_id: subjectId,
            perm: 'view',
          })),
        });
      }
    });
  }

  private async folderChain(
    project: string,
    folderId: string | null,
  ): Promise<{ folderLocked: boolean; parentFolderLocked: boolean; folderIds: string[] }> {
    if (!folderId) {
      return { folderLocked: false, parentFolderLocked: false, folderIds: [] };
    }
    const folder = await this.prisma.saDashboardFolder.findFirst({
      where: { folder_id: folderId, project_name: project },
    });
    if (!folder) return { folderLocked: false, parentFolderLocked: false, folderIds: [] };
    const parent =
      folder.parent_id && folder.parent_id !== ''
        ? await this.prisma.saDashboardFolder.findFirst({
            where: { folder_id: folder.parent_id, project_name: project },
          })
        : null;
    return {
      folderLocked: folder.locked,
      parentFolderLocked: parent?.locked ?? false,
      folderIds: parent ? [folder.folder_id, parent.folder_id] : [folder.folder_id],
    };
  }

  private async hasEditAclsOnTree(asset: LoadedAsset): Promise<boolean> {
    if (asset.type === 'folder') {
      const childFolders = await this.prisma.saDashboardFolder.findMany({
        where: { parent_id: asset.id },
        select: { folder_id: true },
      });
      const folderIds = [asset.id, ...childFolders.map((f) => f.folder_id)];
      const dashboards = await this.prisma.dashboard.findMany({
        where: { folder_id: { in: folderIds } },
        select: { db_id: true },
      });
      const or = [
        ...folderIds.map((id) => ({ asset_type: 'folder', asset_id: id, perm: 'edit' })),
        ...dashboards.map((d) => ({ asset_type: 'dashboard', asset_id: d.db_id, perm: 'edit' })),
      ];
      const n = await this.prisma.saAssetAcl.count({ where: { OR: or } });
      return n > 0;
    }
    const n = await this.prisma.saAssetAcl.count({
      where: { asset_type: asset.type, asset_id: asset.id, perm: 'edit' },
    });
    return n > 0;
  }

  private async assertEditGrantTarget(project: string, grant: AssetAclGrant): Promise<void> {
    if (grant.subject_type === 'user') {
      const member = await this.prisma.saProjectMember.findUnique({
        where: { project_name_user_id: { project_name: project, user_id: grant.subject_id } },
      });
      // account-lifecycle-v3：成员行到期视为非成员
      if (!member || membershipExpired(member.expires_at) || member.role_key !== 'analyst') {
        throw forbidden({
          code: 'iam.asset.editGrantAnalystOnly',
          messageKey: 'iam:error.asset.editGrantAnalystOnly',
          message: '编辑授权只能授给本项目分析师',
        });
      }
      return;
    }
    const group = await this.prisma.saMemberGroup.findFirst({
      where: { id: grant.subject_id, project_name: project },
    });
    if (!group || group.role_key !== 'analyst') {
      throw forbidden({
        code: 'iam.asset.editGrantAnalystGroupOnly',
        messageKey: 'iam:error.asset.editGrantAnalystGroupOnly',
        message: '编辑授权只能授给角色为分析师的成员组',
      });
    }
  }
}

function throwIfDecision(decision: AssetDecision): void {
  if (decision === 'allow') return;
  if (decision === 'conflict_lock') {
    throw conflict({
      code: 'iam.asset.withdrawGrantBeforeLock',
      messageKey: 'iam:error.asset.withdrawGrantBeforeLock',
      message: '先撤回编辑授权再锁定',
    });
  }
  if (decision === 'conflict_grant') {
    throw conflict({
      code: 'iam.asset.unlockBeforeGrant',
      messageKey: 'iam:error.asset.unlockBeforeGrant',
      message: '先解锁再授权',
    });
  }
  throw forbidden({
    code: 'iam.forbidden',
    messageKey: 'iam:error.forbidden',
    message: '无权访问该资源',
  });
}
