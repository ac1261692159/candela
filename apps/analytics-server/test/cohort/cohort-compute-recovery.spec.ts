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

import { CohortComputeService } from '../../src/modules/cohort/cohort-compute.service';

function build(listPending: unknown[]) {
  const repository = {
    listPending: jest.fn().mockResolvedValue(listPending),
    findById: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
  };
  const service = new CohortComputeService(
    repository as never,
    { count: jest.fn(), insertSelect: jest.fn() } as never,
    { buildInsertSelect: jest.fn() } as never,
    { selectUids: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    { query: jest.fn(), insert: jest.fn() } as never,
    { platformTz: 'Asia/Shanghai' } as never,
    undefined,
  );
  return { service, repository };
}

describe('CohortComputeService 启动回收', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('启动时把 pending 分群按项目重新入队（错峰）', async () => {
    jest.useFakeTimers();
    const { service, repository } = build([
      { cohort_id: 'cohort_a', project_name: 'clklogapp' },
      { cohort_id: 'cohort_b', project_name: 'other' },
    ]);
    await service.onModuleInit();
    expect(repository.listPending).toHaveBeenCalledWith(50);
    expect(repository.findById).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2_000);
    // 入队最终落到 compute：先按 id 取行（这里行不存在则安全返回）
    expect(repository.findById).toHaveBeenCalledWith('cohort_a', 'clklogapp');
    expect(repository.findById).toHaveBeenCalledWith('cohort_b', 'other');
  });

  it('没有 pending 时不入队', async () => {
    jest.useFakeTimers();
    const { service, repository } = build([]);
    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(repository.findById).not.toHaveBeenCalled();
  });

  it('回收过程抛错不影响启动', async () => {
    const { service, repository } = build([]);
    repository.listPending.mockRejectedValue(new Error('db down'));
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});
