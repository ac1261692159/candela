import { describe, expect, it } from 'vitest';
import { labeledEventProperties, datatableGroupOptionLabel } from './event-property-options';

describe('labeledEventProperties', () => {
  it('unions source properties with virtual ones labeled 虚拟', () => {
    const rows = labeledEventProperties({
      event: [{ prop_key: 'channel', data_type: 'string' } as never],
      virtual: [{ prop_key: 'vp_paid', display_name: '付费', data_type: 'number' } as never],
    });
    expect(rows.map((row) => row.prop_key)).toEqual(['channel', 'vp_paid']);
    expect(rows[1].display_name).toBe('付费 (虚拟)');
  });

  it('appends datatable dimension properties labeled 数据表', () => {
    const rows = labeledEventProperties(
      {
        event: [{ prop_key: 'goods_id', data_type: 'string' } as never],
        virtual: [],
      },
      [{ prop_key: 'goods_id@goods_name', display_name: '商品名称', data_type: 'string' }],
    );
    expect(rows.map((row) => row.prop_key)).toEqual(['goods_id', 'goods_id@goods_name']);
    expect(rows[1].display_name).toBe('商品名称 (数据表)');
  });
});

describe('datatableGroupOptionLabel', () => {
  it('joins the bound property with the field display name', () => {
    expect(datatableGroupOptionLabel('goods_id@goods_name', '商品名称')).toBe('goods_id@商品名称');
    expect(datatableGroupOptionLabel('#event_name@owner', '负责人')).toBe('#event_name@负责人');
    expect(datatableGroupOptionLabel('goods_id@goods_name')).toBe('goods_id@goods_name');
  });
});
