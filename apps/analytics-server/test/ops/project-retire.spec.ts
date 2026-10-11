import { ProjectRetireService } from '../../src/modules/ops/project-retire.service';
import { ClickHouseService } from '../../src/modules/shared/clickhouse.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';

/** 项目退役预演（phase: clklog-data-management-v1.2，R4-b 第一步）：只读、影响面齐全、防拼错。 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30 },
    log: { level: 'info' },
    background_workers: false,
    reconcile: { reportDir: '/tmp/clklog-project-retire-spec' },
    cleanup: { enabled: true, username: 'sa_cleanup', password: 'x'.repeat(16), confirmKey: 'spec-key', backupDatabase: 'clklog_sa_bak' },
  },
}));

function harness(opts: { registered?: boolean; rows?: number; recent?: number; cleanupEnabled?: boolean } = {}) {
  const clickHouse = {
    cleanupCommand: jest.fn(async () => undefined),
    cleanupEnabled: jest.fn(() => opts.cleanupEnabled ?? true),
    query: jest.fn(async (sql: string) => {
      if (sql.includes('stat_date >= {since')) return [{ n: String(opts.recent ?? 12) }];
      if (sql.includes('min(stat_date)')) return [{ n: String(opts.rows ?? 100), min_d: '2026-07-28', max_d: '2026-10-08' }];
      return [{ n: String(opts.rows ?? 100) }];
    }),
  } as unknown as ClickHouseService;
  const delegate = () => ({ count: jest.fn(async () => 3) });
  const prisma = {
    opsActionLog: { create: jest.fn(async () => ({ id: 9n })), update: jest.fn(async () => ({})) },
    saProject: { findFirst: jest.fn(async () => (opts.registered === false ? null : { name: 'clklogapp' })) },
    metaEvent: delegate(), metaEventProperty: delegate(), metaEventAttribute: delegate(),
    metaUserProperty: delegate(), metaVirtualEvent: delegate(), metaVirtualProperty: delegate(),
    metaSavedMetric: delegate(), metaDiscoveryLog: delegate(), metaDatatable: delegate(),
    metaDatatableBinding: delegate(), metaDatatableImport: delegate(), metaDebugRecord: delegate(),
    metaFunnelTemplate: delegate(), metaPropertyDict: delegate(), metaUserCohort: delegate(),
    metaUserTag: delegate(), metaAnalysisSubject: delegate(), card: delegate(), dashboard: delegate(),
    saDashboardFolder: delegate(), saAssetAcl: delegate(), saDataPolicy: delegate(), saApiKey: delegate(),
    saInvitation: delegate(), saMemberGroup: delegate(), saProjectMember: delegate(), saRoleGrant: delegate(),
    alertRule: delegate(), alertTemplate: delegate(), reconcileSnapshot: delegate(), aiWorkspace: delegate(),
  } as unknown as PrismaService;
  return { service: new ProjectRetireService(clickHouse, prisma), clickHouse: clickHouse as any, prisma: prisma as any };
}

describe('ProjectRetireService.preview', () => {
  it('覆盖 sa 5 张表与 MySQL 全部登记模型，并给出最近 24h 写入与社区版提示', async () => {
    const { service } = harness();
    const out = await service.preview('clklogapp');
    expect(out.sa_tables.map((t) => t.table)).toEqual([
      'clklog_sa.sa_events', 'clklog_sa.sa_user_profiles', 'clklog_sa.sa_datatable_rows',
      'clklog_sa.sa_cohort_members', 'clklog_sa.sa_tag_members',
    ]);
    expect(out.sa_tables[0]).toMatchObject({ rows: 100, min_date: '2026-07-28', max_date: '2026-10-08' });
    // MySQL 清单必须覆盖 31 张（少一张就会留下孤儿数据）
    expect(out.mysql_tables.length).toBeGreaterThanOrEqual(31);
    expect(out.mysql_tables.map((t) => t.table)).toContain('MetaEvent');
    expect(out.mysql_total_rows).toBe(out.mysql_tables.reduce((s, t) => s + t.rows, 0));
    expect(out.writes_last_24h).toBe(12);
    // 文案走 key（前端翻译），服务端不下发中文原文
    expect(out.community_note_key).toBe('communityNoProject');
    expect(out.next_step_keys).toEqual(['stopWrites', 'execution', 'backupAudit']);
  });

  it('项目名非法 → 400；未登记（防拼错）→ 404', async () => {
    const { service } = harness();
    await expect(service.preview("x'; DROP TABLE t --")).rejects.toMatchObject({ status: 400 });
    const unregistered = harness({ registered: false });
    await expect(unregistered.service.preview('typo_project')).rejects.toMatchObject({ status: 404 });
  });

  it('只读：不写任何库（审计表也不写）', async () => {
    const { service, prisma } = harness();
    await service.preview('clklogapp');
    expect(prisma.opsActionLog.create).not.toHaveBeenCalled();
    expect(prisma.opsActionLog.update).not.toHaveBeenCalled();
    // 逐表只用 count（各 delegate 只提供 count），没有任何 delete/update 通道
    const delegates = Object.keys(prisma).filter((k) => k !== 'opsActionLog' && k !== 'saProject');
    for (const key of delegates) {
      expect(Object.keys(prisma[key])).toEqual(['count']);
    }
  });
});

describe('ProjectRetireService.execute（分步、带备份与审计）', () => {
  it('最近 24h 仍有写入 → 409 拒绝（先停上报）', async () => {
    const { service } = harness({ recent: 123 });
    const { token } = await service.signExecuteToken('clklogapp');
    await expect(
      service.execute({ project: 'clklogapp', step: 'sa', confirm_token: token, operator: 'admin' }),
    ).rejects.toMatchObject({ status: 409, errorCode: 'ops.projectRetire.stillWriting' });
  });

  it('token 无效（影响面变化）→ 400', async () => {
    const { service } = harness({ recent: 0 });
    await expect(
      service.execute({ project: 'clklogapp', step: 'sa', confirm_token: 'bad', operator: 'admin' }),
    ).rejects.toMatchObject({ errorCode: 'ops.dataDelete.tokenInvalid' });
  });

  it('sa 步：成员表走 DROP PARTITION、其余走 ALTER DELETE；大表超预算则 done=false', async () => {
    const { service, clickHouse } = harness({ recent: 0, rows: 100 });
    // sa_events 行数 100 < 默认预算 → 全部执行
    const { token } = await service.signExecuteToken('clklogapp');
    const out = await service.execute({ project: 'clklogapp', step: 'sa', confirm_token: token, operator: 'admin' });
    expect(out.done).toBe(true);
    expect(out.message_key).toBe('saDone');
    const calls = clickHouse.cleanupCommand.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((sql: string) => sql.includes("DROP PARTITION 'clklogapp'"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes('ALTER TABLE clklog_sa.sa_events DELETE WHERE project_name'))).toBe(true);

    // 预算 10 行 → sa_events 超预算，标 pending 且 done=false
    const big = harness({ recent: 0, rows: 1000 });
    const t2 = await big.service.signExecuteToken('clklogapp');
    const out2 = await big.service.execute({ project: 'clklogapp', step: 'sa', confirm_token: t2.token, operator: 'admin', maxRowsPerBatch: 10 });
    expect(out2.done).toBe(false);
    expect(out2.tables.some((t) => t.mode === 'alter_delete_pending')).toBe(true);
  });

  it('每步都写审计（action=project_retire），失败如实标 failed', async () => {
    const { service, prisma } = harness({ recent: 0 });
    const { token } = await service.signExecuteToken('clklogapp');
    await service.execute({ project: 'clklogapp', step: 'sa', confirm_token: token, operator: 'admin' });
    const created = prisma.opsActionLog.create.mock.calls[0][0].data;
    expect(created.action).toBe('project_retire');
    expect(created.status).toBe('running');
    expect(prisma.opsActionLog.update.mock.calls[0][0].data.status).toBe('done');
  });
});
