/**
 * 隔离 YAML 配置：`cohort-preview.service` / `cohort.service` 会经 clickhouse / redis
 * 服务顶层加载 `src/config/configuration`（需要 APP_CONFIG_PATH 与真实密钥，CI 里都没有），
 * 与 test/ops/slow-query.*.spec.ts 同款处理。见 scripts/build.sh 的后端单测说明。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    __specConfigMock: true,
  },
}));

import { CohortConditionSqlService } from '../../src/modules/cohort/cohort-condition-sql.service';
import { CohortPreviewService } from '../../src/modules/cohort/cohort-preview.service';

const didEvent = (event: string) => ({
  type: 'did_event' as const,
  polarity: 'did' as const,
  event,
  metric: 'times' as const,
  op: 'gt' as const,
  value: 0,
  time: { mode: 'last_n_days' as const, n: 7 },
});

function buildConditionSql() {
  const virtualEvents = { findDefinition: jest.fn().mockResolvedValue(null) };
  const attributes = {
    inferDataType: jest.fn().mockResolvedValue('string'),
    resolve: jest.fn().mockResolvedValue("JSONExtractString(properties, 'vip')"),
  };
  return new CohortConditionSqlService(virtualEvents as never, attributes as never, {
    resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_userxxxx', kind: 'preset' }),
  } as never);
}

describe('CohortConditionSqlService.buildPreviewParts', () => {
  it('试跑只读：不出现 INSERT，人数与样例共用同一条集合 SQL', async () => {
    const service = buildConditionSql();
    const { count, sample } = await service.buildPreviewParts(
      'clklogapp',
      [didEvent('AppStart')],
      '2026-09-05',
      undefined,
      20,
    );
    expect(count.sql.startsWith('SELECT count() AS c FROM (')).toBe(true);
    expect(count.sql).not.toContain('INSERT');
    expect(sample!.sql).not.toContain('INSERT');
    // 人数与样例来自同一条集合 SQL（只是外层包装不同）
    expect(count.sql).toContain('AND event = {preview_c0_event: String}');
    expect(sample!.sql).toContain('AND event = {preview_c0_event: String}');
    expect(count.sql).toContain('project_name = {project: String}');
    expect(count.sql).toContain('stat_date BETWEEN');
    expect(sample!.params.limit).toBe(20);
    expect(sample!.params.preview_c0_start).toBe('2026-08-29');
    expect(sample!.params.preview_c0_end).toBe('2026-09-04');
    expect(sample!.params.project).toBe('clklogapp');
  });

  it('limit=0 时只算人数，不生成样例 SQL', async () => {
    const service = buildConditionSql();
    const { count, sample } = await service.buildPreviewParts(
      'clklogapp',
      [didEvent('AppStart')],
      '2026-09-05',
      undefined,
      0,
    );
    expect(sample).toBeUndefined();
    expect(count.sql).toContain('count()');
  });

  it('多个条件仍走交集（INNER JOIN），不是取并集', async () => {
    const service = buildConditionSql();
    const { count } = await service.buildPreviewParts(
      'clklogapp',
      [didEvent('AppStart'), didEvent('PageView')],
      '2026-09-05',
      undefined,
      0,
    );
    expect(count.sql).toContain('INNER JOIN');
  });
});

describe('CohortPreviewService', () => {
  const conditionSql = { buildPreviewParts: jest.fn() };
  const clickHouse = { query: jest.fn() };
  const subjects = { resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_userxxxx', kind: 'preset' }) };
  const timezones = { platformTz: 'Asia/Shanghai' };
  const service = new CohortPreviewService(
    conditionSql as never,
    clickHouse as never,
    subjects as never,
    timezones as never,
    undefined,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    subjects.resolve.mockResolvedValue({ subject_id: 'asub_userxxxx', kind: 'preset' });
    conditionSql.buildPreviewParts.mockResolvedValue({
      count: { sql: 'SELECT count() AS c FROM (x)', params: { project: 'clklogapp' } },
      sample: { sql: 'SELECT uid FROM (x)', params: { project: 'clklogapp', limit: 2 } },
    });
  });

  it('返回精确人数与样例，并按 limit 截断标记', async () => {
    clickHouse.query
      .mockResolvedValueOnce([{ c: '1200' }])
      .mockResolvedValueOnce([{ uid: 'u1' }, { uid: 'u2' }]);
    const res = await service.previewCondition('clklogapp', { conditions: [didEvent('AppStart')] }, undefined, 2);
    expect(res.count).toBe(1200);
    expect(res.items).toEqual([{ uid: 'u1' }, { uid: 'u2' }]);
    expect(res.truncated).toBe(true);
    // 两次查询都是有界只读：maxResultRows + 超时
    expect(clickHouse.query.mock.calls[0][2]).toEqual({ maxExecutionTime: 30, maxResultRows: 1 });
    expect(clickHouse.query.mock.calls[1][2]).toEqual({ maxExecutionTime: 30, maxResultRows: 2 });
  });

  it('人数为 0 或未取到样例时不报错，返回空列表', async () => {
    clickHouse.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await service.previewCondition('clklogapp', { conditions: [didEvent('AppStart')] }, undefined, 20);
    expect(res.count).toBe(0);
    expect(res.items).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it('事件属性主体下的「没做过」被挡下（与创建同一处判断）', async () => {
    subjects.resolve.mockResolvedValue({
      subject_id: 'asub_prop0001',
      kind: 'property',
      source: { scope: 'event', prop: 'account_id' },
    });
    await expect(
      service.previewCondition(
        'clklogapp',
        {
          conditions: [
            {
              ...didEvent('AppStart'),
              polarity: 'did_not',
            },
          ],
        },
        'asub_prop0001',
        20,
      ),
    ).rejects.toMatchObject({ errorCode: 'cohort.subject.didNotUnsupported' });
    expect(conditionSql.buildPreviewParts).not.toHaveBeenCalled();
  });
});
