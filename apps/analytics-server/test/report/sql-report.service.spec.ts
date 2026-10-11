import { Test } from '@nestjs/testing';
import { DomainError } from '../../src/i18n/domain-error';

// 服务端预算是配置项（query.maxExecutionTime），spec 里显式注入，避免顶层加载 YAML 配置
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 300, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    __specConfigMock: true,
  },
}));

jest.mock('../../src/modules/shared/clickhouse.service', () => ({ ClickHouseService: class ClickHouseService {} }));
jest.mock('../../src/modules/report/sql-ast-guard.service', () => ({ SqlAstGuardService: class SqlAstGuardService {} }));

import { SqlReportService } from '../../src/modules/report/sql-report.service';
import { CardRepository } from '../../src/modules/report/card.repository';
import { ClickHouseService } from '../../src/modules/shared/clickhouse.service';
import { SqlAstGuardService } from '../../src/modules/report/sql-ast-guard.service';
import { CohortBatchService } from '../../src/modules/query/cohort-batch.service';
import { TagBatchService } from '../../src/modules/query/tag-batch.service';
import { SubjectService } from '../../src/modules/subject/subject.service';
import { AssetPolicyService } from '../../src/modules/iam/asset-policy.service';
import { DataScopeService } from '../../src/modules/iam/data-scope.service';
import { TimeScopeService } from '../../src/modules/time/time-scope';
import { TimezoneService } from '../../src/modules/time/timezone.service';
import type { AuthUser } from '../../src/modules/auth/auth.service';
import { emptyScope } from '../../src/modules/iam/iam.types';

const chartConfig = {
  schema_version: 1,
  recommendation_version: 1,
  mode: 'manual',
  preferred_view: 'chart',
  chart_type: 'bar',
  roles: { country: 'dimension', event_count: 'metric' },
  bindings: { category: 'country', metrics: ['event_count'], ignored: [] },
  options: { orientation: 'vertical', donut: false, include_other: false, units: {}, aggregation: {} },
};

