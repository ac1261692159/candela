/**
 * 用户行为序列的记录读写（phase: clklog-analytics-user-timeline-v1）。
 *
 * 顶部 mock appConfig：import 链会拉到 clickhouse.service → configuration（CI 空环境会抛）。
 */
jest.mock('../../config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { TimelineRecordService, TIMELINE_KIND } from './timeline-record.service';
import { emptyIam, type IamContext } from '../iam/iam.types';
import type { AuthUser } from '../auth/auth.service';
import { DomainError } from '../../i18n/domain-error';

const PROJECT = 'clklogapp';
const USER = { id: 'u-1', username: 'analyst1', display_name: '分析员', platform_role: 'none' } as AuthUser;
const SPEC = { value: '1_13543144', from: '2026-10-08 12:00', to: '2026-10-08 18:00', order: 'desc' as const, limit: 500 };
const SUMMARY = {
  matched_total: 18489,
  shown_total: 2,
  event_kinds: 23,
  first_log_time: '2026-10-08 12:01:00.000',
  last_log_time: '2026-10-08 17:59:59.000',
  truncated: true,
};
const ITEMS = [
  { log_time: 'a', event: 'e1', distinct_id: 'd', user_key: '', properties: '{}' },
  { log_time: 'b', event: 'e2', distinct_id: 'd', user_key: '', properties: '{}' },
];

/** 取拒绝原因并断言类型（`.catch` 的联合类型在 strict 下不可直接用） */
async function captureError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('期望抛出 DomainError，但正常返回了');
}

function iamWith(codes: string[], platformRole: 'super_admin' | 'none' = 'none'): IamContext {
  return { ...emptyIam(), member: true, role_key: 'analyst', platform_role: platformRole, permissions: new Set(codes) };
}

function build() {
  const prisma = {
    metaDebugRecord: {
      create: jest.fn().mockResolvedValue({ id: 'rec-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ id: 'rec-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue({ id: 'rec-1' }),
    },
    metaDebugRecordRow: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn((ops: unknown) => Promise.all(ops as Promise<unknown>[])),
  };
  return { service: new TimelineRecordService(prisma as never), prisma };
}

describe('TimelineRecordService 快路径落档', () => {
  it('落一条 done 记录：kind/spec_json/summary_json/window=null，行按上限截断', async () => {
    const { service, prisma } = build();

    await expect(
      service.archiveSuccess({ project: PROJECT, user: USER, spec: SPEC, summary: SUMMARY, items: ITEMS as never, durationMs: 9100 }),
    ).resolves.toEqual({ archived: true, record_id: 'rec-1', truncated: true });

    const data = prisma.metaDebugRecord.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      project_name: PROJECT,
      kind: TIMELINE_KIND,
      window: null,
      cond_limit: 500,
      status: 'done',
      matched_total: 18489,
      row_count: 2,
      truncated: true,
      duration_ms: 9100,
    });
    expect(JSON.parse(data.spec_json)).toMatchObject({ value: '1_13543144' });
    expect(JSON.parse(data.summary_json)).toMatchObject({ event_kinds: 23, truncated: true });
    expect(data.rows.create).toHaveLength(2);
  });

  it('写库失败只降级为 archived:false（不阻断结果返回）', async () => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.create.mockRejectedValue(new Error('db down'));

    await expect(
      service.archiveSuccess({ project: PROJECT, user: USER, spec: SPEC, summary: SUMMARY, items: ITEMS as never, durationMs: 1 }),
    ).resolves.toEqual({ archived: false });
  });
});

