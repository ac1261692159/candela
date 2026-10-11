/**
 * Debug 查询留档（phase: clklog-analytics-debug-query-v1 的 F1/F2）。
 *
 * 守三件事：① 落档失败/关闭开关都不得影响查询结果；② 截断必须留标记、不静默；
 * ③ 删除权限＝创建者 / 超管 / meta.edit，且删除写审计。
 */
import { DebugArchiveService } from './debug-archive.service';
import { SNAPSHOT_ROW_MAX_BYTES } from '../query-job/query-job.rows';
import { emptyIam, type IamContext } from '../iam/iam.types';
import type { AuthUser } from '../auth/auth.service';
import { DomainError } from '../../i18n/domain-error';

const PROJECT = 'clklogapp';

const USER: AuthUser = {
  id: 'u-1',
  username: 'analyst1',
  display_name: '分析员',
  platform_role: 'none',
};

function iamWith(codes: string[], platformRole: 'super_admin' | 'none' = 'none'): IamContext {
  return { ...emptyIam(), member: true, role_key: 'analyst', platform_role: platformRole, permissions: new Set(codes) };
}

function resultOf(items: Record<string, unknown>[]) {
  return {
    items: items as never,
    matched_total: items.length,
    window: '24h' as const,
    limit: 20,
    since: 1_700_000_000,
  };
}

function row(properties: string) {
  return { log_time: '2026-10-08 09:00:00.000', event: 'fish_open', distinct_id: '1_1', user_key: '1_1', properties };
}

/** 取拒绝原因并断言类型（`.catch` 的联合类型在 strict 下不可直接用） */
async function captureError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('期望抛出 DomainError，但正常返回了');
}

function build(projectRow: { debug_archive_enabled: boolean } | null = { debug_archive_enabled: true }) {
  const prisma = {
    saProject: {
      findUnique: jest.fn().mockResolvedValue(projectRow),
      update: jest.fn().mockResolvedValue({ name: PROJECT, debug_archive_enabled: true }),
    },
    metaDebugRecordRow: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    metaDebugRecord: {
      create: jest.fn().mockResolvedValue({ id: 'rec-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({ id: 'rec-1' }),
      update: jest.fn().mockResolvedValue({ id: 'rec-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    opsActionLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((ops: unknown) => Promise.all(ops as Promise<unknown>[])),
  };
  const service = new DebugArchiveService(prisma as never);
  return { service, prisma };
}

describe('DebugArchiveService 开关（F2）', () => {
  it('项目行缺失按默认开处理（不因配置缺行阻断查询）', async () => {
    const { service } = build(null);
    await expect(service.isEnabled(PROJECT)).resolves.toBe(true);
  });

  it('关闭后 isEnabled 为假，且进程内缓存生效（只查一次库）', async () => {
    const { service, prisma } = build({ debug_archive_enabled: false });
    await expect(service.isEnabled(PROJECT)).resolves.toBe(false);
    await expect(service.isEnabled(PROJECT)).resolves.toBe(false);
    expect(prisma.saProject.findUnique).toHaveBeenCalledTimes(1);
  });

  it('写开关会更新库、清缓存并写审计', async () => {
    const { service, prisma } = build({ debug_archive_enabled: false });

    await expect(service.setEnabled(PROJECT, true, 'ops1')).resolves.toEqual({ enabled: true });
    // 缓存已被新值覆盖：再读不再打库
    await expect(service.isEnabled(PROJECT)).resolves.toBe(true);
    expect(prisma.saProject.findUnique).not.toHaveBeenCalled();
    expect(prisma.opsActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'meta_debug_archive_toggled', operator: 'ops1' }),
      }),
    );
  });
});

describe('DebugArchiveService 落档（F1）', () => {
  const input = (items: Record<string, unknown>[], project = PROJECT) => ({
    project,
    user: USER,
    query: { event: 'fish_open', limit: 20, window: '24h' as const },
    result: resultOf(items),
    durationMs: 1234,
  });

  it('项目关闭留档：不写库，返回 archive_disabled 供界面明示', async () => {
    const { service, prisma } = build({ debug_archive_enabled: false });

    await expect(service.archive(input([row('{}')]))).resolves.toEqual({
      archived: false,
      archive_disabled: true,
    });
    expect(prisma.metaDebugRecord.create).not.toHaveBeenCalled();
  });

  it('落档写入条件、命中数与结果行（seq 按返回顺序）', async () => {
    const { service, prisma } = build();

    await expect(service.archive(input([row('{"a":1}'), row('{"a":2}')]))).resolves.toEqual({
      archived: true,
      record_id: 'rec-1',
      truncated: false,
    });

    const data = prisma.metaDebugRecord.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      project_name: PROJECT,
      created_by: 'u-1',
      created_by_name: '分析员',
      window: '24h',
      cond_event: 'fish_open',
      cond_limit: 20,
      matched_total: 2,
      row_count: 2,
      truncated: false,
      duration_ms: 1234,
    });
    expect(data.rows.create.map((r: { seq: number }) => r.seq)).toEqual([0, 1]);
  });

  it('单行 properties 超限按字节截断（不切断多字节字符）并留标记', async () => {
    const { service, prisma } = build();
    const chinese = '好'.repeat(12000); // 36000 字节 > 32KB 上限

    await service.archive(input([row(chinese)]));

    const saved = prisma.metaDebugRecord.create.mock.calls[0][0].data.rows.create[0];
    expect(saved.properties_truncated).toBe(true);
    const bytes = Buffer.byteLength(saved.properties, 'utf8');
    expect(bytes).toBeLessThanOrEqual(SNAPSHOT_ROW_MAX_BYTES);
    expect(bytes % 3).toBe(0); // 每个汉字 3 字节：整除说明没把字符切一半
    expect(saved.properties).not.toContain('\uFFFD');
  });

  it('单条总量超限按 seq 丢弃剩余行并标记 truncated（不静默）', async () => {
    const { service, prisma } = build();
    const big = 'x'.repeat(50 * 1024); // 每行先被截到 32KB，40 行合计超过 1MB
    const many = Array.from({ length: 40 }, () => row(big));

    const outcome = await service.archive(input(many));

    expect(outcome).toMatchObject({ archived: true, truncated: true });
    const saved = prisma.metaDebugRecord.create.mock.calls[0][0].data.rows.create;
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.length).toBeLessThan(many.length);
    expect(saved.map((r: { seq: number }) => r.seq)).toEqual(saved.map((_: unknown, i: number) => i));
  });

  it('写库失败只降级为 archived:false，不抛错（查询结果照常返回）', async () => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.create.mockRejectedValue(new Error('db down'));

    await expect(service.archive(input([row('{}')]))).resolves.toEqual({ archived: false });
  });
});

