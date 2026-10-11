/**
 * 数据表绑定校验（PRD datatable-v2 A7 / CODE_HANDOVER DT-08）。
 *
 * 2026-09-15 生产实测：绑定一个项目中不存在的属性返回 201，文本键列绑数值属性也照样成功
 * ——后者会静默「0 命中」，用户以为数据没了。本 spec 锁住「存在性 + 类型同族」两道校验。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    __specConfigMock: true,
  },
}));

import { DomainError } from '../../src/i18n/domain-error';
import { DatatableService } from '../../src/modules/datatable/datatable.service';
import { DatatableRowsService } from '../../src/modules/datatable/datatable-rows.service';
import { DatatableImportService } from '../../src/modules/datatable/datatable-import.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';

const COLUMNS = [
  { field_key: 'goods_id', data_type: 'string', display_name: '商品ID' },
  { field_key: 'id', data_type: 'number', display_name: '自增ID' },
  { field_key: 'goods_name', data_type: 'string', display_name: '商品名' },
];

function harness(options: { props?: string[] } = {}) {
  const prisma = {
    metaDatatable: {
      findFirst: jest.fn(async () => ({ id: 'dt_1', project_name: 'demo', table_key: 'goods' })),
    },
    metaDatatableColumn: { findMany: jest.fn(async () => COLUMNS) },
    metaEventProperty: {
      findMany: jest.fn(async () =>
        options.props === undefined
          ? [{ data_type: 'string' }]
          : (options.props ?? []).map((data_type) => ({ data_type })),
      ),
    },
    metaDatatableBinding: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'dtb_new' })),
      update: jest.fn(async () => ({})),
    },
  } as unknown as PrismaService;
  const imports = { touchProject: jest.fn(async () => undefined) } as unknown as DatatableImportService;
  return new DatatableService(prisma, {} as DatatableRowsService, imports);
}

const dto = (over: Record<string, unknown> = {}) => ({
  target_type: 'event_property',
  target_prop: 'goods_id',
  key_column: 'goods_id',
  label_field: 'goods_name',
  ...over,
}) as never;

describe('数据表绑定校验', () => {
  it('属性不存在 → 400（不再静默创建）', async () => {
    const service = harness({ props: [] });
    await expect(service.createBinding('demo', 'u1', 'dt_1', dto({ target_prop: 'goods_num_total' })))
      .rejects.toThrow(/事件属性 goods_num_total 不存在/);
  });

  it('文本键列绑数值属性 → 400 类型不匹配（A7）', async () => {
    const service = harness({ props: ['number'] });
    await expect(service.createBinding('demo', 'u1', 'dt_1', dto({ target_prop: 'diamond_num' })))
      .rejects.toThrow(/类型不匹配.*diamond_num（声明类型 number）/);
  });

  it('数值键列绑数值属性 → 通过', async () => {
    const service = harness({ props: ['number'] });
    await expect(service.createBinding('demo', 'u1', 'dt_1', dto({ target_prop: 'diamond_num', key_column: 'id' })))
      .resolves.toMatchObject({ table_key: 'goods' });
  });

  it('文本键列绑文本属性 → 通过（既有正确用法不受影响）', async () => {
    const service = harness({ props: ['string'] });
    await expect(service.createBinding('demo', 'u1', 'dt_1', dto()))
      .resolves.toMatchObject({ table_key: 'goods' });
  });

  it('复杂类型（object/list）不可作键 → 400', async () => {
    const service = harness({ props: ['object'] });
    await expect(service.createBinding('demo', 'u1', 'dt_1', dto({ target_prop: 'some_obj' })))
      .rejects.toThrow(/类型不匹配/);
  });

  it('系统字段（event_name）跳过属性类型校验', async () => {
    const service = harness({ props: [] });
    await expect(service.createBinding('demo', 'u1', 'dt_1', dto({ target_type: 'event_name', target_prop: '#event_name' })))
      .resolves.toMatchObject({ table_key: 'goods' });
  });

  it('键列不存在 → 400（既有行为保持）', async () => {
    const service = harness({});
    await expect(service.createBinding('demo', 'u1', 'dt_1', dto({ key_column: 'nope' })))
      .rejects.toThrow(/join 键列 nope 不在数据表字段里/);
  });

  it('数据表不存在 → 404（既有行为保持）', async () => {
    const service = harness({});
    (service as unknown as { prisma: { metaDatatable: { findFirst: jest.Mock } } }).prisma.metaDatatable.findFirst
      .mockResolvedValueOnce(null);
    const rejected = service.createBinding('demo', 'u1', 'dt_x', dto());
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 404, errorCode: 'datatable.table.notFound' });
  });

  it('400 是 DomainError（不是 500）', async () => {
    const service = harness({ props: ['number'] });
    const rejected = service.createBinding('demo', 'u1', 'dt_1', dto({ target_prop: 'diamond_num' }));
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 400, errorCode: 'datatable.binding.typeMismatch' });
  });

  it('同一属性跨事件类型不一致（既有 number 又有 string）→ 文本键列仍放行', async () => {
    // 生产实测：state 在 10 个事件是 number、12 个是 string，取任意一条判断会误伤
    const service = harness({ props: ['number', 'string'] });
    await expect(service.createBinding('demo', 'u1', 'dt_1', dto({ target_prop: 'state', key_column: 'goods_id' })))
      .resolves.toMatchObject({ table_key: 'goods' });
  });

  it('属性全部声明为数值 → 文本键列仍拒绝（A7 主场景不受影响）', async () => {
    const service = harness({ props: ['number', 'number'] });
    await expect(service.createBinding('demo', 'u1', 'dt_1', dto({ target_prop: 'diamond_num' })))
      .rejects.toThrow(/类型不匹配/);
  });
});
