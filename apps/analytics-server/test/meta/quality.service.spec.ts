/**
 * QualityService 数据一致性对拍单测。
 *
 * mock ClickHouseService，验证：
 * - 总量对拍（sa_events vs log_analysis）偏差计算与 ALERT 判定
 * - CRC 唯一性检测
 * - 事件级对拍返回结构
 * - log_analysis 走 queryReconcile（只读），sa_events 走 query（带 project_name）
 */
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// clickhouse.service 顶层会加载 YAML 配置（需要 APP_CONFIG_PATH 与真实密钥），
// 单测里隔离掉，只保留本服务用到的字段。
const REPORT_DIR = mkdtempSync(join(tmpdir(), 'clklog-reconcile-spec-'));
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    // 报告落盘目录指向临时目录：既验证真的写了文件，又不碰生产路径
    reconcile: { reportDir: mkdtempSync(join(require('node:os').tmpdir(), 'clklog-reconcile-spec-')) },
  },
}));
import { QualityService } from '../../src/modules/meta/quality.service';
import { DEFAULT_PLATFORM_TZ, todayInTz } from '../../src/modules/time/calendar';
import { shiftYmd } from '../../src/modules/ops/retention-policy';
import { TimezoneService } from '../../src/modules/time/timezone.service';
import { ClickHouseService } from '../../src/modules/shared/clickhouse.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';

