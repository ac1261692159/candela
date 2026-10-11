/**
 * 隔离 YAML 配置：`cohort-preview.service` / `cohort.service` 会经 clickhouse / redis
 * 服务顶层加载 `src/config/configuration`（需要 APP_CONFIG_PATH 与真实密钥，CI 里都没有），
 * 与 test/ops/slow-query.*.spec.ts 同款处理。见 scripts/build.sh 的后端单测说明。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    __specConfigMock: true,
  },
}));

import { CohortService } from '../../src/modules/cohort/cohort.service';

const row = (over: Record<string, unknown> = {}) => ({
  cohort_id: 'cohort_abc123xx',
  project_name: 'clklogapp',
  owner: 'u1',
  name: 'cohort_active',
  display_name: '活跃用户',
  remark: null,
  kind: 'condition',
  definition_json: JSON.stringify({ conditions: [] }),
  schedule: 'manual',
  status: 'ready',
  member_count: 10,
  batch_id: 'b_old',
  last_computed_at: null,
  compute_error: null,
  subject_id: 'asub_userxxxx',
  locked: false,
  created_at: new Date('2026-09-01T00:00:00Z'),
  updated_at: new Date('2026-09-05T00:00:00Z'),
  ...over,
});

function build(overrides: {
  repository?: Record<string, unknown>;
  compute?: Record<string, unknown>;
  members?: Record<string, unknown>;
} = {}) {
  const repository = {
    findById: jest.fn().mockResolvedValue(row()),
    findCardsReferencing: jest.fn().mockResolvedValue([]),
    findDashboardsReferencing: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ count: 1 }),
    update: jest.fn().mockResolvedValue({ count: 1 }),
    ...overrides.repository,
  };
  const compute = {
    enqueue: jest.fn(),
    computeIdUpload: jest.fn().mockResolvedValue(undefined),
    ...overrides.compute,
  };
  const members = { deleteBatch: jest.fn().mockResolvedValue(undefined), ...overrides.members };
  const service = new CohortService(
    repository as never,
    compute as never,
    members as never,
    { preview: jest.fn() } as never,
    { previewCondition: jest.fn() } as never,
    { resolve: jest.fn().mockResolvedValue({ subject_id: 'asub_userxxxx', kind: 'preset' }) } as never,
    { platformTz: 'Asia/Shanghai' } as never,
    undefined,
  );
  return { service, repository, compute, members };
}

describe('CohortService.remove 引用检查', () => {
  it('卡片引用时报 409 并带上卡片名', async () => {
    const { service, repository } = build({
      repository: { findCardsReferencing: jest.fn().mockResolvedValue([{ card_id: 'card_1', name: '渠道看板卡' }]) },
    });
    await expect(service.remove('cohort_abc123xx', 'clklogapp')).rejects.toMatchObject({
      errorCode: 'cohort.cardReferenced',
      params: { names: '渠道看板卡' },
    });
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('只被看板级分群筛引用时也要拦下（这是旧实现漏掉的那条路径）', async () => {
    const { service, repository } = build({
      repository: {
        findCardsReferencing: jest.fn().mockResolvedValue([]),
        findDashboardsReferencing: jest.fn().mockResolvedValue([{ db_id: 'db_1', name: '运营总览' }]),
      },
    });
    await expect(service.remove('cohort_abc123xx', 'clklogapp')).rejects.toMatchObject({
      errorCode: 'cohort.cardReferenced',
      params: { names: '运营总览' },
    });
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('force=1 时卡片与看板都拦不住，且清掉旧批次', async () => {
    const { service, repository, members } = build({
      repository: {
        findCardsReferencing: jest.fn().mockResolvedValue([{ card_id: 'card_1', name: '卡' }]),
        findDashboardsReferencing: jest.fn().mockResolvedValue([{ db_id: 'db_1', name: '看板' }]),
      },
    });
    await expect(service.remove('cohort_abc123xx', 'clklogapp', true)).resolves.toEqual({ success: true });
    expect(members.deleteBatch).toHaveBeenCalledWith('clklogapp', 'cohort_abc123xx', 'b_old');
    expect(repository.delete).toHaveBeenCalled();
  });
});

describe('CohortService.replaceMembers', () => {
  it('非 ID 分群拒绝重传', async () => {
    const { service, compute } = build();
    await expect(service.replaceMembers('cohort_abc123xx', 'clklogapp', 'uid\nu1')).rejects.toMatchObject({
      errorCode: 'cohort.idUpload.onlyIdUpload',
    });
    expect(compute.computeIdUpload).not.toHaveBeenCalled();
  });

  it('ID 分群重传走同一套（新批次 → 切 MySQL → 删旧批次）', async () => {
    const { service, compute, repository } = build({
      repository: { findById: jest.fn().mockResolvedValue(row({ kind: 'id_upload' })) },
    });
    await expect(service.replaceMembers('cohort_abc123xx', 'clklogapp', 'uid\nu1')).resolves.toBeTruthy();
    expect(compute.computeIdUpload).toHaveBeenCalledWith('cohort_abc123xx', 'clklogapp', 'uid\nu1');
  });
});