describe('TimelineRecordService 后台任务', () => {
  it('同规格待办/运行中任务复用（防连点）', async () => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.findFirst.mockResolvedValue({ id: 'rec-existing' });

    await expect(service.enqueue({ project: PROJECT, user: USER, spec: SPEC })).resolves.toEqual({
      record_id: 'rec-existing',
      reused: true,
    });
    expect(prisma.metaDebugRecord.create).not.toHaveBeenCalled();
  });

  it('无重复则建 pending 记录（kind 为 user_timeline）', async () => {
    const { service, prisma } = build();

    await expect(service.enqueue({ project: PROJECT, user: USER, spec: SPEC })).resolves.toEqual({
      record_id: 'rec-1',
      reused: false,
    });
    expect(prisma.metaDebugRecord.create.mock.calls[0][0].data).toMatchObject({ kind: TIMELINE_KIND, status: 'pending' });
  });

  it('认领：kind 过滤 + 原子条件更新', async () => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.findFirst.mockResolvedValue({
      id: 'rec-1',
      project_name: PROJECT,
      created_at: new Date('2026-10-08T04:00:00Z'),
      spec_json: JSON.stringify(SPEC),
    });

    await expect(service.claimNext()).resolves.toMatchObject({ id: 'rec-1', project_name: PROJECT });
    expect(prisma.metaDebugRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'rec-1', status: 'pending' },
      data: { status: 'running', started_at: expect.any(Date) },
    });
  });

  it('spec_json 缺失或竞争失败都不认领', async () => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.findFirst.mockResolvedValue({ id: 'rec-1', spec_json: null });
    await expect(service.claimNext()).resolves.toBeNull();

    prisma.metaDebugRecord.findFirst.mockResolvedValue({ id: 'rec-2', project_name: PROJECT, created_at: new Date(), spec_json: '{}' });
    prisma.metaDebugRecord.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.claimNext()).resolves.toBeNull();
  });

  it('落结果：done + summary_json + 快照行', async () => {
    const { service, prisma } = build();

    await expect(service.finishJob('rec-1', SUMMARY, ITEMS as never, 12000)).resolves.toEqual({
      row_count: 2,
      truncated: true,
    });
    const update = prisma.metaDebugRecord.update.mock.calls[0][0];
    expect(update.data).toMatchObject({ status: 'done', matched_total: 18489, row_count: 2, truncated: true, duration_ms: 12000 });
    expect(JSON.parse(update.data.summary_json).event_kinds).toBe(23);
  });

  it('失败与卡死回收都限定 kind', async () => {
    const { service, prisma } = build();

    await service.failJob('rec-1', 'timeout');
    expect(prisma.metaDebugRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'rec-1', kind: TIMELINE_KIND, status: { in: ['pending', 'running'] } },
      data: { status: 'failed', error_code: 'timeout', finished_at: expect.any(Date) },
    });

    await service.reclaimStale(new Date('2026-10-08T04:00:00Z'));
    expect(prisma.metaDebugRecord.updateMany).toHaveBeenLastCalledWith({
      where: { kind: TIMELINE_KIND, status: 'running', started_at: { lt: new Date('2026-10-08T04:00:00Z') } },
      data: { status: 'failed', error_code: 'timeout', finished_at: expect.any(Date) },
    });
  });
});

describe('TimelineRecordService 记录管理', () => {
  it('列表限定 kind 与本项目', async () => {
    const { service, prisma } = build();
    await service.list(PROJECT, 1, 20);
    expect(prisma.metaDebugRecord.findMany.mock.calls[0][0].where).toEqual({ project_name: PROJECT, kind: TIMELINE_KIND });
  });

  it('详情不存在 → 404', async () => {
    const { service } = build();
    await expect(service.detail(PROJECT, 'rec-x')).rejects.toMatchObject({ errorCode: 'timeline.recordNotFound' });
  });

  it('删除：他人且无 meta.edit 也不是超管 → 403；创建者放行', async () => {
    const { service, prisma } = build();
    prisma.metaDebugRecord.findFirst.mockResolvedValue({ id: 'rec-1', created_by: 'u-1', matched_total: 1, row_count: 1 });

    const error = await captureError(
      service.remove(PROJECT, 'rec-1', { ...USER, id: 'u-2' }, iamWith(['timeline.view'])),
    );
    expect(error.errorCode).toBe('timeline.deleteForbidden');
    expect(prisma.metaDebugRecord.delete).not.toHaveBeenCalled();

    await expect(service.remove(PROJECT, 'rec-1', USER, iamWith(['timeline.view']))).resolves.toEqual({
      deleted: true,
      record_id: 'rec-1',
    });
    expect(prisma.metaDebugRecord.delete).toHaveBeenCalledWith({ where: { id: 'rec-1' } });
  });
});
