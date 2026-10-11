/**
 * 运维面板守卫回归（docs/architecture/clklog-analytics-design-data-management-v1.md §2、
 * PRD ops-console AC2：「非超管直接访问 /ops/* 任一 URL 返回无权限页」）。
 *
 * 数据管理曾把类级守卫写成 `meta.view`：项目管理员（owner / 分析管理员）能通过第一道闸，
 * 只靠 handler 里的 `assertOpsAdmin` 身份兜底才被拒——任何一个新 handler 漏写该调用即静默暴露。
 * 本用例锁死「/ops/* 一律 ops.runtime.access」。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { REQUIRE_PERMISSION_KEY } from '../../src/modules/iam/require-permission';
import { DataMgmtController } from '../../src/modules/ops/data-mgmt.controller';
import { ServerStatusController } from '../../src/modules/ops/server-status.controller';
import { SlowQueryController } from '../../src/modules/ops/slow-query.controller';

const OPS = 'ops.runtime.access';

function classCodes(controller: object): string[] | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION_KEY, controller) as string[] | undefined;
}

function handlerCodes(controller: { prototype: object }, method: string): string[] | undefined {
  const fn = (controller.prototype as Record<string, unknown>)[method];
  return fn ? (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, fn) as string[] | undefined) : undefined;
}

describe('运维接口守卫（ops.runtime.access）', () => {
  it('数据管理类级守卫是 ops.runtime.access，不再是 meta.view', () => {
    expect(classCodes(DataMgmtController)).toEqual([OPS]);
    expect(classCodes(DataMgmtController)).not.toContain('meta.view');
  });

  it('服务器状态 / 慢查询仍是 ops.runtime.access', () => {
    expect(handlerCodes(ServerStatusController, 'status')).toEqual([OPS]);
    expect(handlerCodes(ServerStatusController, 'diskTrend')).toEqual([OPS]);
    expect(handlerCodes(ServerStatusController, 'logExecute')).toEqual([OPS]);
    expect(handlerCodes(SlowQueryController, 'list')).toEqual([OPS]);
  });
});
