import { AttributeResolverService } from './attribute-resolver.service';
import { JoinRegistry } from '../relation/join-registry';

describe('AttributeResolverService user scope', () => {
  const service = new AttributeResolverService({} as never, {} as never);

  it('registers a project-filtered LEFT JOIN and reads the property from that alias', async () => {
    const joins = new JoinRegistry();
    const sql = await service.resolve('vip_level', 'user', 'number', { project: 'clklogapp', joins });

    expect(sql).toBe("JSONExtractFloat(up_1.properties, 'vip_level')");
    const rendered = joins.render().join('\n');
    expect(rendered).toContain(
      'LEFT JOIN (SELECT distinct_id AS uid, properties FROM clklog_sa.sa_user_profiles FINAL WHERE project_name = {project: String}) AS up_1',
    );
    expect(rendered).toContain('ON sa_events.distinct_id = up_1.uid');
  });

  it('never emits a correlated reference to the outer table', async () => {
    const joins = new JoinRegistry();
    const sql = await service.resolve('vip_level', 'user', 'string', { project: 'clklogapp', joins });

    expect(sql).not.toContain('sa_events.');
    expect(joins.render().join('\n')).not.toContain('sa_events.project_name');
  });

  it('reuses a single JOIN for repeated user-property references', async () => {
    const joins = new JoinRegistry();
    await service.resolve('a', 'user', 'string', { project: 'p', joins });
    await service.resolve('b', 'user', 'number', { project: 'p', joins });

    expect(joins.size).toBe(1);
  });

  it('requires a JoinRegistry for user scope', async () => {
    await expect(service.resolve('vip', 'user', 'string', { project: 'p' })).rejects.toThrow(
      /JoinRegistry/,
    );
  });

  it('keeps the data-type specific extraction for profile-side SQL', () => {
    expect(service.resolveUserPropertyDirect('vip_level', 'number')).toBe(
      "JSONExtractFloat(properties, 'vip_level')",
    );
    expect(service.resolveUserPropertyDirect('vip_level', 'string')).toBe(
      "JSONExtractString(properties, 'vip_level')",
    );
  });
});

describe('AttributeResolverService datatable dimensions', () => {
  const binding = {
    datatable_id: 'dt_abc123xyz0',
    target_prop: 'goods_id',
    target_type: 'event_property',
    key_column: 'goods_id',
    granularity: null,
    status: 'active',
  };
  const table = {
    id: 'dt_abc123xyz0',
    active_version: 3,
    status: 'active',
  };
  const columns = [
    { datatable_id: 'dt_abc123xyz0', field_key: 'id', data_type: 'string', is_primary: true, sort_order: 0 },
    { datatable_id: 'dt_abc123xyz0', field_key: 'goods_id', data_type: 'string', is_primary: false, sort_order: 1 },
    { datatable_id: 'dt_abc123xyz0', field_key: 'goods_name', data_type: 'string', is_primary: false, sort_order: 2 },
    { datatable_id: 'dt_abc123xyz0', field_key: 'goods_type', data_type: 'string', is_primary: false, sort_order: 3 },
  ];

  function serviceWith(bindings: unknown[], tables: unknown[] = [table], cols = columns) {
    const prisma = {
      metaDatatableBinding: { findMany: jest.fn().mockResolvedValue(bindings) },
      metaDatatable: { findMany: jest.fn().mockResolvedValue(tables) },
      metaDatatableColumn: { findMany: jest.fn().mockResolvedValue(cols) },
      metaEventProperty: { findFirst: jest.fn().mockResolvedValue(null) },
      metaVirtualProperty: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    return new AttributeResolverService(prisma as never, {} as never);
  }

  it('registers a LEFT JOIN on values JSON and extracts the dimension field', async () => {
    const service = serviceWith([binding]);
    const joins = new JoinRegistry();
    const sql = await service.resolve('goods_id@goods_name', 'event', 'string', {
      project: 'clklogapp',
      joins,
    });
    expect(sql).toBe("JSONExtractString(dtr_dt_abc123xyz0_3_goods_id_1.values, 'goods_name')");
    const rendered = joins.render().join('\n');
    expect(rendered).toContain('LEFT JOIN (SELECT pk, values FROM clklog_sa.sa_datatable_rows');
    expect(rendered).toContain("datatable_key = 'dt_abc123xyz0'");
    expect(rendered).toContain("JSONExtractString(sa_events.properties, 'goods_id')");
    expect(rendered).toContain("JSONExtractString(dtr_dt_abc123xyz0_3_goods_id_1.values, 'goods_id')");
    expect(rendered).not.toMatch(/JSONExtractString\(properties, 'goods_id@/);
  });

  it('fails closed when the binding is missing instead of falling back to JSONExtract', async () => {
    const service = serviceWith([]);
    const joins = new JoinRegistry();
    await expect(
      service.resolve('goods_id@goods_name', 'event', 'string', { project: 'clklogapp', joins }),
    ).rejects.toThrow(/依赖的数据表已失效/);
  });

  it('joins #event_name on sa_events.event', async () => {
    const service = serviceWith(
      [{ ...binding, target_prop: '#event_name', target_type: 'event_name', key_column: 'event' }],
      [table],
      [
        { datatable_id: 'dt_abc123xyz0', field_key: 'event', data_type: 'string', is_primary: true, sort_order: 0 },
        { datatable_id: 'dt_abc123xyz0', field_key: 'owner', data_type: 'string', is_primary: false, sort_order: 1 },
      ],
    );
    const joins = new JoinRegistry();
    await service.resolve('#event_name@owner', 'event', 'string', { project: 'clklogapp', joins });
    expect(joins.render().join('\n')).toContain('sa_events.event');
  });
});

