import { DatatableMapService } from './datatable-map.service';

// CI 上没有 .env：一旦加载真实 DatatableRowsService，就会经 `clickhouse.service` →
// `configuration.ts`（模块加载即读 YAML 并要求 CLICKHOUSE_PASSWORD 等环境变量）而整份套件
// 直接失败。用工厂 mock 断掉这条链路，让回归测试在任何环境都能跑（本地有 .env 也一样过）。
jest.mock('./datatable-rows.service', () => ({ DatatableRowsService: class {} }));
jest.mock('../shared/prisma.service', () => ({ PrismaService: class {} }));

type Column = {
  field_key: string;
  data_type: string;
  is_primary: boolean;
  display_name: string;
  sort_order: number;
};

/** 线上 goods 表结构（截取关键列）：首列自增 id，商品ID 在第二列，名称在 goods_name */
const COLUMNS: Column[] = [
  { field_key: 'id', data_type: 'number', is_primary: true, display_name: '自增ID', sort_order: 0 },
  { field_key: 'goods_id', data_type: 'string', is_primary: false, display_name: '商品ID', sort_order: 1 },
  { field_key: 'goods_name', data_type: 'string', is_primary: false, display_name: '商品名称', sort_order: 2 },
];

function build(options: {
  binding?: { key_column: string; label_field?: string | null } | null;
  columns?: Column[];
  snapshot?: Map<string, string>;
}): DatatableMapService {
  const binding = options.binding === undefined ? { key_column: 'goods_id' } : options.binding;
  const prisma = {
    metaDatatableBinding: {
      findFirst: async () => (binding ? { datatable_id: 'dt_1', ...binding } : null),
    },
    metaDatatable: {
      findFirst: async () => ({ id: 'dt_1', table_key: 'goods', active_version: 1, status: 'active' }),
    },
    metaDatatableColumn: { findMany: async () => options.columns ?? COLUMNS },
  };
  const rows = { readSnapshot: async () => options.snapshot ?? new Map<string, string>() };
  return new DatatableMapService(prisma as never, rows as never);
}

const snapshot = new Map<string, string>([
  ['9346', JSON.stringify({ goods_id: 'SGD0005464', goods_name: 'Feather Arc' })],
  ['9347', JSON.stringify({ goods_id: 'SGD0005465', goods_name: 'Wasteland jacket' })],
]);

describe('DatatableMapService 展示列选择', () => {
  it('键列是名称列、表里只剩 ID 型列可展示时不映射（不会把名称换成 ID）', async () => {
    const lookup = await build({ binding: { key_column: 'goods_name' }, snapshot }).buildForProp(
      'clklogapp',
      'goods_name',
      ['Feather Arc'],
    );

    expect(lookup.bound).toBe(true);
    expect(lookup.result).toBeNull();
  });

  it('join 键列不是首列时按该列取值命中，展示 *_name 列', async () => {
    const lookup = await build({ snapshot }).buildForProp('clklogapp', 'goods_id', [
      'SGD0005464',
      'SGD9999999',
    ]);

    expect(lookup.result?.map).toEqual({ SGD0005464: 'Feather Arc' });
    expect(lookup.result?.label_title).toBe('商品名称');
  });

  it('键列不是首列时，事件取值等于自增主键不再被误映射', async () => {
    const lookup = await build({ snapshot }).buildForProp('clklogapp', 'goods_id', ['9346']);

    expect(lookup.bound).toBe(true);
    expect(lookup.result).toBeNull();
  });

  it('join 键列就是首列时用主键命中（values JSON 里没有首列）', async () => {
    const lookup = await build({ binding: { key_column: 'id' }, snapshot }).buildForProp(
      'clklogapp',
      'id',
      ['9346'],
    );

    expect(lookup.result?.map).toEqual({ 9346: 'Feather Arc' });
  });

  it('没有生效绑定时 bound=false，页面不应提示"已绑定维表"', async () => {
    const lookup = await build({ binding: null }).buildForProp('clklogapp', 'element_id', ['e1']);

    expect(lookup).toEqual({ bound: false, result: null });
  });

  it('显式 label_field 覆盖默认 *_name 展示列', async () => {
    const lookup = await build({
      binding: { key_column: 'goods_id', label_field: 'goods_id' },
      snapshot,
    }).buildForProp('clklogapp', 'goods_id', ['SGD0005464']);

    expect(lookup.result?.map).toEqual({ SGD0005464: 'SGD0005464' });
    expect(lookup.result?.label_field).toBe('goods_id');
  });

  it('取值超过 5 万时截断并标记 truncated', async () => {
    const values = Array.from({ length: 50_001 }, (_, i) => `v${i}`);
    values[0] = 'SGD0005464';
    const lookup = await build({ snapshot }).buildForProp('clklogapp', 'goods_id', values);
    expect(lookup.truncated).toBe(true);
    expect(lookup.result?.map.SGD0005464).toBe('Feather Arc');
  });
});
