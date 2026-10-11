import { DomainError } from '../../i18n/domain-error';
import { DatatableImportService } from './datatable-import.service';
import { DatatableLease } from './datatable-lease';

// 与 map spec 相同：断掉 clickhouse.service → configuration.ts 的模块加载链
jest.mock('./datatable-rows.service', () => ({ DatatableRowsService: class {} }));
jest.mock('../shared/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('./datatable-map.service', () => ({
  DatatableMapService: class {},
  resolveLabelField: () => 'name',
}));

const CSV = 'id,name\n1,a\n';
const SAVED = [
  {
    field_key: 'id',
    data_type: 'number',
    display_name: 'id',
    is_primary: true,
    sort_order: 0,
  },
  {
    field_key: 'name',
    data_type: 'string',
    display_name: 'name',
    is_primary: false,
    sort_order: 1,
  },
];

function makeImport(options: {
  acquire?: number | null;
  publish?: boolean;
  auditThrow?: boolean;
}) {
  const dropVersion = jest.fn(async () => undefined);
  const dropOtherVersions = jest.fn(async () => undefined);
  const writeVersion = jest.fn(async () => undefined);
  const release = jest.fn(async () => undefined);
  const prisma = {
    metaDatatable: {
      findFirst: async () => ({
        id: 'dt_1',
        project_name: 'clklogapp',
        active_version: 1,
        status: 'active',
      }),
    },
    metaDatatableColumn: { findMany: async () => SAVED },
    metaDatatableImport: {
      create: async () => {
        if (options.auditThrow) throw new Error('audit down');
        return { id: 'dti_1' };
      },
    },
    card: { findMany: async () => [] },
    cardCache: { updateMany: async () => ({ count: 0 }) },
  };
  const rows = {
    ensureTable: async () => undefined,
    readSnapshot: async () => new Map([['0', '{"name":"old"}']]),
    writeVersion,
    dropVersion,
    dropOtherVersions,
  };
  const lease = {
    acquire: async () => (options.acquire === undefined ? 2 : options.acquire),
    heartbeat: async () => undefined,
    publish: async () => options.publish !== false,
    release,
  };
  const maps = { invalidateProject: jest.fn() };
  const service = new DatatableImportService(
    prisma as never,
    rows as never,
    lease as never,
    maps as never,
  );
  return { service, dropVersion, dropOtherVersions, writeVersion, release };
}

describe('DatatableLease', () => {
  it('抢租约失败（影响行数 ≠ 1）返回 null，调用方应 409', async () => {
    const lease = new DatatableLease({
      $executeRaw: async () => 0,
      metaDatatable: { findFirst: async () => null },
    } as never);
    expect(await lease.acquire('dt_1', 'clklogapp', 'owner-a')).toBeNull();
  });

  it('抢租约成功返回 pending_version', async () => {
    const lease = new DatatableLease({
      $executeRaw: async () => 1,
      metaDatatable: { findFirst: async () => ({ pending_version: 4 }) },
    } as never);
    expect(await lease.acquire('dt_1', 'clklogapp', 'owner-a')).toBe(4);
  });
});

describe('DatatableImportService 写入协议', () => {
  it('表头名或顺序不一致时拒绝更新，不写版本', async () => {
    const { service, writeVersion } = makeImport({});
    await expect(
      service.update('clklogapp', 'u1', 'dt_1', { csv_text: 'name,id\n1,a\n', mode: 'replace' }),
    ).rejects.toThrow(/表头与当前表结构不一致/);
    expect(writeVersion).not.toHaveBeenCalled();
  });

  it('抢不到租约时 409，不写 pending', async () => {
    const { service, writeVersion } = makeImport({ acquire: null });
    const rejected = service.update('clklogapp', 'u1', 'dt_1', { csv_text: CSV, mode: 'replace' });
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 409, errorCode: 'datatable.table.busy' });
    expect(writeVersion).not.toHaveBeenCalled();
  });

  it('写 pending 后 publish 失败：active 不动，只删 pending', async () => {
    const { service, dropVersion, dropOtherVersions, release } = makeImport({ publish: false });
    const rejected = service.update('clklogapp', 'u1', 'dt_1', { csv_text: CSV, mode: 'replace' });
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 409, errorCode: 'datatable.table.busy' });
    expect(dropVersion).toHaveBeenCalledWith('clklogapp', 'dt_1', 2);
    expect(dropOtherVersions).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it('publish 成功后审计失败：不删生效版本', async () => {
    const { service, dropVersion, dropOtherVersions, writeVersion } = makeImport({ auditThrow: true });
    const result = await service.update('clklogapp', 'u1', 'dt_1', { csv_text: CSV, mode: 'replace' });
    expect(result.added).toBe(1);
    expect(writeVersion).toHaveBeenCalled();
    expect(dropVersion).not.toHaveBeenCalled();
    expect(dropOtherVersions).not.toHaveBeenCalled();
  });
});
