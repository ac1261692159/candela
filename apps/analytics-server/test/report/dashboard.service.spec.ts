/**
 * DashboardService 单测（RBAC v2 / AssetPolicy）。
 */
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { DashboardService } from '../../src/modules/report/dashboard.service';
import { DashboardRepository } from '../../src/modules/report/dashboard.repository';
import { AssetPolicyService } from '../../src/modules/iam/asset-policy.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';
import type { AuthUser } from '../../src/modules/auth/auth.service';
import { emptyScope, type IamContext } from '../../src/modules/iam/iam.types';

describe('DashboardService', () => {
  let service: DashboardService;
  let repo: {
    findMany: jest.Mock;
    findById: jest.Mock;
    findByName: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    findDetail: jest.Mock;
    findDetailByShareToken: jest.Mock;
  };
  let policy: {
    loadDashboard: jest.Mock;
    assert: jest.Mock;
    canUpdate: jest.Mock;
    effectivelyLocked: jest.Mock;
    hasViewGrant: jest.Mock;
    grantCount: jest.Mock;
  };
  let prisma: { saAssetAcl: { findMany: jest.Mock; groupBy: jest.Mock }; saDashboardFolder: { findFirst: jest.Mock; findMany: jest.Mock } };

  const analyst: AuthUser = { id: 'u1', username: 'a1', display_name: null, platform_role: 'none' };
  const iamAnalyst: IamContext = {
    platform_role: 'none',
    member: true,
    role_key: 'analyst',
    permissions: new Set(['dashboard.view', 'dashboard.view_all', 'dashboard.edit']),
    data_scope: emptyScope(false),
    group_ids: [],
  };
  const iamAdmin: IamContext = {
    platform_role: 'none',
    member: true,
    role_key: 'project_owner',
    permissions: new Set(['dashboard.view', 'dashboard.view_all', 'dashboard.edit', 'asset.lock']),
    data_scope: emptyScope(true),
    group_ids: [],
  };
  /** rbac-v5：普通成员默认没有 view_all，只能看被授权的与自己建的 */
  const member: AuthUser = { id: 'u2', username: 'm1', display_name: null, platform_role: 'none' };
  const iamMember: IamContext = {
    platform_role: 'none',
    member: true,
    role_key: 'member',
    permissions: new Set(['dashboard.view', 'dashboard.filter']),
    data_scope: emptyScope(false),
    group_ids: ['g-member'],
  };

  const db = {
    db_id: 'd1',
    project_name: 'clklogapp',
    name: '看板A',
    layout_json: null,
    owner: 'u1',
    share_token: null,
    created_at: new Date(),
    updated_at: new Date(),
    folder_id: null,
    locked: false,
    visibility: 'project',
    _count: { dashboard_cards: 2 },
  };

  beforeEach(async () => {
    repo = {
      findMany: jest.fn(),
      findById: jest.fn(),
      findByName: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findDetail: jest.fn(),
      findDetailByShareToken: jest.fn(),
    };
    policy = {
      loadDashboard: jest.fn().mockResolvedValue({ type: 'dashboard', id: 'd1', ownerId: 'u1', locked: false, folderIds: [] }),
      assert: jest.fn().mockResolvedValue(undefined),
      canUpdate: jest.fn().mockResolvedValue(true),
      effectivelyLocked: jest.fn().mockReturnValue(false),
      hasViewGrant: jest.fn().mockResolvedValue(false),
      grantCount: jest.fn().mockResolvedValue(0),
    };
    const prismaMock = {
      saAssetAcl: { findMany: jest.fn().mockResolvedValue([]), groupBy: jest.fn().mockResolvedValue([]) },
      saDashboardFolder: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    };
    prisma = prismaMock;
    const moduleRef = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: DashboardRepository, useValue: repo },
        { provide: AssetPolicyService, useValue: policy },
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    service = moduleRef.get(DashboardService);
  });

  it('list 不再按 owner 过滤（view_all）', async () => {
    repo.findMany.mockResolvedValue([db]);
    const res = await service.list('clklogapp', analyst, iamAnalyst);
    expect(res).toHaveLength(1);
    expect(repo.findMany).toHaveBeenCalledWith('clklogapp');
  });

  it('rbac-v5：无 view_all 且无授权时看不到别人的看板，但自己建的始终可见', async () => {
    repo.findMany.mockResolvedValue([{ ...db, db_id: 'others', owner: 'u1' }, { ...db, db_id: 'mine', owner: 'u2' }]);
    const res = await service.list('clklogapp', member, iamMember);
    expect(res.map((r) => r.db_id)).toEqual(['mine']);
  });

  it('rbac-v5：看板级 view 授权（含按组授权）即可见', async () => {
    repo.findMany.mockResolvedValue([{ ...db, db_id: 'granted', owner: 'u1' }]);
    prisma.saAssetAcl.findMany.mockResolvedValue([{ asset_type: 'dashboard', asset_id: 'granted' }]);
    const res = await service.list('clklogapp', member, iamMember);
    expect(res.map((r) => r.db_id)).toEqual(['granted']);
    expect(prisma.saAssetAcl.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // rbac-v6：edit 也纳入可见判定
        where: expect.objectContaining({ perm: { in: ['view', 'edit'] }, subject_id: { in: ['u2', 'g-member'] } }),
      }),
    );
  });

  it('rbac-v6：只被授 edit 的看板也可见（edit 蕴含 view）', async () => {
    repo.findMany.mockResolvedValue([{ ...db, db_id: 'edit-only', owner: 'u1' }]);
    prisma.saAssetAcl.findMany.mockResolvedValue([{ asset_type: 'dashboard', asset_id: 'edit-only' }]);
    const res = await service.list('clklogapp', member, iamMember);
    expect(res.map((r) => r.db_id)).toEqual(['edit-only']);
    expect(prisma.saAssetAcl.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ perm: { in: ['view', 'edit'] } }) }),
    );
  });

  it('rbac-v5：文件夹级 view 授权覆盖其内看板（含子文件夹）', async () => {
    repo.findMany.mockResolvedValue([
      { ...db, db_id: 'inChild', owner: 'u1', folder_id: 'f-child' },
      { ...db, db_id: 'elsewhere', owner: 'u1', folder_id: 'f-other' },
    ]);
    prisma.saAssetAcl.findMany.mockResolvedValue([{ asset_type: 'folder', asset_id: 'f-root' }]);
    prisma.saDashboardFolder.findMany.mockResolvedValue([
      { folder_id: 'f-root', parent_id: null },
      { folder_id: 'f-child', parent_id: 'f-root' },
      { folder_id: 'f-other', parent_id: null },
    ]);
    const res = await service.list('clklogapp', member, iamMember);
    expect(res.map((r) => r.db_id)).toEqual(['inChild']);
  });

  it('create owner = 当前用户 id', async () => {
    repo.create.mockResolvedValue({ ...db, db_id: 'new-id' });
    await service.create({ name: '新看板' }, 'clklogapp', analyst);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ project_name: 'clklogapp', owner: 'u1', name: '新看板' }),
    );
  });

  it('update 走 AssetPolicy', async () => {
    repo.findById.mockResolvedValue(db);
    await service.update('d1', 'clklogapp', analyst, iamAnalyst, { name: 'x' });
    expect(policy.assert).toHaveBeenCalledWith('u1', iamAnalyst, 'update', expect.anything());
  });

  it('update 不存在抛 NotFound', async () => {
    policy.loadDashboard.mockRejectedValue(new NotFoundException('看板不存在: nope'));
    await expect(service.update('nope', 'clklogapp', analyst, iamAnalyst, { name: 'x' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('delete 管理员可删他人资产（Policy allow）', async () => {
    repo.delete.mockResolvedValue({ count: 1 });
    const res = await service.delete('d1', 'clklogapp', analyst, iamAdmin);
    expect(res.deleted).toBe(1);
    expect(policy.assert).toHaveBeenCalledWith('u1', iamAdmin, 'delete', expect.anything());
  });
});
