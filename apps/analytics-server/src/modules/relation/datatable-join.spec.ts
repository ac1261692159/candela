import { DomainError } from '../../i18n/domain-error';
import { JoinRegistry, MAX_DATATABLE_JOINS } from './join-registry';
import { datatableJoinRequest, parseDatatableDimension } from './datatable-join';

describe('parseDatatableDimension', () => {
  it('accepts event property and builtin # bindings', () => {
    expect(parseDatatableDimension('goods_id@goods_name')).toEqual({
      targetProp: 'goods_id',
      fieldKey: 'goods_name',
    });
    expect(parseDatatableDimension('#event_name@owner')).toEqual({
      targetProp: '#event_name',
      fieldKey: 'owner',
    });
    expect(parseDatatableDimension('#event_time@campaign')).toEqual({
      targetProp: '#event_time',
      fieldKey: 'campaign',
    });
  });

  it('rejects injection characters, missing at-sign, and oversize names', () => {
    expect(parseDatatableDimension("goods_id@x');drop")).toBeNull();
    expect(parseDatatableDimension('goods_id@goods name')).toBeNull();
    expect(parseDatatableDimension('goods_id')).toBeNull();
    expect(parseDatatableDimension(`goods_id@${'a'.repeat(60)}`)).toBeNull();
    expect(parseDatatableDimension(`${'a'.repeat(200)}@b`)).toBeNull();
  });
});

describe('datatableJoinRequest', () => {
  it('joins on pk when the key column is the primary field', () => {
    const req = datatableJoinRequest({
      tableId: 'dt_abc123xyz0',
      version: 3,
      keyColumn: 'id',
      primaryField: 'id',
      leftExpr: "JSONExtractString(sa_events.properties, 'goods_id')",
    });
    const joins = new JoinRegistry();
    const alias = joins.register(req);
    const sql = joins.render().join('\n');
    expect(sql).toContain('clklog_sa.sa_datatable_rows');
    expect(sql).toContain("datatable_key = 'dt_abc123xyz0'");
    expect(sql).toContain('version = 3');
    expect(sql).toContain(`toString(${alias}.pk)`);
    expect(sql).not.toContain('JSONExtractString(dtr_');
  });

  it('joins on values JSON when the business key is not the primary column', () => {
    const req = datatableJoinRequest({
      tableId: 'dt_abc123xyz0',
      version: 2,
      keyColumn: 'goods_id',
      primaryField: 'id',
      leftExpr: "JSONExtractString(sa_events.properties, 'goods_id')",
    });
    const joins = new JoinRegistry();
    joins.register(req);
    expect(joins.render().join('\n')).toContain("JSONExtractString(dtr_dt_abc123xyz0_2_goods_id_1.values, 'goods_id')");
  });

  it('reuses one JOIN for the same table/version/key and caps unique tables at 3', () => {
    const joins = new JoinRegistry();
    const left = "JSONExtractString(sa_events.properties, 'x')";
    const first = datatableJoinRequest({
      tableId: 'dt_tableaaaaa',
      version: 1,
      keyColumn: 'id',
      primaryField: 'id',
      leftExpr: left,
    });
    expect(joins.register(first)).toBe(joins.register(first));
    joins.register(
      datatableJoinRequest({
        tableId: 'dt_tablebbbbb',
        version: 1,
        keyColumn: 'id',
        primaryField: 'id',
        leftExpr: left,
      }),
    );
    joins.register(
      datatableJoinRequest({
        tableId: 'dt_tableccccc',
        version: 1,
        keyColumn: 'id',
        primaryField: 'id',
        leftExpr: left,
      }),
    );
    expect(joins.size).toBe(MAX_DATATABLE_JOINS);
    let thrown: unknown;
    try {
      joins.register(
        datatableJoinRequest({
          tableId: 'dt_tableddddd',
          version: 1,
          keyColumn: 'id',
          primaryField: 'id',
          leftExpr: left,
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).toMatchObject({ status: 400, errorCode: 'relation.datatable.tooManyJoins' });
  });
});
