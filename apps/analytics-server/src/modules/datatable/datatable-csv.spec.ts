import {
  DatatableCsvError,
  assertHeaderMatches,
  mergeSnapshot,
  parseDatatableCsv,
} from './datatable-csv';

describe('parseDatatableCsv', () => {
  const csv = `item_info,quantity,quality,resource
10001,100,Common,Iron
10002,100,Rare,Gold
`;

  it('parses header, infers types and marks the first column as primary', () => {
    const parsed = parseDatatableCsv(csv);
    expect(parsed.columns[0]).toMatchObject({
      field_key: 'item_info',
      is_primary: true,
      data_type: 'number',
    });
    expect(parsed.columns[1].data_type).toBe('number');
    expect(parsed.columns[2].data_type).toBe('string');
    expect(parsed.successRows).toBe(2);
    expect(parsed.droppedRows).toBe(0);
    expect(parsed.rows.get('10001')).toBe(
      '{"quantity":100,"quality":"Common","resource":"Iron"}',
    );
  });

  it('rejects an illegal header for the whole file', () => {
    expect(() => parseDatatableCsv('Item-Info,x\n1,2\n')).toThrow(DatatableCsvError);
    expect(() => parseDatatableCsv('id,id\n1,2\n')).toThrow(/重复字段名/);
  });

  it('drops rows by empty primary key / type mismatch with line numbers', () => {
    const parsed = parseDatatableCsv('id,amount\n1,10\n,20\n3,abc\n', {
      columns: [
        { field_key: 'id', data_type: 'number' },
        { field_key: 'amount', data_type: 'number' },
      ],
    });
    expect(parsed.successRows).toBe(1);
    expect(parsed.dropped).toEqual([
      { line: 3, reason: '主键为空', reason_key: 'datatable:import.primaryKeyEmpty' },
      {
        line: 4,
        reason: '字段 amount 不是 number 类型或超长',
        reason_key: 'datatable:import.fieldTypeMismatch',
        reason_params: { field: 'amount', type: 'number' },
      },
    ]);
  });

  it('keeps the last row when the primary key repeats inside one file', () => {
    const parsed = parseDatatableCsv('id,name\n1,a\n1,b\n');
    expect(parsed.rows.get('1')).toBe('{"name":"b"}');
    expect(parsed.duplicatedKeys).toBe(1);
    expect(parsed.successRows).toBe(1);
  });

  it('supports BOM / semicolon delimiter / quoted cells', () => {
    const parsed = parseDatatableCsv('\uFEFFid;name\n1;"a,b"\n');
    expect(parsed.columns.map((c) => c.field_key)).toEqual(['id', 'name']);
    expect(parsed.rows.get('1')).toBe('{"name":"a,b"}');
  });

  it('drops a primary-key cell that does not match the declared type', () => {
    const parsed = parseDatatableCsv('id,name\nabc,x\n2,y\n', {
      columns: [
        { field_key: 'id', data_type: 'number' },
        { field_key: 'name', data_type: 'string' },
      ],
    });
    expect(parsed.successRows).toBe(1);
    expect(parsed.dropped).toEqual([
      {
        line: 2,
        reason: '主键不是 number 类型或超长',
        reason_key: 'datatable:import.primaryKeyTypeMismatch',
        reason_params: { type: 'number' },
      },
    ]);
    expect([...parsed.rows.keys()]).toEqual(['2']);
  });

  it('rejects files over the row limit', () => {
    const rows = Array.from({ length: 200_001 }, (_, i) => `${i},x`).join('\n');
    expect(() => parseDatatableCsv(`id,name\n${rows}\n`)).toThrow(/行数超过上限/);
  });
});

describe('mergeSnapshot', () => {
  it('overrides same keys and keeps the rest in incremental mode', () => {
    const prior = new Map([
      ['1', '{"n":"a"}'],
      ['2', '{"n":"b"}'],
    ]);
    const merged = mergeSnapshot(
      prior,
      new Map([
        ['2', '{"n":"B"}'],
        ['3', '{"n":"c"}'],
      ]),
      'incr',
    );
    expect([...merged.keys()].sort()).toEqual(['1', '2', '3']);
    expect(merged.get('2')).toBe('{"n":"B"}');
  });

  it('drops the previous snapshot in replace mode', () => {
    const merged = mergeSnapshot(new Map([['1', '{}']]), new Map([['9', '{}']]), 'replace');
    expect([...merged.keys()]).toEqual(['9']);
  });
});

describe('assertHeaderMatches', () => {
  const saved = [{ field_key: 'id' }, { field_key: 'item_name' }];

  it('accepts the same names in the same order', () => {
    expect(() => assertHeaderMatches(['id', 'item_name'], saved)).not.toThrow();
  });

  it('rejects a different column order even when names match', () => {
    expect(() => assertHeaderMatches(['item_name', 'id'], saved)).toThrow(/表头与当前表结构不一致/);
  });

  it('rejects extra or missing columns by name', () => {
    expect(() => assertHeaderMatches(['id', 'other'], saved)).toThrow(/缺少 item_name/);
  });
});