describe('SqlReportService chart_config', () => {
  let service: SqlReportService;
  let repo: { create: jest.Mock; update: jest.Mock; findById: jest.Mock; findByName: jest.Mock };

  const user: AuthUser = { id: 'u1', username: 'a1', display_name: null, platform_role: 'none' };

  beforeEach(async () => {
    repo = { create: jest.fn(), update: jest.fn(), findById: jest.fn(), findByName: jest.fn().mockResolvedValue(null) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SqlReportService,
        { provide: CardRepository, useValue: repo },
        { provide: ClickHouseService, useValue: {} },
        { provide: SqlAstGuardService, useValue: {} },
        { provide: CohortBatchService, useValue: { resolve: jest.fn() } },
        { provide: TagBatchService, useValue: { resolve: jest.fn() } },
        {
          provide: SubjectService,
          useValue: {
            expr: jest.fn().mockResolvedValue("if(user_key != '', user_key, distinct_id)"),
            resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_user', kind: 'preset' }),
          },
        },
        { provide: AssetPolicyService, useValue: { loadCard: jest.fn().mockResolvedValue({}), assert: jest.fn(), canUpdate: jest.fn().mockResolvedValue(true) } },
        { provide: DataScopeService, useValue: { applyToEventsQuery: () => ({ extraAnd: null }) } },
        { provide: TimeScopeService, useValue: new TimeScopeService(new TimezoneService(undefined)) },
      ],
    }).compile();
    service = moduleRef.get(SqlReportService);
  });

  it('save writes dsl_json.chart_config and syncs Card.chart_type', async () => {
    repo.create.mockResolvedValue({
      card_id: 'c1',
      name: '趋势',
      dsl_json: '{}',
      created_at: new Date(),
      updated_at: new Date(),
    });
    await service.save({ name: '趋势', mode: 'sql', sql_text: 'SELECT 1', chart_config: chartConfig }, 'clklogapp', user);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        chart_type: 'bar',
        dsl_json: expect.stringContaining('"chart_type":"bar"'),
      }),
    );
  });

  it('persists a trend chart_config with options.trend (AC7)', async () => {
    repo.create.mockResolvedValue({
      card_id: 'c-trend',
      name: '趋势',
      dsl_json: '{}',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const trendConfig = {
      schema_version: 1,
      recommendation_version: 1,
      mode: 'manual',
      preferred_view: 'chart',
      chart_type: 'trend',
      roles: { day: 'time', dau: 'metric' },
      bindings: { x: 'day', metrics: ['dau'], ignored: [] },
      options: {
        orientation: 'vertical',
        donut: false,
        include_other: false,
        units: {},
        aggregation: {},
        trend: { forecast_points: 7, threshold: null, show_trend_line: false, show_threshold: true },
      },
    } as never;
    await service.save({ name: 'DAU 趋势', mode: 'sql', sql_text: 'SELECT 1', chart_config: trendConfig }, 'clklogapp', user);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        chart_type: 'trend',
        dsl_json: expect.stringContaining('"chart_type":"trend"'),
      }),
    );
  });

  it('rejects unknown trend option keys', async () => {
    const bad = {
      schema_version: 1,
      recommendation_version: 1,
      mode: 'manual',
      preferred_view: 'chart',
      chart_type: 'trend',
      roles: {},
      bindings: { metrics: [] },
      options: { orientation: 'vertical', donut: false, include_other: false, units: {}, aggregation: {}, trend: { evil: 1 } },
    } as never;
    await expect(
      service.save({ name: 'x', mode: 'sql', sql_text: 'SELECT 1', chart_config: bad }, 'clklogapp', user),
    ).rejects.toThrow('不支持的 trend options: evil');
  });

  it('update keeps config when omitted and clears when explicitly null', async () => {
    const existing = {
      card_id: 'c1',
      project_name: 'clklogapp',
      owner: 'u1',
      type: 'sql',
      dsl_json: JSON.stringify({ mode: 'sql', sql_text: 'SELECT 1', chart_config: chartConfig }),
    };
    repo.findById.mockResolvedValue({
      ...existing,
      name: '趋势',
      created_at: new Date(),
      updated_at: new Date(),
    });
    repo.update.mockResolvedValue({});
    await service.update('c1', { name: '趋势', mode: 'sql' }, 'clklogapp', user, {
      platform_role: 'none',
      member: true,
      role_key: 'analyst',
      permissions: new Set(['model.sql']),
      data_scope: emptyScope(false),
      group_ids: [],
    });
    const kept = JSON.parse(repo.update.mock.calls[0][1].dsl_json);
    expect(kept.chart_config.chart_type).toBe('bar');
    await service.update('c1', { name: '趋势', mode: 'sql', chart_config: null }, 'clklogapp', user, {
      platform_role: 'none',
      member: true,
      role_key: 'analyst',
      permissions: new Set(['model.sql']),
      data_scope: emptyScope(false),
      group_ids: [],
    });
    const cleared = JSON.parse(repo.update.mock.calls[1][1].dsl_json);
    expect(cleared.chart_config).toBeNull();
    expect(repo.update.mock.calls[1][1].chart_type).toBe('table');
  });

  it('get returns v1 config and does not 500 on bad JSON chart_config', async () => {
    repo.findById.mockResolvedValue({
      card_id: 'c1',
      project_name: 'clklogapp',
      owner: 'u1',
      type: 'sql',
      name: '旧卡',
      dsl_json: JSON.stringify({ mode: 'sql', sql_text: 'SELECT 1', chart_config: { nope: true } }),
      created_at: new Date(),
      updated_at: new Date(),
    });
    const detail = await service.get('c1', 'clklogapp', user, {
      platform_role: 'none',
      member: true,
      role_key: 'analyst',
      permissions: new Set(['model.sql', 'dashboard.view_all']),
      data_scope: emptyScope(false),
      group_ids: [],
    });
    expect(detail.chart_config).toBeNull();
  });

  it('rejects illegal config on save', async () => {
    const rejected = service.save(
      { name: 'x', mode: 'sql', chart_config: { schema_version: 1, option: {} } as never },
      'clklogapp',
      user,
    );
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 400, errorCode: 'report.chart.fieldUnsupported' });
  });
});

