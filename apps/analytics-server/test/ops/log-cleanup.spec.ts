/**
 * 日志目录治理（phase: clklog-analytics-data-management-v1）单测。
 *
 * 2026-09-15 验收：非白名单目录返回 500（应为 400），保留天数越界同样 500 —— 一并修掉。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { DomainError } from '../../src/i18n/domain-error';
import { LogCleanupService } from '../../src/modules/ops/log-cleanup.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';

const WHITELIST = '/data/clklog/clklog-docker-compose/clklog_dc_data/receiver';

function harness() {
  const prisma = {
    logCleanupConfig: {
      findMany: jest.fn(async () => [
        { path: WHITELIST, label: 'receiver 原始报文日志', retain_days: 3, enabled: true },
      ]),
      findUnique: jest.fn(async ({ where }: { where: { path: string } }) =>
        where.path === WHITELIST ? { path: WHITELIST, retain_days: 3, enabled: true } : null,
      ),
      update: jest.fn(async () => ({})),
    },
    opsActionLog: { create: jest.fn(async () => ({ id: 1n })) },
  } as unknown as PrismaService;
  return { service: new LogCleanupService(prisma), prisma: prisma as any };
}

describe('日志目录治理', () => {
  it('非白名单目录预演 → 400（此前 500）', async () => {
    const { service } = harness();
    const rejected = service.preview('/etc');
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ status: 400, errorCode: 'ops.logCleanup.pathNotAllowed' });
  });

  it('保留天数越界 → 400（此前 500）', async () => {
    const { service } = harness();
    const tooLarge = service.updateConfig(WHITELIST, { retain_days: 9_999 });
    await expect(tooLarge).rejects.toBeInstanceOf(DomainError);
    await expect(tooLarge).rejects.toMatchObject({ status: 400, errorCode: 'ops.logCleanup.retainDaysInvalid' });
    const tooSmall = service.updateConfig(WHITELIST, { retain_days: 0 });
    await expect(tooSmall).rejects.toBeInstanceOf(DomainError);
    await expect(tooSmall).rejects.toMatchObject({ status: 400, errorCode: 'ops.logCleanup.retainDaysInvalid' });
  });

  it('白名单目录预演：返回待删文件数/字节与最大文件（只读）', async () => {
    const { service } = harness();
    const result = await service.preview(WHITELIST);
    // 目录内容随生产波动，这里只断言结构与保留期回显
    expect(result).toMatchObject({ path: WHITELIST, retain_days: 3 });
    expect(result).toHaveProperty('file_count');
    expect(result).toHaveProperty('total_bytes');
    expect(result).toHaveProperty('largest');
  });

  it('配置列表返回白名单目录与保留期', async () => {
    const { service } = harness();
    const items = await service.listConfigs();
    expect(items[0]).toMatchObject({ path: WHITELIST, retain_days: 3 });
  });
});
