/**
 * 数据管理动作类单测（phase: clklog-analytics-data-management-v1）。
 *
 * 2026-09-15 生产验收发现并修复三处（acceptance-clklog-analytics-ops-hardening-v1 §...）：
 *  - B1：TTL 生成的 DDL 是 `INTERVAL '3650' DAY`，ClickHouse 报语法错误 → TTL 设置完全不可用
 *  - B2：`parseTtlDays` 只认 `INTERVAL 'N' DAY`，解析不出生产实际使用的 `toIntervalMonth(18)`
 *  - B3：输入/护栏类错误抛 `Error` → HTTP 500，应为 400
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    __specConfigMock: true,
  },
}));

import { DomainError } from '../../src/i18n/domain-error';
import { DEFAULT_PLATFORM_TZ, todayInTz, ymdInTz } from '../../src/modules/time/calendar';
import { DataMgmtService, parseTtlDays } from '../../src/modules/ops/data-mgmt.service';
import type { RetentionService } from '../../src/modules/ops/retention.service';
import { ClickHouseService } from '../../src/modules/shared/clickhouse.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';

/** 'YYYYMM' 加减若干个月（只用于造测试分区名，不参与业务断言） */
function shiftMonth(yyyymm: string, delta: number): string {
  const base = new Date(Date.UTC(Number(yyyymm.slice(0, 4)), Number(yyyymm.slice(4, 6)) - 1 + delta, 1));
  return `${base.getUTCFullYear()}${String(base.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 前置对拍默认放行（R2-3 的拒绝分支在下面用 preflight 覆盖） */
export function preflightOk(requiredTo = '2026-08-31'): Record<string, unknown> & { reason: string; ok: boolean } {
  return {
    ok: true,
    reason: 'ok',
    snapshot_id: '7',
    ran_at: new Date().toISOString(),
    range: { from: '2026-08-01', to: '2026-12-31' },
    has_alert: false,
    age_hours: 1,
    max_age_hours: 168,
    required_to: requiredTo,
  };
}

function harness(
  options: {
    partitions?: Array<{ partition: string; rows: string; compressed: string }>;
    preflight?: ReturnType<typeof preflightOk> | (() => Promise<unknown>);
  } = {},
) {
  const clickhouse = {
    queryReconcile: jest.fn(async () => options.partitions ?? []),
    command: jest.fn(async () => undefined),
  } as unknown as ClickHouseService;
  const prisma = {
    opsActionLog: {
      create: jest.fn(async () => ({ id: 1n })),
      update: jest.fn(async () => ({})),
    },
    reconcileSnapshot: { findFirst: jest.fn(async () => null) },
    opsCleanupLedger: { create: jest.fn(async () => ({ id: 11n })) },
  } as unknown as PrismaService;
  const retention = {
    preflight: jest.fn(async () => (typeof options.preflight === 'function' ? await options.preflight() : (options.preflight ?? preflightOk()))),
    recordLedger: jest.fn(async () => '11'),
  } as unknown as RetentionService;
  return {
    service: new DataMgmtService(clickhouse, prisma, undefined, undefined, retention),
    clickhouse: clickhouse as any,
    prisma: prisma as any,
    retention: retention as any,
  };
}

describe('parseTtlDays', () => {
  it('解析 INTERVAL 的两种写法（带引号 / 不带引号）', () => {
    expect(parseTtlDays("TTL log_time + TO INTERVAL '180' DAY")).toBe(180);
    expect(parseTtlDays('TTL stat_date + INTERVAL 365 DAY')).toBe(365);
  });

  it('解析 toIntervalDay(N)', () => {
    expect(parseTtlDays('TTL stat_date + toIntervalDay(90)')).toBe(90);
  });

  it('聚合表也在 TTL 白名单内（社区版 19 张表 + sa_events 都能走审计路径设 TTL）', async () => {
    const { service, clickhouse } = harness();
    await service.executeSetTtl({
      table: 'clklog.visitor_detail_bydate',
      days: 180,
      confirmed_table: 'clklog.visitor_detail_bydate',
      operator: 'admin',
    });
    expect(clickhouse.command.mock.calls[0][0]).toContain('ALTER TABLE clklog.visitor_detail_bydate MODIFY TTL stat_date + INTERVAL 180 DAY');
  });

  it('解析生产实际写法 toIntervalMonth(N)，按月 ×30 折算', () => {
    expect(parseTtlDays('ReplacingMergeTree(ingest_time) PARTITION BY toYYYYMM(stat_date) ORDER BY (a, b) TTL stat_date + toIntervalMonth(18) SETTINGS index_granularity = 8192')).toBe(540);
  });

  it('无 TTL 返回 null', () => {
    expect(parseTtlDays('MergeTree PARTITION BY stat_date ORDER BY distinct_id SETTINGS index_granularity = 8192')).toBeNull();
  });
});

describe('executeSetTtl', () => {
  it('生成 ClickHouse 合法 DDL：INTERVAL N DAY（数值不加引号）', async () => {
    const { service, clickhouse } = harness();
    await service.executeSetTtl({
      table: 'clklog.log_analysis',
      days: 180,
      confirmed_table: 'clklog.log_analysis',
      operator: 'admin',
    });

    const ddl = clickhouse.command.mock.calls[0][0] as string;
    // 时间列统一 stat_date（与分区键同列：TTL 到期可整分区丢弃，不必重写 part）
    expect(ddl).toContain('MODIFY TTL stat_date + INTERVAL 180 DAY');
    expect(ddl).not.toContain("INTERVAL '180'");
  });

  it('带 materialize_ttl_after_modify=0（B5：避免对既有数据做 MATERIALIZE TTL 重写）', async () => {
    const { service, clickhouse } = harness();
    await service.executeSetTtl({
      table: 'clklog.log_analysis', days: 180, confirmed_table: 'clklog.log_analysis', operator: 'admin',
    });

    const options = clickhouse.command.mock.calls[0][2];
    expect(options.settings).toEqual({ materialize_ttl_after_modify: 0 });
  });

  it('审计先落 running、DDL 成功后更新为 done（B7：长 DDL 中途断开也要留痕）', async () => {
    const { service, prisma } = harness();
    await service.executeSetTtl({
      table: 'clklog.log_analysis', days: 365, confirmed_table: 'clklog.log_analysis', operator: 'admin',
    });

    const created = prisma.opsActionLog.create.mock.calls[0][0].data;
    expect(created.action).toBe('set_ttl');
    expect(created.target_table).toBe('clklog.log_analysis');
    expect(created.operator).toBe('admin');
    expect(created.status).toBe('running');
    expect(JSON.stringify(created.detail)).toContain('365');

    const updated = prisma.opsActionLog.update.mock.calls[0][0];
    expect(updated.where).toEqual({ id: 1n });
    expect(updated.data.status).toBe('done');
  });

  it('DDL 失败：审计更新为 failed 并返回 400 可读错误', async () => {
    const { service, clickhouse, prisma } = harness();
    clickhouse.command.mockRejectedValueOnce(new Error('Syntax error: failed at position 58'));

    await expect(
      service.executeSetTtl({ table: 'clklog.log_analysis', days: 365, confirmed_table: 'clklog.log_analysis', operator: 'admin' }),
    ).rejects.toThrow(/TTL 设置失败/);

    const updated = prisma.opsActionLog.update.mock.calls[0][0];
    expect(updated.data.status).toBe('failed');
    expect(updated.data.error).toContain('Syntax error');
  });

  it('确认表名不匹配 / 天数越界 / 未登记表 → 400 而不是 500', async () => {
    const { service } = harness();
    const mismatch = service.executeSetTtl({ table: 'clklog.log_analysis', days: 30, confirmed_table: 'x', operator: 'a' });
    await expect(mismatch).rejects.toBeInstanceOf(DomainError);
    await expect(mismatch).rejects.toMatchObject({ status: 400, errorCode: 'ops.dataMgmt.tableConfirmMismatch' });
    const daysOutOfRange = service.executeSetTtl({
      table: 'clklog.log_analysis',
      days: 99_999,
      confirmed_table: 'clklog.log_analysis',
      operator: 'a',
    });
    await expect(daysOutOfRange).rejects.toBeInstanceOf(DomainError);
    await expect(daysOutOfRange).rejects.toMatchObject({ status: 400, errorCode: 'ops.dataMgmt.ttlDaysInvalid' });
    const unregistered = service.executeSetTtl({
      table: 'clklog.other_table',
      days: 30,
      confirmed_table: 'clklog.other_table',
      operator: 'a',
    });
    await expect(unregistered).rejects.toBeInstanceOf(DomainError);
    await expect(unregistered).rejects.toMatchObject({ status: 400, errorCode: 'ops.dataMgmt.ttlTimeColumnMissing' });
  });
});

describe('previewCleanup', () => {
  it('月分区表：只返回早于 cutoff 且非当月的 YYYYMM 分区', async () => {
    // 分区名以「当前月」为基准构造：写死年月会在跨月第一天变成假红（2026-10-08 实测踩到）
    const current = todayInTz(DEFAULT_PLATFORM_TZ).slice(0, 7).replace('-', '');
    const old1 = shiftMonth(current, -11);
    const old2 = shiftMonth(current, -2);
    const future = shiftMonth(current, 2);
    const { service } = harness({
      partitions: [
        { partition: old1, rows: '100', compressed: '1000' },
        { partition: old2, rows: '200', compressed: '2000' },
        { partition: current, rows: '300', compressed: '3000' },
        { partition: future, rows: '400', compressed: '4000' },
      ],
    });
    jest.spyOn(service, 'overview').mockResolvedValue({
      tables: [{ table: 'clklog_sa.sa_events' } as never],
      generated_at: new Date().toISOString(),
    });

    // days=1 → cutoff 落在当月，故老分区入选、当月与未来分区被排除
    const preview = await service.previewCleanup('clklog_sa.sa_events', 1);

    expect(preview.partitions.map((p) => p.partition)).toEqual([old1, old2]);
    expect(preview.note).toBeUndefined();
  });

  it('cutoff 早于所有分区时无候选（older_than_days 很大 → 什么都不该删）', async () => {
    const { service } = harness({
      partitions: [
        { partition: '202510', rows: '100', compressed: '1000' },
        { partition: '202608', rows: '200', compressed: '2000' },
      ],
    });
    jest.spyOn(service, 'overview').mockResolvedValue({
      tables: [{ table: 'clklog_sa.sa_events' } as never],
      generated_at: new Date().toISOString(),
    });

    const preview = await service.previewCleanup('clklog_sa.sa_events', 3_650);

    expect(preview.partitions).toEqual([]);
  });

  it('按日分区表（log_analysis）：候选为空并给出原因，避免被误读成「没东西可清」', async () => {
    const { service } = harness({
      partitions: [
        { partition: '2026-09-14', rows: '100', compressed: '1000' },
        { partition: '2026-08-30', rows: '200', compressed: '2000' },
      ],
    });
    jest.spyOn(service, 'overview').mockResolvedValue({
      tables: [{ table: 'clklog.log_analysis' } as never],
      generated_at: new Date().toISOString(),
    });

    const preview = await service.previewCleanup('clklog.log_analysis', 30);

    expect(preview.partitions).toEqual([]);
    expect(preview.note).toContain('按日分区');
    expect(preview.note).toContain('TTL');
  });

  it('表不在盘点范围 → 400', async () => {
    const { service } = harness();
    jest.spyOn(service, 'overview').mockResolvedValue({ tables: [], generated_at: new Date().toISOString() });
    const rejected = service.previewCleanup('evil.table', 30);
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 400, errorCode: 'ops.dataMgmt.tableNotInventoried' });
  });
});

describe('清理前置对拍与清理登记（R2：AC-8 / AC-9）', () => {
  it('前置对拍未通过 → 400 带原因，且不执行 DDL、不写登记', async () => {
    const { service, clickhouse, retention } = harness({
      preflight: {
        ...preflightOk('2026-01-31'),
        ok: false,
        reason: 'no_snapshot',
        snapshot_id: null,
        range: null,
        has_alert: null,
        age_hours: null,
      },
    });
    jest.spyOn(service, 'overview').mockResolvedValue({
      tables: [{ table: 'clklog_sa.sa_events' } as never],
      generated_at: new Date().toISOString(),
    });

    const call = service.executeDropPartitions({
      table: 'clklog_sa.sa_events',
      partitions: ['202601'],
      confirmed_table: 'clklog_sa.sa_events',
      dry_run_snapshot: null,
      operator: 'admin',
    });
    await expect(call).rejects.toMatchObject({ status: 400, errorCode: 'ops.dataMgmt.preflight.no_snapshot' });
    expect(clickhouse.command).not.toHaveBeenCalled();
    expect(retention.recordLedger).not.toHaveBeenCalled();
  });

  it('DROP PARTITION 成功后按「月分区 → 该月首末日」登记已清理区间（带前置快照 id）', async () => {
    const { service, clickhouse, retention } = harness();
    jest.spyOn(service, 'overview').mockResolvedValue({
      tables: [{ table: 'clklog_sa.sa_events' } as never],
      generated_at: new Date().toISOString(),
    });

    const result = await service.executeDropPartitions({
      table: 'clklog_sa.sa_events',
      partitions: ['202601'],
      confirmed_table: 'clklog_sa.sa_events',
      dry_run_snapshot: null,
      operator: 'admin',
    });

    expect(result.done).toEqual(['202601']);
    expect(clickhouse.command.mock.calls[0][0]).toContain("DROP PARTITION '202601'");
    expect(retention.recordLedger.mock.calls[0][0]).toMatchObject({
      target_db: 'clklog_sa',
      target_table: 'sa_events',
      scope_type: 'partition',
      range_from: '2026-01-01',
      range_to: '2026-01-31',
      action: 'drop_partition',
      snapshot_id: '7',
      operator: 'admin',
    });
  });

  it('设置 TTL 成功后登记「1970-01-01 ~ 保留截止日」', async () => {
    const { service, retention } = harness();
    await service.executeSetTtl({
      table: 'clklog.log_analysis',
      days: 180,
      confirmed_table: 'clklog.log_analysis',
      operator: 'admin',
    });

    const expectedCutoff = ymdInTz(DEFAULT_PLATFORM_TZ, Date.now() - 180 * 86_400_000);
    expect(retention.recordLedger.mock.calls[0][0]).toMatchObject({
      target_db: 'clklog',
      target_table: 'log_analysis',
      scope_type: 'ttl',
      range_from: '1970-01-01',
      range_to: expectedCutoff,
      action: 'set_ttl',
      snapshot_id: '7',
    });
    // 前置对拍点 = 保留截止日（被 TTL 删掉的最新一天）
    expect(retention.preflight.mock.calls[0][0]).toBe(expectedCutoff);
  });

  it('TTL 的前置对拍未通过 → 400，且不执行 MODIFY TTL、不写登记', async () => {
    const { service, clickhouse, retention } = harness({
      preflight: { ...preflightOk('2026-04-01'), ok: false, reason: 'snapshot_stale' },
    });
    await expect(
      service.executeSetTtl({
        table: 'clklog.log_analysis',
        days: 180,
        confirmed_table: 'clklog.log_analysis',
        operator: 'admin',
      }),
    ).rejects.toMatchObject({ status: 400, errorCode: 'ops.dataMgmt.preflight.snapshot_stale' });
    expect(clickhouse.command).not.toHaveBeenCalled();
    expect(retention.recordLedger).not.toHaveBeenCalled();
  });

  it('清理预演带前置对拍结论（未通过也能先看到原因，而不是点了执行才被拒）', async () => {
    const current = todayInTz(DEFAULT_PLATFORM_TZ).slice(0, 7).replace('-', '');
    const old1 = shiftMonth(current, -3);
    const { service } = harness({
      partitions: [{ partition: old1, rows: '10', compressed: '100' }],
      preflight: { ...preflightOk('2026-01-31'), ok: false, reason: 'snapshot_failed', has_alert: true },
    });
    jest.spyOn(service, 'overview').mockResolvedValue({
      tables: [{ table: 'clklog_sa.sa_events' } as never],
      generated_at: new Date().toISOString(),
    });

    const preview = await service.previewCleanup('clklog_sa.sa_events', 30);
    expect(preview.preflight).toMatchObject({ ok: false, reason: 'snapshot_failed' });
    // 前置要求覆盖被清理数据里最新的一天 = 该月分区末日
    expect(preview.preflight?.required_to).toBe(preflightOk('2026-01-31').required_to);
  });
});
