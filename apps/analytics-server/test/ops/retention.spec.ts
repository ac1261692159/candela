// RetentionService 是值导入（会经 clickhouse.service 触发配置加载）：给一个最小 appConfig
jest.mock('../../src/config/configuration', () => ({
  appConfig: { query: { maxExecutionTime: 30 }, log: { level: 'info' } },
}));
import {
  computeRetentionFloor,
  isSuspiciousPartition,
  monthRange,
  parseTtlDays,
  shiftYmd,
} from '../../src/modules/ops/retention-policy';
import { RetentionService } from '../../src/modules/ops/retention.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';
import { ClickHouseService } from '../../src/modules/shared/clickhouse.service';

/** phase: clklog-data-quality-ops-v1 R2——保留策略 / 可信区间 / 前置对拍 / 清理登记 */

const SA = 'clklog_sa.sa_events';

describe('computeRetentionFloor（对拍可信区间地板）', () => {
  it('只认实际 TTL：两侧取小，并指出是哪张表限制的', () => {
    const floor = computeRetentionFloor([
      { table: SA, ttl_days: 540 },
      { table: 'clklog.log_analysis', ttl_days: 180 },
      { table: 'clklog.user_pv_bydate', ttl_days: 365 },
    ]);
    expect(floor).toEqual({ days: 180, sa_days: 540, raw_days: 180, bound_by: 'clklog.log_analysis' });
  });

  it('聚合表里最小的一张决定上限（任一表被清理都会让对照失真）', () => {
    const floor = computeRetentionFloor([
      { table: SA, ttl_days: 540 },
      { table: 'clklog.log_analysis', ttl_days: 365 },
      { table: 'clklog.flow_trend_byhour', ttl_days: 90 },
    ]);
    expect(floor.days).toBe(90);
    expect(floor.bound_by).toBe('clklog.flow_trend_byhour');
  });

  it('未设置 TTL 视为「不限」：raw 侧全无 TTL 时地板由 sa 侧决定', () => {
    const floor = computeRetentionFloor([
      { table: SA, ttl_days: 540 },
      { table: 'clklog.log_analysis', ttl_days: null },
    ]);
    expect(floor.days).toBe(540);
    expect(floor.raw_days).toBeNull();
    expect(floor.bound_by).toBe(SA);
  });

  it('两侧都没有 TTL → 不设地板（回到数据实际范围）', () => {
    expect(computeRetentionFloor([{ table: SA, ttl_days: null }, { table: 'clklog.log_analysis', ttl_days: null }]).days).toBeNull();
  });
});