describe('QualityService', () => {
  let service: QualityService;
  let clickHouse: {
    query: jest.Mock;
    queryReconcile: jest.Mock;
  };
  let prisma: {
    metaDiscoveryLog: { findMany: jest.Mock };
    opsReconcileConfig: { findFirst: jest.Mock; upsert: jest.Mock };
    opsCleanupLedger: { findMany: jest.Mock };
    opsActionLog: { create: jest.Mock };
    reconcileSnapshot: { create: jest.Mock; count: jest.Mock; findFirst: jest.Mock };
  };

  beforeEach(async () => {
    clickHouse = {
      query: jest.fn(),
      queryReconcile: jest.fn(),
    };
    prisma = {
      metaDiscoveryLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      opsReconcileConfig: { findFirst: jest.fn().mockResolvedValue(null), upsert: jest.fn(async () => ({})) },
      opsCleanupLedger: { findMany: jest.fn().mockResolvedValue([]) },
      opsActionLog: { create: jest.fn(async () => ({})) },
      reconcileSnapshot: { create: jest.fn(async () => ({})), count: jest.fn(async () => 0), findFirst: jest.fn() },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        QualityService,
        { provide: ClickHouseService, useValue: clickHouse },
        { provide: PrismaService, useValue: prisma },
        { provide: TimezoneService, useValue: new TimezoneService(undefined) },
      ],
    }).compile();

    service = moduleRef.get(QualityService);
    // 保留期地板：默认「不设地板」（写缓存，避免地板查询挤掉按顺序排的 queryReconcile mock）；
    // 地板行为在「R2 可信区间」用例里用 setFloor 显式覆盖。
    setFloor(null);
  });

  /** 直设地板缓存（天）；避免每个用例都要 mock 一次 system.tables 查询 */
  const setFloor = (days: number | null) => {
    (service as unknown as { floorCache: { at: number; days: number | null } | null }).floorCache = {
      at: Date.now(),
      days,
    };
  };

  describe('reconcile', () => {
    // 默认按调用顺序 mock query（总量、CRC、事件）与 queryReconcile（总量、事件）
    const setupDefault = (
      opts: {
        saDaily?: Array<{ d: string; sa_cnt: string; sa_uniq: string }>;
        rawDaily?: Array<{ d: string; raw_cnt: string }>;
        crc?: Array<{ total: string; uniq: string }>;
      } = {},
    ) => {
      const saDaily = opts.saDaily ?? [{ d: '2026-08-26', sa_cnt: '100', sa_uniq: '100' }];
      const rawDaily = opts.rawDaily ?? [{ d: '2026-08-26', raw_cnt: '100' }];
      const crc = opts.crc ?? [{ total: '100', uniq: '100' }];
      clickHouse.query
        .mockResolvedValueOnce(saDaily)
        .mockResolvedValueOnce(crc)
        .mockResolvedValueOnce([{ event: 'PageView', cnt: '100' }]);
      clickHouse.queryReconcile
        .mockResolvedValueOnce(rawDaily)
        .mockResolvedValueOnce([{ event: 'PageView', cnt: '100' }]);
    };

    it('总量对拍：偏差在阈值内返回 ok', async () => {
      setupDefault();

      const result = await service.reconcile({
        project: 'clklogapp',
        from: '2026-08-26',
        to: '2026-08-26',
        threshold: 0.1,
      });

      expect(result.summary.has_alert).toBe(false);
      expect(result.daily.items[0].deviation_pct).toBe(0);
      expect(result.daily.items[0].status).toBe('ok');
      // sa_events 走 query（带 project_name）
      const saSql = clickHouse.query.mock.calls[0][0];
      expect(saSql).toContain('project_name = {project');
      // log_analysis 走 queryReconcile（readonly + 600s 上限 + 4GB 内存上限 +
      // max_threads=2：600s 因 CH 23.2 执行前估算波动；内存/线程上限防 OOM）
      expect(clickHouse.queryReconcile).toHaveBeenCalledWith(
        expect.stringContaining('clklog.log_analysis'),
        expect.any(Object),
        { readonly: true, maxExecutionTime: 600, maxMemoryUsage: 4_000_000_000, maxThreads: 2 },
      );
    });

    it('总量对拍：偏差超过阈值返回 ALERT', async () => {
      setupDefault({
        saDaily: [{ d: '2026-08-26', sa_cnt: '200', sa_uniq: '200' }],
        rawDaily: [{ d: '2026-08-26', raw_cnt: '100' }],
      });

      const result = await service.reconcile({
        project: 'clklogapp',
        from: '2026-08-26',
        to: '2026-08-26',
        threshold: 0.1,
      });

      expect(result.daily.items[0].status).toBe('ALERT');
      expect(result.daily.items[0].deviation_pct).toBe(100);
      expect(result.summary.has_alert).toBe(true);
      expect(result.summary.alert_days).toBe(1);
    });

    it('CRC 唯一性：存在重复 CRC 时标记异常', async () => {
      setupDefault({
        saDaily: [{ d: '2026-08-26', sa_cnt: '10', sa_uniq: '10' }],
        crc: [{ total: '10', uniq: '9' }],
      });

      const result = await service.reconcile({
        project: 'clklogapp',
        from: '2026-08-26',
        to: '2026-08-26',
      });

      expect(result.crc.dup_rows).toBe(1);
      expect(result.crc.pass).toBe(false);
      expect(result.summary.crc_pass).toBe(false);
      expect(result.summary.has_alert).toBe(true);
    });

    it('事件级对拍返回两侧列表', async () => {
      // mockReset 清除所有已设置实现，按需重新设置
      clickHouse.query.mockReset();
      clickHouse.queryReconcile.mockReset();
      clickHouse.query
        .mockResolvedValueOnce([{ d: '2026-08-26', sa_cnt: '5', sa_uniq: '5' }])
        .mockResolvedValueOnce([{ total: '5', uniq: '5' }])
        .mockResolvedValueOnce([{ event: 'PageView', cnt: '3' }, { event: 'Buy', cnt: '2' }]);
      clickHouse.queryReconcile
        .mockResolvedValueOnce([{ d: '2026-08-26', raw_cnt: '5' }])
        .mockResolvedValueOnce([{ event: 'PageView', cnt: '3' }, { event: 'Buy', cnt: '2' }]);

      const result = await service.reconcile({
        project: 'clklogapp',
        from: '2026-08-26',
        to: '2026-08-26',
      });

      expect(result.events.sa_events).toHaveLength(2);
      expect(result.events.log_analysis).toHaveLength(2);
      expect(result.events.sa_events[0]).toEqual({ event: 'PageView', cnt: 3 });
    });
  });

  describe('getDiscoveryLog', () => {
    it('返回发现变化记录并按创建时间倒序、限制条数', async () => {
      prisma.metaDiscoveryLog.findMany.mockResolvedValue([
        {
          id: '1',
          project_name: 'clklogapp',
          event_key: 'Buy',
          prop_key: 'amount',
          change_type: 'property_created',
          from_value: null,
          to_value: 'number',
          created_at: new Date('2026-08-26T10:00:00Z'),
        },
      ]);

      const result = await service.getDiscoveryLog('clklogapp', 20);

      expect(result).toHaveLength(1);
      expect(result[0].change_key).toBe('propertyCreated');
      expect(result[0].event).toBe('Buy');
      expect(result[0].prop).toBe('amount');
      expect(prisma.metaDiscoveryLog.findMany).toHaveBeenCalledWith({
        where: { project_name: 'clklogapp' },
        orderBy: { created_at: 'desc' },
        take: 20,
      });
    });

    it('reconcile 报告包含 discovery_logs', async () => {
      clickHouse.query
        .mockResolvedValueOnce([{ d: '2026-08-26', sa_cnt: '5', sa_uniq: '5' }])
        .mockResolvedValueOnce([{ total: '5', uniq: '5' }])
        .mockResolvedValueOnce([{ event: 'PageView', cnt: '5' }]);
      clickHouse.queryReconcile
        .mockResolvedValueOnce([{ d: '2026-08-26', raw_cnt: '5' }])
        .mockResolvedValueOnce([{ event: 'PageView', cnt: '5' }]);
      prisma.metaDiscoveryLog.findMany.mockResolvedValue([
        {
          id: '1',
          project_name: 'clklogapp',
          event_key: 'Buy',
          prop_key: null,
          change_type: 'event_created',
          from_value: null,
          to_value: 'pending',
          created_at: new Date('2026-08-26T10:00:00Z'),
        },
      ]);

      const result = await service.reconcile({
        project: 'clklogapp',
        from: '2026-08-26',
        to: '2026-08-26',
      });

      expect(result.discovery_logs).toHaveLength(1);
      expect(result.discovery_logs[0].change_key).toBe('eventCreated');
      expect(result.summary.recent_changes).toBe(1);
    });
  });
  /**
   * phase: clklog-data-quality-ops-v1（R1）
   *
   * 这一批用例锁住的是「对拍结论可信」的四件事：口径修正、阈值单语义、
   * 已清理区间不参与告警、快照带过期等级与报告落盘。
   */
  describe('R1 口径修正与配置', () => {
    const setupR1 = (opts: {
      saDaily?: Array<{ d: string; sa_cnt: string; sa_uniq: string }>;
      rawDaily?: Array<{ d: string; raw_cnt: string }>;
      crc?: Array<{ total: string; uniq: string }>;
      saEvents?: Array<{ event: string; cnt: string }>;
      rawEvents?: Array<{ event: string; cnt: string }>;
    } = {}) => {
      clickHouse.query.mockReset();
      clickHouse.queryReconcile.mockReset();
      clickHouse.query
        .mockResolvedValueOnce(opts.saDaily ?? [{ d: '2026-08-26', sa_cnt: '100', sa_uniq: '100' }])
        .mockResolvedValueOnce(opts.crc ?? [{ total: '100', uniq: '100' }])
        .mockResolvedValueOnce(opts.saEvents ?? [{ event: 'PageView', cnt: '100' }]);
      clickHouse.queryReconcile
        .mockResolvedValueOnce(opts.rawDaily ?? [{ d: '2026-08-26', raw_cnt: '100' }])
        .mockResolvedValueOnce(opts.rawEvents ?? [{ event: 'PageView', cnt: '100' }]);
    };

    it('raw 侧用表自带 stat_date（可分区剪枝），两侧同一套事件过滤', async () => {
      setupR1();
      await service.reconcile({ project: 'clklogapp', from: '2026-08-26', to: '2026-08-26' });

      const saSql = clickHouse.query.mock.calls[0][0] as string;
      const rawSql = clickHouse.queryReconcile.mock.calls[0][0] as string;
      expect(rawSql).toContain('stat_date BETWEEN');
      expect(rawSql).not.toContain('toDate(log_time)');
      // 空 event 过滤两侧都有（此前只有 raw 侧有，低量日制造假告警）
      expect(saSql).toContain("event != ''");
      expect(rawSql).toContain("event != ''");
    });

    it('忽略清单对称应用在两侧，并在快照里可见', async () => {
      prisma.opsReconcileConfig.findFirst.mockResolvedValue({
        id: 1,
        enabled: true,
        run_at: '03:30',
        threshold_pct: 10,
        ignore_events: ['android_gateway_error'],
        skip_empty_event: true,
        stale_warn_hours: 24,
        stale_error_hours: 72,
        updated_by: 'admin',
        updated_at: new Date(),
      });
      setupR1();

      const result = await service.reconcile({ project: 'clklogapp', from: '2026-08-26', to: '2026-08-26' });

      expect(clickHouse.query.mock.calls[0][0]).toContain("event NOT IN ('android_gateway_error')");
      expect(clickHouse.queryReconcile.mock.calls[0][0]).toContain("event NOT IN ('android_gateway_error')");
      expect(result.events.ignored_events).toEqual(['android_gateway_error']);
      expect(result.summary.ignored_events).toBe(1);
    });

    it('阈值只有「百分比」一个语义：20% 不告警、25% 阈值时照常通过', async () => {
      prisma.opsReconcileConfig.findFirst.mockResolvedValue({
        id: 1,
        enabled: true,
        run_at: '03:30',
        threshold_pct: 25,
        ignore_events: [],
        skip_empty_event: true,
        stale_warn_hours: 24,
        stale_error_hours: 72,
        updated_by: 'admin',
        updated_at: new Date(),
      });
      setupR1({
        saDaily: [{ d: '2026-08-26', sa_cnt: '120', sa_uniq: '120' }],
        rawDaily: [{ d: '2026-08-26', raw_cnt: '100' }],
      });

      const result = await service.reconcile({ project: 'clklogapp', from: '2026-08-26', to: '2026-08-26' });

      expect(result.daily.items[0].deviation_pct).toBe(20);
      expect(result.threshold_pct).toBe(25);
      expect(result.summary.has_alert).toBe(false);
    });

    it('已清理区间：该日标 skipped、不参与告警，CRC 也不判异常', async () => {
      prisma.opsCleanupLedger.findMany.mockResolvedValue([
        {
          target_table: 'sa_events',
          // CRC 检查的是 to-1 天，所以区间要覆盖 08-25 与 08-26 两天
          range_from: '2026-08-25',
          range_to: '2026-08-26',
          action: 'drop_partition',
          executed_at: new Date('2026-08-27T00:00:00Z'),
        },
      ]);
      setupR1({
        saDaily: [{ d: '2026-08-26', sa_cnt: '0', sa_uniq: '0' }],
        rawDaily: [{ d: '2026-08-26', raw_cnt: '100' }],
        crc: [{ total: '0', uniq: '0' }],
      });

      const result = await service.reconcile({ project: 'clklogapp', from: '2026-08-26', to: '2026-08-26' });

      expect(result.daily.items[0].status).toBe('skipped');
      // 原因只下发稳定标识（'cleaned'），文案由前端按查看者语言渲染
      expect(result.daily.items[0].skipped_reason).toBe('cleaned');
      expect(result.daily.items[0].skipped_source).toContain('drop_partition');
      expect(result.summary.has_alert).toBe(false);
      expect(result.summary.skipped_days).toBe(1);
      expect(result.crc.skipped).toBe(true);
    });

    it('事件级差异给出 Top 差值与「仅一侧存在」，并写进快照', async () => {
      setupR1({
        saEvents: [
          { event: 'PageView', cnt: '100' },
          { event: 'Buy', cnt: '50' },
        ],
        rawEvents: [
          { event: 'PageView', cnt: '80' },
          { event: 'OnlyRaw', cnt: '7' },
        ],
      });

      const result = await service.reconcile({
        project: 'clklogapp',
        from: '2026-08-26',
        to: '2026-08-26',
        trigger: 'auto',
      });

      expect(result.events.diffs[0]).toMatchObject({ event: 'PageView', sa_cnt: 100, raw_cnt: 80, diff: 20 });
      // 仅一侧存在的事件按条数倒序（Buy 只在 sa、OnlyRaw 只在 raw）
      expect(result.events.only_in_one).toEqual([
        { event: 'Buy', side: 'sa_events', cnt: 50 },
        { event: 'OnlyRaw', side: 'log_analysis', cnt: 7 },
      ]);
      const snapshotData = prisma.reconcileSnapshot.create.mock.calls[0][0].data;
      expect(snapshotData.events.diffs).toHaveLength(1);
      expect(snapshotData.trigger).toBe('auto');
      expect(snapshotData.report_path).toContain('reconcile-auto-');
      // 报告真的落盘了（临时目录）
      const fs = await import('node:fs');
      expect(fs.existsSync(snapshotData.report_path)).toBe(true);
      // 变更记录：动作 + 范围 + 报告路径
      const audit = prisma.opsActionLog.create.mock.calls[0][0].data;
      expect(audit.action).toBe('reconcile_run');
      expect(audit.operator).toBe('system');
      expect(audit.detail.report_path).toBe(snapshotData.report_path);
    });
  });

  /** R2 可信区间与超保留期标注（AC-7） */
  describe('R2 可信区间', () => {
    it('请求范围跨出两侧保留期 → 超保留期日期标 out_of_retention，不计入 alert_days，也不比对', async () => {
      setFloor(180);
      const today = todayInTz(DEFAULT_PLATFORM_TZ);
      const floorFrom = shiftYmd(today, -179);
      const old = shiftYmd(floorFrom, -1);

      const result = await service.reconcile({ project: 'clklogapp', from: old, to: old, trigger: 'manual' });

      expect(result.daily.items).toHaveLength(1);
      expect(result.daily.items[0]).toMatchObject({ date: old, status: 'out_of_retention' });
      expect(result.summary.out_of_retention_days).toBe(1);
      expect(result.summary.alert_days).toBe(0);
      expect(result.out_of_retention).toEqual({ from: old, to: old });
      // 整段都超保留期：三组重查询一个都不该发（不白扫 ClickHouse）
      expect(clickHouse.query).not.toHaveBeenCalled();
      expect(clickHouse.queryReconcile).not.toHaveBeenCalled();
    });

    it('范围部分超出 → 只比对保留期内的部分，超出的日期显式成行', async () => {
      setFloor(2);
      const today = todayInTz(DEFAULT_PLATFORM_TZ);
      const floorFrom = shiftYmd(today, -1);
      const old = shiftYmd(floorFrom, -2);
      clickHouse.queryReconcile.mockResolvedValueOnce([{ d: floorFrom, raw_cnt: '100' }]);
      clickHouse.queryReconcile.mockResolvedValueOnce([{ event: 'PageView', cnt: '100' }]);
      clickHouse.query
        .mockResolvedValueOnce([{ d: floorFrom, sa_cnt: '100', sa_uniq: '100' }])
        .mockResolvedValueOnce([{ total: '100', uniq: '100' }])
        .mockResolvedValueOnce([{ event: 'PageView', cnt: '100' }]);

      const result = await service.reconcile({ project: 'clklogapp', from: old, to: floorFrom, trigger: 'manual' });

      expect(result.daily.items.map((i) => `${i.date}:${i.status}`)).toEqual([
        `${old}:out_of_retention`,
        `${shiftYmd(today, -2)}:out_of_retention`,
        `${floorFrom}:ok`,
      ]);
      expect(result.summary.out_of_retention_days).toBe(2);
      // 比对 SQL 用的是地板而不是原始 from
      expect(clickHouse.query.mock.calls[0][1]).toMatchObject({ from: floorFrom, to: floorFrom });
      expect(result.retention_days).toBe(2);
    });
  });

  describe('R1 对拍配置与过期状态', () => {
    it('缺配置时用默认值（阈值 10%，与线上现状一致）', async () => {
      const config = await service.configView();
      expect(config).toMatchObject({ enabled: true, run_at: '03:30', threshold_pct: 10, skip_empty_event: true });
    });

    it('保存配置：校验 + 审计 + 清缓存', async () => {
      await expect(service.saveConfig({ run_at: '25:00' }, 'admin')).rejects.toThrow('HH:mm');
      await expect(service.saveConfig({ threshold_pct: 120 }, 'admin')).rejects.toThrow('0~100');
      await expect(service.saveConfig({ stale_warn_hours: 48, stale_error_hours: 24 }, 'admin')).rejects.toThrow(
        '必须大于',
      );

      const saved = await service.saveConfig({ threshold_pct: 0.5, ignore_events: ['a', ' ', 'b'] }, 'admin');
      expect(saved.threshold_pct).toBe(0.5);
      expect(saved.ignore_events).toEqual(['a', 'b']);
      const upsert = prisma.opsReconcileConfig.upsert.mock.calls[0][0];
      expect(upsert.update.threshold_pct).toBe(0.5);
      expect(prisma.opsActionLog.create.mock.calls[0][0].data.action).toBe('reconcile_config_update');
    });

    it('快照过期三级：fresh / warn / error 由配置阈值决定', async () => {
      const now = Date.now();
      prisma.reconcileSnapshot.findFirst.mockResolvedValue({
        ran_at: new Date(now - 30 * 3_600_000), // 30 小时前
        range_from: '2026-08-26',
        range_to: '2026-08-26',
        summary: {},
        daily: null,
        crc: null,
        events: null,
        skipped: null,
        threshold_pct: 10,
        report_path: '/tmp/x.txt',
        trigger: 'auto',
        discovery_count: 0,
      });

      const warn = await service.latestSnapshot('clklogapp');
      expect(warn?.stale_level).toBe('warn');
      expect(warn?.age_hours).toBeGreaterThan(29);

      prisma.reconcileSnapshot.findFirst.mockResolvedValue({
        ran_at: new Date(now - 100 * 3_600_000),
        range_from: '2026-08-26',
        range_to: '2026-08-26',
        summary: {},
        daily: null,
        crc: null,
        events: null,
        skipped: null,
        threshold_pct: 10,
        report_path: null,
        trigger: 'auto',
        discovery_count: 0,
      });
      expect((await service.latestSnapshot('clklogapp'))?.stale_level).toBe('error');

      prisma.reconcileSnapshot.findFirst.mockResolvedValue({
        ran_at: new Date(now - 3_600_000),
        range_from: '2026-08-26',
        range_to: '2026-08-26',
        summary: {},
        daily: null,
        crc: null,
        events: null,
        skipped: null,
        threshold_pct: 10,
        report_path: null,
        trigger: 'auto',
        discovery_count: 0,
      });
      expect((await service.latestSnapshot('clklogapp'))?.stale_level).toBe('fresh');
    });
  });

});
