/**
 * CardService 单测（RBAC + 全局卡片/看板关联重设计）。
 */
// 顶层加载 YAML 配置的模块（clickhouse/card 服务等）在单测里隔离，CI 无密钥也能跑
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DomainError } from '../../src/i18n/domain-error';
import { CardService } from '../../src/modules/report/card.service';
import { CardRepository } from '../../src/modules/report/card.repository';
import { DashboardRepository } from '../../src/modules/report/dashboard.repository';
import { EventQueryService } from '../../src/modules/query/event-query.service';
import { FunnelQueryService } from '../../src/modules/query/funnel-query.service';
import { RetentionQueryService } from '../../src/modules/query/retention-query.service';
import { SqlReportService } from '../../src/modules/report/sql-report.service';
import { CohortBatchService } from '../../src/modules/query/cohort-batch.service';
import { AssetPolicyService } from '../../src/modules/iam/asset-policy.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';
import { MetricEvalService } from '../../src/modules/query/metric-eval.service';
import type { AuthUser } from '../../src/modules/auth/auth.service';
import { emptyScope, type IamContext } from '../../src/modules/iam/iam.types';

describe('CardService（全局卡片 + 看板关联）', () => {
  let service: CardService;
  let repo: {
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    findById: jest.Mock;
    findByName: jest.Mock;
    findDashboardCards: jest.Mock;
    findLink: jest.Mock;
    addLink: jest.Mock;
    updateLink: jest.Mock;
    removeLink: jest.Mock;
    saveLayouts: jest.Mock;
    upsertCache: jest.Mock;
  };
  let dashboardRepo: { findById: jest.Mock };
  let eventQuery: { analyze: jest.Mock };
  let funnelQuery: { analyze: jest.Mock };
  let retentionQuery: { analyze: jest.Mock };
  let sqlReport: { executeFromCardDsl: jest.Mock };
  let cohortBatches: { resolve: jest.Mock };
  // 指标卡（v3）：读 metasavedmetric + 复用指标求值
  let prisma: { metaSavedMetric: { findFirst: jest.Mock } };
  let metricEval: { evaluateEvent: jest.Mock };

  const analyst: AuthUser = { id: 'u1', username: 'a1', display_name: null, platform_role: 'none' };
  const otherUser: AuthUser = { id: 'u2', username: 'a2', display_name: null, platform_role: 'none' };
  const iam: IamContext = {
    platform_role: 'none',
    member: true,
    role_key: 'analyst',
    permissions: new Set(['dashboard.view', 'dashboard.view_all', 'dashboard.edit', 'model.card_save']),
    data_scope: emptyScope(false),
    group_ids: [],
  };
  const ownDashboard = { db_id: 'd1', owner: 'u1' };
  const ownCard = {
    card_id: 'c1',
    project_name: 'clklogapp',
    owner: 'u1',
    name: 'PV 卡片',
    type: 'event',
    dsl_json: JSON.stringify({ event: 'PageView' }),
    chart_type: 'line',
    refresh_policy: 'auto',
    dashboard_cards: [],
  };

  beforeEach(async () => {
    repo = {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findById: jest.fn(),
      findByName: jest.fn().mockResolvedValue(null),
      findDashboardCards: jest.fn().mockResolvedValue([]),
      findLink: jest.fn(),
      addLink: jest.fn(),
      updateLink: jest.fn(),
      removeLink: jest.fn(),
      saveLayouts: jest.fn(),
      upsertCache: jest.fn(),
    };
    dashboardRepo = { findById: jest.fn() };
    eventQuery = { analyze: jest.fn() };
    funnelQuery = { analyze: jest.fn() };
    retentionQuery = { analyze: jest.fn() };
    sqlReport = { executeFromCardDsl: jest.fn() };
    cohortBatches = { resolve: jest.fn() };
    prisma = { metaSavedMetric: { findFirst: jest.fn() } };
    metricEval = { evaluateEvent: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CardService,
        { provide: CardRepository, useValue: repo },
        { provide: DashboardRepository, useValue: dashboardRepo },
        { provide: EventQueryService, useValue: eventQuery },
        { provide: FunnelQueryService, useValue: funnelQuery },
        { provide: RetentionQueryService, useValue: retentionQuery },
        { provide: SqlReportService, useValue: sqlReport },
        { provide: CohortBatchService, useValue: cohortBatches },
        { provide: PrismaService, useValue: prisma },
        { provide: MetricEvalService, useValue: metricEval },
        {
          provide: AssetPolicyService,
          useValue: {
            loadDashboard: jest.fn().mockResolvedValue({ type: 'dashboard', id: 'd1', ownerId: 'u1', locked: false, folderIds: [] }),
            loadCard: jest.fn().mockImplementation(async (_p: string, id: string) => ({
              type: 'card',
              id,
              ownerId: id === ownCard.card_id ? 'u1' : 'u1',
              locked: false,
              folderIds: [],
            })),
            assert: jest.fn(async (uid: string) => {
              if (uid !== 'u1') throw new ForbiddenException('无权访问该资源');
            }),
            canUpdate: jest.fn(async (uid: string) => uid === 'u1'),
            hasViewGrant: jest.fn().mockResolvedValue(false),
            grantCount: jest.fn().mockResolvedValue(0),
            effectivelyLocked: jest.fn().mockReturnValue(false),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(CardService);
  });

  it('create 创建全局卡片（不带 db_id，owner=当前用户）', async () => {
    repo.create.mockResolvedValue(ownCard);
    const res = await service.create(
      { name: 'PV 卡片', type: 'event', dsl: { event: 'PageView' } },
      'clklogapp',
      analyst,
    );
    const arg = repo.create.mock.calls[0][0];
    expect(arg.owner).toBe('u1');
    expect(arg.project_name).toBe('clklogapp');
    expect(arg.name).toBe('PV 卡片');
    expect(res.card_id).toBe('c1');
  });

  it('create 重名被拒且不落库（项目内名称唯一）', async () => {
    repo.findByName.mockResolvedValue({ card_id: 'c2' });
    const rejected = service.create(
      { name: 'PV 卡片', type: 'event', dsl: { event: 'PageView' } },
      'clklogapp',
      analyst,
    );
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 409, errorCode: 'report.card.nameExists' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('create 描述为纯空白时归一为 null', async () => {
    repo.create.mockResolvedValue(ownCard);
    await service.create(
      { name: 'PV 卡片', description: '   ', type: 'event', dsl: { event: 'PageView' } },
      'clklogapp',
      analyst,
    );
    expect(repo.create.mock.calls[0][0].description).toBeNull();
  });

  it('update 改名时查重排除自身，并写入描述', async () => {
    repo.findById.mockResolvedValue(ownCard);
    repo.update.mockResolvedValue({});
    await service.update('c1', 'clklogapp', analyst, iam, { name: 'PV 卡片2', description: '口径说明' });
    expect(repo.findByName).toHaveBeenCalledWith('clklogapp', 'PV 卡片2', 'c1');
    expect(repo.update.mock.calls[0][1]).toMatchObject({ name: 'PV 卡片2', description: '口径说明' });
  });

  it('update 改名撞已有卡名时拒绝', async () => {
    repo.findById.mockResolvedValue(ownCard);
    repo.findByName.mockResolvedValue({ card_id: 'c2' });
    const rejected = service.update('c1', 'clklogapp', analyst, iam, { name: '已有名' });
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 409, errorCode: 'report.card.nameExists' });
  });

  it('update 非 owner 拒绝', async () => {
    repo.findById.mockResolvedValue(ownCard);
    await expect(
      service.update('c1', 'clklogapp', otherUser, iam, { name: '改' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('addToDashboard 添加已有卡片到看板', async () => {
    dashboardRepo.findById.mockResolvedValue(ownDashboard);
    repo.findById.mockResolvedValue(ownCard);
    repo.findLink.mockResolvedValue(null);
    await service.addToDashboard('d1', 'clklogapp', analyst, iam, { card_id: 'c1' });
    expect(repo.addLink).toHaveBeenCalledWith(
      expect.objectContaining({ db_id: 'd1', card_id: 'c1', position_x: 0, width: 12, height: 6 }),
    );
  });

  it('addToDashboard 重复添加拒绝', async () => {
    dashboardRepo.findById.mockResolvedValue(ownDashboard);
    repo.findById.mockResolvedValue(ownCard);
    repo.findLink.mockResolvedValue({ id: 'x' });
    const rejected = service.addToDashboard('d1', 'clklogapp', analyst, iam, { card_id: 'c1' });
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 403, errorCode: 'report.card.alreadyInDashboard' });
  });

  it('removeFromDashboard 仅删关联，不删卡片', async () => {
    dashboardRepo.findById.mockResolvedValue(ownDashboard);
    repo.findLink.mockResolvedValue({ id: 'x', db_id: 'd1', card_id: 'c1' });
    await service.removeFromDashboard('c1', 'd1', 'clklogapp', analyst, iam);
    expect(repo.removeLink).toHaveBeenCalledWith('d1', 'c1');
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('refresh 按全局卡片类型分发（事件卡片）', async () => {
    dashboardRepo.findById.mockResolvedValue(ownDashboard);
    repo.findById.mockResolvedValue(ownCard);
    eventQuery.analyze.mockResolvedValue({ columns: [], rows: [], elapsed_ms: 1, sql: '' });

    const res = await service.refresh('c1', 'd1', 'clklogapp', analyst, iam);
    expect(eventQuery.analyze).toHaveBeenCalledWith({ event: 'PageView' }, 'clklogapp', true, iam.data_scope);
    expect(res.card_id).toBe('c1');
  });

  it('listByDashboard 返回卡片内容 + 布局', async () => {
    dashboardRepo.findById.mockResolvedValue(ownDashboard);
    repo.findDashboardCards.mockResolvedValue([
      {
        position_x: 0,
        position_y: 0,
        width: 6,
        height: 4,
        card: ownCard,
      },
    ]);
    const res = await service.listByDashboard('d1', 'clklogapp', analyst, iam);
    expect(res[0].name).toBe('PV 卡片');
    expect(res[0].width).toBe(6);
    expect(res[0].display).toBeNull();
  });

  it('updateDisplay writes placement json and rejects illegal views', async () => {
    dashboardRepo.findById.mockResolvedValue(ownDashboard);
    repo.findLink.mockResolvedValue({ id: 'x', db_id: 'd1', card_id: 'c1' });
    repo.findById.mockResolvedValue({ ...ownCard, type: 'retention' });
    await service.updateDisplay('c1', 'd1', 'clklogapp', analyst, iam, { view: 'people_table' });
    expect(repo.updateLink).toHaveBeenCalledWith('d1', 'c1', {
      display_json: JSON.stringify({ view: 'people_table' }),
    });
    const rejected = service.updateDisplay('c1', 'd1', 'clklogapp', analyst, iam, { view: 'line' } as never);
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 400, errorCode: 'report.card.displayViewInvalid' });
  });

  it('refresh sql 卡片调用 executeFromCardDsl', async () => {
    const sqlCard = {
      ...ownCard,
      card_id: 'c-sql',
      type: 'sql',
      dsl_json: JSON.stringify({ sql_text: 'SELECT 1 AS n', mode: 'sql' }),
    };
    dashboardRepo.findById.mockResolvedValue(ownDashboard);
    repo.findById.mockResolvedValue(sqlCard);
    sqlReport.executeFromCardDsl.mockResolvedValue({
      columns: [{ name: 'n', type: 'UInt8' }],
      rows: [{ n: 1 }],
      row_count: 1,
      truncated: false,
    });

    const res = await service.refresh('c-sql', 'd1', 'clklogapp', analyst, iam);
    expect(sqlReport.executeFromCardDsl).toHaveBeenCalledWith(
      { sql_text: 'SELECT 1 AS n', mode: 'sql' },
      'clklogapp',
      { scope: iam.data_scope },
    );
    expect(res.type).toBe('sql');
    expect(res.result).toMatchObject({ row_count: 1 });
    expect(repo.upsertCache).toHaveBeenCalled();
  });

  it('refresh text 卡片返回 400', async () => {
    dashboardRepo.findById.mockResolvedValue(ownDashboard);
    repo.findById.mockResolvedValue({ ...ownCard, type: 'text', dsl_json: JSON.stringify({ body: 'hi' }) });
    await expect(service.refresh('c1', 'd1', 'clklogapp', analyst, iam)).rejects.toThrow('标签卡无需刷新');
    expect(repo.upsertCache).not.toHaveBeenCalled();
  });

  it('refresh sql 空 SQL 由 execute 抛 400', async () => {
    dashboardRepo.findById.mockResolvedValue(ownDashboard);
    repo.findById.mockResolvedValue({
      ...ownCard,
      type: 'sql',
      dsl_json: JSON.stringify({ mode: 'sql' }),
    });
    sqlReport.executeFromCardDsl.mockRejectedValue(new BadRequestException('卡片未保存 SQL'));

    await expect(service.refresh('c1', 'd1', 'clklogapp', analyst, iam)).rejects.toThrow(BadRequestException);
  });

  it('refresh 看板分群筛选 AND 进事件 DSL', async () => {
    dashboardRepo.findById.mockResolvedValue({
      ...ownDashboard,
      cohort_filter_json: JSON.stringify({ cohort_id: 'cohort_abc123xxxx', op: 'in' }),
    });
    repo.findById.mockResolvedValue(ownCard);
    cohortBatches.resolve.mockResolvedValue({ batch_id: 'b1', ready: true });
    eventQuery.analyze.mockResolvedValue({ columns: [], rows: [], elapsed_ms: 1, sql: '' });

    await service.refresh('c1', 'd1', 'clklogapp', analyst, iam);
    expect(eventQuery.analyze).toHaveBeenCalledWith(
      {
        event: 'PageView',
        filters: { logic: 'and', items: [{ scope: 'cohort', prop: 'cohort_abc123xxxx', op: 'in' }] },
      },
      'clklogapp',
      true,
      iam.data_scope,
    );
  });

  it('refresh 看板分群未就绪抛错而非静默全表', async () => {
    dashboardRepo.findById.mockResolvedValue({
      ...ownDashboard,
      cohort_filter_json: JSON.stringify({ cohort_id: 'cohort_abc123xxxx', op: 'in' }),
    });
    repo.findById.mockResolvedValue(ownCard);
    cohortBatches.resolve.mockResolvedValue({ batch_id: '__missing__', ready: false });

    const rejected = service.refresh('c1', 'd1', 'clklogapp', analyst, iam);
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 400, errorCode: 'report.card.cohortFilterUnavailable' });
    expect(eventQuery.analyze).not.toHaveBeenCalled();
    expect(repo.upsertCache).not.toHaveBeenCalled();
  });

  it('refresh 手写 SQL 不改 sql_text，走表级过滤', async () => {
    const sqlCard = {
      ...ownCard,
      card_id: 'c-sql',
      type: 'sql',
      dsl_json: JSON.stringify({ sql_text: 'SELECT 1 AS n', mode: 'sql' }),
    };
    dashboardRepo.findById.mockResolvedValue({
      ...ownDashboard,
      cohort_filter_json: JSON.stringify({ cohort_id: 'cohort_abc123xxxx', op: 'not_in' }),
    });
    repo.findById.mockResolvedValue(sqlCard);
    cohortBatches.resolve.mockResolvedValue({ batch_id: 'b1', ready: true });
    sqlReport.executeFromCardDsl.mockResolvedValue({ columns: [], rows: [], row_count: 0, truncated: false });

    await service.refresh('c-sql', 'd1', 'clklogapp', analyst, iam);
    expect(sqlReport.executeFromCardDsl).toHaveBeenCalledWith(
      { sql_text: 'SELECT 1 AS n', mode: 'sql' },
      'clklogapp',
      {
        cohortTableFilter: { cohortId: 'cohort_abc123xxxx', batchId: 'b1', op: 'not_in' },
        scope: iam.data_scope,
      },
    );
  });

  it('refresh 未知 type 返回 400 而不是 NotFound', async () => {
    dashboardRepo.findById.mockResolvedValue(ownDashboard);
    repo.findById.mockResolvedValue({
      ...ownCard,
      type: 'unknown',
      dsl_json: '{}',
    });

    await expect(service.refresh('c1', 'd1', 'clklogapp', analyst, iam)).rejects.toThrow('未知卡片类型');
  });

  it('get 返回卡片缓存供分析页回填', async () => {
    repo.findById.mockResolvedValue({
      ...ownCard,
      cache: {
        result_json: JSON.stringify({
          columns: [{ name: 'd', type: 'Date' }],
          rows: [{ d: '2026-09-01' }],
        }),
        error: null,
        row_count: 1,
        refreshed_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const res = await service.get('c1', 'clklogapp', analyst, iam);
    expect((res.cache.result as { rows: unknown[] }).rows).toHaveLength(1);
    expect(res.cache.stale).toBe(true);
  });
describe('指标卡（card.type=metric，phase: clklog-analytics-metric-v3）', () => {
  const metricRow = {
    metric_id: 'metric_1',
    name: 'http_report_count',
    display_name: '今日 HTTP 上报事件数',
    kind: 'event',
    definition_json: JSON.stringify({ metric: { event: 'base_performance_httprequest_report', analysis: 'total_times' } }),
    project_name: 'clklogapp',
  };
  const outcome = {
    value: 42,
    series: [
      { date: '2026-09-14', value: 20 },
      { date: '2026-09-15', value: null },
      { date: '2026-09-16', value: 22 },
    ],
    window: { start: '2026-09-10', end: '2026-09-16', days: 7, label: '近 7 天', source: 'default' },
    pick: 'sum',
    pick_label: '累计',
    pick_note: '',
    pick_explicit: false,
    used_overall: true,
    elapsed_ms: 5,
  };

  it('产出分析同构结果：阶段汇总行 + 日序列，并把口径带回给界面', async () => {
    prisma.metaSavedMetric.findFirst.mockResolvedValue(metricRow);
    metricEval.evaluateEvent.mockResolvedValue(outcome);

    const result = (await service.computeResult({
      card_id: 'c9',
      type: 'metric',
      dsl_json: JSON.stringify({ metric_id: 'metric_1' }),
      project_name: 'clklogapp',
    })) as unknown as {
      columns: { key: string; title: string }[];
      rows: Record<string, unknown>[];
      metric_meta: { display_name: string; window_label: string; value_pick_label: string; cohort_applied: boolean };
    };

    expect(result.columns.map((col) => col.key)).toEqual(['g_0', 'm_0']);
    expect(result.columns[1].title).toBe('今日 HTTP 上报事件数');
    // 首行是「阶段汇总」（取值选择后的单值），其余是每日点；图表层会过滤 __stage
    expect(result.rows[0]).toMatchObject({ __stage: true, g_0: '阶段汇总', m_0: 42 });
    expect(result.rows[1]).toMatchObject({ g_0: '2026-09-14', m_0: 20 });
    expect(result.rows[2]).toMatchObject({ g_0: '2026-09-15', m_0: null });
    expect(result.metric_meta).toMatchObject({
      display_name: '今日 HTTP 上报事件数',
      window_label: '近 7 天',
      value_pick_label: '累计',
      cohort_applied: true,
    });
  });

  it('看板分群筛选对指标卡不生效：结果照常返回并标注 cohort_applied=false（AC-12）', async () => {
    prisma.metaSavedMetric.findFirst.mockResolvedValue(metricRow);
    metricEval.evaluateEvent.mockResolvedValue(outcome);

    const result = (await service.computeResult(
      { card_id: 'c9', type: 'metric', dsl_json: JSON.stringify({ metric_id: 'metric_1' }), project_name: 'clklogapp' },
      { filter: { cohort_id: 'cohort_1', op: 'in' }, batchId: 'batch_1' },
    )) as unknown as { metric_meta: { cohort_applied: boolean } };

    expect(result.metric_meta.cohort_applied).toBe(false);
    // 分群筛选不会混进指标查询 DSL
    expect(metricEval.evaluateEvent.mock.calls[0][0]).not.toHaveProperty('filters');
  });

  it('指标不存在 / 非事件指标 / 缺 metric_id → 400（不建永远空的卡）', async () => {
    prisma.metaSavedMetric.findFirst.mockResolvedValue(null);
    const rejected = service.computeResult({ card_id: 'c9', type: 'metric', dsl_json: JSON.stringify({ metric_id: 'gone' }), project_name: 'clklogapp' });
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 400, errorCode: 'report.card.metricCardMissing' });

    prisma.metaSavedMetric.findFirst.mockResolvedValue({ ...metricRow, kind: 'retention' });
    await expect(
      service.computeResult({ card_id: 'c9', type: 'metric', dsl_json: JSON.stringify({ metric_id: 'metric_1' }), project_name: 'clklogapp' }),
    ).rejects.toThrow('只支持事件指标');

    await expect(
      service.create(
        { name: '指标卡', type: 'metric', dsl: {} } as never,
        'clklogapp',
        { id: 'u1', username: 'a1', display_name: null, platform_role: 'none' } as never,
      ),
    ).rejects.toThrow('metric_id');
  });
});

});