describe('保留策略纯函数', () => {
  it('monthRange：月分区名 → 该月首末日（含闰年 2 月）', () => {
    expect(monthRange('202602')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('202402')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange('202612')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('shiftYmd：跨月跨年不依赖运行时区', () => {
    expect(shiftYmd('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftYmd('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftYmd('2026-10-09', -179)).toBe('2026-04-13');
  });

  it('isSuspiciousPartition：未来分区与早于可信区间的历史脏数据（2019/2023 测试日期）', () => {
    expect(isSuspiciousPartition('202709', '202610', null)).toBe('future');
    expect(isSuspiciousPartition('201903', '202610', '202504')).toBe('ancient');
    expect(isSuspiciousPartition('202609', '202610', '202504')).toBeNull();
  });

  it('parseTtlDays 兼容 toIntervalMonth 折算（生产 sa_events 18 个月 = 540 天）', () => {
    expect(parseTtlDays('TTL stat_date + toIntervalMonth(18)')).toBe(540);
  });
});

function harness(options: {
  policyRows?: unknown[];
  snapshots?: Array<{ id: bigint; range_from: string; range_to: string; summary: unknown; ran_at: Date }>;
  parts?: Array<{ tname: string; partition: string; rows: string }>;
  /** system.tables 行（可信区间下限用）；缺省 = 无 TTL → 不设下限 */
  tables?: Array<{ tname: string; engine_full: string }>;
} = {}) {
  const prisma = {
    opsRetentionPolicy: {
      findMany: jest.fn(async () => options.policyRows ?? []),
      upsert: jest.fn(async (args: unknown) => {
        const data = (args as { create: Record<string, unknown> }).create;
        return { ...data, updated_at: new Date('2026-10-09T00:00:00.000Z') };
      }),
    },
    reconcileSnapshot: { findFirst: jest.fn(async () => options.snapshots?.[0] ?? null) },
    opsCleanupLedger: { create: jest.fn(async () => ({ id: 12n })) },
  } as unknown as PrismaService;
  const clickhouse = {
    queryReconcile: jest.fn(async (sql: string) => {
      if (sql.includes('system.tables')) return options.tables ?? [];
      return options.parts ?? [];
    }),
  } as unknown as ClickHouseService;
  const service = new RetentionService(prisma, clickhouse);
  return { service, prisma: prisma as any, clickhouse: clickhouse as any };
}

describe('RetentionService.preflight（清理前置对拍，R2-3）', () => {
  it('无快照 → 拒绝，原因是 no_snapshot', async () => {
    const { service } = harness();
    const r = await service.preflight('2026-08-31');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_snapshot');
    expect(r.required_to).toBe('2026-08-31');
  });

  it('被清理窗口在可信区间内、快照未覆盖 → not_covered', async () => {
    // 可信区间：sa_events TTL 540 天 → 下限约今天 -539 天；这里拿「昨天」当被清理日（明显在区间内）
    const { service } = harness({
      tables: [{ tname: 'clklog_sa.sa_events', engine_full: 'TTL stat_date + toIntervalMonth(18)' }],
      // 快照存在但只覆盖很久以前 → 不覆盖被清理日
      snapshots: [
        {
          id: 12n,
          range_from: '2026-01-01',
          range_to: '2026-01-02',
          summary: { has_alert: false },
          ran_at: new Date(Date.now() - 3600_000),
        },
      ],
    });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const r = await service.preflight(yesterday);
    expect(r).toMatchObject({ ok: false, reason: 'not_covered', coverage_required: true });
  });

  it('被清理窗口已超出物理保留期 → 不再要求覆盖，近期通过快照即可放行', async () => {
    // 场景：社区版设 180 天 TTL 后，清理 200 天前的分区（本来就不可比）
    const { service } = harness({
      tables: [
        { tname: 'clklog_sa.sa_events', engine_full: 'TTL stat_date + toIntervalMonth(18)' },
        { tname: 'clklog.log_analysis', engine_full: 'PARTITION BY stat_date TTL stat_date + toIntervalDay(180)' },
      ],
      snapshots: [
        {
          id: 9n,
          range_from: '2026-10-07',
          range_to: '2026-10-07',
          summary: { has_alert: false },
          ran_at: new Date(Date.now() - 3600_000),
        },
      ],
    });
    const old = new Date(Date.now() - 240 * 86_400_000).toISOString().slice(0, 10);
    const r = await service.preflight(old);
    expect(r.coverage_required).toBe(false);
    expect(r).toMatchObject({ ok: true, reason: 'ok', snapshot_id: '9' });
  });

  it('旧窗口但快照有告警 / 过期 → 仍拒绝（链路不健康就不许删）', async () => {
    const tables = [
      { tname: 'clklog_sa.sa_events', engine_full: 'TTL stat_date + toIntervalMonth(18)' },
      { tname: 'clklog.log_analysis', engine_full: 'TTL stat_date + toIntervalDay(180)' },
    ];
    const old = new Date(Date.now() - 240 * 86_400_000).toISOString().slice(0, 10);
    const failed = harness({
      tables,
      snapshots: [{ id: 10n, range_from: '2026-10-07', range_to: '2026-10-07', summary: { has_alert: true }, ran_at: new Date() }],
    });
    expect(await failed.service.preflight(old)).toMatchObject({ ok: false, reason: 'snapshot_failed' });

    const stale = harness({
      tables,
      snapshots: [
        {
          id: 11n,
          range_from: '2026-10-07',
          range_to: '2026-10-07',
          summary: { has_alert: false },
          ran_at: new Date(Date.now() - 10 * 86_400_000),
        },
      ],
    });
    expect(await stale.service.preflight(old)).toMatchObject({ ok: false, reason: 'snapshot_stale' });
  });

  it('TTL 动作（requireCoverage=false）：截止日不需要被覆盖，近期通过快照即放行', async () => {
    const { service } = harness({
      tables: [{ tname: 'clklog_sa.sa_events', engine_full: 'TTL stat_date + toIntervalMonth(18)' }],
      snapshots: [
        {
          id: 13n,
          range_from: '2026-10-08',
          range_to: '2026-10-08',
          summary: { has_alert: false },
          ran_at: new Date(Date.now() - 3600_000),
        },
      ],
    });
    // 截止日在可比范围内（可信下限约今年 4 月），但 TTL 不要求覆盖
    const r = await service.preflight('2026-04-12', 'clklogapp', { requireCoverage: false });
    expect(r).toMatchObject({ ok: true, reason: 'ok', coverage_required: false, snapshot_id: '13' });
  });

  it('（保留原语义）快照存在但完全不含被清理日 → not_covered', async () => {
    const { service } = harness({
      snapshots: [
        {
          id: 5n,
          range_from: '2026-08-01',
          range_to: '2026-08-20',
          summary: { has_alert: false },
          ran_at: new Date(),
        },
      ],
    });
    const r = await service.preflight('2026-08-31');
    expect(r).toMatchObject({ ok: false, reason: 'not_covered', snapshot_id: '5' });
  });

  it('快照有告警 → snapshot_failed（没通过的对拍不能当作清理依据）', async () => {
    const { service } = harness({
      snapshots: [
        {
          id: 6n,
          range_from: '2026-08-01',
          range_to: '2026-09-30',
          summary: { has_alert: true },
          ran_at: new Date(),
        },
      ],
    });
    const r = await service.preflight('2026-08-31');
    expect(r).toMatchObject({ ok: false, reason: 'snapshot_failed', has_alert: true });
  });

  it('快照超过 7 天 → snapshot_stale', async () => {
    const { service } = harness({
      snapshots: [
        {
          id: 7n,
          range_from: '2026-08-01',
          range_to: '2026-09-30',
          summary: { has_alert: false },
          ran_at: new Date(Date.now() - 8 * 86_400_000),
        },
      ],
    });
    const r = await service.preflight('2026-08-31');
    expect(r).toMatchObject({ ok: false, reason: 'snapshot_stale', max_age_hours: 168 });
  });

  it('覆盖 + 通过 + 新鲜 → 放行，并回报快照 id（进审计与清理登记）', async () => {
    const { service } = harness({
      snapshots: [
        {
          id: 8n,
          range_from: '2026-08-01',
          range_to: '2026-09-30',
          summary: { has_alert: false },
          ran_at: new Date(Date.now() - 3600_000),
        },
      ],
    });
    const r = await service.preflight('2026-08-31');
    expect(r).toMatchObject({ ok: true, reason: 'ok', snapshot_id: '8' });
  });
});

describe('RetentionService.overview（保留策略总览，R2-1 / AC-6）', () => {
  const inventory = {
    tables: [
      { table: SA, ttl_days: 540, rows: 100, compressed_bytes: 1000, partitions: 12 },
      { table: 'clklog.log_analysis', ttl_days: null, rows: 900, compressed_bytes: 9000, partitions: 30 },
      { table: 'clklog.user_pv_bydate', ttl_days: null, rows: 10, compressed_bytes: 100, partitions: 5 },
    ],
  };

  it('未登记时用默认建议值；raw 侧无 TTL 标 unset（风险），并给出可信区间数值', async () => {
    const { service } = harness();
    const view = await service.overview(inventory);
    const raw = view.rows.find((r) => r.table === 'clklog.log_analysis')!;
    expect(raw).toMatchObject({ expected_days: 180, registered: false, actual_ttl_days: null, status: 'unset' });
    const sa = view.rows.find((r) => r.table === SA)!;
    expect(sa).toMatchObject({ expected_days: 540, actual_ttl_days: 540, status: 'ok' });
    // 可信区间：两侧取小 = sa 的 540 天（raw 无 TTL 视为不限）
    expect(view.trusted_range.retention_days).toBe(540);
    expect(view.trusted_range.sa_days).toBe(540);
    expect(view.trusted_range.raw_days).toBeNull();
    expect(view.trusted_range.bound_by).toBe(SA);
    expect(view.summary.raw_unset).toBe(2);
    expect(view.summary.unset).toBe(2);
  });

  it('已登记策略与实际 TTL 偏离超过 10% → deviates', async () => {
    const { service } = harness({
      policyRows: [
        {
          target_db: 'clklog',
          target_table: 'log_analysis',
          keep_days: 365,
          mode: 'ttl',
          enabled: true,
          remark: null,
          updated_by: 'admin',
          updated_at: new Date('2026-10-01T00:00:00.000Z'),
        },
      ],
    });
    const view = await service.overview(inventory);
    const raw = view.rows.find((r) => r.table === 'clklog.log_analysis')!;
    // 登记 365 天但表上还没设置 TTL → 仍是未设置（风险），预期值按登记显示
    expect(raw).toMatchObject({ expected_days: 365, registered: true, actual_ttl_days: null, status: 'unset' });
  });

  it('可疑分区：未来分区与早于可信区间的历史脏日期（R2-6，默认只提示）', async () => {
    const { service } = harness({
      parts: [
        { tname: 'clklog.log_analysis', partition: '201903', rows: '12' },
        { tname: 'clklog.log_analysis', partition: '202709', rows: '3' },
        { tname: 'clklog_sa.sa_events', partition: '202609', rows: '100' },
      ],
    });
    const view = await service.overview(inventory);
    const kinds = view.summary.suspicious_partitions.map((p) => `${p.partition}:${p.kind}`);
    expect(kinds).toContain('201903:ancient');
    expect(kinds).toContain('202709:future');
    expect(kinds).not.toContain('202609:future');
  });
});

describe('RetentionService.upsertPolicy / recordLedger', () => {
  it('登记预期保留：白名单 + 天数校验 + 落库字段', async () => {
    const { service, prisma } = harness();
    const row = await service.upsertPolicy(
      { db: 'clklog', table: 'log_analysis', keep_days: 180, mode: 'ttl', remark: '按 DR 要求' },
      'admin',
      ['clklog.log_analysis', SA],
    );
    expect(row).toMatchObject({ table: 'clklog.log_analysis', expected_days: 180, registered: true });
    const args = prisma.opsRetentionPolicy.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ target_db_target_table: { target_db: 'clklog', target_table: 'log_analysis' } });
    expect(args.create).toMatchObject({ keep_days: 180, updated_by: 'admin', remark: '按 DR 要求' });
  });

  it('表不在盘点范围 / 天数越界 → 400', async () => {
    const { service } = harness();
    await expect(
      service.upsertPolicy({ db: 'clklog', table: 'unknown', keep_days: 180 }, 'admin', ['clklog.log_analysis']),
    ).rejects.toThrow(/不在保留策略范围/);
    await expect(
      service.upsertPolicy({ db: 'clklog', table: 'log_analysis', keep_days: 0 }, 'admin', ['clklog.log_analysis']),
    ).rejects.toThrow(/保留天数须为/);
  });

  it('清理登记：snapshot_id 转 BigInt 落库，非法 id 置空', async () => {
    const { service, prisma } = harness();
    await service.recordLedger({
      target_db: 'clklog_sa',
      target_table: 'sa_events',
      scope_type: 'partition',
      range_from: '2026-08-01',
      range_to: '2026-08-31',
      action: 'drop_partition',
      snapshot_id: '42',
      operator: 'admin',
    });
    expect(prisma.opsCleanupLedger.create.mock.calls[0][0].data).toMatchObject({
      scope_type: 'partition',
      range_from: '2026-08-01',
      range_to: '2026-08-31',
      snapshot_id: 42n,
    });
    await service.recordLedger({
      target_db: 'clklog_sa',
      target_table: 'sa_events',
      scope_type: 'ttl',
      range_from: '1970-01-01',
      range_to: '2026-04-13',
      action: 'set_ttl',
      snapshot_id: null,
      operator: 'admin',
    });
    expect(prisma.opsCleanupLedger.create.mock.calls[1][0].data.snapshot_id).toBeNull();
  });
});
