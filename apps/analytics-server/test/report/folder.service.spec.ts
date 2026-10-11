import { DomainError } from '../../src/i18n/domain-error';
import { FolderService } from '../../src/modules/report/folder.service';

describe('FolderService', () => {
  const policy = {
    loadFolder: jest.fn().mockResolvedValue({}),
    assert: jest.fn().mockResolvedValue(undefined),
    listAcl: jest.fn(),
    replaceAcl: jest.fn(),
  };

  it('rejects creating a third-level folder', async () => {
    const prisma = {
      saDashboardFolder: {
        findFirst: jest.fn().mockResolvedValue({ folder_id: 'child', parent_id: 'root' }),
        create: jest.fn(),
      },
    };
    const svc = new FolderService(prisma as never, policy as never);
    const rejected = svc.create('clklogapp', { name: 'too-deep', parent_id: 'child' });
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 400, errorCode: 'report.folder.tooDeep' });
    expect(prisma.saDashboardFolder.create).not.toHaveBeenCalled();
  });

  it('rejects moving a folder into itself', async () => {
    const prisma = {
      saDashboardFolder: {
        findFirst: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
    };
    const svc = new FolderService(prisma as never, policy as never);
    const rejected = svc.patch('clklogapp', 'fold_1', 'u1', {} as never, { parent_id: 'fold_1' });
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 400, errorCode: 'report.folder.moveIntoSelf' });
    expect(prisma.saDashboardFolder.update).not.toHaveBeenCalled();
  });

  it('rejects nesting a folder that still has children', async () => {
    const prisma = {
      saDashboardFolder: {
        findFirst: jest.fn().mockResolvedValue({ folder_id: 'root2', parent_id: '' }),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn(),
      },
    };
    const svc = new FolderService(prisma as never, policy as never);
    const rejected = svc.patch('clklogapp', 'fold_1', 'u1', {} as never, { parent_id: 'root2' });
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 400, errorCode: 'report.folder.moveWithChildren' });
    expect(prisma.saDashboardFolder.update).not.toHaveBeenCalled();
  });

  it('rejects deleting a folder that still has dashboards', async () => {
    const prisma = {
      saDashboardFolder: {
        count: jest.fn().mockResolvedValue(0),
        delete: jest.fn(),
      },
      dashboard: { count: jest.fn().mockResolvedValue(2) },
    };
    const svc = new FolderService(prisma as never, policy as never);
    const rejected = svc.remove('clklogapp', 'fold_1', 'u1', {} as never);
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 409, errorCode: 'report.folder.notEmpty' });
    expect(prisma.saDashboardFolder.delete).not.toHaveBeenCalled();
  });
});
