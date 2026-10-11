import {
  buildDeletePlan,
  buildBackupSql,
  backupTableName,
  DELETE_MAX_ROWS,
  DELETE_TABLES,
  DeletePlanError,
  signConfirmToken,
  verifyConfirmToken,
} from '../../src/modules/ops/cleanup-plan';
import { DataDeleteService } from '../../src/modules/ops/data-delete.service';
import { RetentionService } from '../../src/modules/ops/retention.service';
import { ClickHouseService } from '../../src/modules/shared/clickhouse.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';
import { DomainError } from '../../src/i18n/domain-error';

/**
 * 定点删除（phase: clklog-data-management-v1.2，R4-a）。
 * 重点覆盖**护栏**：条件白名单、社区版硬拒、时间上界、token、备份失败中止、
 * 影响行数上限、mutation 并发保护、台账写入。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    clickhouse: { write: { host: '127.0.0.1', port: 8123, protocol: 'http', username: 'default', password: 'x', database: 'clklog_sa' } },
    cleanup: { enabled: true, username: 'sa_cleanup', password: 'x'.repeat(16), confirmKey: 'spec-confirm-key', backupDatabase: 'clklog_sa_bak' },
  },
}));

const TODAY = '2026-10-09';

describe('cleanup-plan：条件白名单与 SQL 构造', () => {
  it('按事件删除：SQL 必带 project_name 与时间上界，事件名参数化', () => {
    const plan = buildDeletePlan({
      kind: 'event',
      table: 'clklog_sa.sa_events',
      project: 'clklogapp',
      event: '$SignUp',
      from: '2026-01-01',
      to: '2026-06-30',
      today: TODAY,
    });
    expect(plan.sql).toBe(
      'ALTER TABLE clklog_sa.sa_events DELETE WHERE project_name = {project: String} AND event = {event: String} AND stat_date >= {from: Date} AND stat_date <= {to: Date}',
    );
    expect(plan.params).toMatchObject({ project: 'clklogapp', event: '$SignUp', from: '2026-01-01', to: '2026-06-30' });
    expect(plan.dropPartition).toBeNull();
  });

  it('社区版库硬拒（红线 1）：任何 clklog.* 表都不在白名单', () => {
    for (const table of ['clklog.log_analysis', 'clklog.user_pv_bydate']) {
      expect(() =>
        buildDeletePlan({ kind: 'project', table, project: 'clklogapp', today: TODAY }),
      ).toThrow(DeletePlanError);
      try {
        buildDeletePlan({ kind: 'project', table, project: 'clklogapp', today: TODAY });
      } catch (e) {
        expect((e as DeletePlanError).code).toBe('ops.dataDelete.communityRefused');
      }
    }
    expect(Object.keys(DELETE_TABLES).every((t) => t.startsWith('clklog_sa.'))).toBe(true);
  });

  it('时间上界不得晚于今天；before 也不得晚于今天（未来数据要走 future 条件）', () => {
    expect(() =>
      buildDeletePlan({ kind: 'project', table: 'clklog_sa.sa_events', project: 'clklogapp', to: '2026-12-31', today: TODAY }),
    ).toThrow(/to 不得晚于今天/);
    expect(() =>
      buildDeletePlan({ kind: 'before', table: 'clklog_sa.sa_events', project: 'clklogapp', before: '2027-01-01', today: TODAY }),
    ).toThrow(/before 不得晚于今天/);
  });

  it('未来时间戳条件：只允许 sa_events，且用 > today（不使用 DROP PARTITION）', () => {
    const plan = buildDeletePlan({ kind: 'future', table: 'clklog_sa.sa_events', project: 'clklogapp', today: TODAY });
    expect(plan.sql).toContain('stat_date > {today: Date}');
    expect(plan.sql.startsWith('ALTER TABLE clklog_sa.sa_events DELETE')).toBe(true);
    expect(plan.params.today).toBe(TODAY);
    expect(() =>
      buildDeletePlan({ kind: 'future', table: 'clklog_sa.sa_user_profiles', project: 'clklogapp', today: TODAY }),
    ).toThrow(DeletePlanError);
  });

  it('分区键是项目名的表走 DROP PARTITION（分区名先按格式校验）', () => {
    const plan = buildDeletePlan({ kind: 'project', table: 'clklog_sa.sa_cohort_members', project: 'clklogapp', today: TODAY });
    expect(plan.sql).toBe("ALTER TABLE clklog_sa.sa_cohort_members DROP PARTITION 'clklogapp'");
    expect(plan.params).toEqual({});
    expect(plan.dropPartition).toBe('clklogapp');
    expect(() =>
      buildDeletePlan({ kind: 'project', table: 'clklog_sa.sa_cohort_members', project: "x'; DROP TABLE t --", today: TODAY }),
    ).toThrow(/项目名格式非法/);
  });

  it('不支持的条件组合被拒（如 sa_user_profiles 按事件删）', () => {
    expect(() =>
      buildDeletePlan({ kind: 'event', table: 'clklog_sa.sa_user_profiles', project: 'clklogapp', event: 'Buy', today: TODAY }),
    ).toThrow(/不支持该删除条件/);
  });

  it('备份 SQL：结构复制 + 同条件 INSERT SELECT；备份表名带时间戳', () => {
    const plan = buildDeletePlan({ kind: 'before', table: 'clklog_sa.sa_events', project: 'clklogapp', before: '2026-04-01', today: TODAY });
    const backup = buildBackupSql(plan, 'clklog_sa_bak.sa_events_20261009120000');
    expect(backup.create).toBe('CREATE TABLE IF NOT EXISTS clklog_sa_bak.sa_events_20261009120000 AS clklog_sa.sa_events');
    expect(backup.insert).toContain('INSERT INTO clklog_sa_bak.sa_events_20261009120000 SELECT * FROM clklog_sa.sa_events WHERE');
    expect(backup.insert).toContain('project_name = {project: String}');
    expect(backupTableName('clklog_sa.sa_events', new Date('2026-10-09T12:00:00Z'))).toBe('clklog_sa_bak.sa_events_20261009120000');
  });

  it('确认 token：绑定条件与行数，5 分钟过期', () => {
    const key = 'k';
    const t0 = new Date('2026-10-09T10:00:00Z');
    const token = signConfirmToken('summary-a', 100, key, t0);
    expect(verifyConfirmToken(token, 'summary-a', 100, key, t0)).toBe(true);
    // 条件变化 → 失效
    expect(verifyConfirmToken(token, 'summary-b', 100, key, t0)).toBe(false);
    // 行数变化 → 失效
    expect(verifyConfirmToken(token, 'summary-a', 101, key, t0)).toBe(false);
    // 超过 5 分钟 → 失效
    expect(verifyConfirmToken(token, 'summary-a', 100, key, new Date(t0.getTime() + 5 * 60_000 + 1))).toBe(false);
    // 换密钥 → 失效
    expect(verifyConfirmToken(token, 'summary-a', 100, 'other', t0)).toBe(false);
  });

  it('样例列的别名不得与真实列同名（别名遮蔽会让 WHERE 里的日期比较报类型错）', () => {
    // 回归：`toString(stat_date) AS stat_date` 曾让 kind=before/future/event+to 的预演全部 500
    for (const [table, spec] of Object.entries(DELETE_TABLES)) {
      for (const col of spec.sampleColumns) {
        const alias = /\s+AS\s+(\w+)/i.exec(col)?.[1];
        if (!alias) continue;
        expect(alias).not.toBe(spec.timeColumn);
        expect(alias).not.toBe('project_name');
        expect(`${table}:${col}`).toContain('AS');
      }
    }
  });

  it('影响行数上限常量为 500 万（分批建议的判据）', () => {
    expect(DELETE_MAX_ROWS).toBe(5_000_000);
  });
});

// ---------- 服务层护栏 ----------

type CkMock = {
  query: jest.Mock;
  cleanupCommand: jest.Mock;
  cleanupEnabled: jest.Mock;
  countPendingMutations: jest.Mock;
  latestMutationId: jest.Mock;
};

function harness(opts: { rows?: number; backupRows?: number; cleanupEnabled?: boolean; runningMutations?: number } = {}) {
  const ck: CkMock = {
    query: jest.fn(async (sql: string) => {
      // 备份行数校验的 SQL 也含 "count() AS rows FROM"，必须先判 bak 库
      if (sql.includes('clklog_sa_bak')) return [{ rows: String(opts.backupRows ?? opts.rows ?? 10) }];
      if (sql.includes('count() AS rows FROM ')) return [{ rows: String(opts.rows ?? 10) }];
      if (sql.includes('min(stat_date)')) return [{ min_d: '2026-01-01', max_d: '2026-03-31' }];
      if (sql.startsWith('SELECT event')) return [{ event: 'Buy', distinct_id: 'u1', stat_date: '2026-02-01' }];
      if (sql.includes('system.mutations') && sql.includes('NOT is_done')) return [{ n: '0' }];
      if (sql.includes('system.mutations')) return [{ id: '42' }];
      return [];
    }),
    cleanupCommand: jest.fn(async () => undefined),
    cleanupEnabled: jest.fn(() => opts.cleanupEnabled ?? true),
    // system.mutations 探测走受限通道（不走 query()，见 ClickHouseService 注释）
    countPendingMutations: jest.fn(async () => opts.runningMutations ?? 0),
    latestMutationId: jest.fn(async () => '42'),
  };
  const prisma = {
    opsActionLog: { create: jest.fn(async () => ({ id: 7n })), update: jest.fn(async () => ({})) },
    opsCleanupLedger: { create: jest.fn(async () => ({ id: 11n })) },
    reconcileSnapshot: {
      findFirst: jest.fn(async () => ({
        id: 10n,
        range_from: '2026-01-01',
        range_to: '2026-12-31',
        summary: { has_alert: false },
        ran_at: new Date(),
      })),
    },
  };
  const retention = new RetentionService(prisma as unknown as PrismaService, ck as unknown as ClickHouseService);
  const service = new DataDeleteService(
    ck as unknown as ClickHouseService,
    prisma as unknown as PrismaService,
    retention,
  );
  // mock 对象按 any 暴露：jest.fn 的 calls 元组在严格模式下推断为 []，断言处需要宽松类型
  return { service, ck: ck as any, prisma: prisma as any, retention };
}

describe('DataDeleteService：执行护栏', () => {
  it('预演返回影响面 + 前置对拍 + token（不写任何数据）', async () => {
    const { service, ck, prisma } = harness({ rows: 123 });
    const out = await service.preview({ kind: 'before', table: 'clklog_sa.sa_events', project: 'clklogapp', before: '2026-04-01' });
    expect(out.rows).toBe(123);
    expect(out.min_date).toBe('2026-01-01');
    expect(out.confirm_token).toBeTruthy();
    expect(out.cleanup_enabled).toBe(true);
    expect(out.preflight.ok).toBe(true);
    expect(prisma.opsActionLog.create).not.toHaveBeenCalled();
    expect(ck.cleanupCommand).not.toHaveBeenCalled();
  });

  it('清洗账号未配置 → 执行被拒且不备份、不删（不回退高权账号）', async () => {
    const { service, ck } = harness({ cleanupEnabled: false });
    await expect(
      service.execute({
        kind: 'before',
        table: 'clklog_sa.sa_events',
        project: 'clklogapp',
        before: '2026-04-01',
        confirm_table: 'clklog_sa.sa_events',
        confirm_token: 'x',
        operator: 'admin',
      }),
    ).rejects.toMatchObject({ errorCode: 'ops.dataDelete.cleanupAccountMissing' });
    expect(ck.cleanupCommand).not.toHaveBeenCalled();
  });

  it('确认表名不匹配 → 400；token 无效 → 400；社区版表 → 400', async () => {
    const { service } = harness({ rows: 5 });
    const base = { kind: 'before' as const, project: 'clklogapp', before: '2026-04-01', operator: 'admin' };
    await expect(
      service.execute({ ...base, table: 'clklog_sa.sa_events', confirm_table: 'other', confirm_token: 'x' }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      service.execute({ ...base, table: 'clklog_sa.sa_events', confirm_table: 'clklog_sa.sa_events', confirm_token: 'bad' }),
    ).rejects.toMatchObject({ errorCode: 'ops.dataDelete.tokenInvalid' });
    await expect(
      service.execute({ ...base, table: 'clklog.log_analysis', confirm_table: 'clklog.log_analysis', confirm_token: 'x' }),
    ).rejects.toMatchObject({ errorCode: 'ops.dataDelete.communityRefused' });
  });

  it('影响行数超上限 → 拒绝并给分批建议；零命中 → 拒绝', async () => {
    const big = harness({ rows: DELETE_MAX_ROWS + 1 });
    await expect(
      big.service.execute({
        kind: 'before',
        table: 'clklog_sa.sa_events',
        project: 'clklogapp',
        before: '2026-04-01',
        confirm_table: 'clklog_sa.sa_events',
        confirm_token: 'x',
        operator: 'admin',
      }),
    ).rejects.toBeInstanceOf(DomainError);

    const none = harness({ rows: 0 });
    await expect(
      none.service.execute({
        kind: 'before',
        table: 'clklog_sa.sa_events',
        project: 'clklogapp',
        before: '2026-04-01',
        confirm_table: 'clklog_sa.sa_events',
        confirm_token: 'x',
        operator: 'admin',
      }),
    ).rejects.toMatchObject({ errorCode: 'ops.dataDelete.nothingToDelete' });
  });

  it('备份行数校验必须带 project_name（否则被红线守卫拦下、表现成备份失败）', async () => {
    const { service, ck } = harness({ rows: 20 });
    const preview = await service.preview({ kind: 'before', table: 'clklog_sa.sa_events', project: 'clklogapp', before: '2026-04-01' });
    await service.execute({
      kind: 'before', table: 'clklog_sa.sa_events', project: 'clklogapp', before: '2026-04-01',
      confirm_table: 'clklog_sa.sa_events', confirm_token: preview.confirm_token!, operator: 'admin',
    });
    const backupCheck = ck.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes('FROM clklog_sa_bak.') && String(c[0]).includes('count()'));
    expect(backupCheck).toHaveLength(1);
    expect(String(backupCheck[0][0])).toContain('project_name = {project: String}');
    expect(backupCheck[0][1]).toMatchObject({ project: 'clklogapp' });
  });

  it('正常路径：token 正确 → 备份 → 删除 → 审计 + 清理登记（带备份表名与 mutation id）', async () => {
    const { service, ck, prisma } = harness({ rows: 50 });
    const preview = await service.preview({ kind: 'before', table: 'clklog_sa.sa_events', project: 'clklogapp', before: '2026-04-01' });
    const out = await service.execute({
      kind: 'before',
      table: 'clklog_sa.sa_events',
      project: 'clklogapp',
      before: '2026-04-01',
      confirm_table: 'clklog_sa.sa_events',
      confirm_token: preview.confirm_token!,
      operator: 'admin',
    });

    expect(out.rows_planned).toBe(50);
    expect(out.mode).toBe('alter_delete');
    expect(out.backup_table).toContain('clklog_sa_bak.sa_events_');
    expect(out.mutation_id).toBe('42');
    expect(out.ledger_id).toBe('11');
    // 调用顺序：create → insert → ALTER DELETE
    const calls = ck.cleanupCommand.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toContain('CREATE TABLE IF NOT EXISTS clklog_sa_bak.');
    expect(calls[1]).toContain('INSERT INTO clklog_sa_bak.');
    expect(calls[2]).toContain('ALTER TABLE clklog_sa.sa_events DELETE WHERE');
    // 审计：先 running 再 done
    expect(prisma.opsActionLog.create.mock.calls[0][0].data.action).toBe('delete_rows');
    expect(prisma.opsActionLog.create.mock.calls[0][0].data.status).toBe('running');
    expect(prisma.opsActionLog.update.mock.calls[0][0].data.status).toBe('done');
    // 清理登记：range 用预演出的真实日期范围（不是条件里的 9999）
    expect(prisma.opsCleanupLedger.create.mock.calls[0][0].data).toMatchObject({
      target_db: 'clklog_sa',
      target_table: 'sa_events',
      scope_type: 'rows',
      range_from: '2026-01-01',
      range_to: '2026-03-31',
      action: 'delete_rows',
    });
  });

  it('备份行数不足 → 中止且不执行删除', async () => {
    const { service, ck, prisma } = harness({ rows: 100, backupRows: 3 });
    const preview = await service.preview({ kind: 'before', table: 'clklog_sa.sa_events', project: 'clklogapp', before: '2026-04-01' });
    await expect(
      service.execute({
        kind: 'before',
        table: 'clklog_sa.sa_events',
        project: 'clklogapp',
        before: '2026-04-01',
        confirm_table: 'clklog_sa.sa_events',
        confirm_token: preview.confirm_token!,
        operator: 'admin',
      }),
    ).rejects.toMatchObject({ errorCode: 'ops.dataDelete.backupFailed' });
    const calls = ck.cleanupCommand.mock.calls.map((c) => String(c[0]));
    expect(calls.some((sql) => sql.includes('ALTER TABLE clklog_sa.sa_events DELETE'))).toBe(false);
    expect(prisma.opsActionLog.create).not.toHaveBeenCalled();
  });

  it('mutation 探测走受限系统表通道（不走 query()，避免被 project_name 守卫拦下误判）', async () => {
    const { service, ck } = harness({ rows: 10 });
    const preview = await service.preview({ kind: 'before', table: 'clklog_sa.sa_events', project: 'clklogapp', before: '2026-04-01' });
    await service.execute({
      kind: 'before', table: 'clklog_sa.sa_events', project: 'clklogapp', before: '2026-04-01',
      confirm_table: 'clklog_sa.sa_events', confirm_token: preview.confirm_token!, operator: 'admin',
    });
    expect(ck.countPendingMutations).toHaveBeenCalledWith('clklog_sa', 'sa_events');
    expect(ck.latestMutationId).toHaveBeenCalledWith('clklog_sa', 'sa_events');
    // query() 不得再被用于 system.mutations（那会触发 ensureProjectFilter 抛错）
    const viaQuery = ck.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes('system.mutations'));
    expect(viaQuery).toHaveLength(0);
  });

  it('目标表有未完成 mutation → 409（IO 保护）', async () => {
    const { service } = harness({ rows: 10, runningMutations: 2 });
    const preview = await service.preview({ kind: 'before', table: 'clklog_sa.sa_events', project: 'clklogapp', before: '2026-04-01' });
    await expect(
      service.execute({
        kind: 'before',
        table: 'clklog_sa.sa_events',
        project: 'clklogapp',
        before: '2026-04-01',
        confirm_table: 'clklog_sa.sa_events',
        confirm_token: preview.confirm_token!,
        operator: 'admin',
      }),
    ).rejects.toMatchObject({ errorCode: 'ops.dataDelete.mutationRunning' });
  });

  it('覆盖要求有时效边界：历史窗口（早于近 30 天）不要求覆盖，只要求新鲜通过快照', async () => {
    // 快照只覆盖「昨天」，而被删窗口在 2026-07-30（远早于近 30 天）→ 不应因未覆盖被拒
    const { service } = harness({ rows: 2 });
    const out = await service.preview({
      kind: 'event',
      table: 'clklog_sa.sa_events',
      project: 'clklogapp',
      event: '$undefined',
      // harness 的 min/max 固定为 2026-01-01~2026-03-31（早于近 30 天）
    });
    expect(out.preflight.ok).toBe(true);
    expect(out.confirm_token).toBeTruthy();
  });

  it('未来时间戳条件天然豁免覆盖要求（快照不可能覆盖未来日期）', async () => {
    const { service, ck } = harness({ rows: 5 });
    ck.query.mockImplementation(async (sql: string) => {
      if (sql.includes('min(stat_date)')) return [{ min_d: '2026-11-01', max_d: '2026-11-08' }];
      if (sql.includes('count() AS rows FROM ')) return [{ rows: '5' }];
      if (sql.includes('NOT is_done')) return [{ n: '0' }];
      return [];
    });
    const out = await service.preview({ kind: 'future', table: 'clklog_sa.sa_events', project: 'clklogapp' });
    expect(out.preflight.ok).toBe(true);
  });

  it('近窗口（在时效边界内）未被快照覆盖 → 前置对拍不通过', async () => {
    const { service, prisma, ck } = harness({ rows: 10 });
    // 被删窗口落在近 30 天内 → 要求覆盖；快照只覆盖很久以前 → 不覆盖
    const today = new Date().toISOString().slice(0, 10);
    ck.query.mockImplementation(async (sql: string) => {
      if (sql.includes('min(stat_date)')) return [{ min_d: today, max_d: today }];
      if (sql.includes('count() AS rows FROM ')) return [{ rows: '10' }];
      if (sql.includes('NOT is_done')) return [{ n: '0' }];
      return [];
    });
    prisma.reconcileSnapshot.findFirst.mockResolvedValue({
      id: 11n,
      range_from: '2025-01-01',
      range_to: '2025-01-02',
      summary: { has_alert: false },
      ran_at: new Date(),
    });
    const preview = await service.preview({ kind: 'before', table: 'clklog_sa.sa_events', project: 'clklogapp', before: '2026-04-01' });
    expect(preview.preflight.ok).toBe(false);
  });
});
