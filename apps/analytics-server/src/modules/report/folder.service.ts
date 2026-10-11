import { Injectable } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { badRequest, conflict, notFound } from '../../i18n/domain-error';
import { PrismaService } from '../shared/prisma.service';
import { AssetPolicyService } from '../iam/asset-policy.service';
import type { IamContext } from '../iam/iam.types';
import type { AssetAclGrant } from '../iam/asset-policy.service';

@Injectable()
export class FolderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: AssetPolicyService,
  ) {}

  async tree(project: string) {
    const folders = await this.prisma.saDashboardFolder.findMany({
      where: { project_name: project },
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    });
    const counts = await this.prisma.dashboard.groupBy({
      by: ['folder_id'],
      where: { project_name: project },
      _count: { db_id: true },
    });
    const countMap = new Map(counts.map((c) => [c.folder_id ?? '', c._count.db_id]));
    const uncategorized = countMap.get('') ?? 0;
    const roots = folders.filter((f) => !f.parent_id || f.parent_id === '');
    return {
      uncategorized: { name: '未分组', dashboard_count: uncategorized },
      folders: roots.map((root) => ({
        ...this.toFolder(root, countMap.get(root.folder_id) ?? 0),
        children: folders
          .filter((c) => c.parent_id === root.folder_id)
          .map((c) => this.toFolder(c, countMap.get(c.folder_id) ?? 0)),
      })),
    };
  }

  async create(project: string, dto: { name: string; parent_id?: string | null }) {
    const parentId = dto.parent_id && dto.parent_id !== '' ? dto.parent_id : '';
    if (parentId) {
      const parent = await this.prisma.saDashboardFolder.findFirst({
        where: { folder_id: parentId, project_name: project },
      });
      if (!parent) {
        throw notFound({
          code: 'report.folder.parentNotFound',
          messageKey: 'report:error.folder.parentNotFound',
          message: '父文件夹不存在',
        });
      }
      if (parent.parent_id && parent.parent_id !== '') {
        throw badRequest({
          code: 'report.folder.tooDeep',
          messageKey: 'report:error.folder.tooDeep',
          message: '文件夹最多两层',
        });
      }
    }
    const name = dto.name.trim();
    if (!name) {
      throw badRequest({
        code: 'report.folder.nameRequired',
        messageKey: 'report:error.folder.nameRequired',
        message: '名称不能为空',
      });
    }
    return this.prisma.saDashboardFolder.create({
      data: {
        folder_id: `fold_${nanoid(10)}`,
        project_name: project,
        name,
        parent_id: parentId,
      },
    });
  }

  async patch(
    project: string,
    id: string,
    userId: string,
    ctx: IamContext,
    dto: { name?: string; parent_id?: string | null; sort_order?: number },
  ) {
    const asset = await this.policy.loadFolder(project, id);
    await this.policy.assert(userId, ctx, 'update', asset);
    const data: { name?: string; parent_id?: string; sort_order?: number } = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw badRequest({
          code: 'report.folder.nameRequired',
          messageKey: 'report:error.folder.nameRequired',
          message: '名称不能为空',
        });
      }
      data.name = name;
    }
    if (dto.parent_id !== undefined) {
      const parentId = dto.parent_id && dto.parent_id !== '' ? dto.parent_id : '';
      if (parentId === id) {
        throw badRequest({
          code: 'report.folder.moveIntoSelf',
          messageKey: 'report:error.folder.moveIntoSelf',
          message: '不能把文件夹移入自己',
        });
      }
      if (parentId) {
        const parent = await this.prisma.saDashboardFolder.findFirst({
          where: { folder_id: parentId, project_name: project },
        });
        if (!parent) {
          throw notFound({
            code: 'report.folder.parentNotFound',
            messageKey: 'report:error.folder.parentNotFound',
            message: '父文件夹不存在',
          });
        }
        if (parent.parent_id && parent.parent_id !== '') {
          throw badRequest({
            code: 'report.folder.tooDeep',
            messageKey: 'report:error.folder.tooDeep',
            message: '文件夹最多两层',
          });
        }
        const childCount = await this.prisma.saDashboardFolder.count({
          where: { parent_id: id, project_name: project },
        });
        if (childCount > 0) {
          throw badRequest({
            code: 'report.folder.moveWithChildren',
            messageKey: 'report:error.folder.moveWithChildren',
            message: '含子文件夹时不能移入另一层',
          });
        }
      }
      data.parent_id = parentId;
    }
    if (dto.sort_order !== undefined) data.sort_order = dto.sort_order;
    return this.prisma.saDashboardFolder.update({ where: { folder_id: id }, data });
  }

  async remove(project: string, id: string, userId: string, ctx: IamContext) {
    const asset = await this.policy.loadFolder(project, id);
    await this.policy.assert(userId, ctx, 'delete', asset);
    const childFolders = await this.prisma.saDashboardFolder.count({
      where: { parent_id: id, project_name: project },
    });
    const dashboards = await this.prisma.dashboard.count({ where: { folder_id: id } });
    if (childFolders + dashboards > 0) {
      throw conflict({
        code: 'report.folder.notEmpty',
        messageKey: 'report:error.folder.notEmpty',
        message: '文件夹非空，请先移出看板和子文件夹',
      });
    }
    await this.prisma.saDashboardFolder.delete({ where: { folder_id: id } });
    return { ok: true };
  }

  async lock(project: string, id: string, userId: string, ctx: IamContext, locked: boolean) {
    const asset = await this.policy.loadFolder(project, id);
    await this.policy.assert(userId, ctx, 'lock', asset, { locking: locked });
    await this.prisma.saDashboardFolder.update({ where: { folder_id: id }, data: { locked } });
    return { ok: true, locked };
  }

  async listAcl(project: string, id: string) {
    return this.policy.listAcl(project, 'folder', id);
  }

  async putAcl(project: string, id: string, userId: string, ctx: IamContext, grants: AssetAclGrant[]) {
    const asset = await this.policy.loadFolder(project, id);
    await this.policy.replaceAcl(userId, ctx, project, asset, grants);
    return { ok: true };
  }

  private toFolder(
    f: { folder_id: string; name: string; parent_id: string; locked: boolean; sort_order: number },
    dashboard_count: number,
  ) {
    return {
      folder_id: f.folder_id,
      name: f.name,
      parent_id: f.parent_id || null,
      locked: f.locked,
      sort_order: f.sort_order,
      dashboard_count,
    };
  }
}
