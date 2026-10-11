/**
 * 用户行为序列查询（phase: clklog-analytics-user-timeline-v1）。
 *
 * 顶部 mock appConfig：import 链会拉到 clickhouse.service → configuration（CI 空环境下读 CLICKHOUSE_PASSWORD 会抛）。
 */
jest.mock('../../config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { TimelineService, TIMELINE_MAX_ROWS } from './timeline.service';
import { DomainError } from '../../i18n/domain-error';

/** 2026-10-08 12:00（平台时区 Asia/Shanghai）→ 04:00Z */
const FROM = '2026-10-08 12:00';
const TO = '2026-10-08 18:00';

function build(rows: unknown[] = []) {
  const clickHouse = { query: jest.fn().mockResolvedValue(rows) };
  const subjects = { resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_user', kind: 'preset' }) };
  const timezones = { platformTz: 'Asia/Shanghai' };
  const service = new TimelineService(clickHouse as never, subjects as never, timezones as never);
  return { service, clickHouse, subjects };
}

/** 取拒绝原因并断言类型（`.catch` 的联合类型在 strict 下不可直接用） */
async function captureError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('期望抛出 DomainError，但正常返回了');
}

const spec = { value: '1_13543144', from: FROM, to: TO, order: 'desc' as const, limit: 500 };

function lastCall(clickHouse: { query: jest.Mock }) {
  const [sql, params] = clickHouse.query.mock.calls[0] as [string, Record<string, unknown>];
  return { sql, params };
}

/** 事件表那条查询（两段式解析后，调用序列里会有画像表查询；按下标取会取错） */
function eventCall(clickHouse: { query: jest.Mock }) {
  const call = (clickHouse.query.mock.calls as [string, Record<string, unknown>][]).find(([sql]) =>
    sql.includes('clklog_sa.sa_events'),
  );
  if (!call) throw new Error('未找到 sa_events 查询');
  return { sql: call[0], params: call[1] };
}

/** 画像表解析查询（按属性解析标识的第一段） */
function resolveCall(clickHouse: { query: jest.Mock }) {
  const call = (clickHouse.query.mock.calls as [string, Record<string, unknown>][]).find(([sql]) =>
    sql.includes('clklog_sa.sa_user_profiles'),
  );
  if (!call) throw new Error('未找到 sa_user_profiles 查询');
  return { sql: call[0], params: call[1] };
}

/** 两段式 mock：画像表返回 identities，事件表返回 rows */
function buildResolved(identities: { distinct_id: string; user_key: string }[], rows: unknown[] = [ROW]) {
  const clickHouse = {
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('clklog_sa.sa_user_profiles')) return Promise.resolve(identities);
      if (sql.includes('clklog_sa.sa_events')) return Promise.resolve(rows);
      return Promise.resolve([]);
    }),
  };
  const subjects = { resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_user', kind: 'preset' }) };
  const timezones = { platformTz: 'Asia/Shanghai' };
  const service = new TimelineService(clickHouse as never, subjects as never, timezones as never);
  return { service, clickHouse, subjects };
}

const ROW = {
  log_time: '2026-10-08 17:00:00.000',
  event: 'open_ui2',
  distinct_id: '1_13543144',
  user_key: '1_13543144',
  properties: '{}',
  matched_total: '18489',
  event_kinds: '23',
  first_log_time: '2026-10-08 12:01:00.000',
  last_log_time: '2026-10-08 17:59:59.000',
};