describe('DebugArchiveService 删除与权限', () => {
  const existing = {
    id: 'rec-1',
    created_by: 'u-1',
    cond_event: 'fish_open',
    matched_total: 4,
    row_count: 4,
    window: '24h',
  };

  it('记录不存在 → 404', async () => {
    const { service } = build();
    await expect(service.remove(PROJECT, 'rec-x', USER, iamWith([]))).rejects.toMatchObject({
      errorCode: 'meta.debug.recordNotFound',
      status: 404,
    });
  });

  it('他人且无 meta.edit 也不是超管 → 403，且不删库', async () => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.findFirst.mockResolvedValue(existing);

    const error = await captureError(
      service.remove(PROJECT, 'rec-1', { ...USER, id: 'u-2', username: 'other' }, iamWith(['meta.view'])),
    );

    expect(error.errorCode).toBe('meta.debug.deleteForbidden');
    expect(error.getStatus()).toBe(403);
    expect(prisma.metaDebugRecord.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['创建者本人', USER, iamWith([])],
    ['平台超管', { ...USER, id: 'u-9', username: 'ops1' }, iamWith([], 'super_admin')],
    ['持 meta.edit 的成员', { ...USER, id: 'u-8', username: 'admin2' }, iamWith(['meta.edit'])],
  ])('%s 可删，且写删除审计', async (_label, user, iam) => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.findFirst.mockResolvedValue(existing);

    await expect(service.remove(PROJECT, 'rec-1', user as AuthUser, iam as IamContext)).resolves.toEqual({
      deleted: true,
      record_id: 'rec-1',
    });
    expect(prisma.metaDebugRecord.delete).toHaveBeenCalledWith({ where: { id: 'rec-1' } });
    expect(prisma.opsActionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'meta_debug_record_deleted',
          target_table: 'metadebugrecord',
          operator: (user as AuthUser).username,
        }),
      }),
    );
  });
});

