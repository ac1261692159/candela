/**
 * 主体视角的看板授权（phase: clklog-analytics-rbac-v6 §5.1）。
 *
 * 边界必须锁死：只增删**本主体**在「本项目文件夹/看板」上的 `view` 行——
 * 其他主体的授权、本主体的 `edit` 行、以及界面上看不见的历史行都不动。
 */
import { AssetPolicyService } from '../../src/modules/iam/asset-policy.service';

function build() {
  const prisma: Record<string, unknown> = {
    saDashboardFolder: { findMany: jest.fn().mockResolvedValue([{ folder_id: 'f1' }, { folder_id: 'f2' }]) },
    dashboard: { findMany: jest.fn().mockResolvedValue([{ db_id: 'd1' }]) },
    saAssetAcl: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  const service = new AssetPolicyService(prisma as never);
  return { service, prisma: prisma as {
    saAssetAcl: { findMany: jest.Mock; deleteMany: jest.Mock; createMany: jest.Mock };
  } };
}

describe('主体视角看板授权（rbac-v6）', () => {
  it('新增勾选资产；删除未勾选的本主体 view 行；历史孤儿行与 edit 行都不动', async () => {
    const { service, prisma } = build();
    prisma.saAssetAcl.findMany.mockResolvedValue([
      { id: 'acl-old-view', asset_type: 'dashboard', asset_id: 'd1', perm: 'view' }, // 本主体旧 view 且未勾 → 删
      { id: 'acl-edit', asset_type: 'folder', asset_id: 'f2', perm: 'edit' }, // 本主体 edit → 保留
      { id: 'acl-orphan', asset_type: 'dashboard', asset_id: 'gone', perm: 'view' }, // 已删资产 → 界面看不见，保留
    ]);

    await service.replaceSubjectViewGrants('clklogapp', 'group', 'g1', ['f1']);

    expect(prisma.saAssetAcl.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['acl-old-view'] } } });
    expect(prisma.saAssetAcl.createMany).toHaveBeenCalledWith({
      data: [
        {
          project_name: 'clklogapp',
          asset_type: 'folder',
          asset_id: 'f1',
          subject_type: 'group',
          subject_id: 'g1',
          perm: 'view',
        },
      ],
    });
  });

  it('忽略不可授权的 id（卡片 id / 跨项目 id）', async () => {
    const { service, prisma } = build();
    await service.replaceSubjectViewGrants('clklogapp', 'user', 'u1', ['d1', 'card-1', 'other-project-db']);
    expect(prisma.saAssetAcl.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ asset_type: 'dashboard', asset_id: 'd1', subject_type: 'user' })],
    });
  });

  it('已勾选且已存在时既不删也不重复插入', async () => {
    const { service, prisma } = build();
    prisma.saAssetAcl.findMany.mockResolvedValue([
      { id: 'acl-keep', asset_type: 'dashboard', asset_id: 'd1', perm: 'view' },
    ]);
    await service.replaceSubjectViewGrants('clklogapp', 'user', 'u1', ['d1']);
    expect(prisma.saAssetAcl.deleteMany).not.toHaveBeenCalled();
    expect(prisma.saAssetAcl.createMany).not.toHaveBeenCalled();
  });

  it('listSubjectGrants 只返回文件夹与看板两类行', async () => {
    const { service, prisma } = build();
    prisma.saAssetAcl.findMany.mockResolvedValue([
      { asset_type: 'folder', asset_id: 'f1', perm: 'view' },
      { asset_type: 'card', asset_id: 'c1', perm: 'edit' },
      { asset_type: 'dashboard', asset_id: 'd1', perm: 'edit' },
    ]);
    const rows = await service.listSubjectGrants('clklogapp', 'group', 'g1');
    expect(rows).toEqual([
      { asset_type: 'folder', asset_id: 'f1', perm: 'view' },
      { asset_type: 'dashboard', asset_id: 'd1', perm: 'edit' },
    ]);
  });
});