describe('TimelineService 查询形状', () => {
  it('按主体表达式等值 + 区间两端 epoch + stat_date 双向余量 + 窗口汇总', async () => {
    const { service, clickHouse, subjects } = build([ROW]);

    const { items, summary } = await service.query(service.normalize(spec), 'clklogapp');

    expect(subjects.resolve).toHaveBeenCalledWith('clklogapp', null);
    const { sql, params } = lastCall(clickHouse);
    expect(sql).toContain('count() OVER () AS matched_total');
    expect(sql).toContain('uniqExact(event) OVER () AS event_kinds');
    expect(sql).toContain('min(log_time) OVER () AS first_log_time');
    expect(sql).toContain('max(log_time) OVER () AS last_log_time');
    expect(sql).toContain('log_time >= toDateTime({since: UInt32})');
    expect(sql).toContain('log_time < toDateTime({until: UInt32})');
    expect(sql).toContain('stat_date >= toDate({stat_from: String})');
    expect(sql).toContain('stat_date <= toDate({stat_to: String})');
    expect(sql).toContain('ORDER BY log_time DESC');
    expect(sql).toContain('LIMIT {limit: UInt32}');
    expect(sql).not.toContain('event IN {events');
    // from/to 按平台时区解释成 epoch 秒；stat_date 两端各留 2 天余量
    expect(params).toMatchObject({
      project: 'clklogapp',
      value: '1_13543144',
      since: Math.floor(Date.parse('2026-10-08T04:00:00Z') / 1000),
      until: Math.floor(Date.parse('2026-10-08T10:00:00Z') / 1000),
      stat_from: '2026-10-06',
      stat_to: '2026-10-10',
      limit: 500,
    });
    expect(items).toHaveLength(1);
    expect(summary).toEqual({
      matched_total: 18489,
      shown_total: 1,
      event_kinds: 23,
      first_log_time: '2026-10-08 12:01:00.000',
      last_log_time: '2026-10-08 17:59:59.000',
      truncated: true,
    });
  });

  it('按用户属性查标识：先在画像表解析成 distinct_id，再用主体表达式限定事件（**不 JOIN 事实表**）', async () => {
    // 生产实证：把属性条件 JOIN 到 sa_events 上会让事实表失去剪枝能力，
    // ClickHouse 按 stat_date 区间整段预估（9550 万行 / 180 秒）→ 超 120 秒上限直接失败。
    const { service, clickHouse } = buildResolved([{ distinct_id: '1_14552557', user_key: '' }]);

    await service.query(
      service.normalize({ ...spec, value: 'YYZ000014552557', id_kind: 'user_property', id_key: 'massid' }),
      'clklogapp',
    );

    const resolve = resolveCall(clickHouse);
    expect(resolve.sql).toContain('FROM clklog_sa.sa_user_profiles FINAL');
    expect(resolve.sql).toContain('JSONExtractString(properties, {id_key: String}) = {value: String}');
    expect(resolve.params).toMatchObject({ project: 'clklogapp', id_key: 'massid', value: 'YYZ000014552557' });

    const evt = eventCall(clickHouse);
    expect(evt.sql).not.toContain('JOIN');
    expect(evt.sql).not.toContain('{id_key');
    // 单一标识 → 主体表达式等值（与 id_kind=subject 的查询完全同形）
    expect(evt.sql).toMatch(/= \{ident: String\}/);
    expect(evt.params).toMatchObject({ ident: '1_14552557' });
  });

  it('属性匹配到多个标识 → 主体表达式 IN 数组（user_key 优先）', async () => {
    const { service, clickHouse } = buildResolved([
      { distinct_id: '1_a', user_key: 'u_a' },
      { distinct_id: '1_b', user_key: '' },
    ]);

    await service.query(
      service.normalize({ ...spec, value: 'YYZ000014552557', id_kind: 'user_property', id_key: 'massid' }),
      'clklogapp',
    );

    const evt = eventCall(clickHouse);
    expect(evt.sql).toMatch(/IN \{idents: Array\(String\)\}/);
    expect(evt.params.idents).toEqual(['u_a', '1_b']);
  });

  it('属性值匹配不到用户 → 400 timeline.userNotFound（不静默返回空表）', async () => {
    const { service } = buildResolved([]);

    const error = await captureError(
      service.query(
        service.normalize({ ...spec, value: 'NOPE', id_kind: 'user_property', id_key: 'massid' }),
        'clklogapp',
      ),
    );

    expect(error.errorCode).toBe('timeline.userNotFound');
    expect(error.getStatus()).toBe(400);
  });

  it('按事件属性查标识：直接吃事件 properties（无需 JOIN、无需解析）', async () => {
    const { service, clickHouse } = build([ROW]);

    await service.query(
      service.normalize({ ...spec, value: 'a97f26aa4012fdd8', id_kind: 'event_property', id_key: 'device_id' }),
      'clklogapp',
    );

    const { sql, params } = eventCall(clickHouse);
    expect(sql).toContain('JSONExtractString(properties, {id_key: String}) = {value: String}');
    expect(params.id_key).toBe('device_id');
    // 事件属性口径不需要解析画像表
    expect(sql).not.toContain('sa_user_profiles');
  });

  it('服务端行级筛选：附加等值条件（事件属性）', async () => {
    const { service, clickHouse } = build([ROW]);

    await service.query(
      service.normalize({ ...spec, filter_key: 'module_name', filter_value: 'danmuview' }),
      'clklogapp',
    );

    const { sql, params } = eventCall(clickHouse);
    expect(sql).toContain('JSONExtractString(properties, {filter_key: String}) = {filter_value: String}');
    expect(params).toMatchObject({ filter_key: 'module_name', filter_value: 'danmuview' });
  });

  it('服务端行级筛选：用户属性同样走两段式解析；解析不到 → 条件恒假（空结果，不报错）', async () => {
    const { service, clickHouse } = buildResolved([{ distinct_id: '1_a', user_key: 'u_a' }]);

    await service.query(
      service.normalize({
        ...spec,
        filter_key: 'massid',
        filter_scope: 'user',
        filter_value: 'YYZ000014552557',
      }),
      'clklogapp',
    );
    expect(eventCall(clickHouse).params).toMatchObject({ filter_ident: 'u_a' });
    expect(eventCall(clickHouse).sql).not.toContain('JOIN');

    const empty = buildResolved([]);
    await empty.service.query(
      empty.service.normalize({
        ...spec,
        filter_key: 'massid',
        filter_scope: 'user',
        filter_value: 'NOPE',
      }),
      'clklogapp',
    );
    expect(eventCall(empty.clickHouse).sql).toContain('1 = 0');
  });

  it('事件多选走参数化 IN，排序可切正序', async () => {
    const { service, clickHouse } = build([ROW]);

    await service.query(service.normalize({ ...spec, events: ['open_ui2', 'gift_display'], order: 'asc' }), 'clklogapp');

    const { sql, params } = lastCall(clickHouse);
    expect(sql).toContain('event IN {events: Array(String)}');
    expect(sql).toContain('ORDER BY log_time ASC');
    expect(params.events).toEqual(['open_ui2', 'gift_display']);
  });

  it('条数收敛到 [1, TIMELINE_MAX_ROWS]', async () => {
    const { service, clickHouse } = build([ROW]);

    await service.query(service.normalize({ ...spec, limit: 99999 }), 'clklogapp');
    expect(lastCall(clickHouse).params.limit).toBe(TIMELINE_MAX_ROWS);

    await service.query(service.normalize({ ...spec, limit: -3 }), 'clklogapp');
    expect(clickHouse.query.mock.calls[1][1].limit).toBe(1);
  });

  it('空结果：汇总归零、不判截断', async () => {
    const { service } = build([]);
    const { items, summary } = await service.query(service.normalize(spec), 'clklogapp');
    expect(items).toEqual([]);
    expect(summary).toMatchObject({ matched_total: 0, shown_total: 0, event_kinds: 0, truncated: false });
  });

  it('非法时间格式 → 400 timeInvalid；起点不早于终点 → 400 rangeInvalid', async () => {
    const { service } = build();
    await expect(
      service.query({ ...service.normalize(spec), from: '2026/10/08 12:00' }, 'clklogapp'),
    ).rejects.toMatchObject({ errorCode: 'timeline.timeInvalid' });
    await expect(
      service.query(service.normalize({ ...spec, from: '2026-10-08 18:00', to: FROM }), 'clklogapp'),
    ).rejects.toMatchObject({ errorCode: 'timeline.rangeInvalid' });
  });

  it('标识为空 → 400', () => {
    const { service } = build();
    try {
      service.normalize({ ...spec, value: '   ' });
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as DomainError).errorCode).toBe('timeline.valueRequired');
      expect((error as DomainError).getStatus()).toBe(400);
    }
  });

  it('选了属性口径但没给属性键 → 400 idKeyRequired（不静默退回标识口径）', () => {
    const { service } = build();
    for (const id_kind of ['user_property', 'event_property'] as const) {
      const error = (() => {
        try {
          service.normalize({ ...spec, id_kind });
        } catch (e) {
          return e as DomainError;
        }
        throw new Error('应当抛错');
      })();
      expect(error.errorCode).toBe('timeline.idKeyRequired');
      expect(error.getStatus()).toBe(400);
    }
    // 给了键就正常
    expect(service.normalize({ ...spec, id_kind: 'user_property', id_key: 'massid' }).id_key).toBe('massid');
  });

  it('ClickHouse 超时 → 504 timeline.queryTimeout（供控制器转后台）', async () => {
    const { service, clickHouse } = build();
    clickHouse.query.mockRejectedValue(new Error('Code: 159. DB::Exception: Timeout exceeded'));

    const error = await captureError(service.query(service.normalize(spec), 'clklogapp'));

    expect(error.errorCode).toBe('timeline.queryTimeout');
    expect(error.getStatus()).toBe(504);
  });

  it('其它 ClickHouse 错误 → 500 timeline.queryFailed，且不外泄引擎文本', async () => {
    const { service, clickHouse } = build();
    clickHouse.query.mockRejectedValue(new Error('Memory limit exceeded (for query)'));

    const error = await captureError(service.query(service.normalize(spec), 'clklogapp'));

    expect(error.errorCode).toBe('timeline.queryFailed');
    expect(JSON.stringify(error.getResponse())).not.toContain('Memory');
  });
});