describe('DebugArchiveService 列表分页', () => {
  it('页码与页大小收敛到合法范围', async () => {
    const { service, prisma } = build();

    await service.list(PROJECT, 0, 999);

    const args = prisma.metaDebugRecord.findMany.mock.calls[0][0];
    expect(args.skip).toBe(0);
    expect(args.take).toBe(100);
    expect(args.where).toEqual({ project_name: PROJECT, kind: 'debug' });
  });
});

describe('DebugArchiveService 后台任务（异步两段式，phase: clklog-analytics-debug-async-query-v1）', () => {
  const enqueueInput = {
    project: PROJECT,
    user: USER,
    query: { distinct_id: '1_13543144', window: '7d' as const, limit: 20 },
    window: '7d' as const,
    limit: 20,
  };

  it('相同条件 + 相同窗口已有待办/运行中任务时复用（防连点重复排队）', async () => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.findFirst.mockResolvedValue({ id: 'rec-existing' });

    await expect(service.enqueue(enqueueInput)).resolves.toEqual({ record_id: 'rec-existing', reused: true });
    expect(prisma.metaDebugRecord.create).not.toHaveBeenCalled();
    expect(prisma.metaDebugRecord.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['pending', 'running'] }, window: '7d', cond_limit: 20 }),
      }),
    );
  });

  it('无重复则建 pending 任务（命中数与行数为 0，结果等 worker 填）', async () => {
    const { service, prisma } = build();

    await expect(service.enqueue(enqueueInput)).resolves.toEqual({ record_id: 'rec-1', reused: false });

    expect(prisma.metaDebugRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          project_name: PROJECT,
          status: 'pending',
          cond_distinct_id: '1_13543144',
          cond_limit: 20,
          matched_total: 0,
          row_count: 0,
        }),
      }),
    );
  });

  it('认领是原子的：条件更新命中 1 行才算认领成功', async () => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.findFirst.mockResolvedValue({ id: 'rec-1', project_name: PROJECT });

    await expect(service.claimNextPending()).resolves.toMatchObject({ id: 'rec-1' });
    // 认领必须限定 kind：记录表泛化后（user_timeline）曾有 bug —— Debug runner 抢走时间线的任务
    expect(prisma.metaDebugRecord.findFirst.mock.calls[0][0].where).toMatchObject({ status: 'pending', kind: 'debug' });
    expect(prisma.metaDebugRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'rec-1', status: 'pending' },
      data: { status: 'running', started_at: expect.any(Date) },
    });
  });

  it('认领竞争失败（影响 0 行）返回 null，不重复执行', async () => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.findFirst.mockResolvedValue({ id: 'rec-1' });
    prisma.metaDebugRecord.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.claimNextPending()).resolves.toBeNull();
  });

  it('无待办返回 null', async () => {
    const { service } = build();
    await expect(service.claimNextPending()).resolves.toBeNull();
  });

  it('落结果：status=done + 命中数 + 快照行（同一套截断逻辑）', async () => {
    const { service, prisma } = build();

    await expect(
      service.finishJob(
        'rec-1',
        { items: [{ log_time: 'x', event: 'e', distinct_id: 'd', user_key: '', properties: '{}' }] as never, matched_total: 18489, window: '7d', limit: 20, since: 1 },
        1234,
      ),
    ).resolves.toEqual({ row_count: 1, truncated: false });

    const update = prisma.metaDebugRecord.update.mock.calls[0][0];
    expect(update).toMatchObject({
      where: { id: 'rec-1' },
      data: { status: 'done', matched_total: 18489, row_count: 1, duration_ms: 1234, error_code: null },
    });
    expect(update.data.rows.create).toHaveLength(1);
  });

  it('失败留痕：pending/running 才允许改成 failed + 错误码', async () => {
    const { service, prisma } = build();

    await service.failJob('rec-1', 'timeout');

    expect(prisma.metaDebugRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'rec-1', status: { in: ['pending', 'running'] } },
      data: { status: 'failed', error_code: 'timeout', finished_at: expect.any(Date) },
    });
  });

  it('回收卡死的 running', async () => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.updateMany.mockResolvedValue({ count: 3 });

    await expect(service.reclaimStale(new Date('2026-10-08T04:00:00Z'))).resolves.toBe(3);
    // kind 限定：记录表泛化后必须只回收本 kind 的卡死任务
    expect(prisma.metaDebugRecord.updateMany).toHaveBeenCalledWith({
      where: { status: 'running', kind: 'debug', started_at: { lt: new Date('2026-10-08T04:00:00Z') } },
      data: { status: 'failed', error_code: 'timeout', finished_at: expect.any(Date) },
    });
  });
});
