/**
 * 时区解析链 v2（phase: clklog-analytics-timezone-v2）：显式→用户→项目→平台。
 * registry 用静态 seed 模拟（与 Prisma 解耦），验证优先级与恒等快路语义。
 */
import { ProjectTimeRegistry } from '../../src/modules/time/project-time-registry';
import { TimeScopeService } from '../../src/modules/time/time-scope';
import { TimezoneService } from '../../src/modules/time/timezone.service';

function makeServices(projects: Record<string, string | null>, platformTz = 'Asia/Shanghai') {
  const registry = new ProjectTimeRegistry({} as never);
  registry.seedForTest(projects);
  const timezones = new TimezoneService({ platformTz }, registry);
  const scope = new TimeScopeService(timezones);
  return { registry, timezones, scope };
}

const NOW = new Date('2026-09-17T02:00:00Z');

describe('TimezoneService.resolveChain 优先级', () => {
  const { timezones } = makeServices({ proj_ny: 'America/New_York', proj_jp: 'Asia/Tokyo' });

  it('显式 > 用户 > 项目 > 平台', () => {
    expect(timezones.resolveChain({}).displayTz).toBe('Asia/Shanghai');
    expect(timezones.resolveChain({ projectName: 'proj_ny' }).displayTz).toBe('America/New_York');
    expect(timezones.resolveChain({ projectName: 'proj_ny', authUserTz: 'Asia/Tokyo' }).displayTz).toBe('Asia/Tokyo');
    expect(
      timezones.resolveChain({ projectName: 'proj_ny', authUserTz: 'Asia/Tokyo', explicit: 'UTC' }).displayTz,
    ).toBe('UTC');
  });

  it('statTz 不受用户/显式影响，只见项目→平台', () => {
    expect(timezones.resolveChain({ projectName: 'proj_ny', authUserTz: 'UTC', explicit: 'Asia/Tokyo' }).statTz).toBe(
      'America/New_York',
    );
    expect(timezones.resolveChain({ explicit: 'UTC' }).statTz).toBe('Asia/Shanghai');
  });

  it('项目值非法 → 平台兜底（fail-open）；用户值非法 → 400', () => {
    const bad = makeServices({ proj_bad: 'Mars/Olympus' });
    expect(bad.timezones.resolveChain({ projectName: 'proj_bad' }).displayTz).toBe('Asia/Shanghai');
    expect(() => bad.timezones.resolveChain({ authUserTz: 'Mars/Olympus' }).displayTz).toThrow(/时区不合法/);
  });
});

describe('TimeScopeService.materialize（v2 链与恒等语义）', () => {
  const { scope } = makeServices({ proj_ny: 'America/New_York' });

  it('项目口径恒等：displayTz == statTz（项目）→ 快路；宽扫不重开', () => {
    const s = scope.materialize(
      { start: '2026-09-16', end: '2026-09-16' },
      { now: NOW, projectName: 'proj_ny' },
    );
    expect(s.tz).toBe('America/New_York');
    expect(s.statTz).toBe('America/New_York');
    expect(s.isPlatformCalendar).toBe(true);
    expect(s.scanStartYmd).toBe('2026-09-16');
  });

  it('用户偏好盖过项目 → 宽扫（纽约落库日历 ≠ 用户东京展示）', () => {
    const s = scope.materialize(
      { start: '2026-09-16', end: '2026-09-16' },
      { now: NOW, projectName: 'proj_ny', authUserTz: 'Asia/Tokyo' },
    );
    expect(s.tz).toBe('Asia/Tokyo');
    expect(s.statTz).toBe('America/New_York');
    expect(s.isPlatformCalendar).toBe(false);
    expect(s.scanStartYmd).toBe('2026-09-15');
    expect(s.scanEndYmd).toBe('2026-09-17');
  });

  it('无项目/用户字段 = v1：平台单一口径恒等', () => {
    const s = scope.materialize({ start: '2026-09-16', end: '2026-09-16' }, { now: NOW });
    expect(s.tz).toBe('Asia/Shanghai');
    expect(s.statTz).toBe('Asia/Shanghai');
    expect(s.isPlatformCalendar).toBe(true);
  });

  it('显性 timezone=UTC 在默认项目下与 v1 判定一致', () => {
    const s = scope.materialize({ start: '2026-09-16', end: '2026-09-16', timezone: 'UTC' }, { now: NOW });
    expect(s.isPlatformCalendar).toBe(false);
    expect(s.startEpochMs).toBe(Date.parse('2026-09-16T00:00:00Z'));
  });
});

describe('ProjectTimeRegistry', () => {
  it('未知项目 fail-open；在册项目透出；非法值兜底', () => {
    const registry = new ProjectTimeRegistry({} as never);
    registry.seedForTest({ a: 'Asia/Tokyo', bad: 'Not/AZone', none: null });
    expect(registry.timeZoneOf('a', 'Asia/Shanghai')).toBe('Asia/Tokyo');
    expect(registry.timeZoneOf('unknown', 'Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(registry.timeZoneOf('bad', 'Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(registry.timeZoneOf('none', 'Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(registry.timeZoneOf(null, 'Asia/Shanghai')).toBe('Asia/Shanghai');
  });

  it('invalidate 触发回源刷新（prisma 刷新通道）', async () => {
    const prisma = {
      saProject: {
        findMany: jest.fn().mockResolvedValue([{ name: 'a', timezone: 'Pacific/Honolulu' }]),
      },
    } as never;
    const registry = new ProjectTimeRegistry(prisma);
    await (registry as unknown as { refresh(): Promise<void> }).refresh();
    expect(registry.timeZoneOf('a', 'Asia/Shanghai')).toBe('Pacific/Honolulu');
    // 源变化 → 失效后刷新换值
    (prisma as { saProject: { findMany: jest.Mock } }).saProject.findMany.mockResolvedValue([
      { name: 'a', timezone: 'Europe/London' },
    ]);
    registry.invalidate('a');
    await new Promise((resolve) => setImmediate(resolve));
    await (registry as unknown as { refresh(): Promise<void> }).refresh();
    expect(registry.timeZoneOf('a', 'Asia/Shanghai')).toBe('Europe/London');
    registry.onModuleDestroy();
  });

  it('刷新失败（prisma throw）→ 保旧缓存仍可服务', async () => {
    const prisma = {
      saProject: { findMany: jest.fn().mockRejectedValue(new Error('db down')) },
    } as never;
    const registry = new ProjectTimeRegistry(prisma);
    registry.seedForTest({ a: 'Asia/Tokyo' });
    await (registry as unknown as { refresh(): Promise<void> }).refresh();
    expect(registry.timeZoneOf('a', 'Asia/Shanghai')).toBe('Asia/Tokyo');
    registry.onModuleDestroy();
  });
});