describe('TimelineService 画像（按属性定位 + 解析回报）', () => {
  it('按用户属性查：返回属性与「已解析为」的标识，标签按解析后的主体值查', async () => {
    const profiled = {
      distinct_id: '1_14552557',
      user_key: '',
      properties: JSON.stringify({ massid: 'YYZ000014552557', area: 'ID' }),
    };
    const clickHouse = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('sa_user_profiles')) return Promise.resolve([profiled]);
        if (sql.includes('sa_tag_members')) return Promise.resolve([{ tag_id: 't1', value: '1' }]);
        return Promise.resolve([]);
      }),
    };
    const prisma = { metaUserTag: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new TimelineService(clickHouse as never, undefined as never, {
      platformTz: 'Asia/Shanghai',
    } as never, prisma as never);

    const result = await service.profile(
      { value: 'YYZ000014552557', id_kind: 'user_property', id_key: 'massid' },
      'clklogapp',
    );

    expect(result.attributes).toMatchObject({ massid: 'YYZ000014552557' });
    expect(result.resolved).toEqual({ distinct_id: '1_14552557', user_key: '' });
    expect(result.matched_users).toBe(1);
    const tagSql = (clickHouse.query.mock.calls as [string, Record<string, unknown>][]).find(([sql]) =>
      sql.includes('sa_tag_members'),
    );
    expect(tagSql?.[1]).toMatchObject({ uids: ['YYZ000014552557', '1_14552557'] });
  });

  it('按标识查（subject 口径）：不返回 resolved，标签仍按原值查', async () => {
    const clickHouse = {
      query: jest.fn().mockImplementation((sql: string) =>
        sql.includes('sa_user_profiles')
          ? Promise.resolve([{ distinct_id: '1_14552557', user_key: '', properties: '{}' }])
          : Promise.resolve([]),
      ),
    };
    const service = new TimelineService(
      clickHouse as never,
      undefined as never,
      { platformTz: 'Asia/Shanghai' } as never,
      { metaUserTag: { findMany: jest.fn().mockResolvedValue([]) } } as never,
    );

    const result = await service.profile({ value: '1_14552557' }, 'clklogapp');

    expect(result.resolved).toEqual({ distinct_id: '1_14552557', user_key: '' });
    const profileSql = (clickHouse.query.mock.calls as [string, Record<string, unknown>][]).find(([sql]) =>
      sql.includes('sa_user_profiles'),
    )?.[0];
    expect(profileSql).toContain('distinct_id = {value: String} OR user_key = {value: String}');
  });

  it('空标识 → 直接返回空（不打 ClickHouse）', async () => {
    const clickHouse = { query: jest.fn().mockResolvedValue([]) };
    const service = new TimelineService(clickHouse as never, undefined as never, {
      platformTz: 'Asia/Shanghai',
    } as never);

    const result = await service.profile({ value: '  ' }, 'clklogapp');

    expect(result).toEqual({ attributes: {}, tags: [], resolved: null, matched_users: 0 });
    expect(clickHouse.query).not.toHaveBeenCalled();
  });
});