describe('SqlReportService cohort SQL', () => {
  let service: SqlReportService;
  let clickHouse: { querySql: jest.Mock };
  let guard: { guard: jest.Mock; tableFilterSetting: jest.Mock };
  let cohortBatches: { resolve: jest.Mock };

  beforeEach(async () => {
    clickHouse = {
      querySql: jest.fn().mockResolvedValue({
        query_id: 'q1',
        columns: [],
        rows: [],
        read_rows: 0,
        read_bytes: 0,
      }),
    };
    guard = {
      guard: jest.fn((sql: string) => sql),
      tableFilterSetting: jest.fn(() => '{}'),
    };
    cohortBatches = {
      resolve: jest.fn().mockResolvedValue({ batch_id: 'b_ready', ready: true }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SqlReportService,
        { provide: CardRepository, useValue: { create: jest.fn(), update: jest.fn(), findById: jest.fn() } },
        { provide: ClickHouseService, useValue: clickHouse },
        { provide: SqlAstGuardService, useValue: guard },
        { provide: CohortBatchService, useValue: cohortBatches },
        { provide: TagBatchService, useValue: { resolve: jest.fn().mockResolvedValue({ batch_id: 'tag_batch', ready: true }) } },
        {
          provide: SubjectService,
          useValue: {
            expr: jest.fn().mockResolvedValue("if(user_key != '', user_key, distinct_id)"),
            resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_user', kind: 'preset' }),
          },
        },
        { provide: AssetPolicyService, useValue: { loadCard: jest.fn().mockResolvedValue({}), assert: jest.fn(), canUpdate: jest.fn().mockResolvedValue(true) } },
        { provide: DataScopeService, useValue: { applyToEventsQuery: () => ({ extraAnd: null }) } },
        { provide: TimeScopeService, useValue: new TimeScopeService(new TimezoneService(undefined)) },
      ],
    }).compile();
    service = moduleRef.get(SqlReportService);
  });

  it('builder generates members IN subquery and uid uniq, not event-rule SQL', async () => {
    await service.execute(
      {
        mode: 'builder',
        dsl: {
          event: 'AppStart',
          groups: [{ kind: 'cohort', prop: 'cohort_abc123xxxx' }],
          metrics: [{ fn: 'uniq' }],
          filters: { logic: 'and', items: [{ scope: 'cohort', prop: 'cohort_abc123xxxx', op: 'in' }] },
        },
        time_range: { start: '2026-08-01', end: '2026-08-07' },
      },
      'clklogapp',
    );
    const sql = guard.guard.mock.calls[0][0] as string;
    expect(sql).toContain('sa_cohort_members');
    expect(sql).toContain("uniqExactIf(if(user_key != '', user_key, distinct_id)");
    expect(sql).toContain("batch_id = 'b_ready'");
    expect(sql).not.toContain('windowFunnel');
    expect(sql).not.toContain('definition_json');
  });

  it('builder generates tag members IN subquery and LEFT JOIN, not tag-rule SQL', async () => {
    await service.execute(
      {
        mode: 'builder',
        dsl: {
          event: 'AppStart',
          groups: [{ kind: 'tag', prop: 'tag_abc123xxxx' }],
          metrics: [{ fn: 'uniq' }],
          filters: { logic: 'and', items: [{ scope: 'tag', prop: 'tag_abc123xxxx', op: 'in', value: ['高活'] }] },
        },
        time_range: { start: '2026-08-01', end: '2026-08-07' },
      },
      'clklogapp',
    );
    const sql = guard.guard.mock.calls[0][0] as string;
    expect(sql).toContain('sa_tag_members');
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('未打标');
    expect(sql).toContain("uniqExactIf(if(user_key != '', user_key, distinct_id)");
    expect(sql).not.toContain('windowFunnel');
    expect(sql).not.toContain('definition_json');
  });

  it('expands sa_in_cohort after guard without SELECT *', async () => {
    await service.execute(
      {
        mode: 'sql',
        sql: "SELECT count() FROM sa_events WHERE sa_in_cohort('cohort_abc123xxxx')",
        time_range: { start: '2026-08-01', end: '2026-08-07' },
      },
      'clklogapp',
    );
    expect(guard.guard.mock.calls[0][0]).toContain('sa_in_cohort');
    const expanded = clickHouse.querySql.mock.calls[0][0] as string;
    expect(expanded).toContain('sa_cohort_members');
    expect(expanded).not.toContain('sa_in_cohort');
    expect(expanded).not.toContain('SELECT *');
  });

  it('dashboard handwritten filter goes into additional_table_filters', async () => {
    await service.execute(
      {
        mode: 'sql',
        sql: 'SELECT count() FROM sa_events',
        time_range: { start: '2026-08-01', end: '2026-08-07' },
      },
      'clklogapp',
      { cohortId: 'cohort_abc123xxxx', batchId: 'b_ready', op: 'in' },
    );
    expect(guard.tableFilterSetting).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'clklogapp' }),
      expect.objectContaining({
        events: expect.stringContaining('sa_cohort_members'),
        profiles: expect.stringContaining('sa_cohort_members'),
      }),
    );
    const extra = guard.tableFilterSetting.mock.calls[0][1] as { events: string };
    expect(extra.events).not.toContain('SELECT *');
  });

  it('resolves relative past_n before injecting filters and echoes the window', async () => {
    const result = await service.execute(
      {
        mode: 'sql',
        sql: 'SELECT count() FROM sa_events',
        time_range: { start: '2000-01-01', end: '2000-01-02', relative: { kind: 'past_n', n: 30 } },
      },
      'clklogapp',
    );
    const bound = guard.tableFilterSetting.mock.calls.at(-1)?.[0] as { from: string; to: string; eventsTimeExtra?: string };
    expect(bound.from).not.toBe('2000-01-01');
    // 恒等路径（未带 timezone）：宽扫=起止日、回显平台时区（phase: clklog-analytics-timezone-v1）
    expect(result.applied_time_range).toEqual({ start: bound.from, end: bound.to, timezone: 'Asia/Shanghai' });
    expect(bound.eventsTimeExtra).toBeUndefined();
    expect(bound.from < bound.to).toBe(true);
  });

  it('timezone=UTC：宽扫 ±1 天 + epoch 精确裁切，回显展示时区', async () => {
    const result = await service.execute(
      {
        mode: 'sql',
        sql: 'SELECT count() FROM sa_events',
        time_range: { start: '2026-09-16', end: '2026-09-16', timezone: 'UTC' },
      },
      'clklogapp',
    );
    const bound = guard.tableFilterSetting.mock.calls.at(-1)?.[0] as { from: string; to: string; eventsTimeExtra?: string };
    expect(bound.from).toBe('2026-09-15');
    expect(bound.to).toBe('2026-09-17');
    expect(bound.eventsTimeExtra).toBe(
      `log_time >= fromUnixTimestamp64Milli(${Date.parse('2026-09-16T00:00:00Z')})` +
        ` AND log_time < fromUnixTimestamp64Milli(${Date.parse('2026-09-17T00:00:00Z')})`,
    );
    expect(result.applied_time_range).toEqual({ start: '2026-09-16', end: '2026-09-16', timezone: 'UTC' });
  });
});
